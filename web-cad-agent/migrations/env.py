from __future__ import annotations

from logging.config import fileConfig
import os
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool
from sqlalchemy.engine import make_url

if context.config.config_file_name is not None:
    fileConfig(context.config.config_file_name)

database_url = os.environ.get("WEBCAD_AGENT_DATABASE_URL")
if database_url:
    context.config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))

target_metadata = None


def _ensure_sqlite_parent(url: str) -> None:
    parsed = make_url(url)
    if parsed.get_backend_name() != "sqlite" or not parsed.database or parsed.database == ":memory:":
        return
    Path(parsed.database).parent.mkdir(parents=True, exist_ok=True)


def run_migrations_offline() -> None:
    url = context.config.get_main_option("sqlalchemy.url")
    _ensure_sqlite_parent(url)
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    _ensure_sqlite_parent(context.config.get_main_option("sqlalchemy.url"))
    connectable = engine_from_config(context.config.get_section(context.config.config_ini_section, {}),
                                     prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
