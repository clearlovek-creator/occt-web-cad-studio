from __future__ import annotations

import pickle
from collections import defaultdict
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Iterator, Sequence

from langgraph.checkpoint.memory import InMemorySaver
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from modeling_agent.adapters.persistence.sqlalchemy import create_sync_engine
from modeling_agent.adapters.persistence.sqlalchemy_models import (
    AgentCheckpointRow,
    AgentCheckpointThreadRow,
    Base,
)


class SqlAlchemyCheckpointSaver(InMemorySaver):
    """Durable LangGraph checkpoint adapter.

    LangGraph's native serializer is retained, but checkpoint payloads are
    stored one row per ``thread_id``. This prevents a write for Run A from
    replacing Run B's checkpoint and makes restart recovery independent per
    workflow. The old single-row table is still read as a compatibility
    fallback for databases created before migration 0005.
    """

    def __init__(self, database_url: str, *, initialize: bool = False) -> None:
        super().__init__()
        self.engine = create_sync_engine(database_url)
        if initialize:
            Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(self.engine, expire_on_commit=False, class_=Session)
        self._lock = RLock()
        self._loaded_threads: set[str] = set()
        self._load_legacy()

    def close(self) -> None:
        self.engine.dispose()

    @staticmethod
    def _plain_storage(storage: Any) -> dict[str, dict[str, dict[str, Any]]]:
        return {
            str(thread_id): {
                str(namespace): dict(checkpoints)
                for namespace, checkpoints in namespaces.items()
            }
            for thread_id, namespaces in storage.items()
        }

    @staticmethod
    def _thread_id(config: dict[str, Any]) -> str:
        return str(config["configurable"]["thread_id"])

    def _thread_payload(self, thread_id: str) -> dict[str, Any]:
        storage = self._plain_storage(self.storage)
        return {
            "storage": {thread_id: storage.get(thread_id, {})},
            "writes": {
                key: dict(value)
                for key, value in self.writes.items()
                if key[0] == thread_id
            },
            "blobs": {
                key: value
                for key, value in self.blobs.items()
                if key[0] == thread_id
            },
        }

    def _replace_thread(self, thread_id: str, payload: dict[str, Any]) -> None:
        if thread_id in self.storage:
            del self.storage[thread_id]
        storage = defaultdict(dict)
        raw_storage = payload.get("storage", {}).get(thread_id, {})
        for namespace, checkpoints in raw_storage.items():
            storage[str(namespace)] = dict(checkpoints)
        self.storage[thread_id] = storage

        for key in list(self.writes):
            if key[0] == thread_id:
                del self.writes[key]
        for key, value in payload.get("writes", {}).items():
            self.writes[key] = dict(value)

        for key in list(self.blobs):
            if key[0] == thread_id:
                del self.blobs[key]
        for key, value in payload.get("blobs", {}).items():
            self.blobs[key] = value

    def _load_legacy(self) -> None:
        """Load the pre-0005 aggregate row, if one exists."""
        with self.sessions() as session:
            row = session.get(AgentCheckpointRow, 1)
            if row is None:
                return
            payload = pickle.loads(row.payload)
        storage = defaultdict(lambda: defaultdict(dict))
        for thread_id, namespaces in payload.get("storage", {}).items():
            storage[thread_id] = defaultdict(dict, namespaces)
        self.storage = storage
        self.writes = defaultdict(dict, payload.get("writes", {}))
        self.blobs = defaultdict(None, payload.get("blobs", {}))

    def _load_thread(self, thread_id: str) -> None:
        with self._lock:
            if thread_id in self._loaded_threads:
                return
            try:
                with self.sessions() as session:
                    row = session.get(AgentCheckpointThreadRow, thread_id)
                    payload = pickle.loads(row.payload) if row is not None else None
            except OperationalError:
                # A pre-0005 database can still recover from the legacy row.
                payload = None
            if payload is not None:
                self._replace_thread(thread_id, payload)
            self._loaded_threads.add(thread_id)

    def _load_all_threads(self) -> None:
        try:
            with self.sessions() as session:
                thread_ids = [str(item) for item in session.scalars(select(AgentCheckpointThreadRow.thread_id))]
        except OperationalError:
            thread_ids = []
        thread_ids.extend(str(item) for item in self.storage.keys())
        for thread_id in set(thread_ids):
            self._load_thread(thread_id)

    def _persist_thread(self, thread_id: str) -> None:
        payload = pickle.dumps(self._thread_payload(thread_id), protocol=pickle.HIGHEST_PROTOCOL)
        now = datetime.now(timezone.utc)
        try:
            with self._lock, self.sessions.begin() as session:
                row = session.get(AgentCheckpointThreadRow, thread_id)
                if row is None:
                    session.add(AgentCheckpointThreadRow(thread_id=thread_id, payload=payload, updated_at=now))
                else:
                    row.payload = payload
                    row.updated_at = now
        except OperationalError:
            # Keep old installations usable until migration 0005 is applied.
            self._persist_legacy()

    def _persist_legacy(self) -> None:
        payload = pickle.dumps(
            {
                "storage": self._plain_storage(self.storage),
                "writes": {key: dict(value) for key, value in self.writes.items()},
                "blobs": dict(self.blobs),
            },
            protocol=pickle.HIGHEST_PROTOCOL,
        )
        with self._lock, self.sessions.begin() as session:
            row = session.get(AgentCheckpointRow, 1)
            if row is None:
                session.add(AgentCheckpointRow(id=1, payload=payload, updated_at=datetime.now(timezone.utc)))
            else:
                row.payload = payload
                row.updated_at = datetime.now(timezone.utc)

    def get_tuple(self, config: dict[str, Any]) -> Any:
        self._load_thread(self._thread_id(config))
        return super().get_tuple(config)

    def list(
        self,
        config: dict[str, Any] | None,
        *,
        filter: dict[str, Any] | None = None,
        before: dict[str, Any] | None = None,
        limit: int | None = None,
    ) -> Iterator[Any]:
        if config is not None:
            self._load_thread(self._thread_id(config))
        else:
            self._load_all_threads()
        yield from super().list(config, filter=filter, before=before, limit=limit)

    def put(
        self,
        config: dict[str, Any],
        checkpoint: dict[str, Any],
        metadata: dict[str, Any],
        new_versions: dict[str, Any],
    ) -> dict[str, Any]:
        thread_id = self._thread_id(config)
        self._load_thread(thread_id)
        result = super().put(config, checkpoint, metadata, new_versions)
        self._persist_thread(thread_id)
        return result

    def put_writes(
        self,
        config: dict[str, Any],
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        thread_id = self._thread_id(config)
        self._load_thread(thread_id)
        super().put_writes(config, writes, task_id, task_path)
        self._persist_thread(thread_id)

    def delete_thread(self, thread_id: str) -> None:
        self._load_thread(thread_id)
        super().delete_thread(thread_id)
        try:
            with self._lock, self.sessions.begin() as session:
                row = session.get(AgentCheckpointThreadRow, thread_id)
                if row is not None:
                    session.delete(row)
        except OperationalError:
            self._persist_legacy()
