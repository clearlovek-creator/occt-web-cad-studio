from __future__ import annotations

from collections import defaultdict
from contextlib import contextmanager
from threading import Lock
from time import perf_counter
from typing import Any, Iterator

try:
    from opentelemetry import metrics, trace
except ImportError:  # pragma: no cover
    metrics = None  # type: ignore[assignment]
    trace = None  # type: ignore[assignment]


_SAFE_ATTRIBUTE_KEYS = frozenset({"stage", "tool_name", "node_name", "model_name", "outcome"})
_metric_lock = Lock()
_metric_counts: dict[tuple[str, tuple[tuple[str, str], ...]], int] = defaultdict(int)
_metric_duration_ms: dict[tuple[str, tuple[tuple[str, str], ...]], float] = defaultdict(float)
_meter = metrics.get_meter("modeling-agent") if metrics is not None else None
_span_counter = _meter.create_counter("agent.spans") if _meter is not None else None
_span_duration = _meter.create_histogram("agent.span.duration_ms") if _meter is not None else None


def get_tracer(name: str = "modeling-agent") -> Any:
    if trace is None:
        return None
    return trace.get_tracer(name)


def _safe_attributes(attributes: dict[str, Any] | None) -> dict[str, str]:
    return {
        key: str(value)
        for key, value in (attributes or {}).items()
        if key in _SAFE_ATTRIBUTE_KEYS and value is not None
    }


def record_metric(name: str, *, duration_ms: float | None = None, attributes: dict[str, Any] | None = None) -> None:
    safe = _safe_attributes(attributes)
    key = (name, tuple(sorted(safe.items())))
    with _metric_lock:
        _metric_counts[key] += 1
        if duration_ms is not None:
            _metric_duration_ms[key] += float(duration_ms)
    if _span_counter is not None:
        _span_counter.add(1, attributes=safe)
    if duration_ms is not None and _span_duration is not None:
        _span_duration.record(float(duration_ms), attributes=safe)


def metrics_snapshot() -> list[dict[str, Any]]:
    with _metric_lock:
        return [
            {
                "name": name,
                "attributes": dict(attributes),
                "count": count,
                "duration_ms_sum": round(_metric_duration_ms.get((name, attributes), 0.0), 3),
            }
            for (name, attributes), count in sorted(_metric_counts.items())
        ]


@contextmanager
def agent_span(name: str, attributes: dict[str, Any] | None = None) -> Iterator[Any]:
    tracer = get_tracer()
    started = perf_counter()
    span = None
    try:
        if tracer is None:
            yield None
        else:
            with tracer.start_as_current_span(name, attributes=attributes or {}) as active_span:
                span = active_span
                yield active_span
    except Exception:
        if span is not None:
            span.set_attribute("outcome", "error")
        raise
    finally:
        duration_ms = (perf_counter() - started) * 1000
        if span is not None:
            span.set_attribute("duration_ms", duration_ms)
        record_metric(name, duration_ms=duration_ms, attributes=attributes)
