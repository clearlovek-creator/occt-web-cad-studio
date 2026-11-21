from __future__ import annotations

from collections import defaultdict
from threading import Lock
from typing import Mapping


class Metrics:
    """Small process-local counter/timing registry; exporters remain optional."""

    def __init__(self) -> None:
        self._counts: defaultdict[str, int] = defaultdict(int)
        self._timings: defaultdict[str, list[float]] = defaultdict(list)
        self._lock = Lock()

    def inc(self, name: str, value: int = 1) -> None:
        with self._lock:
            self._counts[name] += value

    def observe(self, name: str, value: float) -> None:
        with self._lock:
            self._timings[name].append(float(value))

    def snapshot(self) -> Mapping[str, object]:
        with self._lock:
            timings = {name: {"count": len(values), "last": values[-1] if values else None,
                              "average": sum(values) / len(values) if values else None}
                       for name, values in self._timings.items()}
            return {"counters": dict(self._counts), "timings": timings}
