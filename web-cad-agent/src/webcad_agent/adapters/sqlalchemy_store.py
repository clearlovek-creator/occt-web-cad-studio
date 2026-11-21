from __future__ import annotations

import json
from pathlib import Path
from threading import RLock
from typing import Any

from pydantic import BaseModel
from sqlalchemy import Column, Integer, MetaData, String, Table, Text, create_engine, select

from ..domain.models import (
    ActionEnvelope, AgentEvent, AgentPlan, AgentRun, AgentSession, ApprovalRequest,
    CompactionCheckpoint, ConfigSnapshot, ElicitationRequest, SessionMessage,
)


class SQLAlchemyStore:
    """Portable SQLAlchemy Repository using the same inspectable SQLite schema.

    The payload tables intentionally store versioned Pydantic JSON. This keeps
    migrations additive and lets an existing ``SQLiteStore`` database be opened
    by the production repository without a data rewrite.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._engine = create_engine(
            f"sqlite:///{self.path}",
            connect_args={"check_same_thread": False},
            future=True,
        )
        metadata = MetaData()
        self._records = Table(
            "records", metadata,
            Column("kind", String, primary_key=True),
            Column("record_id", String, primary_key=True),
            Column("payload", Text, nullable=False),
        )
        self._events = Table(
            "events", metadata,
            Column("session_id", String, primary_key=True),
            Column("sequence_number", Integer, primary_key=True),
            Column("payload", Text, nullable=False),
        )
        self._idempotency = Table(
            "idempotency", metadata,
            Column("key", String, primary_key=True),
            Column("payload", Text, nullable=False),
        )
        metadata.create_all(self._engine)

    @staticmethod
    def _dump(value: BaseModel) -> str:
        return json.dumps(value.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)

    @staticmethod
    def _load(payload: str | None) -> dict[str, Any] | None:
        return json.loads(payload) if payload else None

    def close(self) -> None:
        self._engine.dispose()

    def _save(self, kind: str, value: BaseModel, record_id: str) -> None:
        with self._lock, self._engine.begin() as connection:
            connection.execute(self._records.delete().where(
                (self._records.c.kind == kind) & (self._records.c.record_id == record_id)))
            connection.execute(self._records.insert().values(kind=kind, record_id=record_id, payload=self._dump(value)))

    def _get(self, kind: str, record_id: str) -> dict[str, Any] | None:
        with self._lock, self._engine.connect() as connection:
            row = connection.execute(select(self._records.c.payload).where(
                (self._records.c.kind == kind) & (self._records.c.record_id == record_id))).first()
        return self._load(row[0] if row else None)

    def _list_kind(self, kind: str) -> list[dict[str, Any]]:
        with self._lock, self._engine.connect() as connection:
            rows = connection.execute(select(self._records.c.payload).where(self._records.c.kind == kind)).all()
        return [json.loads(row[0]) for row in rows]

    def save_session(self, value: AgentSession) -> None: self._save("session", value, value.session_id)
    def get_session(self, value: str) -> AgentSession | None:
        raw = self._get("session", value); return AgentSession.model_validate(raw) if raw else None
    def list_sessions(self, *, document_id: str | None = None) -> list[AgentSession]:
        values = [AgentSession.model_validate(item) for item in self._list_kind("session")]
        if document_id: values = [item for item in values if item.document_id == document_id]
        return sorted(values, key=lambda item: item.updated_at, reverse=True)

    def save_run(self, value: AgentRun) -> None: self._save("run", value, value.run_id)
    def get_run(self, value: str) -> AgentRun | None:
        raw = self._get("run", value); return AgentRun.model_validate(raw) if raw else None
    def list_runs(self, *, session_id: str | None = None) -> list[AgentRun]:
        values = [AgentRun.model_validate(item) for item in self._list_kind("run")]
        if session_id: values = [item for item in values if item.session_id == session_id]
        return sorted(values, key=lambda item: item.updated_at, reverse=True)
    def save_config_snapshot(self, value: ConfigSnapshot) -> None: self._save("config_snapshot", value, value.snapshot_id)
    def get_config_snapshot(self, value: str) -> ConfigSnapshot | None:
        raw = self._get("config_snapshot", value); return ConfigSnapshot.model_validate(raw) if raw else None

    def save_message(self, value: SessionMessage) -> None: self._save("message", value, value.message_id)
    def list_messages(self, *, session_id: str) -> list[SessionMessage]:
        values = [SessionMessage.model_validate(item) for item in self._list_kind("message") if item.get("session_id") == session_id]
        return sorted(values, key=lambda item: item.created_at)

    def save_plan(self, value: AgentPlan) -> None: self._save("plan", value, value.plan_id)
    def get_plan(self, value: str) -> AgentPlan | None:
        raw = self._get("plan", value); return AgentPlan.model_validate(raw) if raw else None
    def save_action(self, value: ActionEnvelope) -> None: self._save("action", value, value.action_id)
    def get_action(self, value: str) -> ActionEnvelope | None:
        raw = self._get("action", value); return ActionEnvelope.model_validate(raw) if raw else None
    def save_approval(self, value: ApprovalRequest) -> None: self._save("approval", value, value.approval_id)
    def get_approval(self, value: str) -> ApprovalRequest | None:
        raw = self._get("approval", value); return ApprovalRequest.model_validate(raw) if raw else None
    def get_approval_for_run(self, run_id: str) -> ApprovalRequest | None:
        values = [ApprovalRequest.model_validate(item) for item in self._list_kind("approval") if item.get("run_id") == run_id]
        return max(values, key=lambda item: item.expires_at, default=None)

    def save_compaction_checkpoint(self, value: CompactionCheckpoint) -> None:
        self._save("compaction_checkpoint", value, value.checkpoint_id)
    def list_compaction_checkpoints(self, *, session_id: str) -> list[CompactionCheckpoint]:
        values = [CompactionCheckpoint.model_validate(item) for item in self._list_kind("compaction_checkpoint") if item.get("session_id") == session_id]
        return sorted(values, key=lambda item: item.created_at)
    def save_elicitation(self, value: ElicitationRequest) -> None: self._save("elicitation", value, value.request_id)
    def get_elicitation(self, value: str) -> ElicitationRequest | None:
        raw = self._get("elicitation", value); return ElicitationRequest.model_validate(raw) if raw else None

    def append_event(self, event: AgentEvent) -> None:
        with self._lock, self._engine.begin() as connection:
            connection.execute(self._events.insert().values(
                session_id=event.session_id, sequence_number=event.sequence_number, payload=self._dump(event)))
    def list_events(self, *, session_id: str, after_sequence: int = 0) -> list[AgentEvent]:
        with self._lock, self._engine.connect() as connection:
            rows = connection.execute(select(self._events.c.payload).where(
                (self._events.c.session_id == session_id) & (self._events.c.sequence_number > after_sequence)
            ).order_by(self._events.c.sequence_number)).all()
        return [AgentEvent.model_validate(json.loads(row[0])) for row in rows]
    def next_sequence(self, session_id: str) -> int:
        with self._lock, self._engine.connect() as connection:
            rows = connection.execute(select(self._events.c.sequence_number).where(
                self._events.c.session_id == session_id).order_by(self._events.c.sequence_number.desc()).limit(1)).first()
        return int(rows[0]) + 1 if rows else 1

    def get_idempotency(self, key: str) -> dict[str, Any] | None:
        with self._lock, self._engine.connect() as connection:
            row = connection.execute(select(self._idempotency.c.payload).where(self._idempotency.c.key == key)).first()
        return json.loads(row[0]) if row else None
    def save_idempotency(self, key: str, value: dict[str, Any]) -> None:
        with self._lock, self._engine.begin() as connection:
            connection.execute(self._idempotency.delete().where(self._idempotency.c.key == key))
            connection.execute(self._idempotency.insert().values(key=key, payload=json.dumps(value, ensure_ascii=False)))
