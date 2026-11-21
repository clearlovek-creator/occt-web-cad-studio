"""Create first-stage Agent core tables.

Revision ID: 0001_agent_core
Revises:
"""
from alembic import op
import sqlalchemy as sa


revision = "0001_agent_core"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    json_type = sa.JSON()
    op.create_table(
        "agent_runs",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("project_id", sa.String(100), nullable=False, index=True),
        sa.Column("document_id", sa.String(100), nullable=False, index=True),
        sa.Column("user_id", sa.String(100), nullable=False, index=True),
        sa.Column("status", sa.String(40), nullable=False, index=True),
        sa.Column("current_stage", sa.String(40), nullable=False),
        sa.Column("goal_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("graph_version", sa.String(100), nullable=False),
        sa.Column("config_snapshot_id", sa.String(100), nullable=False),
        sa.Column("document_revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("waiting_request_id", sa.String(100)),
        sa.Column("waiting_approval_id", sa.String(100)),
        sa.Column("last_error", json_type),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "agent_goals",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("run_id", sa.String(100), nullable=False, index=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("goal", json_type, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("run_id", "version", name="uq_agent_goal_version"),
    )
    op.create_table(
        "agent_events",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("run_id", sa.String(100), nullable=False, index=True),
        sa.Column("sequence_number", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(80), nullable=False, index=True),
        sa.Column("actor", sa.String(100), nullable=False),
        sa.Column("correlation_id", sa.String(100), nullable=False),
        sa.Column("causation_id", sa.String(100)),
        sa.Column("schema_version", sa.String(20), nullable=False),
        sa.Column("payload", json_type, nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "agent_actions",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("run_id", sa.String(100), nullable=False, index=True),
        sa.Column("tool_name", sa.String(160), nullable=False, index=True),
        sa.Column("tool_version", sa.String(40), nullable=False),
        sa.Column("arguments", json_type, nullable=False),
        sa.Column("side_effect", sa.String(20), nullable=False),
        sa.Column("risk_level", sa.String(20), nullable=False),
        sa.Column("expected_document_revision", sa.Integer()),
        sa.Column("idempotency_key", sa.String(200), nullable=False, unique=True),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("success_criteria", json_type, nullable=False),
        sa.Column("action_hash", sa.String(128), nullable=False, index=True),
        sa.Column("status", sa.String(40), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "agent_approvals",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("run_id", sa.String(100), nullable=False, index=True),
        sa.Column("action_id", sa.String(100), nullable=False, index=True),
        sa.Column("action_hash", sa.String(128), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("impact", json_type, nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("allowed_decisions", json_type, nullable=False),
        sa.Column("decision", sa.String(20)),
        sa.Column("decision_payload", json_type, nullable=False),
    )


def downgrade() -> None:
    op.drop_table("agent_approvals")
    op.drop_table("agent_actions")
    op.drop_table("agent_events")
    op.drop_table("agent_goals")
    op.drop_table("agent_runs")
