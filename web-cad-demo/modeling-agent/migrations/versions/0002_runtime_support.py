"""Add durable questions and idempotency records."""

from alembic import op
import sqlalchemy as sa

revision = "0002_runtime_support"
down_revision = "0001_agent_core"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_questions",
        sa.Column("id", sa.String(length=100), primary_key=True),
        sa.Column("run_id", sa.String(length=100), nullable=False, index=True),
        sa.Column("reason_code", sa.String(length=100), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("expected_schema", sa.JSON(), nullable=False),
        sa.Column("choices", sa.JSON(), nullable=True),
        sa.Column("current_value", sa.JSON(), nullable=True),
        sa.Column("recommended_value", sa.JSON(), nullable=True),
    )
    op.create_table(
        "agent_idempotency",
        sa.Column("key", sa.String(length=200), primary_key=True),
        sa.Column("observation", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("agent_idempotency")
    op.drop_table("agent_questions")
