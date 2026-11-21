"""Persist the immutable configuration snapshot referenced by each Run."""

from alembic import op
import sqlalchemy as sa


revision = "0004_config_snapshots"
down_revision = "0003_agent_checkpoints"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_config_snapshots",
        sa.Column("id", sa.String(length=100), primary_key=True),
        sa.Column("graph_version", sa.String(length=100), nullable=False),
        sa.Column("tool_registry_version", sa.String(length=100), nullable=False),
        sa.Column("policy_version", sa.String(length=100), nullable=False),
        sa.Column("settings", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("agent_config_snapshots")
