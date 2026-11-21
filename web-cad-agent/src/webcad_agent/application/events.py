from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from threading import RLock
from typing import Any


class EventBus:
    """In-process fan-out bus. Persistence remains the source of truth."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[Callable[[Any], None]]] = defaultdict(list)
        self._lock = RLock()

    def subscribe(self, event_type: str, callback: Callable[[Any], None]) -> Callable[[], None]:
        with self._lock: self._subscribers[event_type].append(callback)
        def unsubscribe() -> None:
            with self._lock:
                if callback in self._subscribers[event_type]: self._subscribers[event_type].remove(callback)
        return unsubscribe

    def publish(self, event: Any) -> None:
        key = getattr(event, "event_type", "*")
        with self._lock:
            callbacks = list(self._subscribers.get(key, [])) + list(self._subscribers.get("*", []))
        for callback in callbacks: callback(event)
