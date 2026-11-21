from __future__ import annotations

from pathlib import Path
from threading import RLock
from typing import Any

from langgraph.types import Command

from modeling_agent.adapters.persistence.json_checkpoint import JsonCheckpointSaver
from modeling_agent.adapters.persistence.sqlalchemy_checkpoint import SqlAlchemyCheckpointSaver
from modeling_agent.context.engine import ContextBudgetExceeded
from modeling_agent.agents.react import ModelPort, ReActBudget
from modeling_agent.application.store import InMemoryRepository
from modeling_agent.domain.models import (
    AgentRun,
    ConfigSnapshot,
    ApprovalDecision,
    ElicitationRequest,
    EventType,
    RunStatus,
    Stage,
    new_id,
)
from modeling_agent.workflows.langgraph_adapter import LangGraphRuntime, build_langgraph
from modeling_agent.modeling.parameters import validate_box_parameter_changes


class LangGraphWorkflowEngine:
    """Application facade that exposes the graph through the Run API contract."""

    def __init__(
        self,
        *,
        repository: InMemoryRepository,
        geometry: Any,
        checkpoint_path: str | Path | None = None,
        checkpoint_database_url: str | None = None,
        theory_model: ModelPort | None = None,
        planner_model: ModelPort | None = None,
        theory_budget: ReActBudget | None = None,
    ) -> None:
        self.repository = repository
        self.geometry = geometry
        self._cancelled: set[str] = set()
        self._cancel_lock = RLock()
        if checkpoint_database_url:
            checkpointer = SqlAlchemyCheckpointSaver(checkpoint_database_url)
        elif checkpoint_path:
            checkpointer = JsonCheckpointSaver(checkpoint_path)
        else:
            checkpointer = None
        self.checkpointer = checkpointer
        self.runtime = LangGraphRuntime.create(
            repository,
            geometry,
            theory_model=theory_model,
            planner_model=planner_model,
            theory_budget=theory_budget,
            cancel_checker=self._is_cancelled,
        )
        self.graph = build_langgraph(checkpointer, runtime=self.runtime)
        self.theory_model = theory_model

    def _is_cancelled(self, run_id: str) -> bool:
        with self._cancel_lock:
            if run_id in self._cancelled:
                return True
        try:
            return self.repository.get_run(run_id).status == RunStatus.CANCELLED
        except KeyError:
            return False

    def _config(self, run_id: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": run_id}}

    def _invoke(self, input_value: Any, *, config: dict[str, Any]) -> dict[str, Any]:
        try:
            return self.graph.invoke(input_value, config=config)
        except ContextBudgetExceeded as exc:
            run_id = str(config.get("configurable", {}).get("thread_id", ""))
            run = self.repository.get_run(run_id)
            error = {
                "code": "CONTEXT_BUDGET_EXCEEDED",
                "used_chars": exc.used_chars,
                "max_chars": exc.max_chars,
            }
            run.status = RunStatus.FAILED
            run.current_stage = Stage.VERIFICATION
            run.last_error = error
            run.waiting_request_id = None
            run.waiting_approval_id = None
            self.repository.update_run(run)
            self.repository.append_event(run_id, EventType.RUN_FAILED, error, actor="context-engine")
            return {"status": "failed", "current_stage": Stage.VERIFICATION.value, "error": error}

    def _sync_run(self, run_id: str, result: dict[str, Any]) -> AgentRun:
        run = self.repository.get_run(run_id)
        goal = result.get("structured_goal")
        if isinstance(goal, dict):
            previous_goal = self.repository.get_goal(run_id, run.goal_version)
            if previous_goal != goal:
                run.goal_version += 1
                self.repository.save_goal(run_id, run.goal_version, goal)
        result_stage = result.get("current_stage")
        if result_stage:
            try:
                run.current_stage = Stage(str(result_stage))
            except ValueError:
                run.last_error = {"code": "UNKNOWN_WORKFLOW_STAGE", "stage": str(result_stage)}
        if result.get("status") == "completed":
            run.status = RunStatus.COMPLETED
            run.current_stage = Stage.COMPLETION
            run.waiting_request_id = None
            run.waiting_approval_id = None
        elif result.get("status") == "cancelled":
            run.status = RunStatus.CANCELLED
            run.current_stage = Stage.COMPLETION
            run.waiting_request_id = None
            run.waiting_approval_id = None
        elif result.get("status") == "failed":
            run.status = RunStatus.FAILED
            # Keep the failing stage returned by the graph.  Falling back to
            # verification is only for legacy/custom graph implementations
            # that do not return a stage.
            failed_stage = result.get("current_stage")
            try:
                run.current_stage = Stage(str(failed_stage)) if failed_stage else Stage.VERIFICATION
            except ValueError:
                run.current_stage = Stage.VERIFICATION
            run.waiting_request_id = None
            run.waiting_approval_id = None
            run.last_error = result.get("error") or {"code": "WORKFLOW_FAILED"}
        elif result.get("__interrupt__"):
            interrupt = result["__interrupt__"][0]
            value = getattr(interrupt, "value", interrupt)
            if value.get("kind") == "elicitation":
                question = ElicitationRequest(
                    request_id=new_id("question"),
                    run_id=run_id,
                    reason_code=str(value.get("reason_code", "required_fields_missing")),
                    question=str(value.get("question", "Please provide the missing fields.")),
                    expected_schema={"fields": value.get("missing_fields", [])},
                )
                self.repository.save_question(question)
                run.waiting_request_id = question.request_id
                run.waiting_approval_id = None
                run.status = RunStatus.WAITING_USER
                run.current_stage = Stage.REQUIREMENTS
            elif value.get("kind") == "approval":
                run.waiting_approval_id = value.get("approval_id")
                run.waiting_request_id = None
                run.status = RunStatus.WAITING_APPROVAL
                run.current_stage = Stage.POLICY
        self.repository.update_run(run)
        return run

    def get_status(self, run_id: str) -> AgentRun:
        return self.repository.get_run(run_id)

    def create_run(
        self,
        *,
        project_id: str,
        document_id: str,
        user_id: str,
        message: str,
        template_id: str | None = None,
        autonomy_level: str = "supervised",
        client_creation: dict[str, Any] | None = None,
    ) -> AgentRun:
        registry_version = self.runtime.registry.version
        snapshot = ConfigSnapshot(
            snapshot_id=new_id("config"),
            graph_version="phase1-langgraph-1",
            tool_registry_version=registry_version,
            settings={"workflow_engine": "langgraph", "checkpoint_backend": type(self.checkpointer).__name__ if self.checkpointer is not None else "none", "autonomy_level": autonomy_level,
                      **({"client_creation": client_creation} if client_creation else {})},
        )
        self.repository.save_config_snapshot(snapshot)
        run = AgentRun(
            id=client_creation["client_run_id"] if client_creation else new_id("run"),
            project_id=project_id,
            document_id=document_id,
            user_id=user_id,
            config_snapshot_id=snapshot.snapshot_id,
            graph_version=snapshot.graph_version,
            document_revision=self.geometry.current_revision(document_id),
        )
        self.repository.create_run(run)
        self.repository.append_event(run.id, EventType.RUN_STARTED, {"message": message})
        result = self._invoke(
            {"run_id": run.id, "user_message": message, "structured_goal": {}, "template_id": template_id},
            config=self._config(run.id),
        )
        return self._sync_run(run.id, result)

    def respond(
        self, run_id: str, request_id: str, response: Any, *, expected_run_version: int | None = None
    ) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status != RunStatus.WAITING_USER or run.waiting_request_id != request_id:
            raise ValueError("The Run is not waiting for this request")
        self.repository.append_event(run_id, EventType.USER_INPUT_RECEIVED, {"response": response})
        result = self._invoke(Command(resume=response), config=self._config(run_id))
        return self._sync_run(run_id, result)

    def decide_approval(
        self,
        run_id: str,
        approval_id: str,
        decision: ApprovalDecision,
        *,
        expected_run_version: int | None = None,
    ) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status != RunStatus.WAITING_APPROVAL or run.waiting_approval_id != approval_id:
            raise ValueError("The Run is not waiting for this approval")
        result = self._invoke(Command(resume=decision.value), config=self._config(run_id))
        return self._sync_run(run_id, result)

    def change_parameters(
        self, run_id: str, changes: dict[str, Any], *, expected_run_version: int | None = None
    ) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status not in {RunStatus.COMPLETED, RunStatus.FAILED}:
            raise ValueError("Parameters can only be changed after the current run is terminal")
        normalized = validate_box_parameter_changes(changes)
        goal = self.repository.get_goal(run_id, run.goal_version) or {}
        run.status = RunStatus.RUNNING
        run.current_stage = Stage.PLANNING
        run.waiting_request_id = None
        run.waiting_approval_id = None
        self.repository.update_run(run)
        result = self._invoke(
            {
                "run_id": run_id,
                "structured_goal": goal,
                "parameter_overrides": normalized,
                "current_action_id": None,
                "pending_approval_id": None,
                "approval_decision": None,
                "last_observation": None,
                "last_verification": None,
                "status": "running",
            },
            config=self._config(run_id),
        )
        return self._sync_run(run_id, result)

    def cancel(self, run_id: str, *, expected_run_version: int | None = None) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        with self._cancel_lock:
            self._cancelled.add(run_id)
        run = self.repository.get_run(run_id)
        if run.status in {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}:
            return run
        run.status = RunStatus.CANCELLED
        run.current_stage = Stage.COMPLETION
        run.waiting_request_id = None
        run.waiting_approval_id = None
        run.paused_from_status = None
        self.repository.update_run(run)
        self.repository.append_event(run_id, EventType.RUN_CANCELLED, {})
        return run

    def pause(self, run_id: str, *, expected_run_version: int | None = None) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status == RunStatus.PAUSED:
            return run
        if run.status not in {RunStatus.WAITING_USER, RunStatus.WAITING_APPROVAL, RunStatus.WAITING_EXTERNAL}:
            raise ValueError("A Run can only pause at a safe waiting boundary")
        run.paused_from_status = run.status
        run.status = RunStatus.PAUSED
        self.repository.update_run(run)
        self.repository.append_event(run_id, EventType.RUN_PAUSED, {"from_status": run.paused_from_status.value})
        return run

    def resume(self, run_id: str, *, expected_run_version: int | None = None) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status != RunStatus.PAUSED:
            raise ValueError("A Run is not paused")
        previous = run.paused_from_status or RunStatus.WAITING_USER
        run.status = previous
        run.paused_from_status = None
        self.repository.update_run(run)
        self.repository.append_event(run_id, EventType.RUN_RESUMED, {"to_status": previous.value})
        return run

    @staticmethod
    def _assert_run_version(run: AgentRun, expected_run_version: int | None) -> None:
        if expected_run_version is not None and run.run_version != expected_run_version:
            raise ValueError(
                f"Run version conflict: expected {expected_run_version}, current {run.run_version}"
            )

    def close(self) -> None:
        close = getattr(self.checkpointer, "close", None)
        if close is not None:
            close()
