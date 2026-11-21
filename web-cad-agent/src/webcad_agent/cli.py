from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from .adapters.gateway import HttpGeometryAdapter
from .adapters.json_store import JsonStore
from .adapters.sqlite_store import SQLiteStore
from .adapters.sqlalchemy_store import SQLAlchemyStore
from .application.service import AgentApplication
from .ui.repl import run_repl
from .ui.tui_app import run_tui
from .ui.deep_link import viewer_url
from .domain.units import parse_length
from .extensions.manifest import ExtensionManifest
from .extensions.manager import ExtensionManager
from .tools.registry import ToolRegistry
from .skills.registry import SkillRegistry
from .policy_lease import DocumentLeaseManager
from .llm.http_model import HttpJsonModel
from .evals.defaults import run_default_evals
from .evals.model import run_model_evals
from .observability.otel import configure_telemetry, shutdown_telemetry


def _default_state() -> Path:
    override = os.environ.get("WEBCAD_AGENT_STATE")
    return Path(override) if override else Path(".data") / "agent.db"


def _app(args: argparse.Namespace) -> tuple[AgentApplication, object]:
    store = JsonStore(args.state) if args.state.suffix.lower() == ".json" else SQLAlchemyStore(args.state)
    geometry = HttpGeometryAdapter(args.gateway)
    extension_state = args.state.with_name(args.state.stem + ".extensions.json")
    manager = ExtensionManager(state_path=extension_state)
    registry = ToolRegistry.discover(enabled_providers=manager.enabled_ids)
    skills = SkillRegistry.discover(enabled_providers=manager.enabled_ids)
    model_endpoint = getattr(args, "model_endpoint", None) or os.environ.get("WEBCAD_AGENT_MODEL_ENDPOINT")
    model = HttpJsonModel(model_endpoint) if model_endpoint else None
    leases = DocumentLeaseManager(lease_dir=args.state.parent / ".leases")
    return AgentApplication(store=store, geometry=geometry, registry=registry, skills=skills,
                            lease_manager=leases, model=model), geometry


