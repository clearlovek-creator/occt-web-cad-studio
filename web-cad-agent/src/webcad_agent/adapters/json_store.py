from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import RLock
from typing import Any, TypeVar

from pydantic import BaseModel

from ..domain.models import ActionEnvelope, AgentEvent, AgentPlan, AgentRun, AgentSession, ApprovalRequest, CompactionCheckpoint, ConfigSnapshot, ElicitationRequest, SessionMessage

T = TypeVar("T", bound=BaseModel)


class JsonStore:
    """Small durable store for the first standalone milestone.

    The data format is intentionally boring and inspectable. SQLAlchemy can replace
    this adapter later without changing domain/application services.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._data: dict[str, Any] = {
            "sessions": {}, "runs": {}, "events": [], "idempotency": {},
            "actions": {}, "approvals": {},
            "plans": {}, "compaction_checkpoints": {}, "elicitations": {},
            "messages": {},
            "config_snapshots": {},
        }
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if not isinstance(loaded, dict):
            raise ValueError("Agent state file must contain a JSON object")
        self._data.update(loaded)
        for key, default in {"sessions": {}, "runs": {}, "events": [], "idempotency": {}, "actions": {}, "approvals": {}, "plans": {}, "messages": {}, "compaction_checkpoints": {}, "elicitations": {}, "config_snapshots": {}}.items():
            self._data.setdefault(key, default)

    def _write(self) -> None:
        payload = json.dumps(self._data, ensure_ascii=False, indent=2, sort_keys=True)
        fd, temp_name = tempfile.mkstemp(prefix=self.path.name, suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    @staticmethod
    def _dump(value: BaseModel) -> dict[str, Any]:
        return value.model_dump(mode="json")

    def save_session(self, session: AgentSession) -> None:
        with self._lock:
            self._data["sessions"][session.session_id] = self._dump(session)
            self._write()

    def get_session(self, session_id: str) -> AgentSession | None:
        with self._lock:
            raw = self._data["sessions"].get(session_id)
            return AgentSession.model_validate(raw) if raw else None

    def list_sessions(self, *, document_id: str | None = None) -> list[AgentSession]:
        with self._lock:
            sessions = [AgentSession.model_validate(item) for item in self._data["sessions"].values()]
        if document_id:
            sessions = [item for item in sessions if item.document_id == document_id]
        return sorted(sessions, key=lambda item: item.updated_at, reverse=True)

    def save_run(self, run: AgentRun) -> None:
        with self._lock:
            self._data["runs"][run.run_id] = self._dump(run)
            self._write()

    def save_message(self, message: SessionMessage) -> None:
        with self._lock:
            self._data["messages"][message.message_id] = self._dump(message)
            self._write()

    def list_messages(self, *, session_id: str) -> list[SessionMessage]:
        with self._lock:
            values = [SessionMessage.model_validate(item) for item in self._data["messages"].values() if item.get("session_id") == session_id]
        return sorted(values, key=lambda item: item.created_at)

    def get_run(self, run_id: str) -> AgentRun | None:
        with self._lock:
            raw = self._data["runs"].get(run_id)
            return AgentRun.model_validate(raw) if raw else None

    def list_runs(self, *, session_id: str | None = None) -> list[AgentRun]:
        with self._lock:
            values = [AgentRun.model_validate(item) for item in self._data["runs"].values()]
        if session_id:
            values = [item for item in values if item.session_id == session_id]
        return sorted(values, key=lambda item: item.updated_at, reverse=True)

    def save_config_snapshot(self, value: ConfigSnapshot) -> None:
        with self._lock:
            self._data["config_snapshots"][value.snapshot_id] = self._dump(value)
            self._write()

    def get_config_snapshot(self, snapshot_id: str) -> ConfigSnapshot | None:
        with self._lock:
            raw = self._data["config_snapshots"].get(snapshot_id)
            return ConfigSnapshot.model_validate(raw) if raw else None

    def save_plan(self, plan: AgentPlan) -> None:
        with self._lock:
            self._data["plans"][plan.plan_id] = self._dump(plan)
            self._write()

    def get_plan(self, plan_id: str) -> AgentPlan | None:
        with self._lock:
            raw = self._data["plans"].get(plan_id)
            return AgentPlan.model_validate(raw) if raw else None

    def save_compaction_checkpoint(self, checkpoint: CompactionCheckpoint) -> None:
        with self._lock:
            self._data["compaction_checkpoints"][checkpoint.checkpoint_id] = self._dump(checkpoint)
            self._write()

    def list_compaction_checkpoints(self, *, session_id: str) -> list[CompactionCheckpoint]:
        with self._lock:
            values = [CompactionCheckpoint.model_validate(item) for item in self._data["compaction_checkpoints"].values()
                      if item.get("session_id") == session_id]
        return sorted(values, key=lambda item: item.created_at)

    def save_elicitation(self, value: ElicitationRequest) -> None:
        with self._lock:
            self._data["elicitations"][value.request_id] = self._dump(value)
            self._write()
    def get_elicitation(self, value: str) -> ElicitationRequest | None:
        with self._lock:
            raw = self._data["elicitations"].get(value)
            return ElicitationRequest.model_validate(raw) if raw else None

    def save_action(self, action: ActionEnvelope) -> None:
        with self._lock:
            self._data["actions"][action.action_id] = self._dump(action)
            self._write()

    def get_action(self, action_id: str) -> ActionEnvelope | None:
        with self._lock:
            raw = self._data["actions"].get(action_id)
            return ActionEnvelope.model_validate(raw) if raw else None

    def save_approval(self, approval: ApprovalRequest) -> None:
        with self._lock:
            self._data["approvals"][approval.approval_id] = self._dump(approval)
            self._write()

    def get_approval(self, approval_id: str) -> ApprovalRequest | None:
        with self._lock:
            raw = self._data["approvals"].get(approval_id)
            return ApprovalRequest.model_validate(raw) if raw else None

    def get_approval_for_run(self, run_id: str) -> ApprovalRequest | None:
        with self._lock:
            values = self._data["approvals"].values()
            matches = [ApprovalRequest.model_validate(item) for item in values if item.get("run_id") == run_id]
        return max(matches, key=lambda item: item.expires_at, default=None)

    def append_event(self, event: AgentEvent) -> None:
        with self._lock:
            self._data["events"].append(self._dump(event))
            self._write()

    def list_events(self, *, session_id: str, after_sequence: int = 0) -> list[AgentEvent]:
        with self._lock:
            events = [AgentEvent.model_validate(item) for item in self._data["events"]]
        return [
            item for item in events
            if item.session_id == session_id and item.sequence_number > after_sequence
        ]

    def next_sequence(self, session_id: str) -> int:
        events = self.list_events(session_id=session_id)
        return (events[-1].sequence_number if events else 0) + 1

    def get_idempotency(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            value = self._data["idempotency"].get(key)
            return dict(value) if isinstance(value, dict) else None

    def save_idempotency(self, key: str, value: dict[str, Any]) -> None:
        with self._lock:
            self._data["idempotency"][key] = value
            self._write()
