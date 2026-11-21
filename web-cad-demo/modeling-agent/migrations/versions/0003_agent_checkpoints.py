"""Add durable LangGraph checkpoint storage.

Revision ID: 0003_agent_checkpoints
Revises: 0002_runtime_support
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision = "0003_agent_checkpoints"
down_revision = "0002_runtime_support"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_checkpoints",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("agent_checkpoints")
