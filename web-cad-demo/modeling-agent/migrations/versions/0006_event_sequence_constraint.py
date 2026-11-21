"""Serialize per-Run event sequence allocation.

Revision ID: 0006_event_sequence_constraint
Revises: 0005_checkpoint_threads
"""

from collections.abc import Sequence

from alembic import op


revision = "0006_event_sequence_constraint"
down_revision = "0005_checkpoint_threads"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("agent_events") as batch_op:
        batch_op.create_unique_constraint(
            "uq_agent_event_sequence", ["run_id", "sequence_number"]
        )


def downgrade() -> None:
    with op.batch_alter_table("agent_events") as batch_op:
        batch_op.drop_constraint("uq_agent_event_sequence", type_="unique")
