from __future__ import annotations

import json
import os
import time
from contextlib import asynccontextmanager
from typing import Any
from sqlalchemy.exc import IntegrityError

from modeling_agent.adapters.persistence.json_repository import JsonRepository
from modeling_agent.adapters.persistence.sqlalchemy_repository import SqlAlchemyRepository
from modeling_agent.adapters.http_geometry import HttpGeometryAdapter
from modeling_agent.adapters.llm import OpenAICompatibleModel
from modeling_agent.domain.models import AntennaGoal, EventType, InputRoute, RunStatus
from modeling_agent.workflows.router import InputRouter
from modeling_agent.modeling.templates import ModelingTemplateRegistry
from modeling_agent.workflows.engine import LangGraphWorkflowEngine
from modeling_agent.workflows.local import LocalWorkflowEngine
from modeling_agent.workflows.protocol import WorkflowEngine
from modeling_agent.api.schemas import (
    ApprovalDecisionRequest,
    CreateRunRequest,
    ModelingPlanRequest,
    ParameterChangeRequest,
    ResponseRequest,
    RouteRequest,
    VersionRequest,
)

try:
    from fastapi import FastAPI, HTTPException, Header
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import StreamingResponse
except ImportError:  # pragma: no cover - exercised only in the offline base image
    FastAPI = None  # type: ignore[assignment]
    HTTPException = RuntimeError  # type: ignore[assignment,misc]
    StreamingResponse = None  # type: ignore[assignment]
    Header = None  # type: ignore[assignment]
    CORSMiddleware = None  # type: ignore[assignment]


