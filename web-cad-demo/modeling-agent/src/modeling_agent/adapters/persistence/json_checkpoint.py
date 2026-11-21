from __future__ import annotations

"""A small durable LangGraph checkpointer for the local/dev profile.

The production profile should use a database-backed checkpointer.  This adapter
keeps the first phase restartable without making the domain layer depend on a
specific LangGraph storage implementation.
"""

import os
import pickle
from collections import defaultdict
from pathlib import Path
from threading import RLock, get_ident
from typing import Any, Sequence

from langgraph.checkpoint.memory import InMemorySaver


class JsonCheckpointSaver(InMemorySaver):
    """Persist the in-memory LangGraph checkpoint structures to one local file.

    The file is an internal development artifact and must not be treated as a
    portable or untrusted interchange format.  Production deployments should
    replace this saver with a PostgreSQL-backed checkpointer.
    """

    def __init__(self, path: str | Path) -> None:
        super().__init__()
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._persist_lock = RLock()
        self._load()

    @staticmethod
    def _plain_storage(storage: Any) -> dict[str, dict[str, dict[str, Any]]]:
        return {
            str(thread_id): {
                str(namespace): dict(checkpoints)
                for namespace, checkpoints in namespaces.items()
            }
            for thread_id, namespaces in storage.items()
        }

    def _payload(self) -> dict[str, Any]:
        return {
            "storage": self._plain_storage(self.storage),
            "writes": {key: dict(value) for key, value in self.writes.items()},
            "blobs": dict(self.blobs),
        }

    def _persist(self) -> None:
        with self._persist_lock:
            temporary = self.path.with_name(
                f".{self.path.name}.{os.getpid()}.{get_ident()}.{id(self)}.tmp"
            )
            try:
                with temporary.open("wb") as stream:
                    pickle.dump(self._payload(), stream, protocol=pickle.HIGHEST_PROTOCOL)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
            finally:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("rb") as stream:
            payload = pickle.load(stream)
        storage = defaultdict(lambda: defaultdict(dict))
        for thread_id, namespaces in payload.get("storage", {}).items():
            storage[thread_id] = defaultdict(dict, namespaces)
        self.storage = storage
        self.writes = defaultdict(dict, payload.get("writes", {}))
        self.blobs = defaultdict(None, payload.get("blobs", {}))

    def put(self, config: dict[str, Any], checkpoint: dict[str, Any], metadata: dict[str, Any], new_versions: dict[str, Any]) -> dict[str, Any]:
        result = super().put(config, checkpoint, metadata, new_versions)
        self._persist()
        return result

    def put_writes(
        self,
        config: dict[str, Any],
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        super().put_writes(config, writes, task_id, task_path)
        self._persist()

    def delete_thread(self, thread_id: str) -> None:
        super().delete_thread(thread_id)
        self._persist()

    def delete_for_runs(self, run_ids: Sequence[str]) -> None:
        super().delete_for_runs(run_ids)
        self._persist()
