from __future__ import annotations

from datetime import timedelta
import re
from time import perf_counter
from typing import Any

from ..adapters.gateway import canonical_hash
from ..context.builder import ContextBuilder
from ..context.compactor import ContextCompactor
from ..domain.models import (
    ActionEnvelope, ActionStatus, AgentEvent, AgentRun, AgentSession, ApprovalRequest,
    ConfigSnapshot, ContextRequirements, CompactionCheckpoint, ElicitationRequest, EventType, ErrorClass, PlanStatus, RouteDecision, RunStatus, SideEffect,
    RiskLevel, SessionMessage, new_id, utc_now,
)
from ..domain.state import transition
from ..policy import PolicyEngine
from ..planning.executor import PlanExecutor
from ..planning.planner import DeterministicPlanner
from ..planning.llm_planner import StructuredPlanner
from ..llm.protocol import LLMModel
from ..routing.router import IntentRouter
from ..ports import GeometryPort
from ..tools.registry import ToolRegistry
from ..skills.registry import SkillRegistry
from ..tools.validation import validate_input
from ..verification.geometry import verify_box, verify_cone, verify_cylinder, verify_operation_ack, verify_relation, verify_shape, verify_sphere, verify_torus, verify_translation
from ..resolution.resolver import EntityResolver
from .events import EventBus
from ..observability.logging import JsonEventLogger
from ..observability.trace import current_trace
from ..observability.otel import span
from ..observability.metrics import Metrics
from ..policy_lease import DocumentLeaseManager
from ..nl import parse_command


