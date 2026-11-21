from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any


_SENSITIVE = {"api_key", "apikey", "authorization", "token", "secret", "prompt", "content"}


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: "[REDACTED]" if key.lower() in _SENSITIVE else redact(item) for key, item in value.items()}
    if isinstance(value, list): return [redact(item) for item in value]
    return value


class JsonEventLogger:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path); self.path.parent.mkdir(parents=True, exist_ok=True); self._lock = RLock()

    def write(self, event: str, *, trace_id: str | None = None, **fields: Any) -> None:
        entry = {"timestamp": datetime.now(timezone.utc).isoformat(), "event": event,
                 "trace_id": trace_id, **redact(fields)}
        with self._lock:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