async def _run(args: argparse.Namespace) -> int:
    if args.command == "eval":
        result = await (run_model_evals(endpoint=args.model_endpoint, repetitions=args.repetitions)
                        if args.model_endpoint else run_default_evals(repetitions=args.repetitions))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["status"] == "passed" else 1
    if args.command is None:
        app, geometry = _app(args)
        try:
            session = app.create_session(document_id="web-cad-demo", gateway_origin=args.gateway)
            try:
                run_tui(app=app, session_id=session.session_id)
            except RuntimeError:
                run_repl(app, session_id=session.session_id)
            return 0
        finally:
            await geometry.close()
            if getattr(app, "model", None) is not None and hasattr(app.model, "close"): await app.model.close()
            if hasattr(app.store, "close"): app.store.close()
    if args.command == "health":
        app, geometry = _app(args)
        try:
            print(json.dumps(await geometry.health(), ensure_ascii=False, indent=2))
            return 0
        finally:
            await geometry.close()
            if getattr(app, "model", None) is not None and hasattr(app.model, "close"): await app.model.close()
            if hasattr(app.store, "close"): app.store.close()
    if args.command == "backup":
        source = args.state
        if not source.exists():
            print(json.dumps({"status": "missing", "source": str(source)}, ensure_ascii=False, indent=2))
            return 2
        destination = args.destination
        destination.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = destination / f"agent-{stamp}{source.suffix or '.db'}"
        shutil.copy2(source, target)
        files = [{"path": str(target), "sha256": _sha256(target), "size_bytes": target.stat().st_size}]
        extension_state = source.with_name(source.stem + ".extensions.json")
        if extension_state.exists():
            extension_target = destination / f"agent-{stamp}.extensions.json"
            shutil.copy2(extension_state, extension_target)
            files.append({"path": str(extension_target), "sha256": _sha256(extension_target),
                          "size_bytes": extension_target.stat().st_size})
        print(json.dumps({"status": "completed", "created_at": stamp, "files": files}, ensure_ascii=False, indent=2))
        return 0
    if args.command == "config":
        if args.config_command == "show":
            print(json.dumps({"gateway_url": args.gateway, "state_path": str(args.state),
                              "mode": args.mode, "resume": args.resume,
                              "model_configured": bool(getattr(args, "model_endpoint", None) or os.environ.get("WEBCAD_AGENT_MODEL_ENDPOINT"))},
                             ensure_ascii=False, indent=2))
            return 0
        raise ValueError(f"Unknown config command: {args.config_command}")
    if args.command == "extensions":
        registry = __import__("webcad_agent.tools.registry", fromlist=["ToolRegistry"]).ToolRegistry.discover()
        extension_state = args.state.with_name(args.state.stem + ".extensions.json")
        manager = ExtensionManager(state_path=extension_state)
        action = args.extensions_command
        if action == "list":
            snapshot = registry.snapshot()
            payload = snapshot.model_dump(mode="json")
            payload["enabled"] = sorted(manager.enabled_ids)
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 0
        if action == "info":
            snapshot = registry.snapshot()
            matches = [item.model_dump(mode="json") for item in snapshot.extensions
                       if item.extension_id == args.extension_id or item.provider == args.extension_id]
            if not matches:
                print(json.dumps({"status": "not_found", "extension_id": args.extension_id}, ensure_ascii=False, indent=2))
                return 2
            print(json.dumps(matches, ensure_ascii=False, indent=2))
            return 0
        if action == "enable":
            manifest = ExtensionManifest.from_path(args.manifest)
            if args.trusted:
                manager.trusted_ids.add(manifest.extension_id)
            checked = manager.enable(manifest)
            print(json.dumps({"status": "enabled", "manifest": checked.model_dump(mode="json"),
                              "state_path": str(extension_state)}, ensure_ascii=False, indent=2))
            return 0
        if action == "disable":
            manager.disable(args.extension_id)
            print(json.dumps({"status": "disabled", "extension_id": args.extension_id}, ensure_ascii=False, indent=2))
            return 0
        if action == "doctor":
            snapshot = registry.snapshot()
            print(json.dumps(manager.doctor(snapshot.extensions), ensure_ascii=False, indent=2))
            return 0
        if action == "validate":
            manifest = ExtensionManifest.from_path(args.manifest)
            manager = ExtensionManager(trusted_ids={manifest.extension_id} if args.trusted else set())
            checked = manager.validate_manifest(manifest)
            result = {"status": "valid", "manifest": checked.model_dump(mode="json")}
            if args.skill:
                skills = manager.load_skills(checked, args.skill)
                result["skills"] = [skill.model_dump(mode="json") for skill in skills.list()]
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        raise ValueError(f"Unknown extensions command: {action}")
    app, geometry = _app(args)
    try:
        if getattr(args, "resume", None) == "last" and hasattr(args, "session") and not args.session:
            sessions = app.store.list_sessions(document_id=getattr(args, "document", None))
            if sessions: args.session = sessions[0].session_id
        if args.command == "session":
            session = app.create_session(document_id=args.document, gateway_origin=args.gateway)
            print(json.dumps(session.model_dump(mode="json"), ensure_ascii=False, indent=2))
            return 0
        if args.command == "open-session":
            result = await app.recover_session(args.session)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "summary":
            session_id = args.session
            if not session_id:
                session = app.create_session(document_id=args.document, gateway_origin=args.gateway)
                session_id = session.session_id
            print(json.dumps(await app.summary(session_id), ensure_ascii=False, indent=2))
            return 0
        if args.command == "view":
            result = await app.view(session_id=args.session, offset=args.offset, limit=args.limit)
            print(json.dumps(result, ensure_ascii=False, indent=2)); return 0
        if args.command == "properties":
            result = await app.properties(args.session)
            print(json.dumps(result, ensure_ascii=False, indent=2)); return 0
        if args.command == "spatial":
            result = await app.spatial(session_id=args.session, kind=args.kind, body_id=args.body, feature_id=args.feature)
            print(json.dumps(result, ensure_ascii=False, indent=2)); return 0 if result.get("status") == "completed" else 2
        if args.command == "measure":
            result = await app.measure(session_id=args.session, reference=args.reference)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result["status"] == "completed" else 3
        if args.command == "relation":
            result = await app.relation(session_id=args.session, body_a=args.body_a, body_b=args.body_b,
                                        tolerance=args.tolerance)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result["status"] == "completed" else 3
        if args.command == "create-box":
            session = app.store.get_session(args.session) if args.session else None
            if session is None:
                session = app.create_session(document_id=args.document, gateway_origin=args.gateway)
            result = await app.propose_box(session_id=session.session_id, width=args.width, depth=args.depth,
                                           height=args.height, x=args.x, y=args.y, z=args.z, approve=args.approve,
                                           mode=args.mode)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result["status"] == "completed" else 3 if result["status"] == "approval_required" else 1
        if args.command == "create-tube":
            session = app.store.get_session(args.session) if args.session else None
            if session is None:
                session = app.create_session(document_id=args.document, gateway_origin=args.gateway)
            result = await app.propose_hollow_tube(session_id=session.session_id, outer_radius=args.outer_radius,
                                                   inner_radius=args.inner_radius, height=args.height, approve=args.approve,
                                                   mode=args.mode)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result["status"] == "completed" else 3 if result["status"] == "approval_required" else 1
        if args.command == "translate":
            result = await app.propose_translate(session_id=args.session, reference=args.reference,
                                                 dx=args.dx, dy=args.dy, dz=args.dz, approve=args.approve, mode=args.mode)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result["status"] == "completed" else 3 if result["status"] == "approval_required" else 1
        if args.command == "tool":
            try:
                arguments = json.loads(args.arguments)
            except json.JSONDecodeError as exc:
                raise ValueError(f"--arguments must be JSON: {exc}") from exc
            result = await app.propose_tool(session_id=args.session, tool_name=args.tool_name,
                                            arguments=arguments, approve=args.approve, mode=args.mode)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result["status"] == "completed" else 3 if result["status"] == "approval_required" else 1
        if args.command == "run":
            session = app.store.get_session(args.session) if args.session else None
            if session is None:
                session = app.create_session(document_id=args.document, gateway_origin=args.gateway)
            text = args.prompt.strip()
            result = await app.handle_prompt(session_id=session.session_id, text=text,
                                              approve=args.approve, mode=args.mode)
            print(json.dumps(result, ensure_ascii=False, indent=2) if args.output == "json" else _render_result(result))
            return 0 if result["status"] == "completed" else 3 if result["status"] in {"approval_required", "needs_clarification"} else 1
        if args.command == "approve":
            run = app.store.get_run(args.run)
            if run is None: raise ValueError("Unknown run")
            if run.active_plan_id:
                result = await app.approve_plan(session_id=run.session_id, run_id=run.run_id, plan_id=run.active_plan_id)
            else:
                result = await app.approve(run.run_id)
            print(json.dumps(result, ensure_ascii=False, indent=2)); return 0 if result["status"] == "completed" else 1
        if args.command in {"pause", "resume", "cancel", "reject"}:
            run = app.store.get_run(args.run)
            if run is None: raise ValueError("Unknown run")
            if args.command == "pause": value = app.pause_run(session_id=run.session_id, run_id=run.run_id)
            elif args.command == "resume": value = app.resume_run(session_id=run.session_id, run_id=run.run_id)
            elif args.command == "cancel": value = app.cancel_run(session_id=run.session_id, run_id=run.run_id)
            else: value = app.reject_run(session_id=run.session_id, run_id=run.run_id)
            print(json.dumps(value.model_dump(mode="json"), ensure_ascii=False, indent=2)); return 0
        if args.command == "answer-input":
            try:
                answer = json.loads(args.answer)
            except json.JSONDecodeError as exc:
                raise ValueError(f"--answer must be JSON: {exc}") from exc
            if args.continue_run:
                value = await app.answer_input_and_continue(request_id=args.request, answer=answer,
                                                            approve=args.approve)
            else:
                value = app.answer_input(request_id=args.request, answer=answer).model_dump(mode="json")
            print(json.dumps(value, ensure_ascii=False, indent=2)); return 0
        if args.command in {"undo", "redo"}:
            result = await app.history(session_id=args.session, direction=args.command)
            print(json.dumps(result, ensure_ascii=False, indent=2)); return 0
        if args.command == "open-viewer":
            session = await app.open_session(args.session)
            url = viewer_url(origin=args.origin, document_id=session.document_id,
                             revision=session.last_document_revision, body_id=args.body)
            print(url); return 0
        if args.command == "sessions":
            values = app.store.list_sessions(document_id=args.document)
            print(json.dumps([item.model_dump(mode="json") for item in values], ensure_ascii=False, indent=2)); return 0
        if args.command == "runs":
            values = app.list_runs(session_id=args.session)
            print(json.dumps([item.model_dump(mode="json") for item in values], ensure_ascii=False, indent=2)); return 0
        if args.command == "events":
            values = app.events(session_id=args.session, after_sequence=args.after)
            print(json.dumps([item.model_dump(mode="json") for item in values], ensure_ascii=False, indent=2)); return 0
        if args.command == "metrics":
            print(json.dumps(app.metrics_snapshot(), ensure_ascii=False, indent=2)); return 0
        if args.command == "archive":
            value = app.archive_session(args.session)
            print(json.dumps(value.model_dump(mode="json"), ensure_ascii=False, indent=2)); return 0
        if args.command == "recover":
            result = await app.recover_session(args.session)
            print(json.dumps(result, ensure_ascii=False, indent=2)); return 0
        if args.command == "chat":
            session = app.store.get_session(args.session) if args.session else None
            if session is None:
                session = app.create_session(document_id=args.document, gateway_origin=args.gateway)
            run_repl(app, session_id=session.session_id)
            return 0
        if args.command == "compact":
            print(json.dumps(app.compact_session(args.session), ensure_ascii=False, indent=2))
            return 0
        raise ValueError(f"Unknown command: {args.command}")
    finally:
        await geometry.close()
        if getattr(app, "model", None) is not None and hasattr(app.model, "close"): await app.model.close()
        if hasattr(app.store, "close"): app.store.close()


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="webcad-agent", description="Independent Python Web CAD Agent")
    p.add_argument("--gateway", default="http://127.0.0.1:8788")
    p.add_argument("--state", type=Path, default=_default_state())
    p.add_argument("--resume", choices=["last"])
    p.add_argument("--mode", choices=["readonly", "supervised", "auto"], default="supervised")
    p.add_argument("--model-endpoint", help="Optional provider-neutral structured model endpoint")
    p.add_argument("--otel-exporter", choices=["none", "console", "otlp_http"],
                   default=None, help="Optional OpenTelemetry exporter")
    p.add_argument("--otel-endpoint", help="OTLP HTTP traces endpoint")
    p.add_argument("--service-name", default=None, help="OpenTelemetry service name")
    sub = p.add_subparsers(dest="command", required=False)
    health = sub.add_parser("health"); del health
    backup = sub.add_parser("backup", help="Create a portable backup of Agent state")
    backup.add_argument("--destination", type=Path, required=True)
    config = sub.add_parser("config", help="Inspect effective non-secret configuration")
    config_sub = config.add_subparsers(dest="config_command", required=True)
    config_sub.add_parser("show")
    for name in ("session", "summary"):
        cmd = sub.add_parser(name); cmd.add_argument("--document", default="web-cad-demo"); cmd.add_argument("--session")
    open_session = sub.add_parser("open-session"); open_session.add_argument("--session", required=True)
    measure = sub.add_parser("measure"); measure.add_argument("reference"); measure.add_argument("--session", required=True)
    relation = sub.add_parser("relation"); relation.add_argument("body_a"); relation.add_argument("body_b"); relation.add_argument("--session", required=True); relation.add_argument("--tolerance", type=float, default=1.0e-6)
    view = sub.add_parser("view"); view.add_argument("--session", required=True); view.add_argument("--offset", type=int, default=0); view.add_argument("--limit", type=int, default=50)
    properties = sub.add_parser("properties"); properties.add_argument("--session", required=True)
    spatial = sub.add_parser("spatial"); spatial.add_argument("--session", required=True)
    spatial.add_argument("--kind", choices=["geometry-tree", "body", "variables", "coordinates", "materials", "history", "properties", "property-types"], default="geometry-tree")
    spatial.add_argument("--body"); spatial.add_argument("--feature")
    box = sub.add_parser("create-box")
    box.add_argument("--document", default="web-cad-demo"); box.add_argument("--session"); box.add_argument("--width", type=float, required=True)
    box.add_argument("--depth", type=float, required=True); box.add_argument("--height", type=float, required=True)
    box.add_argument("--x", type=float, default=0); box.add_argument("--y", type=float, default=0); box.add_argument("--z", type=float, default=0)
    box.add_argument("--approve", action="store_true"); box.add_argument("--mode", choices=["readonly", "supervised", "auto"], default="supervised")
    tube = sub.add_parser("create-tube")
    tube.add_argument("--document", default="web-cad-demo"); tube.add_argument("--session")
    tube.add_argument("--outer-radius", type=float, required=True); tube.add_argument("--inner-radius", type=float, required=True)
    tube.add_argument("--height", type=float, required=True); tube.add_argument("--approve", action="store_true")
    tube.add_argument("--mode", choices=["readonly", "supervised", "auto"], default="supervised")
    translate = sub.add_parser("translate"); translate.add_argument("reference"); translate.add_argument("--session", required=True)
    translate.add_argument("--dx", type=float, required=True); translate.add_argument("--dy", type=float, required=True); translate.add_argument("--dz", type=float, required=True); translate.add_argument("--approve", action="store_true")
    translate.add_argument("--mode", choices=["readonly", "supervised", "auto"], default="supervised")
    tool = sub.add_parser("tool"); tool.add_argument("tool_name"); tool.add_argument("--session", required=True); tool.add_argument("--arguments", required=True); tool.add_argument("--approve", action="store_true"); tool.add_argument("--mode", choices=["readonly", "supervised", "auto"], default="supervised")
    run = sub.add_parser("run"); run.add_argument("prompt"); run.add_argument("--document", default="web-cad-demo"); run.add_argument("--session"); run.add_argument("--approve", action="store_true"); run.add_argument("--mode", choices=["readonly", "supervised", "auto"], default="supervised"); run.add_argument("--output", choices=["text", "json"], default="text")
    approve = sub.add_parser("approve"); approve.add_argument("--run", required=True)
    for name in ("pause", "resume", "cancel", "reject"):
        cmd = sub.add_parser(name); cmd.add_argument("--run", required=True)
    answer_input = sub.add_parser("answer-input"); answer_input.add_argument("--request", required=True); answer_input.add_argument("--answer", required=True)
    answer_input.add_argument("--continue", dest="continue_run", action="store_true")
    answer_input.add_argument("--approve", action="store_true")
    for name in ("undo", "redo"):
        cmd = sub.add_parser(name); cmd.add_argument("--session", required=True)
    sessions = sub.add_parser("sessions"); sessions.add_argument("--document")
    runs = sub.add_parser("runs"); runs.add_argument("--session")
    events = sub.add_parser("events"); events.add_argument("--session", required=True); events.add_argument("--after", type=int, default=0)
    sub.add_parser("metrics")
    eval_cmd = sub.add_parser("eval", help="Run deterministic or opt-in model-backed acceptance scenarios")
    eval_cmd.add_argument("--repetitions", type=int, default=1)
    archive = sub.add_parser("archive"); archive.add_argument("--session", required=True)
    recover = sub.add_parser("recover"); recover.add_argument("--session", required=True)
    viewer = sub.add_parser("open-viewer"); viewer.add_argument("--session", required=True); viewer.add_argument("--body"); viewer.add_argument("--origin", default="http://127.0.0.1:3000")
    chat = sub.add_parser("chat"); chat.add_argument("--document", default="web-cad-demo"); chat.add_argument("--session")
    compact = sub.add_parser("compact"); compact.add_argument("--session", required=True)
    extensions = sub.add_parser("extensions", help="Inspect and validate installed Tool/Skill extensions")
    extension_sub = extensions.add_subparsers(dest="extensions_command", required=True)
    extension_sub.add_parser("list")
    info = extension_sub.add_parser("info"); info.add_argument("extension_id")
    enable = extension_sub.add_parser("enable"); enable.add_argument("manifest", type=Path); enable.add_argument("--trusted", action="store_true")
    disable = extension_sub.add_parser("disable"); disable.add_argument("extension_id")
    extension_sub.add_parser("doctor")
    validate = extension_sub.add_parser("validate"); validate.add_argument("manifest", type=Path)
    validate.add_argument("--skill", type=Path); validate.add_argument("--trusted", action="store_true")
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    configure_telemetry(exporter=args.otel_exporter, endpoint=args.otel_endpoint,
                        service_name=args.service_name)
    try:
        return asyncio.run(_run(args))
    finally:
        shutdown_telemetry()


def _extract_box(text: str) -> tuple[float, float, float] | None:
    matches = re.findall(r"(?<![A-Za-z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|cm|m|in|ft)?", text, re.I)
    numbers = [parse_length(f"{value} {unit}" if unit else value) for value, unit in matches]
    if len(numbers) < 3 or not re.search(r"box|长方体|方盒|矩形体|创建|新建|create", text, re.I):
        return None
    return numbers[:3]


def _render_result(result: dict) -> str:
    status = result.get("status", "unknown")
    if status == "approval_required":
        approval = result.get("approval", {})
        return f"等待审批：{approval.get('summary', 'CAD 写操作')}\napproval_id={approval.get('approval_id')}\nrun_id={result.get('run', {}).get('run_id')}"
    if status == "completed":
        return f"已完成：body_id={result.get('body_id')} verification={result.get('verification', {}).get('passed')}"
    return json.dumps(result, ensure_ascii=False, indent=2)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
