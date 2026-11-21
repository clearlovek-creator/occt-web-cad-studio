from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from threading import RLock
from typing import Any

from pydantic import BaseModel

from ..domain.models import ActionEnvelope, AgentEvent, AgentPlan, AgentRun, AgentSession, ApprovalRequest, CompactionCheckpoint, ConfigSnapshot, ElicitationRequest, SessionMessage


class SQLiteStore:
    """SQLite-backed Repository with the same surface as JsonStore.

    JSON remains the portable debug store; SQLite is the default production store
    because records, event sequence and idempotency writes share one transaction.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript("""
        CREATE TABLE IF NOT EXISTS records (
          kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (kind, record_id)
        );
        CREATE TABLE IF NOT EXISTS events (
          session_id TEXT NOT NULL, sequence_number INTEGER NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (session_id, sequence_number)
        );
        CREATE TABLE IF NOT EXISTS idempotency (
          key TEXT PRIMARY KEY, payload TEXT NOT NULL
        );
        """)
        self._db.commit()

    @staticmethod
    def _dump(value: BaseModel) -> str:
        return json.dumps(value.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)

    @staticmethod
    def _load(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return json.loads(row["payload"]) if row else None

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def _save(self, kind: str, value: BaseModel, record_id: str) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO records(kind,record_id,payload) VALUES(?,?,?)",
                             (kind, record_id, self._dump(value)))

    def _get(self, kind: str, record_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._load(self._db.execute("SELECT payload FROM records WHERE kind=? AND record_id=?", (kind, record_id)).fetchone())

    def save_session(self, value: AgentSession) -> None: self._save("session", value, value.session_id)
    def get_session(self, value: str) -> AgentSession | None:
        raw = self._get("session", value); return AgentSession.model_validate(raw) if raw else None
    def list_sessions(self, *, document_id: str | None = None) -> list[AgentSession]:
        with self._lock:
            rows = self._db.execute("SELECT payload FROM records WHERE kind='session'").fetchall()
        values = [AgentSession.model_validate(json.loads(row["payload"])) for row in rows]
        if document_id: values = [item for item in values if item.document_id == document_id]
        return sorted(values, key=lambda item: item.updated_at, reverse=True)

    def save_run(self, value: AgentRun) -> None: self._save("run", value, value.run_id)
    def get_run(self, value: str) -> AgentRun | None:
        raw = self._get("run", value); return AgentRun.model_validate(raw) if raw else None
    def list_runs(self, *, session_id: str | None = None) -> list[AgentRun]:
        with self._lock:
            rows = self._db.execute("SELECT payload FROM records WHERE kind='run'").fetchall()
        values = [AgentRun.model_validate(json.loads(row["payload"])) for row in rows]
        if session_id:
            values = [item for item in values if item.session_id == session_id]
        return sorted(values, key=lambda item: item.updated_at, reverse=True)
    def save_config_snapshot(self, value: ConfigSnapshot) -> None: self._save("config_snapshot", value, value.snapshot_id)
    def get_config_snapshot(self, value: str) -> ConfigSnapshot | None:
        raw = self._get("config_snapshot", value); return ConfigSnapshot.model_validate(raw) if raw else None
    def save_message(self, value: SessionMessage) -> None: self._save("message", value, value.message_id)
    def list_messages(self, *, session_id: str) -> list[SessionMessage]:
        with self._lock:
            rows = self._db.execute("SELECT payload FROM records WHERE kind='message'").fetchall()
        values = [SessionMessage.model_validate(json.loads(row["payload"])) for row in rows if json.loads(row["payload"]).get("session_id") == session_id]
        return sorted(values, key=lambda item: item.created_at)
    def save_plan(self, value: AgentPlan) -> None: self._save("plan", value, value.plan_id)
    def get_plan(self, value: str) -> AgentPlan | None:
        raw = self._get("plan", value); return AgentPlan.model_validate(raw) if raw else None
    def save_compaction_checkpoint(self, value: CompactionCheckpoint) -> None:
        self._save("compaction_checkpoint", value, value.checkpoint_id)
    def list_compaction_checkpoints(self, *, session_id: str) -> list[CompactionCheckpoint]:
        with self._lock:
            rows = self._db.execute("SELECT payload FROM records WHERE kind='compaction_checkpoint'").fetchall()
        values = [CompactionCheckpoint.model_validate(json.loads(row["payload"])) for row in rows]
        return sorted([item for item in values if item.session_id == session_id], key=lambda item: item.created_at)
    def save_elicitation(self, value: ElicitationRequest) -> None: self._save("elicitation", value, value.request_id)
    def get_elicitation(self, value: str) -> ElicitationRequest | None:
        raw = self._get("elicitation", value); return ElicitationRequest.model_validate(raw) if raw else None
    def save_action(self, value: ActionEnvelope) -> None: self._save("action", value, value.action_id)
    def get_action(self, value: str) -> ActionEnvelope | None:
        raw = self._get("action", value); return ActionEnvelope.model_validate(raw) if raw else None
    def save_approval(self, value: ApprovalRequest) -> None: self._save("approval", value, value.approval_id)
    def get_approval(self, value: str) -> ApprovalRequest | None:
        raw = self._get("approval", value); return ApprovalRequest.model_validate(raw) if raw else None
    def get_approval_for_run(self, run_id: str) -> ApprovalRequest | None:
        with self._lock:
            rows = self._db.execute("SELECT payload FROM records WHERE kind='approval'").fetchall()
        matches = [ApprovalRequest.model_validate(json.loads(row["payload"])) for row in rows if json.loads(row["payload"]).get("run_id") == run_id]
        return max(matches, key=lambda item: item.expires_at, default=None)

    def append_event(self, event: AgentEvent) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT INTO events(session_id,sequence_number,payload) VALUES(?,?,?)",
                             (event.session_id, event.sequence_number, self._dump(event)))
    def list_events(self, *, session_id: str, after_sequence: int = 0) -> list[AgentEvent]:
        with self._lock:
            rows = self._db.execute("SELECT payload FROM events WHERE session_id=? AND sequence_number>? ORDER BY sequence_number", (session_id, after_sequence)).fetchall()
        return [AgentEvent.model_validate(json.loads(row["payload"])) for row in rows]
    def next_sequence(self, session_id: str) -> int:
        with self._lock:
            row = self._db.execute("SELECT COALESCE(MAX(sequence_number),0)+1 AS next FROM events WHERE session_id=?", (session_id,)).fetchone()
        return int(row["next"])
    def get_idempotency(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT payload FROM idempotency WHERE key=?", (key,)).fetchone()
        return json.loads(row["payload"]) if row else None
    def save_idempotency(self, key: str, value: dict[str, Any]) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO idempotency(key,payload) VALUES(?,?)", (key, json.dumps(value, ensure_ascii=False)))
