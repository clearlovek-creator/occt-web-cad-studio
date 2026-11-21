"""Persist safe-boundary Run pause state.

Revision ID: 0008_run_pause
Revises: 0007_run_version
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision = "0008_run_pause"
down_revision = "0007_run_version"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("agent_runs", sa.Column("paused_from_status", sa.String(length=40), nullable=True))


def downgrade() -> None:
    op.drop_column("agent_runs", "paused_from_status")
