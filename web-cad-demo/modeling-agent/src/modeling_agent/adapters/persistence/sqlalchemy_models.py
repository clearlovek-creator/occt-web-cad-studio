from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON


class Base(DeclarativeBase):
    pass


class AgentConfigSnapshotRow(Base):
    __tablename__ = "agent_config_snapshots"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    graph_version: Mapped[str] = mapped_column(String(100))
    tool_registry_version: Mapped[str] = mapped_column(String(100))
    policy_version: Mapped[str] = mapped_column(String(100))
    settings: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AgentRunRow(Base):
    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(100), index=True)
    document_id: Mapped[str] = mapped_column(String(100), index=True)
    user_id: Mapped[str] = mapped_column(String(100), index=True)
    status: Mapped[str] = mapped_column(String(40), index=True)
    current_stage: Mapped[str] = mapped_column(String(40))
    run_version: Mapped[int] = mapped_column(Integer, default=0)
    goal_version: Mapped[int] = mapped_column(Integer, default=0)
    graph_version: Mapped[str] = mapped_column(String(100))
    config_snapshot_id: Mapped[str] = mapped_column(String(100))
    document_revision: Mapped[int] = mapped_column(Integer, default=0)
    waiting_request_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    waiting_approval_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    paused_from_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    last_error: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AgentGoalRow(Base):
    __tablename__ = "agent_goals"
    __table_args__ = (UniqueConstraint("run_id", "version", name="uq_agent_goal_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(100), index=True)
    version: Mapped[int] = mapped_column(Integer)
    goal: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AgentEventRow(Base):
    __tablename__ = "agent_events"
    __table_args__ = (UniqueConstraint("run_id", "sequence_number", name="uq_agent_event_sequence"),)

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(100), index=True)
    sequence_number: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(80), index=True)
    actor: Mapped[str] = mapped_column(String(100))
    correlation_id: Mapped[str] = mapped_column(String(100))
    causation_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    schema_version: Mapped[str] = mapped_column(String(20))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AgentActionRow(Base):
    __tablename__ = "agent_actions"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(100), index=True)
    tool_name: Mapped[str] = mapped_column(String(160), index=True)
    tool_version: Mapped[str] = mapped_column(String(40))
    arguments: Mapped[dict[str, Any]] = mapped_column(JSON)
    side_effect: Mapped[str] = mapped_column(String(20))
    risk_level: Mapped[str] = mapped_column(String(20))
    expected_document_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(200), unique=True)
    reason: Mapped[str] = mapped_column(Text)
    success_criteria: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    action_hash: Mapped[str] = mapped_column(String(128), index=True)
    status: Mapped[str] = mapped_column(String(40), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AgentApprovalRow(Base):
    __tablename__ = "agent_approvals"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(100), index=True)
    action_id: Mapped[str] = mapped_column(String(100), index=True)
    action_hash: Mapped[str] = mapped_column(String(128))
    summary: Mapped[str] = mapped_column(Text)
    impact: Mapped[list[str]] = mapped_column(JSON)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    allowed_decisions: Mapped[list[str]] = mapped_column(JSON)
    decision: Mapped[str | None] = mapped_column(String(20), nullable=True)
    decision_payload: Mapped[dict[str, Any]] = mapped_column(JSON)


class AgentQuestionRow(Base):
    __tablename__ = "agent_questions"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(100), index=True)
    reason_code: Mapped[str] = mapped_column(String(100))
    question: Mapped[str] = mapped_column(Text)
    expected_schema: Mapped[dict[str, Any]] = mapped_column(JSON)
    choices: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)
    current_value: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    recommended_value: Mapped[Any | None] = mapped_column(JSON, nullable=True)


class AgentIdempotencyRow(Base):
    __tablename__ = "agent_idempotency"

    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    observation: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AgentCheckpointRow(Base):
    """Durable LangGraph checkpoint payload for service restart recovery."""

    __tablename__ = "agent_checkpoints"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    payload: Mapped[bytes] = mapped_column(LargeBinary)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AgentCheckpointThreadRow(Base):
    """One opaque checkpoint payload per LangGraph thread.

    The legacy ``agent_checkpoints`` row remains readable for migration
    compatibility; new writes use this table so one Run cannot overwrite
    another Run's checkpoint payload.
    """

    __tablename__ = "agent_checkpoint_threads"

    thread_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    payload: Mapped[bytes] = mapped_column(LargeBinary)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
