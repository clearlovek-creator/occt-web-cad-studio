from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from modeling_agent.application.store import InMemoryRepository
from modeling_agent.domain.models import (
    ActionRequest,
    AgentEvent,
    AgentRun,
    ApprovalRequest,
    ConfigSnapshot,
    ElicitationRequest,
)


class JsonRepository(InMemoryRepository):
    """Crash-safe local repository for the first-stage desktop/dev profile."""

    def __init__(self, path: str | Path) -> None:
        super().__init__()
        self.path = Path(path)
        # The API handles requests in a thread pool.  A fixed ``.tmp`` name
        # lets concurrent saves collide on Windows (the second writer gets a
        # PermissionError while the first writer still owns the file).
        self._persist_lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._load()

    def _persist(self) -> None:
        with self._persist_lock:
            payload = {
                "runs": {key: value.model_dump(mode="json") for key, value in self.runs.items()},
                "goals": [
                    {"run_id": run_id, "version": version, "goal": goal}
                    for (run_id, version), goal in self.goals.items()
                ],
                "actions": {key: value.model_dump(mode="json") for key, value in self.actions.items()},
                "approvals": {key: value.model_dump(mode="json") for key, value in self.approvals.items()},
                "questions": {key: value.model_dump(mode="json") for key, value in self.questions.items()},
                "events": {
                    key: [value.model_dump(mode="json") for value in values]
                    for key, values in self.events.items()
                },
                "idempotency": self.idempotency,
                "config_snapshots": {
                    key: value.model_dump(mode="json")
                    for key, value in self.config_snapshots.items()
                },
            }
            temporary = self.path.with_name(
                f".{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
            )
            try:
                temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
                os.replace(temporary, self.path)
            finally:
                # If serialization or replacement fails, do not leave a
                # stale temporary file that can block the next request.
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def _load(self) -> None:
        if not self.path.exists():
            return
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        self.runs = {key: AgentRun.model_validate(value) for key, value in payload.get("runs", {}).items()}
        self.goals = {
            (item["run_id"], int(item["version"])): item["goal"]
            for item in payload.get("goals", [])
        }
        self.actions = {
            key: ActionRequest.model_validate(value)
            for key, value in payload.get("actions", {}).items()
        }
        self.approvals = {
            key: ApprovalRequest.model_validate(value)
            for key, value in payload.get("approvals", {}).items()
        }
        self.questions = {
            key: ElicitationRequest.model_validate(value)
            for key, value in payload.get("questions", {}).items()
        }
        self.events = {
            key: [AgentEvent.model_validate(item) for item in values]
            for key, values in payload.get("events", {}).items()
        }
        self.idempotency = payload.get("idempotency", {})
        self.config_snapshots = {
            key: ConfigSnapshot.model_validate(value)
            for key, value in payload.get("config_snapshots", {}).items()
        }

    def create_run(self, run: AgentRun) -> AgentRun:
        result = super().create_run(run)
        self._persist()
        return result

    def update_run(self, run: AgentRun) -> AgentRun:
        result = super().update_run(run)
        self._persist()
        return result

    def append_event(self, *args: Any, **kwargs: Any) -> AgentEvent:
        result = super().append_event(*args, **kwargs)
        self._persist()
        return result

    def save_goal(self, *args: Any, **kwargs: Any) -> None:
        super().save_goal(*args, **kwargs)
        self._persist()

    def save_config_snapshot(self, snapshot: ConfigSnapshot) -> ConfigSnapshot:
        result = super().save_config_snapshot(snapshot)
        self._persist()
        return result

    def save_action(self, action: ActionRequest) -> ActionRequest:
        result = super().save_action(action)
        self._persist()
        return result

    def save_approval(self, approval: ApprovalRequest) -> ApprovalRequest:
        result = super().save_approval(approval)
        self._persist()
        return result

    def save_question(self, question: ElicitationRequest) -> ElicitationRequest:
        result = super().save_question(question)
        self._persist()
        return result

    def save_idempotent(self, *args: Any, **kwargs: Any) -> None:
        super().save_idempotent(*args, **kwargs)
        self._persist()
