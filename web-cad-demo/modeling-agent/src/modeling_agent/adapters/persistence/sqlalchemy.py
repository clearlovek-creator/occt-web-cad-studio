from __future__ import annotations

from sqlalchemy import Engine, create_engine

from modeling_agent.adapters.persistence.sqlalchemy_models import Base


def create_sync_engine(database_url: str) -> Engine:
    """Create a SQLAlchemy engine for migrations and repository adapters."""
    return create_engine(database_url, pool_pre_ping=True, future=True)


def initialize_schema(database_url: str) -> None:
    """Development bootstrap only; production uses Alembic migrations."""
    engine = create_sync_engine(database_url)
    try:
        Base.metadata.create_all(engine)
    finally:
        engine.dispose()
