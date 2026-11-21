from __future__ import annotations

from contextlib import contextmanager
import os
from threading import Lock
from typing import Any, Iterator


_lock = Lock()
_configured = False
_provider: Any | None = None


def _attribute_value(value: Any) -> Any:
    """Keep OTel attributes scalar and never emit sensitive/free-form payloads."""
    if isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (list, tuple)) and all(isinstance(item, (str, bool, int, float)) for item in value):
        return list(value)
    return str(value)[:256]


def safe_attributes(attributes: dict[str, Any] | None = None) -> dict[str, Any]:
    sensitive = {"api_key", "apikey", "authorization", "token", "secret", "prompt", "content"}
    return {key: "[REDACTED]" if key.lower() in sensitive else _attribute_value(value)
            for key, value in (attributes or {}).items()}


def configure_telemetry(*, exporter: str | None = None, endpoint: str | None = None,
                        service_name: str | None = None) -> dict[str, Any]:
    """Configure the optional SDK exporter once and return a diagnostic payload.

    Supported exporters are ``none`` (default), ``console`` and ``otlp_http``.
    OTLP is loaded lazily so the base CLI remains installable without telemetry
    dependencies.  A missing optional exporter never prevents CAD work.
    """
    global _configured, _provider
    selected = (exporter or os.environ.get("WEBCAD_AGENT_OTEL_EXPORTER", "none")).strip().lower()
    selected = {"otlp": "otlp_http", "otlphttp": "otlp_http"}.get(selected, selected)
    if selected in {"", "off", "disabled"}:
        selected = "none"
    if selected not in {"none", "console", "otlp_http"}:
        raise ValueError("OTel exporter must be none, console or otlp_http")
    if selected == "none":
        return {"enabled": False, "exporter": "none"}
    with _lock:
        if _configured:
            return {"enabled": True, "exporter": selected, "configured": True}
        try:
            from opentelemetry import trace
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
        except ImportError as exc:
            return {"enabled": False, "exporter": selected, "reason": "optional_dependency_missing",
                    "error": str(exc)}
        resource = Resource.create({"service.name": service_name or os.environ.get("WEBCAD_AGENT_SERVICE_NAME", "webcad-agent")})
        provider = TracerProvider(resource=resource)
        if selected == "console":
            span_exporter = ConsoleSpanExporter()
        else:
            try:
                from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            except ImportError as exc:
                return {"enabled": False, "exporter": selected, "reason": "otlp_dependency_missing",
                        "error": str(exc)}
            configured_endpoint = endpoint or os.environ.get("WEBCAD_AGENT_OTEL_ENDPOINT")
            span_exporter = OTLPSpanExporter(**({"endpoint": configured_endpoint} if configured_endpoint else {}))
        provider.add_span_processor(BatchSpanProcessor(span_exporter))
        trace.set_tracer_provider(provider)
        _provider = provider
        _configured = True
        return {"enabled": True, "exporter": selected, "configured": True}


def shutdown_telemetry() -> None:
    global _configured, _provider
    with _lock:
        if _provider is not None and hasattr(_provider, "shutdown"):
            _provider.shutdown()
        _provider = None
        _configured = False


@contextmanager
def span(name: str, *, attributes: dict[str, Any] | None = None) -> Iterator[None]:
    """Use OpenTelemetry when installed, while keeping the core dependency-free.

    The application can wrap Gateway/Planner boundaries with this helper. In
    the base CLI distribution it is a no-op; deployments that install the
    optional OpenTelemetry extras get real spans without changing domain code.
    """
    try:
        from opentelemetry import trace
    except ImportError:
        yield
        return
    tracer = trace.get_tracer("webcad-agent")
    with tracer.start_as_current_span(name, attributes=safe_attributes(attributes)):
        yield
