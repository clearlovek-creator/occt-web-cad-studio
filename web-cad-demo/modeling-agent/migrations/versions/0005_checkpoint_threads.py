"""Store LangGraph checkpoints per thread.

Revision ID: 0005_checkpoint_threads
Revises: 0004_config_snapshots
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision = "0005_checkpoint_threads"
down_revision = "0004_config_snapshots"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_checkpoint_threads",
        sa.Column("thread_id", sa.String(length=200), primary_key=True),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("agent_checkpoint_threads")
