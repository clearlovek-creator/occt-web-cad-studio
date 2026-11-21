from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from uuid import uuid4


@dataclass(frozen=True)
class TraceContext:
    trace_id: str
    span_id: str

    @classmethod
    def new(cls) -> "TraceContext":
        return cls(trace_id=f"trace-{uuid4().hex}", span_id=f"span-{uuid4().hex}")


_current: ContextVar[TraceContext | None] = ContextVar("webcad_trace", default=None)


def current_trace() -> TraceContext:
    value = _current.get()
    if value is None:
        value = TraceContext.new()
        _current.set(value)
    return value
