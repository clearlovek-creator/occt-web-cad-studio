from __future__ import annotations

from time import perf_counter
from typing import Any

import httpx

from modeling_agent.domain.models import ActionRequest, ErrorClass, Observation


class HttpGeometryAdapter:
    """HTTP adapter for the existing Node Gateway / OCCT Worker boundary."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout_seconds: float = 30.0,
        dimension_scale: float = 1000.0,
        retry_attempts: int = 2,
    ) -> None:
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=httpx.Timeout(timeout_seconds),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=5),
        )
        self.dimension_scale = dimension_scale
        self.retry_attempts = max(1, retry_attempts)

    def _send(self, payload: dict[str, Any], *, attempts: int | None = None) -> httpx.Response:
        last_error: Exception | None = None
        for attempt in range(attempts or self.retry_attempts):
            try:
                request_id = payload.get("requestId") or payload.get("idempotencyKey")
                headers = {"X-Correlation-ID": str(request_id)} if request_id else None
                response = self.client.post("/api/commands", json=payload, headers=headers)
                return response
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                if attempt + 1 >= (attempts or self.retry_attempts):
                    raise
        assert last_error is not None
        raise last_error

    def close(self) -> None:
        self.client.close()

    def current_revision(self, document_id: str) -> int:
        return int(self.summary(document_id).get("revision", 0))

    def summary(self, document_id: str) -> dict[str, Any]:
        response = self._send(
            {
                "operation": "document.summary",
                "documentId": document_id,
                "inputs": {},
                "parameters": {},
            },
            attempts=self.retry_attempts,
        )
        response.raise_for_status()
        payload: dict[str, Any] = response.json()
        result = payload.get("result")
        if isinstance(result, dict):
            merged = dict(result)
            merged.update({key: value for key, value in payload.items() if key != "result"})
        else:
            merged = payload
        normalized_bodies: list[dict[str, Any]] = []
        for feature in merged.get("features", []):
            if not isinstance(feature, dict):
                continue
            parameters = feature.get("numberParameters", {})
            if not isinstance(parameters, dict):
                continue
            outputs = feature.get("outputBodies", [])
            body_id = outputs[0] if outputs else feature.get("id")
            if not body_id:
                continue
            body = {"body_id": body_id, "kind": feature.get("type", "unknown")}
            for source_key, target_key in (("width", "width_m"), ("depth", "depth_m"), ("height", "height_m"), ("x", "x_m"), ("y", "y_m"), ("z", "z_m")):
                if source_key in parameters:
                    body[target_key] = float(parameters[source_key]) / self.dimension_scale
            normalized_bodies.append(body)
        if normalized_bodies:
            merged["bodies"] = normalized_bodies
        return merged

    def undo(self, document_id: str, expected_revision: int, idempotency_key: str) -> Observation:
        started = perf_counter()
        command = {
            "protocolVersion": 1,
            "operation": "document.undo",
            "documentId": document_id,
            "requestId": idempotency_key,
            "idempotencyKey": idempotency_key,
            "options": {"idempotencyKey": idempotency_key},
            "inputs": {},
            "parameters": {},
        }
        try:
            response = self._send(command, attempts=self.retry_attempts)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            return Observation(action_id=idempotency_key, success=False, before_revision=expected_revision, error_code="GEOMETRY_TRANSPORT_UNKNOWN", error_class=ErrorClass.TOOL_TRANSIENT, result={"error": str(exc), "retryable": True}, duration_ms=int((perf_counter() - started) * 1000))
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError:
            try:
                payload = response.json()
            except ValueError:
                payload = {"status_code": response.status_code}
            code = str(payload.get("code", "GEOMETRY_UNDO_FAILED"))
            return Observation(action_id=idempotency_key, success=False, before_revision=expected_revision, after_revision=expected_revision, error_code=code, error_class=ErrorClass.REVISION_CONFLICT if response.status_code == 409 else ErrorClass.NON_RECOVERABLE, result=payload, duration_ms=int((perf_counter() - started) * 1000))
        payload = response.json()
        revision = payload.get("revision", payload.get("result", {}).get("revision"))
        ok = bool(payload.get("ok", payload.get("success", False)))
        return Observation(action_id=idempotency_key, success=ok, before_revision=expected_revision, after_revision=int(revision) if revision is not None else None, error_code=None if ok else str(payload.get("code", "GEOMETRY_UNDO_FAILED")), result=payload, duration_ms=int((perf_counter() - started) * 1000))

    def execute(self, action: ActionRequest) -> Observation:
        started = perf_counter()
        document_id = str(action.arguments.get("document_id", "default"))
        if action.tool_name != "geometry.create_box":
            return Observation(
                action_id=action.action_id,
                success=False,
                error_code="UNSUPPORTED_GEOMETRY_TOOL",
            )
        parameters = {
            key: float(action.arguments[key]) * self.dimension_scale
            for key in ("width_m", "depth_m", "height_m")
        }
        parameters = {
            "width": parameters["width_m"],
            "depth": parameters["depth_m"],
            "height": parameters["height_m"],
        }
        for source_key, target_key in (("x_m", "x"), ("y_m", "y"), ("z_m", "z")):
            if source_key in action.arguments:
                parameters[target_key] = float(action.arguments[source_key]) * self.dimension_scale
        command = {
            "protocolVersion": 1,
            "operation": "primitive.box",
            "documentId": document_id,
            "baseRevision": action.expected_document_revision,
            "requestId": action.action_id,
            "idempotencyKey": action.idempotency_key,
            "parameters": parameters,
            "inputs": {},
        }
        try:
            response = self._send(command, attempts=self.retry_attempts)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            return Observation(
                action_id=action.action_id,
                success=False,
                before_revision=action.expected_document_revision,
                duration_ms=int((perf_counter() - started) * 1000),
                error_code="GEOMETRY_TRANSPORT_UNKNOWN",
                error_class=ErrorClass.TOOL_TRANSIENT,
                result={"error": str(exc), "retryable": True},
            )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            try:
                error_payload: dict[str, Any] = response.json()
            except ValueError:
                error_payload = {"status_code": response.status_code}
            code = str(error_payload.get("code", "GEOMETRY_COMMAND_FAILED"))
            error_class = ErrorClass.REVISION_CONFLICT if response.status_code == 409 else ErrorClass.NON_RECOVERABLE
            return Observation(
                action_id=action.action_id,
                success=False,
                before_revision=action.expected_document_revision,
                duration_ms=int((perf_counter() - started) * 1000),
                error_code=code,
                error_class=error_class,
                result=error_payload,
            )
        payload: dict[str, Any] = response.json()
        ok = bool(payload.get("ok", payload.get("success", False)))
        revision = payload.get("revision", payload.get("result", {}).get("revision"))
        return Observation(
            action_id=action.action_id,
            success=ok,
            result=payload,
            before_revision=action.expected_document_revision,
            after_revision=int(revision) if revision is not None else None,
            duration_ms=int((perf_counter() - started) * 1000),
            error_code=None if ok else str(payload.get("code", "GEOMETRY_COMMAND_FAILED")),
        )
