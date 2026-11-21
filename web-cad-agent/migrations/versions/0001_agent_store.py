"""create the portable Agent repository tables"""

from alembic import op
import sqlalchemy as sa

revision = "0001_agent_store"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("records",
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("record_id", sa.String(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("kind", "record_id"))
    op.create_table("events",
        sa.Column("session_id", sa.String(), nullable=False),
        sa.Column("sequence_number", sa.Integer(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("session_id", "sequence_number"))
    op.create_table("idempotency",
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("key"))


def downgrade() -> None:
    op.drop_table("idempotency")
    op.drop_table("events")
    op.drop_table("records")