def create_app(
    engine: WorkflowEngine | None = None,
    data_path: str | None = None,
    gateway_url: str | None = None,
    workflow_mode: str = "local",
    checkpoint_path: str | None = None,
    database_url: str | None = None,
    llm_base_url: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
) -> Any:
    if FastAPI is None:
        raise RuntimeError("FastAPI is not installed; install the project dependencies first.")
    repository = (
        SqlAlchemyRepository(database_url)
        if database_url
        else (JsonRepository(data_path) if data_path else None)
    )
    geometry = HttpGeometryAdapter(gateway_url) if gateway_url else None
    llm = (
        OpenAICompatibleModel(llm_base_url, api_key=llm_api_key, model=llm_model or "")
        if llm_base_url and llm_model
        else None
    )
    if engine is not None:
        service = engine
    elif workflow_mode == "langgraph":
        if repository is None:
            repository = JsonRepository(data_path or ".data/agent-state.json")
        service = LangGraphWorkflowEngine(
            repository=repository,
            geometry=geometry or __import__("modeling_agent.adapters.geometry", fromlist=["FakeGeometryAdapter"]).FakeGeometryAdapter(),
            checkpoint_path=checkpoint_path or ".data/langgraph-checkpoints.bin",
            checkpoint_database_url=database_url,
            theory_model=llm,
            planner_model=llm,
        )
    else:
        service = LocalWorkflowEngine(repository=repository, geometry=geometry)
    @asynccontextmanager
    async def lifespan(_: Any):
        try:
            yield
        finally:
            if geometry is not None:
                geometry.close()
            if llm is not None:
                llm.close()
            close_service = getattr(service, "close", None)
            if close_service is not None:
                close_service()
            close_repository = getattr(getattr(service, "repository", None), "close", None)
            if close_repository is not None:
                close_repository()

    app = FastAPI(title="Modeling Agent", version="0.1.0", lifespan=lifespan)
    if CORSMiddleware is not None:
        origins = [item.strip() for item in os.getenv("MODEL_AGENT_WEB_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if item.strip()]
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Accept", "Content-Type", "Last-Event-ID", "X-Request-Id"],
        )

    def _status_payload(run_id: str) -> dict[str, Any]:
        getter = getattr(service, "get_status", service.repository.get_run)
        run = getter(run_id)
        payload = run.model_dump(mode="json")
        payload["run_id"] = run.id
        try:
            snapshot = service.repository.get_config_snapshot(run.config_snapshot_id)
        except KeyError:
            if run.id.startswith("py-run-"):
                raise HTTPException(status_code=503, detail="Original client creation binding is unavailable; do not create again.")
        else:
            if "client_creation" in snapshot.settings:
                payload["client_creation"] = snapshot.settings["client_creation"]
        # Older runs were persisted by a workflow version that normalized all
        # failures to ``verification``.  Keep those sessions truthful when
        # reopened: planner failures happened before any action was proposed.
        display_stage = run.current_stage.value
        error_code = str((run.last_error or {}).get("code", ""))
        if run.status == RunStatus.FAILED and display_stage == "verification":
            if error_code.startswith("PLANNER_"):
                display_stage = "planning"
            elif error_code.startswith("THEORY_"):
                display_stage = "theory"
            elif error_code == "POLICY_DENIED":
                display_stage = "policy"
        payload["current_stage"] = display_stage
        actions = service.repository.list_actions(run_id)
        payload["actions"] = [action.model_dump(mode="json") for action in actions]
        completed_actions = sum(1 for action in actions if action.status.value == "succeeded")
        pending_action = next(
            (action for action in reversed(actions) if action.status.value in {"proposed", "approval_pending", "approved", "running"}),
            None,
        )
        payload["pending_action"] = pending_action.model_dump(mode="json") if pending_action is not None else None
        stage_order = [
            "intake", "requirements", "theory", "planning", "policy",
            "execution", "observation", "verification", "completion",
        ]
        stage_index = stage_order.index(display_stage) if display_stage in stage_order else 0
        total_steps = max(len(actions), 1)
        payload["progress"] = {
            "stage_index": stage_index,
            "stage_count": len(stage_order),
            "stage_percent": round((stage_index + 1) * 100 / len(stage_order), 1),
            "completed_actions": completed_actions,
            "total_actions": len(actions),
            "action_percent": round(completed_actions * 100 / total_steps, 1) if actions else 0.0,
        }
        payload["pending_input"] = None
        if run.waiting_request_id:
            try:
                payload["pending_input"] = service.repository.get_question(run.waiting_request_id).model_dump(mode="json")
            except KeyError:
                payload["pending_input"] = {"request_id": run.waiting_request_id}
        payload["pending_approval"] = None
        if run.waiting_approval_id:
            try:
                payload["pending_approval"] = service.repository.get_approval(run.waiting_approval_id).model_dump(mode="json")
            except KeyError:
                payload["pending_approval"] = {"approval_id": run.waiting_approval_id}
        events = service.repository.list_events(run_id)
        latest_observation = next(
            (event.payload for event in reversed(events) if event.event_type == EventType.OBSERVATION_RECORDED),
            None,
        )
        payload["latest_observation"] = latest_observation
        payload["artifact_refs"] = list((latest_observation or {}).get("artifact_refs") or [])
        payload["last_event_sequence"] = events[-1].sequence_number if events else 0
        payload["events_url"] = f"/api/v1/agent/runs/{run_id}/events"
        return payload

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/v1/agent/modeling/plan")
    def preview_modeling_plan(payload: ModelingPlanRequest) -> dict[str, Any]:
        try:
            template_id = payload.template_id
            goal = AntennaGoal.model_validate(payload.goal)
            plan = ModelingTemplateRegistry().get(template_id).build(
                run_id=payload.run_id,
                goal_version=payload.goal_version,
                goal=goal,
                document_id=payload.document_id,
            )
            return plan.model_dump(mode="json")
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/v1/agent/route")
    def route_input(payload: RouteRequest) -> dict[str, Any]:
        message = payload.message
        project_id = payload.project_id
        user_id = payload.user_id
        # Never search all active Runs when the caller has not supplied the
        # routing scope. A missing scope may start a new workflow decision, but
        # it cannot target an existing Run from another project or user.
        active_runs = (
            service.repository.list_runs(
                project_id=str(project_id),
                user_id=str(user_id),
                active_only=True,
            )
            if project_id is not None and user_id is not None
            else []
        )
        decision = InputRouter().route(message, active_runs)
        if (project_id is None or user_id is None) and decision.route != InputRoute.START_WORKFLOW:
            decision.reason_codes.append("routing_scope_required")
        if decision.target_run_id is not None:
            service.repository.append_event(
                decision.target_run_id,
                EventType.ROUTING_DECIDED,
                decision.model_dump(mode="json"),
                actor="input-router",
            )
        return decision.model_dump(mode="json")

    @app.post("/api/v1/agent/runs")
    def create_run(payload: CreateRunRequest) -> dict[str, Any]:
        creation = payload.model_dump(mode="json") if payload.client_run_id else None
        if payload.client_run_id:
            try:
                service.repository.get_run(payload.client_run_id)
            except KeyError:
                pass
            else:
                raise HTTPException(status_code=409, detail="This client Run ID is already bound; read the original Run, never submit creation again.")
        try:
            run = service.create_run(
                project_id=payload.project_id,
                document_id=payload.document_id,
                user_id=payload.user_id,
                message=payload.message,
                template_id=payload.template_id,
                autonomy_level=payload.autonomy_level,
                **({"client_creation": creation} if creation else {}),
            )
        except (ValueError, IntegrityError) as exc:
            # A concurrent duplicate can pass the earlier lookup; the existing
            # repository's unique Run key is the final no-reexecution boundary.
            duplicate = isinstance(exc, IntegrityError) or str(exc) == f"Run already exists: {payload.client_run_id}"
            if payload.client_run_id and duplicate:
                try:
                    service.repository.get_run(payload.client_run_id)
                except KeyError:
                    raise exc
                raise HTTPException(status_code=409, detail="This client Run ID is already bound; read the original Run.") from exc
            raise
        return _status_payload(run.id)

    @app.get("/api/v1/agent/runs/{run_id}")
    def get_run(run_id: str, project_id: str | None = None,
                document_id: str | None = None, user_id: str | None = None) -> dict[str, Any]:
        try:
            run = service.repository.get_run(run_id)
            if any(expected is not None and expected != actual for expected, actual in (
                (project_id, run.project_id), (document_id, run.document_id), (user_id, run.user_id),
            )):
                raise HTTPException(status_code=409, detail="The Run belongs to another project, document or user; no workflow was continued.")
            return _status_payload(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/v1/agent/runs/{run_id}/events")
    def events(
        run_id: str,
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
        follow: bool = False,
        wait_seconds: float = 30.0,
    ) -> Any:
        try:
            service.repository.get_run(run_id)
            cursor = int(last_event_id or 0)
            wait_seconds = max(0.1, min(float(wait_seconds), 300.0))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Last-Event-ID must be an integer sequence number") from exc
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        def stream():
            nonlocal cursor
            deadline = time.monotonic() + wait_seconds
            first_pass = True
            while first_pass or follow:
                first_pass = False
                items = [
                    event.model_dump(mode="json")
                    for event in service.repository.list_events(run_id)
                    if event.sequence_number > cursor
                ]
                for item in items:
                    cursor = int(item["sequence_number"])
                    yield f"id: {cursor}\nevent: {item['event_type']}\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
                if not follow:
                    break
                current = service.repository.get_run(run_id)
                if current.status in {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED} and not items:
                    break
                if time.monotonic() >= deadline:
                    yield ": stream-timeout\n\n"
                    break
                if not items:
                    # Polling keeps this adapter usable with both memory and SQL
                    # repositories, including separate API worker processes.
                    time.sleep(0.1)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.post("/api/v1/agent/runs/{run_id}/responses")
    def respond(run_id: str, payload: ResponseRequest) -> dict[str, Any]:
        try:
            result = service.respond(
                run_id,
                payload.request_id,
                payload.response,
                expected_run_version=payload.expected_run_version,
            )
            return result.model_dump(mode="json")
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/v1/agent/runs/{run_id}/approvals/{approval_id}/decision")
    def decide(run_id: str, approval_id: str, payload: ApprovalDecisionRequest) -> dict[str, Any]:
        try:
            result = service.decide_approval(
                run_id,
                approval_id,
                payload.decision,
                expected_run_version=payload.expected_run_version,
            )
            return result.model_dump(mode="json")
        except (KeyError, ValueError, PermissionError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/v1/agent/runs/{run_id}/pause")
    def pause(run_id: str, payload: VersionRequest | None = None) -> dict[str, Any]:
        try:
            method = getattr(service, "pause", None)
            if method is None:
                raise ValueError("The selected workflow engine does not support pause")
            return method(
                run_id,
                expected_run_version=payload.expected_run_version if payload is not None else None,
            ).model_dump(mode="json")
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/v1/agent/runs/{run_id}/resume")
    def resume(run_id: str, payload: VersionRequest | None = None) -> dict[str, Any]:
        try:
            method = getattr(service, "resume", None)
            if method is None:
                raise ValueError("The selected workflow engine does not support resume")
            return method(
                run_id,
                expected_run_version=payload.expected_run_version if payload is not None else None,
            ).model_dump(mode="json")
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/v1/agent/runs/{run_id}/parameters")
    def change_parameters(run_id: str, payload: ParameterChangeRequest) -> dict[str, Any]:
        try:
            changes = payload.changes
            method = getattr(service, "change_parameters", None)
            if method is None:
                raise ValueError("The selected workflow engine does not support parameter changes")
            result = method(
                run_id,
                changes,
                expected_run_version=payload.expected_run_version,
            )
            return result.model_dump(mode="json")
        except (KeyError, ValueError, PermissionError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/v1/agent/runs/{run_id}/cancel")
    def cancel(run_id: str, payload: VersionRequest | None = None) -> dict[str, Any]:
        try:
            return service.cancel(
                run_id,
                expected_run_version=payload.expected_run_version if payload is not None else None,
            ).model_dump(mode="json")
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return app