def _unwrap(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("result")
    return value if isinstance(value, dict) else payload


def _body_id(payload: dict[str, Any]) -> str | None:
    value = _unwrap(payload)
    for key in ("bodyId", "body_id", "id"):
        if value.get(key):
            return str(value[key])
    nested = value.get("body")
    return str(nested.get("id")) if isinstance(nested, dict) and nested.get("id") else None


def _action_fingerprint(*, tool_name: str, tool_version: str, document_id: str,
                        arguments: dict[str, Any], expected_revision: int | None,
                        success_criteria: list[dict[str, Any]]) -> str:
    """Hash every fact that changes the meaning or acceptance of an action."""
    return canonical_hash({
        "tool_name": tool_name,
        "tool_version": tool_version,
        "document_id": document_id,
        "arguments": arguments,
        "expected_revision": expected_revision,
        "success_criteria": success_criteria,
    })


def _prompt_reference(text: str) -> str | None:
    match = re.search(r"(@?(?:body|feature|face|edge)[-_:/\w]*|Body[-_]?\w+)", text, re.I)
    return match.group(1) if match else None


class AgentApplication:
    """Application orchestration for the independent CLI Agent."""

    def __init__(self, *, store: Any, geometry: GeometryPort, registry: ToolRegistry | None = None,
                 policy: PolicyEngine | None = None, compactor: ContextCompactor | None = None,
                 event_bus: EventBus | None = None, logger: JsonEventLogger | None = None,
                 model: LLMModel | None = None, auto_compact_threshold: int = 24,
                 lease_manager: DocumentLeaseManager | None = None, metrics: Metrics | None = None,
                 skills: SkillRegistry | None = None) -> None:
        self.store = store
        self.geometry = geometry
        self.registry = registry or ToolRegistry.discover()
        self.policy = policy or PolicyEngine()
        self.compactor = compactor or ContextCompactor()
        self.event_bus = event_bus or EventBus()
        self.logger = logger
        self.skills = skills or SkillRegistry.discover()
        self.context = ContextBuilder(geometry, self.registry, self.skills)
        self.planner = DeterministicPlanner(self.registry)
        self.plan_executor = PlanExecutor(store=store, geometry=geometry, registry=self.registry,
                                           policy=self.policy, emit=self._emit)
        self.router = IntentRouter()
        self.resolver = EntityResolver()
        self.model = model
        self.structured_planner = StructuredPlanner(model, self.registry) if model else None
        self.auto_compact_threshold = max(0, auto_compact_threshold)
        self.leases = lease_manager or DocumentLeaseManager()
        self.metrics = metrics or Metrics()

    def _lease_key(self, session_id: str) -> str:
        session = self.store.get_session(session_id)
        if session is None:
            raise ValueError(f"Unknown session: {session_id}")
        return f"{session.gateway_origin}:{session.document_id}"

    def _acquire_write_lease(self, *, session_id: str, run_id: str) -> None:
        self.leases.acquire(self._lease_key(session_id), run_id)

    def _release_write_lease(self, run: AgentRun) -> None:
        try:
            self.leases.release(self._lease_key(run.session_id), run.run_id)
        except ValueError:
            pass

    def _emit(self, session_id: str, event_type: EventType, *, run_id: str | None = None,
              payload: dict[str, Any] | None = None, correlation_id: str | None = None) -> AgentEvent:
        event = AgentEvent(
            session_id=session_id, run_id=run_id, sequence_number=self.store.next_sequence(session_id),
            event_type=event_type, actor="agent", correlation_id=correlation_id or run_id or session_id,
            payload=payload or {},
        )
        self.store.append_event(event)
        self.event_bus.publish(event)
        self.metrics.inc(f"event.{event_type.value}")
        if self.logger:
            self.logger.write("agent.event", trace_id=current_trace().trace_id, session_id=session_id,
                              run_id=run_id, event_type=event_type.value, sequence_number=event.sequence_number,
                              payload=payload or {})
        return event

    def create_session(self, *, document_id: str, gateway_origin: str, title: str = "Web CAD Session") -> AgentSession:
        session = AgentSession(document_id=document_id, gateway_origin=gateway_origin, title=title)
        self.store.save_session(session)
        self._emit(session.session_id, EventType.SESSION_CREATED, payload={"document_id": document_id})
        return session

    async def open_session(self, session_id: str) -> AgentSession:
        session = self.store.get_session(session_id)
        if session is None:
            raise ValueError(f"Unknown session: {session_id}")
        gateway_error: str | None = None
        try:
            summary = await self.geometry.summary(session.document_id)
            session.last_document_revision = _revision(summary)
        except Exception as exc:
            # Reopening a session is still useful offline: historical events,
            # messages and a pending Goal remain inspectable. Writes cannot
            # resume until a later health/revision check succeeds.
            gateway_error = str(exc)
        session.status = "active"
        session.last_opened_at = utc_now()
        session.updated_at = utc_now()
        self.store.save_session(session)
        self._emit(session.session_id, EventType.SESSION_OPENED,
                   payload={"revision": session.last_document_revision,
                            "gateway_available": gateway_error is None,
                            **({"error": gateway_error} if gateway_error else {})})
        return session

    def append_message(self, *, session_id: str, role: str, content: str, run_id: str | None = None,
                       document_revision: int | None = None) -> SessionMessage:
        message = SessionMessage(session_id=session_id, role=role, content=content, run_id=run_id, document_revision=document_revision)
        if hasattr(self.store, "save_message"):
            self.store.save_message(message)
        # Messages are events in the first store; this preserves ordering and reopenability.
        self._emit(session_id, EventType.MESSAGE_APPENDED,
                   run_id=run_id, payload={"message": message.model_dump(mode="json")})
        if role == "user":
            self._emit(session_id, EventType.INPUT_RECEIVED, run_id=run_id, payload={"message_id": message.message_id})
        if self.auto_compact_threshold and hasattr(self.store, "list_messages"):
            if len(self.store.list_messages(session_id=session_id)) > self.auto_compact_threshold:
                self.compact_session(session_id)
        return message

    async def start_run(self, *, session_id: str, goal: str, mode: str = "supervised") -> AgentRun:
        session = self.store.get_session(session_id)
        if session is None:
            raise ValueError(f"Unknown session: {session_id}")
        summary = await self.geometry.summary(session.document_id)
        config = ConfigSnapshot(agent_version="0.1.0", mode=mode,
                                model_name=getattr(self.model, "model", None),
                                gateway_protocol_version=getattr(self.geometry, "capabilities", {}).get("protocolVersion"))
        if hasattr(self.store, "save_config_snapshot"):
            self.store.save_config_snapshot(config)
        run = AgentRun(session_id=session_id, document_id=session.document_id, goal=goal,
                       document_revision=_revision(summary), registry_version=self.registry.version,
                       config_snapshot_id=config.snapshot_id)
        self.store.save_run(run)
        session.active_run_id = run.run_id
        session.last_document_revision = run.document_revision
        session.updated_at = utc_now()
        self.store.save_session(session)
        self._emit(session_id, EventType.RUN_CREATED, run_id=run.run_id, payload={"goal": goal})
        self._emit(session_id, EventType.GOAL_PARSED, run_id=run.run_id, payload={"goal": goal, "goal_version": run.goal_version})
        return run

    async def build_context(self, *, run_id: str, user_input: str, node_name: str = "planner",
                            requirements: ContextRequirements | None = None):
        run = self.store.get_run(run_id)
        if run is None:
            raise ValueError(f"Unknown run: {run_id}")
        session = self.store.get_session(run.session_id)
        if session is None:
            raise ValueError(f"Unknown session: {run.session_id}")
        req = requirements or ContextRequirements(include_goal=True, document_views=["summary"], include_policy=True,
                                                   tool_names=[item.name for item in self.registry.list()], observation_limit=8)
        events = self.store.list_events(session_id=session.session_id)
        observations = [event.payload for event in events if event.event_type == EventType.OBSERVATION_RECORDED]
        context = await self.context.build(session=session, run=run, user_input=user_input, node_name=node_name,
                                           requirements=req, observations=observations)
        self._emit(session.session_id, EventType.CONTEXT_BUILT, run_id=run.run_id,
                   payload={"context_pack_id": context.context_pack_id, "node_name": node_name,
                            "estimated_tokens": context.budgets.get("estimated_tokens")})
        return context

    def route(self, *, session_id: str, text: str, pending_run_id: str | None = None):
        decision = self.router.route(text, pending_run_id=pending_run_id)
        self._emit(session_id, EventType.ROUTE_DECIDED, payload=decision.model_dump(mode="json"))
        return decision

    async def propose_box(self, *, session_id: str, width: float, depth: float, height: float,
                          x: float = 0.0, y: float = 0.0, z: float = 0.0, approve: bool = False,
                          mode: str = "supervised", _run: AgentRun | None = None) -> dict[str, Any]:
        if min(width, depth, height) <= 0:
            raise ValueError("Box dimensions must be positive")
        run = _run or await self.start_run(session_id=session_id, goal=f"Create a box {width} x {depth} x {height}", mode=mode)
        spec = self.registry.require("core.geometry.create_box", stage="execute")
        arguments = {"width": width, "depth": depth, "height": height, "x": x, "y": y, "z": z}
        success_criteria = [{"type": "box_geometry", "min": [x, y, z],
                             "max": [x + width, y + depth, z + height],
                             "volume": width * depth * height}]
        action_hash = _action_fingerprint(tool_name=spec.gateway_operation or spec.name,
                                          tool_version=spec.version, document_id=run.document_id,
                                          arguments=arguments, expected_revision=run.document_revision,
                                          success_criteria=success_criteria)
        action = ActionEnvelope(
            run_id=run.run_id, tool_name=spec.gateway_operation or spec.name, tool_version=spec.version,
            document_id=run.document_id, arguments=arguments, side_effect=spec.side_effect,
            risk_level=spec.risk_level, expected_revision=run.document_revision, idempotency_key=action_hash,
            action_hash=action_hash, reason="Create box from explicit CLI request",
            arguments_hash=canonical_hash(arguments),
            success_criteria=success_criteria,
        )
        self.store.save_action(action)
        decision = self.policy.decide(action, mode=mode)
        if not decision.allowed:
            run.last_error = {"code": "POLICY_DENIED", "reason": decision.reason}
            run.status = RunStatus.FAILED
            self.store.save_run(run)
            self._emit(session_id, EventType.RUN_FAILED, run_id=run.run_id, payload=run.last_error)
            return {"status": "failed", "run": run.model_dump(mode="json")}
        try:
            self._acquire_write_lease(session_id=session_id, run_id=run.run_id)
        except RuntimeError as exc:
            run.status = RunStatus.FAILED; run.last_error = {"code": "LEASE_UNAVAILABLE", "reason": str(exc)}
            self.store.save_run(run)
            return {"status": "failed", "run": run.model_dump(mode="json")}
        preview = await self.geometry.preview(action)
        if decision.requires_approval:
            approval = ApprovalRequest(run_id=run.run_id, action_id=action.action_id, action_hash=action.action_hash,
                                       document_id=run.document_id, before_revision=run.document_revision,
                                       normalized_arguments=arguments,
                                       parameter_sources={key: "user" for key in arguments},
                                       affected_entities=[{"kind": "document", "id": run.document_id}],
                                       risk_level=action.risk_level,
                                       rollback={"strategy": "document.undo", "requires_revision_match": True},
                                       summary=f"Create box {width} x {depth} x {height}",
                                       impact=[f"Adds one solid body to document {run.document_id}"],
                                       expected_revision=run.document_revision,
                                       expires_at=utc_now() + timedelta(minutes=15))
            self.store.save_approval(approval)
        if decision.requires_approval and not approve:
            action.status = ActionStatus.APPROVAL_PENDING
            run.status = RunStatus.WAITING_APPROVAL
            run.pending_action_id = action.action_id
            run.waiting_reason = approval.approval_id
            self.store.save_action(action); self.store.save_run(run)
            self._emit(session_id, EventType.APPROVAL_REQUESTED, run_id=run.run_id,
                       payload={"approval": approval.model_dump(mode="json"), "action": action.model_dump(mode="json")})
            return {"status": "approval_required", "run": run.model_dump(mode="json"),
                    "approval": approval.model_dump(mode="json"), "action": action.model_dump(mode="json"), "preview": preview}
        if decision.requires_approval:
            run.pending_action_id = action.action_id
            self.store.save_run(run)
        return await self.approve(run.run_id, approval_override=True)

    async def propose_hollow_tube(self, *, session_id: str, outer_radius: float, inner_radius: float,
                                  height: float, approve: bool = False, mode: str = "supervised",
                                  _run: AgentRun | None = None) -> dict[str, Any]:
        run = _run or await self.start_run(session_id=session_id,
                                           goal=f"Create a hollow tube R{outer_radius}/R{inner_radius} x {height}", mode=mode)
        plan = self.planner.hollow_tube(run, outer_radius=outer_radius, inner_radius=inner_radius, height=height)
        if mode != "readonly":
            try:
                self._acquire_write_lease(session_id=session_id, run_id=run.run_id)
            except RuntimeError as exc:
                run.status = RunStatus.FAILED; run.last_error = {"code": "LEASE_UNAVAILABLE", "reason": str(exc)}
                self.store.save_run(run)
                return {"status": "failed", "run": run.model_dump(mode="json")}
        decisions = await self.plan_executor.propose(session_id=session_id, run=run, plan=plan, approve=approve, mode=mode)
        if decisions.get("status") != "approval_required":
            self._release_write_lease(run)
        return decisions

    async def handle_prompt(self, *, session_id: str, text: str, approve: bool = False,
                            mode: str = "supervised", run_id: str | None = None) -> dict[str, Any]:
        """Run one deterministic CLI/TUI prompt through the application boundary.

        The parser only extracts explicit values.  Missing values become a
        persisted elicitation; no implicit body or dimension is selected.
        """
        continuation = self.store.get_run(run_id) if run_id else None
        message = self.append_message(session_id=session_id, role="user", content=text, run_id=run_id)
        route = self.route(session_id=session_id, text=text)
        parsed = parse_command(text)
        result: dict[str, Any]
        if parsed.complete:
            if parsed.kind == "box":
                result = await self.propose_box(session_id=session_id, width=parsed.arguments["width"],
                                                depth=parsed.arguments["depth"], height=parsed.arguments["height"],
                                                x=parsed.arguments.get("x", 0), y=parsed.arguments.get("y", 0),
                                                z=parsed.arguments.get("z", 0), approve=approve, mode=mode, _run=continuation)
            elif parsed.kind == "tube":
                result = await self.propose_hollow_tube(session_id=session_id,
                                                        outer_radius=parsed.arguments["outer_radius"],
                                                        inner_radius=parsed.arguments["inner_radius"],
                                                        height=parsed.arguments["height"], approve=approve, mode=mode, _run=continuation)
            elif parsed.kind == "translate":
                result = await self.propose_translate(session_id=session_id, reference=parsed.reference or "",
                                                      dx=parsed.arguments["dx"], dy=parsed.arguments["dy"],
                                                      dz=parsed.arguments["dz"], approve=approve, mode=mode, _run=continuation)
            else:
                tool_name = {"cylinder": "core.geometry.create_cylinder", "cone": "core.geometry.create_cone",
                             "sphere": "core.geometry.create_sphere", "torus": "core.geometry.create_torus",
                             "cut": "core.boolean.cut", "fuse": "core.boolean.fuse",
                             "common": "core.boolean.common", "fillet": "core.detail.fillet",
                             "chamfer": "core.detail.chamfer", "pattern_linear": "core.pattern.linear",
                             "pattern_circular": "core.pattern.circular", "pattern_rectangular": "core.pattern.rectangular",
                             "pattern_mirror": "core.pattern.mirror", "material": "core.project.set_material"}[parsed.kind]
                result = await self.propose_tool(session_id=session_id, tool_name=tool_name,
                                                 arguments=parsed.arguments, approve=approve, mode=mode, _run=continuation)
        elif parsed.kind != "unknown" and parsed.missing:
            run = continuation or await self.start_run(session_id=session_id, goal=text, mode=mode)
            request = self.request_input(run_id=run.run_id,
                                         question=f"请补充 {', '.join(parsed.missing)} 后再继续。",
                                         fields=list(parsed.missing), metadata={"prompt": text, "mode": mode})
            result = {"status": "needs_clarification", "request": request.model_dump(mode="json"),
                      "run": run.model_dump(mode="json"), "parsed": {"kind": parsed.kind, "missing": parsed.missing}}
        elif route.path == "read":
            session = await self.open_session(session_id)
            lowered = text.lower()
            if re.search(r"(?:property|properties|属性)", lowered):
                result = {"status": "completed", "document_id": session.document_id,
                          "revision": session.last_document_revision,
                          "properties": await self.properties(session_id)}
            elif re.search(r"(?:measure|测量|体积|尺寸)", lowered):
                ref = _prompt_reference(text)
                result = await self.measure(session_id=session_id, reference=ref) if ref else {
                    "status": "needs_clarification", "message": "请提供要测量的 Body/Feature/Face/Edge 引用。"}
            else:
                result = {"status": "completed", "document_id": session.document_id,
                          "revision": session.last_document_revision,
                          "summary": await self.summary(session_id)}
        elif self.structured_planner is not None:
            run = continuation or await self.start_run(session_id=session_id, goal=text, mode=mode)
            context = await self.build_context(run_id=run.run_id, user_input=text, node_name="planner",
                                                requirements=ContextRequirements(include_goal=True, include_policy=True,
                                                                                 document_views=["summary"],
                                                                                 tool_names=[item.name for item in self.registry.list()],
                                                                                 observation_limit=8))
            plan = await self.structured_planner.plan(run=run, user_goal=text, context=context.model_dump(mode="json"))
            result = await self.plan_executor.propose(session_id=session_id, run=run, plan=plan,
                                                      approve=approve, mode=mode)
        else:
            result = {"status": "needs_clarification",
                      "message": "请明确 CAD 操作和参数；支持 Box、Cylinder、Cone、Sphere、Torus、空心管及平移。"}
        result.setdefault("route", route.model_dump(mode="json"))
        result.setdefault("message_id", message.message_id)
        return result

    async def propose_translate(self, *, session_id: str, reference: str, dx: float, dy: float, dz: float,
                               approve: bool = False, mode: str = "supervised",
                               _run: AgentRun | None = None) -> dict[str, Any]:
        session = await self.open_session(session_id)
        summary = await self.geometry.summary(session.document_id)
        run = _run or await self.start_run(session_id=session_id, goal=f"Translate {reference} by {dx},{dy},{dz}", mode=mode)
        resolved = self.resolver.resolve(reference, summary=_unwrap(summary), revision=_revision(summary))
        if resolved.status != "resolved":
            request = self.request_input(
                run_id=run.run_id,
                question="请选择唯一的 Body/Feature/Face/Edge 引用后再继续。",
                fields=["reference"], candidates=resolved.candidates)
            return {"status": "needs_clarification", "resolution": {"status": resolved.status, "candidates": resolved.candidates},
                    "request": request.model_dump(mode="json"), "run": run.model_dump(mode="json")}
        before = await self.geometry.measure(session.document_id, resolved.entity.entity_id)
        spec = self.registry.require("core.transform.translate", stage="execute")
        arguments = {"inputs": {"bodyId": resolved.entity.entity_id}, "parameters": {"dx": dx, "dy": dy, "dz": dz}}
        success_criteria = [{"type": "translation", "before": _unwrap(before), "delta": [dx, dy, dz]}]
        action_hash = _action_fingerprint(tool_name=spec.gateway_operation or spec.name,
                                          tool_version=spec.version, document_id=run.document_id,
                                          arguments=arguments, expected_revision=run.document_revision,
                                          success_criteria=success_criteria)
        action = ActionEnvelope(run_id=run.run_id, tool_name=spec.gateway_operation or spec.name, tool_version=spec.version,
                                document_id=run.document_id, arguments=arguments, side_effect=spec.side_effect,
                                risk_level=spec.risk_level, expected_revision=run.document_revision,
                                idempotency_key=action_hash, action_hash=action_hash,
                                arguments_hash=canonical_hash(arguments), reason="Translate an explicitly resolved Body",
                                success_criteria=success_criteria)
        self.store.save_action(action)
        decision = self.policy.decide(action, mode=mode)
        if not decision.allowed:
            run.status = RunStatus.FAILED; run.last_error = {"code": "POLICY_DENIED"}; self.store.save_run(run)
            return {"status": "failed", "run": run.model_dump(mode="json")}
        try:
            self._acquire_write_lease(session_id=session_id, run_id=run.run_id)
        except RuntimeError as exc:
            run.status = RunStatus.FAILED; run.last_error = {"code": "LEASE_UNAVAILABLE", "reason": str(exc)}
            self.store.save_run(run)
            return {"status": "failed", "run": run.model_dump(mode="json")}
        preview = await self.geometry.preview(action)
        approval = None
        if decision.requires_approval:
            approval = ApprovalRequest(run_id=run.run_id, action_id=action.action_id, action_hash=action.action_hash,
                                       document_id=run.document_id, before_revision=run.document_revision,
                                       normalized_arguments=arguments,
                                       parameter_sources={"reference": "resolved_entity", "dx": "user", "dy": "user", "dz": "user"},
                                       affected_entities=[{"kind": resolved.entity.kind, "id": resolved.entity.entity_id}],
                                       risk_level=action.risk_level,
                                       rollback={"strategy": "document.undo", "requires_revision_match": True},
                                       expected_revision=run.document_revision, summary=f"Translate {resolved.entity.entity_id}",
                                       impact=[f"delta=({dx}, {dy}, {dz})"], expires_at=utc_now() + timedelta(minutes=15))
            self.store.save_approval(approval)
        if decision.requires_approval and not approve:
            action.status = ActionStatus.APPROVAL_PENDING; run.status = RunStatus.WAITING_APPROVAL
            run.pending_action_id = action.action_id; run.waiting_reason = approval.approval_id
            self.store.save_action(action); self.store.save_run(run)
            self._emit(session_id, EventType.APPROVAL_REQUESTED, run_id=run.run_id,
                       payload={"approval": approval.model_dump(mode="json"), "preview": preview})
            return {"status": "approval_required", "run": run.model_dump(mode="json"),
                    "approval": approval.model_dump(mode="json"), "action": action.model_dump(mode="json"), "preview": preview}
        run.pending_action_id = action.action_id; self.store.save_run(run)
        return await self.approve(run.run_id, approval_override=True) if decision.requires_approval else await self._execute_and_verify(run, action)

    async def approve_plan(self, *, session_id: str, run_id: str, plan_id: str) -> dict[str, Any]:
        run_before = self.store.get_run(run_id)
        if run_before is not None:
            try:
                self._acquire_write_lease(session_id=session_id, run_id=run_id)
            except RuntimeError as exc:
                run_before.status = RunStatus.PAUSED; run_before.last_error = {"code": "LEASE_UNAVAILABLE", "reason": str(exc)}
                self.store.save_run(run_before)
                return {"status": "failed", "run": run_before.model_dump(mode="json")}
        result = await self.plan_executor.approve(session_id=session_id, run_id=run_id, plan_id=plan_id)
        run = self.store.get_run(run_id)
        if run and result.get("status") != "approval_required":
            self._release_write_lease(run)
        return result

    async def propose_tool(self, *, session_id: str, tool_name: str, arguments: dict[str, Any],
                           goal: str | None = None, approve: bool = False, mode: str = "supervised",
                           _run: AgentRun | None = None) -> dict[str, Any]:
        """Execute an allow-listed ToolSpec through the same policy path as built-in helpers."""
        spec = self.registry.require(tool_name, stage="execute")
        if spec.side_effect not in {SideEffect.WRITE, SideEffect.DESTRUCTIVE}:
            raise PermissionError(f"Tool {tool_name} is not a write Tool; use a READ operation instead")
        validate_input(spec.input_schema, arguments)
        run = _run or await self.start_run(session_id=session_id, goal=goal or f"Execute {tool_name}", mode=mode)
        success_criteria: list[dict[str, Any]] = [{"type": spec.verifier or "shape_valid"}]
        if spec.verifier == "box_geometry":
            origin = [float(arguments.get(axis, 0.0)) for axis in ("x", "y", "z")]
            dimensions = [float(arguments[name]) for name in ("width", "depth", "height")]
            success_criteria = [{"type": "box_geometry", "min": origin,
                                 "max": [origin[index] + dimensions[index] for index in range(3)],
                                 "volume": dimensions[0] * dimensions[1] * dimensions[2]}]
        elif spec.verifier == "cylinder_geometry":
            success_criteria = [{"type": "cylinder_geometry", "radius": float(arguments["radius"]),
                                 "height": float(arguments["height"]),
                                 "x": float(arguments.get("x", 0.0)),
                                 "y": float(arguments.get("y", 0.0)),
                                 "z": float(arguments.get("z", 0.0))}]
        elif spec.verifier == "sphere_geometry":
            success_criteria = [{"type": "sphere_geometry", "radius": float(arguments["radius"]),
                                 "x": float(arguments.get("x", 0.0)), "y": float(arguments.get("y", 0.0)),
                                 "z": float(arguments.get("z", 0.0))}]
        elif spec.verifier == "cone_geometry":
            success_criteria = [{"type": "cone_geometry", "radius1": float(arguments["radius1"]),
                                 "radius2": float(arguments["radius2"]), "height": float(arguments["height"]),
                                 "x": float(arguments.get("x", 0.0)), "y": float(arguments.get("y", 0.0)),
                                 "z": float(arguments.get("z", 0.0))}]
        elif spec.verifier == "torus_geometry":
            success_criteria = [{"type": "torus_geometry", "majorRadius": float(arguments["majorRadius"]),
                                 "minorRadius": float(arguments["minorRadius"]),
                                 "x": float(arguments.get("x", 0.0)), "y": float(arguments.get("y", 0.0)),
                                 "z": float(arguments.get("z", 0.0))}]
        action_hash = _action_fingerprint(tool_name=spec.gateway_operation or spec.name,
                                          tool_version=spec.version, document_id=run.document_id,
                                          arguments=arguments, expected_revision=run.document_revision,
                                          success_criteria=success_criteria)
        action = ActionEnvelope(run_id=run.run_id, tool_name=spec.gateway_operation or spec.name,
                                tool_version=spec.version, document_id=run.document_id, arguments=arguments,
                                side_effect=spec.side_effect, risk_level=spec.risk_level,
                                expected_revision=run.document_revision, idempotency_key=action_hash,
                                action_hash=action_hash, arguments_hash=canonical_hash(arguments),
                                reason=f"Explicitly execute allow-listed Tool {tool_name}",
                                success_criteria=success_criteria)
        self.store.save_action(action)
        decision = self.policy.decide(action, mode=mode)
        if not decision.allowed:
            run.status = RunStatus.FAILED; run.last_error = {"code": "POLICY_DENIED", "reason": decision.reason}; self.store.save_run(run)
            return {"status": "failed", "run": run.model_dump(mode="json")}
        try:
            self._acquire_write_lease(session_id=session_id, run_id=run.run_id)
        except RuntimeError as exc:
            run.status = RunStatus.FAILED; run.last_error = {"code": "LEASE_UNAVAILABLE", "reason": str(exc)}
            self.store.save_run(run)
            return {"status": "failed", "run": run.model_dump(mode="json")}
        preview = await self.geometry.preview(action) if spec.supports_preview else {"supported": False}
        approval = None
        if decision.requires_approval:
            approval = ApprovalRequest(run_id=run.run_id, action_id=action.action_id, action_hash=action.action_hash,
                                       document_id=run.document_id, before_revision=run.document_revision,
                                       normalized_arguments=arguments,
                                       parameter_sources={key: "user_or_plan" for key in arguments},
                                       affected_entities=[{"kind": "document", "id": run.document_id}],
                                       risk_level=action.risk_level,
                                       rollback={"strategy": "document.undo", "requires_revision_match": True},
                                       expected_revision=run.document_revision, summary=f"Execute {tool_name}",
                                       impact=[f"Tool arguments: {arguments}"], expires_at=utc_now() + timedelta(minutes=15))
            self.store.save_approval(approval)
        if decision.requires_approval and not approve:
            action.status = ActionStatus.APPROVAL_PENDING; run.status = RunStatus.WAITING_APPROVAL
            run.pending_action_id = action.action_id; run.waiting_reason = approval.approval_id
            self.store.save_action(action); self.store.save_run(run)
            self._emit(session_id, EventType.APPROVAL_REQUESTED, run_id=run.run_id,
                       payload={"approval": approval.model_dump(mode="json"), "action": action.model_dump(mode="json"), "preview": preview})
            return {"status": "approval_required", "run": run.model_dump(mode="json"),
                    "approval": approval.model_dump(mode="json"), "action": action.model_dump(mode="json"), "preview": preview}
        run.pending_action_id = action.action_id; self.store.save_run(run)
        return await self.approve(run.run_id, approval_override=True) if decision.requires_approval else await self._execute_and_verify(run, action)

    async def propose_model_plan(self, *, session_id: str, goal: str, approve: bool = False,
                                 mode: str = "supervised") -> dict[str, Any]:
        if self.structured_planner is None:
            raise RuntimeError("No structured LLM model is configured")
        run = await self.start_run(session_id=session_id, goal=goal, mode=mode)
        context = await self.build_context(run_id=run.run_id, user_input=goal, node_name="planner")
        plan = await self.structured_planner.plan(run=run, user_goal=goal, context=context.model_dump(mode="json"))
        return await self.plan_executor.propose(session_id=session_id, run=run, plan=plan, approve=approve, mode=mode)

    def reject_run(self, *, session_id: str, run_id: str, reason: str = "User rejected the proposed action") -> AgentRun:
        run = self.store.get_run(run_id)
        if run is None or run.session_id != session_id:
            raise ValueError("Unknown run")
        if run.status not in {RunStatus.WAITING_APPROVAL, RunStatus.WAITING_USER, RunStatus.PAUSED}:
            raise ValueError(f"Run cannot be rejected from {run.status}")
        run.status = RunStatus.CANCELLED; run.waiting_reason = reason; self.store.save_run(run)
        self._release_write_lease(run)
        if run.active_plan_id:
            plan = self.store.get_plan(run.active_plan_id)
            if plan:
                plan.status = PlanStatus.CANCELLED; plan.updated_at = utc_now(); self.store.save_plan(plan)
        approval = self.store.get_approval_for_run(run_id)
        if approval and approval.decision is None:
            approval.decision = "reject"; approval.decided_at = utc_now(); self.store.save_approval(approval)
        self._emit(session_id, EventType.APPROVAL_DECIDED, run_id=run_id, payload={"decision": "reject", "reason": reason})
        self._emit(session_id, EventType.RUN_CANCELLED, run_id=run_id, payload={"reason": reason})
        return run

    def pause_run(self, *, session_id: str, run_id: str) -> AgentRun:
        return self._set_run_status(session_id, run_id, RunStatus.PAUSED, EventType.RUN_PAUSED)

    def resume_run(self, *, session_id: str, run_id: str) -> AgentRun:
        run = self._set_run_status(session_id, run_id, RunStatus.RUNNING, EventType.RUN_RESUMED)
        return run

    def cancel_run(self, *, session_id: str, run_id: str) -> AgentRun:
        value = self._set_run_status(session_id, run_id, RunStatus.CANCELLED, EventType.RUN_CANCELLED)
        self._release_write_lease(value)
        return value

    def _set_run_status(self, session_id: str, run_id: str, target: RunStatus, event_type: EventType) -> AgentRun:
        run = self.store.get_run(run_id)
        if run is None or run.session_id != session_id:
            raise ValueError("Unknown run")
        if run.status in {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}:
            raise ValueError("Run is terminal")
        if target == RunStatus.RUNNING and run.status not in {RunStatus.PAUSED, RunStatus.WAITING_USER, RunStatus.WAITING_APPROVAL}:
            raise ValueError(f"Run cannot resume from {run.status}")
        run = transition(run, target).model_copy(update={"updated_at": utc_now()}); self.store.save_run(run)
        self._emit(session_id, event_type, run_id=run_id, payload={"status": target.value})
        return run

    async def history(self, *, session_id: str, direction: str) -> dict[str, Any]:
        session = self.store.get_session(session_id)
        if session is None: raise ValueError("Unknown session")
        summary = await self.geometry.summary(session.document_id)
        revision = _revision(summary)
        owner_id = f"history-{new_id(direction)}"
        self._acquire_write_lease(session_id=session_id, run_id=owner_id)
        try:
            result = await self.geometry.history(session.document_id, direction, idempotency_key=owner_id,
                                                 expected_revision=revision)
        finally:
            # History is a short control operation; the lease owner is unique
            # to this call and must never survive an exception.
            self.leases.release(self._lease_key(session_id), owner_id)
        self._emit(session_id, EventType.OBSERVATION_RECORDED, payload={"operation": f"document.{direction}", "result": result})
        session.last_document_revision = _revision(result); session.updated_at = utc_now(); self.store.save_session(session)
        return result

    def archive_session(self, session_id: str) -> AgentSession:
        session = self.store.get_session(session_id)
        if session is None: raise ValueError("Unknown session")
        session.status = "archived"; session.updated_at = utc_now(); self.store.save_session(session)
        return session

    def events(self, *, session_id: str, after_sequence: int = 0) -> list[AgentEvent]:
        return self.store.list_events(session_id=session_id, after_sequence=after_sequence)

    def get_run(self, run_id: str) -> AgentRun | None:
        return self.store.get_run(run_id)

    def get_session(self, session_id: str) -> AgentSession | None:
        return self.store.get_session(session_id)

    def request_input(self, *, run_id: str, question: str, fields: list[str] | None = None,
                      candidates: list[dict[str, Any]] | None = None,
                      metadata: dict[str, Any] | None = None) -> ElicitationRequest:
        run = self.store.get_run(run_id)
        if run is None:
            raise ValueError("Unknown run")
        request = ElicitationRequest(run_id=run_id, question=question, fields=fields or [], candidates=candidates or [],
                                     metadata=metadata or {})
        run.status = RunStatus.WAITING_USER; run.waiting_reason = request.request_id; self.store.save_run(run)
        if hasattr(self.store, "save_elicitation"):
            self.store.save_elicitation(request)
        self._emit(run.session_id, EventType.INPUT_REQUESTED, run_id=run_id,
                   payload={"request": request.model_dump(mode="json")})
        return request

    def answer_input(self, *, request_id: str, answer: dict[str, Any]) -> ElicitationRequest:
        request = self.store.get_elicitation(request_id) if hasattr(self.store, "get_elicitation") else None
        if request is None or request.status != "open":
            raise ValueError("Unknown or closed elicitation request")
        run = self.store.get_run(request.run_id)
        if run is None or run.status != RunStatus.WAITING_USER:
            raise ValueError("Run is not waiting for this input")
        request.status = "answered"; request.answer = dict(answer); self.store.save_elicitation(request)
        run.status = RunStatus.RUNNING; run.waiting_reason = None; self.store.save_run(run)
        self._emit(run.session_id, EventType.INPUT_RECEIVED, run_id=run.run_id,
                   payload={"request_id": request_id, "answer": answer})
        return request

    async def answer_input_and_continue(self, *, request_id: str, answer: dict[str, Any],
                                        approve: bool = False) -> dict[str, Any]:
        request = self.answer_input(request_id=request_id, answer=answer)
        run = self.store.get_run(request.run_id)
        if run is None:
            raise ValueError("Run for elicitation no longer exists")
        prompt = str(request.metadata.get("prompt") or run.goal)
        suffix = " ".join(f"{key} {value}" for key, value in answer.items())
        resumed = await self.handle_prompt(session_id=run.session_id, text=f"{prompt} {suffix}".strip(),
                                           approve=approve, mode=str(request.metadata.get("mode", "supervised")),
                                           run_id=run.run_id)
        resumed["resumed_request_id"] = request.request_id
        return resumed

    def list_runs(self, *, session_id: str | None = None) -> list[AgentRun]:
        if hasattr(self.store, "list_runs"):
            return self.store.list_runs(session_id=session_id)
        return []

    def list_sessions(self, *, document_id: str | None = None) -> list[AgentSession]:
        return self.store.list_sessions(document_id=document_id)

    def metrics_snapshot(self) -> dict[str, object]:
        return dict(self.metrics.snapshot())

    async def approve(self, run_id: str, *, approval_override: bool = False) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if run is None or not run.pending_action_id:
            raise ValueError("Run has no pending action")
        action = self.store.get_action(run.pending_action_id)
        approval = self.store.get_approval_for_run(run_id)
        if action is None or approval is None:
            raise ValueError("Pending action or approval record is missing")
        try:
            self._acquire_write_lease(session_id=run.session_id, run_id=run.run_id)
        except RuntimeError as exc:
            run.status = RunStatus.PAUSED; run.last_error = {"code": "LEASE_UNAVAILABLE", "reason": str(exc)}
            self.store.save_run(run)
            return {"status": "failed", "run": run.model_dump(mode="json")}
        if not approval_override and approval.expires_at <= utc_now():
            raise ValueError("Approval request has expired")
        if approval.action_hash != action.action_hash:
            raise ValueError("Approval hash does not match action")
        if action.arguments_hash and canonical_hash(action.arguments) != action.arguments_hash:
            raise ValueError("Action arguments changed after approval was created")
        current = await self.geometry.summary(run.document_id)
        if approval.expected_revision is not None and _revision(current) != approval.expected_revision:
            raise ValueError("Approval is invalid because the document revision changed")
        approval.decision = "approve"; approval.decided_at = utc_now(); action.status = ActionStatus.APPROVED
        self.store.save_approval(approval); self.store.save_action(action)
        run.status = RunStatus.RUNNING; run.waiting_reason = None; self.store.save_run(run)
        self._emit(run.session_id, EventType.APPROVAL_DECIDED, run_id=run_id, payload={"decision": "approve"})
        self._emit(run.session_id, EventType.RUN_STARTED, run_id=run_id, payload={"action_id": action.action_id})
        return await self._execute_and_verify(run, action)

    async def _execute_and_verify(self, run: AgentRun, action: ActionEnvelope) -> dict[str, Any]:
        action.status = ActionStatus.RUNNING; self.store.save_action(action)
        self._emit(run.session_id, EventType.ACTION_STARTED, run_id=run.run_id, payload={"action_id": action.action_id})
        current = await self.geometry.summary(run.document_id)
        current_revision = _revision(current)
        if action.expected_revision is not None and current_revision != action.expected_revision:
            return await self._fail(run, action, "REVISION_CONFLICT", ErrorClass.REVISION_CONFLICT,
                                    {"expected": action.expected_revision, "actual": current_revision})
        cached = self.store.get_idempotency(action.idempotency_key)
        if cached is not None:
            from ..domain.models import Observation
            observation = Observation.model_validate(cached)
        else:
            started = perf_counter()
            with span("cad.execute", attributes={"tool.name": action.tool_name, "document.id": action.document_id,
                                                   "run.id": action.run_id}):
                observation = await self.geometry.execute(action)
            self.metrics.observe("tool.duration_ms", (perf_counter() - started) * 1000)
            self.metrics.inc("tool.success" if observation.success else "tool.failure")
            self.store.save_idempotency(action.idempotency_key, observation.model_dump(mode="json"))
        self._emit(run.session_id, EventType.OBSERVATION_RECORDED, run_id=run.run_id,
                   payload=observation.model_dump(mode="json"))
        if not observation.success:
            if observation.error_class == ErrorClass.TOOL_OUTCOME_UNKNOWN or observation.error_code in {"GATEWAY_OUTCOME_UNKNOWN", "GATEWAY_TRANSPORT_UNKNOWN"}:
                run.status = RunStatus.PAUSED
                run.last_error = {"code": observation.error_code or "GATEWAY_OUTCOME_UNKNOWN",
                                  "class": ErrorClass.TOOL_OUTCOME_UNKNOWN.value, "details": observation.result}
                self.store.save_run(run)
                self._emit(run.session_id, EventType.RUN_PAUSED, run_id=run.run_id, payload=run.last_error)
                return {"status": "outcome_unknown", "run": run.model_dump(mode="json"),
                        "observation": observation.model_dump(mode="json")}
            return await self._fail(run, action, observation.error_code or "EXECUTION_FAILED",
                                    observation.error_class or ErrorClass.NON_RECOVERABLE, observation.result)
        action.status = ActionStatus.SUCCEEDED; self.store.save_action(action)
        self._emit(run.session_id, EventType.ACTION_SUCCEEDED, run_id=run.run_id,
                   payload={"action_id": action.action_id, "after_revision": observation.after_revision})
        body_id = _body_id(observation.result)
        criteria = action.success_criteria[0] if action.success_criteria else {}
        measurement = await self.geometry.measure(run.document_id, body_id) if body_id else {}
        after_summary = await self.geometry.summary(run.document_id)
        if criteria.get("type") == "operation_ack":
            verification = verify_operation_ack(action_id=action.action_id, payload=_unwrap(observation.result))
        elif criteria.get("type") == "relation":
            verification = verify_relation(action_id=action.action_id, payload=_unwrap(observation.result),
                                            expected_relation=criteria.get("expectedRelation"),
                                            expected_distance=criteria.get("expectedDistance"),
                                            tolerance=float(criteria.get("tolerance", 1.0e-6)))
        elif body_id and criteria.get("type") == "translation":
            verification = verify_translation(action_id=action.action_id, before=criteria.get("before", {}),
                                              after=_unwrap(measurement), delta=criteria.get("delta", []))
        elif body_id and criteria.get("type") == "cylinder_geometry":
            verification = verify_cylinder(action_id=action.action_id, measurement=_unwrap(measurement),
                                           radius=float(criteria.get("radius", 0)),
                                           height=float(criteria.get("height", 0)),
                                           x=float(criteria.get("x", 0)), y=float(criteria.get("y", 0)),
                                           z=float(criteria.get("z", 0)))
        elif body_id and criteria.get("type") == "sphere_geometry":
            verification = verify_sphere(action_id=action.action_id, measurement=_unwrap(measurement),
                                         radius=float(criteria["radius"]), x=float(criteria.get("x", 0)),
                                         y=float(criteria.get("y", 0)), z=float(criteria.get("z", 0)))
        elif body_id and criteria.get("type") == "cone_geometry":
            verification = verify_cone(action_id=action.action_id, measurement=_unwrap(measurement),
                                       radius1=float(criteria["radius1"]), radius2=float(criteria["radius2"]),
                                       height=float(criteria["height"]), x=float(criteria.get("x", 0)),
                                       y=float(criteria.get("y", 0)), z=float(criteria.get("z", 0)))
        elif body_id and criteria.get("type") == "torus_geometry":
            verification = verify_torus(action_id=action.action_id, measurement=_unwrap(measurement),
                                        major_radius=float(criteria["majorRadius"]),
                                        minor_radius=float(criteria["minorRadius"]),
                                        x=float(criteria.get("x", 0)), y=float(criteria.get("y", 0)),
                                        z=float(criteria.get("z", 0)))
        elif body_id and criteria.get("type") == "shape_valid":
            verification = verify_shape(action_id=action.action_id,
                                        check_payload=_unwrap(await self.geometry.check(run.document_id, body_id)))
        else:
            verification = verify_box(action_id=action.action_id, measurement=_unwrap(measurement),
                                      expected_min=criteria.get("min", []), expected_max=criteria.get("max", []),
                                      expected_volume=float(criteria.get("volume", 0))) if body_id else None
        if verification is None or not verification.passed:
            payload = verification.model_dump(mode="json") if verification else {"code": "ENTITY_NOT_FOUND"}
            return await self._fail(run, action, "VERIFICATION_FAILED", ErrorClass.VERIFICATION_FAILED, payload)
        run.status = RunStatus.COMPLETED; run.pending_action_id = None; run.last_error = None
        run.document_revision = observation.after_revision
        self.store.save_run(run)
        self._release_write_lease(run)
        self._emit(run.session_id, EventType.VERIFICATION_PASSED, run_id=run.run_id, payload=verification.model_dump(mode="json"))
        self._emit(run.session_id, EventType.RUN_COMPLETED, run_id=run.run_id, payload={"body_id": body_id})
        from ..verification.document import document_diff
        diff = document_diff(current, after_summary)
        return {"status": "completed", "run": run.model_dump(mode="json"), "observation": observation.model_dump(mode="json"),
                "measurement": measurement, "verification": verification.model_dump(mode="json"), "document_diff": diff, "body_id": body_id}

    async def _fail(self, run: AgentRun, action: ActionEnvelope, code: str, error_class: ErrorClass,
                    details: dict[str, Any]) -> dict[str, Any]:
        action.status = ActionStatus.FAILED; self.store.save_action(action)
        run.status = RunStatus.FAILED; run.last_error = {"code": code, "class": error_class.value, "details": details}
        self.store.save_run(run)
        self._release_write_lease(run)
        self._emit(run.session_id, EventType.ACTION_FAILED, run_id=run.run_id, payload=run.last_error)
        self._emit(run.session_id, EventType.RUN_FAILED, run_id=run.run_id, payload=run.last_error)
        return {"status": "failed", "run": run.model_dump(mode="json"), "error": run.last_error}

    async def summary(self, session_id: str) -> dict[str, Any]:
        session = await self.open_session(session_id)
        return await self.geometry.summary(session.document_id)

    async def view(self, *, session_id: str, offset: int = 0, limit: int = 50) -> dict[str, Any]:
        session = await self.open_session(session_id)
        return await self.geometry.view(session.document_id, offset=offset, limit=limit)

    async def properties(self, session_id: str) -> dict[str, Any]:
        session = await self.open_session(session_id)
        return await self.geometry.property_list(session.document_id)

    async def spatial(self, *, session_id: str, kind: str = "geometry-tree",
                      body_id: str | None = None, feature_id: str | None = None) -> dict[str, Any]:
        session = await self.open_session(session_id)
        if not hasattr(self.geometry, "model_query"):
            return {"status": "unsupported", "reason": "Gateway does not expose /api/agent/model/query"}
        result = await self.geometry.model_query(session.document_id, kind=kind, body_id=body_id, feature_id=feature_id)
        return {"status": "completed", "document_id": session.document_id,
                "revision": session.last_document_revision, "query": result.get("query", result)}

    async def measure(self, *, session_id: str, reference: str) -> dict[str, Any]:
        session = await self.open_session(session_id)
        summary = await self.geometry.summary(session.document_id)
        resolved = self.resolver.resolve(reference, summary=_unwrap(summary), revision=_revision(summary))
        if resolved.status != "resolved":
            return {"status": "needs_clarification" if resolved.status == "ambiguous" else "missing",
                    "resolution": {"status": resolved.status, "candidates": resolved.candidates, "reason": resolved.reason}}
        measurement = await self.geometry.measure(session.document_id, resolved.entity.entity_id)
        return {"status": "completed", "document_id": session.document_id,
                "revision": session.last_document_revision, "entity": resolved.entity.model_dump(mode="json"),
                "measurement": measurement}

    async def relation(self, *, session_id: str, body_a: str, body_b: str,
                       tolerance: float = 1.0e-6) -> dict[str, Any]:
        session = await self.open_session(session_id)
        if not hasattr(self.geometry, "relation"):
            return {"status": "unsupported", "reason": "Gateway does not expose geometry.relation"}
        result = await self.geometry.relation(session.document_id, body_a, body_b, tolerance)
        payload = _unwrap(result)
        verification = verify_relation(action_id=f"read-relation-{body_a}-{body_b}", payload=payload,
                                        tolerance=tolerance)
        return {"status": "completed" if verification.passed else "failed",
                "document_id": session.document_id, "revision": session.last_document_revision,
                "relation": payload, "verification": verification.model_dump(mode="json")}

    async def recover_session(self, session_id: str) -> dict[str, Any]:
        session = await self.open_session(session_id)
        gateway_available = True
        try:
            await self.geometry.summary(session.document_id)
        except Exception:
            gateway_available = False
        run = self.store.get_run(session.active_run_id) if session.active_run_id else None
        if run and run.registry_version != self.registry.version and run.status not in {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}:
            run.status = RunStatus.PAUSED
            run.last_error = {"code": "REGISTRY_CHANGED", "expected": run.registry_version, "actual": self.registry.version}
            self.store.save_run(run)
            self._emit(session_id, EventType.RUN_PAUSED, run_id=run.run_id, payload=run.last_error)
        if run and run.status == RunStatus.WAITING_APPROVAL and gateway_available:
            try:
                self._acquire_write_lease(session_id=session_id, run_id=run.run_id)
            except RuntimeError as exc:
                run.status = RunStatus.PAUSED
                run.last_error = {"code": "LEASE_UNAVAILABLE", "reason": str(exc)}
                self.store.save_run(run)
                self._emit(session_id, EventType.RUN_PAUSED, run_id=run.run_id, payload=run.last_error)
            approval = self.store.get_approval_for_run(run.run_id)
            if approval and approval.expected_revision is not None and approval.expected_revision != session.last_document_revision:
                run.status = RunStatus.PAUSED
                run.last_error = {"code": "REVISION_CHANGED", "expected": approval.expected_revision,
                                  "actual": session.last_document_revision}
                self.store.save_run(run)
                self._emit(session_id, EventType.RUN_PAUSED, run_id=run.run_id, payload=run.last_error)
        return {"session": session.model_dump(mode="json"), "run": run.model_dump(mode="json") if run else None}

    def compact_session(self, session_id: str) -> dict[str, Any]:
        session = self.store.get_session(session_id)
        if session is None:
            raise ValueError(f"Unknown session: {session_id}")
        events = self.store.list_events(session_id=session_id)
        from ..domain.models import SessionMessage
        if hasattr(self.store, "list_messages"):
            messages = self.store.list_messages(session_id=session_id)
        else:
            messages = [SessionMessage.model_validate(item.payload["message"])
                        for item in events if isinstance(item.payload.get("message"), dict)]
        compacted = self.compactor.compact(messages, existing_summary=session.rolling_summary)
        critical_facts: list[str] = []
        if session.active_run_id:
            active_run = self.store.get_run(session.active_run_id)
            if active_run:
                critical_facts.append(f"active_run={active_run.run_id} status={active_run.status.value} goal={active_run.goal}")
                if active_run.waiting_reason: critical_facts.append(f"waiting_reason={active_run.waiting_reason}")
                approval = self.store.get_approval_for_run(active_run.run_id)
                if approval and approval.decision is None:
                    critical_facts.append(f"pending_approval={approval.approval_id} revision={approval.expected_revision}")
        session.rolling_summary = " | ".join(part for part in [compacted.summary, *critical_facts] if part)[:12000]
        session.updated_at = utc_now(); self.store.save_session(session)
        if hasattr(self.store, "save_compaction_checkpoint"):
            active_run = self.store.get_run(session.active_run_id) if session.active_run_id else None
            completed = []
            if hasattr(self.store, "list_runs"):
                for run in self.store.list_runs(session_id=session_id):
                    if run.status == RunStatus.COMPLETED:
                        completed.append({"run_id": run.run_id, "goal": run.goal, "revision": run.document_revision})
            checkpoint = CompactionCheckpoint(
                session_id=session_id,
                through_message_id=messages[len(compacted.removed_message_ids) - 1].message_id if compacted.removed_message_ids else None,
                rolling_summary=session.rolling_summary,
                confirmed_facts=[{"fact": fact} for fact in critical_facts],
                unresolved_questions=[{"reason": active_run.waiting_reason}] if active_run and active_run.waiting_reason else [],
                completed_run_summaries=completed[-20:],
                source_message_ids=[item.message_id for item in messages],
            )
            self.store.save_compaction_checkpoint(checkpoint)
        self._emit(session_id, EventType.CONTEXT_COMPACTED,
                   payload={"summary": compacted.summary, "kept_messages": len(compacted.recent),
                            "removed_message_ids": compacted.removed_message_ids})
        return {"summary": compacted.summary, "kept_messages": len(compacted.recent),
                "removed_message_ids": compacted.removed_message_ids}


def _revision(payload: dict[str, Any]) -> int | None:
    value = _unwrap(payload).get("revision")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
