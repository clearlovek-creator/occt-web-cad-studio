from __future__ import annotations

from copy import deepcopy
from threading import RLock
from typing import Any

from modeling_agent.domain.models import (
    ActionRequest,
    AgentEvent,
    AgentRun,
    ConfigSnapshot,
    ApprovalRequest,
    ElicitationRequest,
    EventType,
    RunStatus,
    new_id,
    utc_now,
)
from modeling_agent.domain.state_machine import assert_transition


class InMemoryRepository:
    """Local/test repository; its interface is intentionally replaceable by SQLAlchemy."""

    def __init__(self) -> None:
        self._lock = RLock()
        self.runs: dict[str, AgentRun] = {}
        self.goals: dict[tuple[str, int], dict[str, Any]] = {}
        self.actions: dict[str, ActionRequest] = {}
        self.approvals: dict[str, ApprovalRequest] = {}
        self.questions: dict[str, ElicitationRequest] = {}
        self.events: dict[str, list[AgentEvent]] = {}
        self.idempotency: dict[str, dict[str, Any]] = {}
        self.config_snapshots: dict[str, ConfigSnapshot] = {}

    def create_run(self, run: AgentRun) -> AgentRun:
        with self._lock:
            if run.id in self.runs:
                raise ValueError(f"Run already exists: {run.id}")
            self.runs[run.id] = deepcopy(run)
            self.events[run.id] = []
            self.append_event(run.id, EventType.RUN_CREATED, {"status": run.status.value})
            return deepcopy(run)

    def list_runs(
        self,
        *,
        project_id: str | None = None,
        user_id: str | None = None,
        active_only: bool = False,
    ) -> list[AgentRun]:
        with self._lock:
            terminal = {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}
            values = []
            for run in self.runs.values():
                if project_id is not None and run.project_id != project_id:
                    continue
                if user_id is not None and run.user_id != user_id:
                    continue
                if active_only and run.status in terminal:
                    continue
                values.append(deepcopy(run))
            return sorted(values, key=lambda item: item.updated_at, reverse=True)

    def get_run(self, run_id: str) -> AgentRun:
        with self._lock:
            try:
                return deepcopy(self.runs[run_id])
            except KeyError as exc:
                raise KeyError(f"Run not found: {run_id}") from exc

    def update_run(self, run: AgentRun) -> AgentRun:
        with self._lock:
            if run.id not in self.runs:
                raise KeyError(run.id)
            run.updated_at = utc_now()
            run.run_version += 1
            self.runs[run.id] = deepcopy(run)
            return deepcopy(run)

    def transition(self, run_id: str, target: RunStatus) -> AgentRun:
        with self._lock:
            run = self.get_run(run_id)
            assert_transition(run.status, target)
            run.status = target
            return self.update_run(run)

    def append_event(
        self,
        run_id: str,
        event_type: EventType,
        payload: dict[str, Any],
        *,
        actor: str = "system",
        correlation_id: str | None = None,
    ) -> AgentEvent:
        with self._lock:
            stream = self.events.setdefault(run_id, [])
            event = AgentEvent(
                event_id=new_id("evt"),
                run_id=run_id,
                sequence_number=len(stream) + 1,
                event_type=event_type,
                actor=actor,
                correlation_id=correlation_id or run_id,
                causation_id=stream[-1].event_id if stream else None,
                payload=deepcopy(payload),
            )
            stream.append(event)
            return deepcopy(event)

    def list_events(self, run_id: str) -> list[AgentEvent]:
        with self._lock:
            return deepcopy(self.events.get(run_id, []))

    def save_config_snapshot(self, snapshot: ConfigSnapshot) -> ConfigSnapshot:
        with self._lock:
            if snapshot.snapshot_id in self.config_snapshots:
                return deepcopy(self.config_snapshots[snapshot.snapshot_id])
            self.config_snapshots[snapshot.snapshot_id] = deepcopy(snapshot)
            return deepcopy(snapshot)

    def get_config_snapshot(self, snapshot_id: str) -> ConfigSnapshot:
        with self._lock:
            try:
                return deepcopy(self.config_snapshots[snapshot_id])
            except KeyError as exc:
                raise KeyError(f"Config snapshot not found: {snapshot_id}") from exc

    def save_goal(self, run_id: str, version: int, goal: dict[str, Any]) -> None:
        with self._lock:
            self.goals[(run_id, version)] = deepcopy(goal)

    def get_goal(self, run_id: str, version: int) -> dict[str, Any] | None:
        with self._lock:
            return deepcopy(self.goals.get((run_id, version)))

    def save_action(self, action: ActionRequest) -> ActionRequest:
        with self._lock:
            self.actions[action.action_id] = deepcopy(action)
            return deepcopy(action)

    def list_actions(self, run_id: str) -> list[ActionRequest]:
        with self._lock:
            return [deepcopy(item) for item in self.actions.values() if item.run_id == run_id]

    def get_action(self, action_id: str) -> ActionRequest:
        with self._lock:
            return deepcopy(self.actions[action_id])

    def save_approval(self, approval: ApprovalRequest) -> ApprovalRequest:
        with self._lock:
            self.approvals[approval.approval_id] = deepcopy(approval)
            return deepcopy(approval)

    def list_approvals(self, run_id: str) -> list[ApprovalRequest]:
        with self._lock:
            return [deepcopy(item) for item in self.approvals.values() if item.run_id == run_id]

    def get_approval(self, approval_id: str) -> ApprovalRequest:
        with self._lock:
            return deepcopy(self.approvals[approval_id])

    def save_question(self, question: ElicitationRequest) -> ElicitationRequest:
        with self._lock:
            self.questions[question.request_id] = deepcopy(question)
            return deepcopy(question)

    def get_question(self, request_id: str) -> ElicitationRequest:
        with self._lock:
            return deepcopy(self.questions[request_id])

    def save_idempotent(self, key: str, value: dict[str, Any]) -> None:
        with self._lock:
            self.idempotency[key] = deepcopy(value)

    def get_idempotent(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            return deepcopy(self.idempotency.get(key))
