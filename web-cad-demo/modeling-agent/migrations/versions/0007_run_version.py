"""Add optimistic Run versioning for resume/approval requests.

Revision ID: 0007_run_version
Revises: 0006_event_sequence_constraint
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision = "0007_run_version"
down_revision = "0006_event_sequence_constraint"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("agent_runs", sa.Column("run_version", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("agent_runs", "run_version")
