from __future__ import annotations

import asyncio
import hashlib
import json
from urllib.parse import urlparse
from time import perf_counter
from typing import Any

import httpx

from ..domain.models import (
    ActionEnvelope,
    ErrorClass,
    Observation,
)


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class GatewayError(RuntimeError):
    def __init__(self, message: str, *, code: str = "GATEWAY_ERROR", status_code: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


_GATEWAY_INPUT_KEYS = {"bodyId", "bodyIds", "targetBody", "toolBody", "featureId", "featureIds",
                       "faceId", "faceIds", "edgeId", "edgeIds", "selectionType", "selectionId", "bodyA", "bodyB"}


def _gateway_arguments(arguments: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Map flat Tool arguments to Gateway inputs/parameters without model-side HTTP access."""
    if "inputs" in arguments or "parameters" in arguments:
        return dict(arguments.get("inputs", {})), dict(arguments.get("parameters", {}))
    inputs = {key: value for key, value in arguments.items() if key in _GATEWAY_INPUT_KEYS}
    parameters = {key: value for key, value in arguments.items() if key not in _GATEWAY_INPUT_KEYS}
    return inputs, parameters


class HttpGeometryAdapter:
    """HTTP/JSON adapter for the existing Node Gateway."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout_seconds: float = 30.0,
        client: httpx.AsyncClient | None = None,
        max_response_bytes: int = 8 * 1024 * 1024,
        allow_insecure_remote: bool = False,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        parsed = urlparse(self.base_url)
        if (client is None and parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
                and not allow_insecure_remote):
            raise ValueError("Remote Gateway must use HTTPS unless allow_insecure_remote=True")
        self.max_response_bytes = max(1024, max_response_bytes)
        self.client = client or httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(timeout_seconds),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
        self._owns_client = client is None
        self.capabilities: dict[str, Any] = {}

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    async def _post(self, payload: dict[str, Any], *, read_only: bool = False) -> dict[str, Any]:
        request_id = str(payload.get("requestId") or payload.get("idempotencyKey") or "")
        headers = {"X-Correlation-ID": request_id} if request_id else None
        attempts = 3 if read_only else 1
        response = None
        for attempt in range(attempts):
            try:
                response = await self.client.post("/api/commands", json=payload, headers=headers)
                if read_only and response.status_code >= 500 and attempt + 1 < attempts:
                    await asyncio.sleep(0.05 * (2 ** attempt))
                    continue
                break
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                if attempt + 1 >= attempts:
                    raise GatewayError(str(exc), code="GATEWAY_UNAVAILABLE" if read_only else "GATEWAY_TRANSPORT_UNKNOWN") from exc
                await asyncio.sleep(0.05 * (2 ** attempt))
        assert response is not None
        if len(response.content) > self.max_response_bytes:
            raise GatewayError("Gateway response exceeds configured limit", code="RESPONSE_TOO_LARGE",
                                status_code=response.status_code)
        try:
            body = response.json()
        except ValueError as exc:
            raise GatewayError("Gateway returned non-JSON data", code="INVALID_GATEWAY_RESPONSE", status_code=response.status_code) from exc
        if not isinstance(body, dict):
            raise GatewayError("Gateway response must be an object", code="INVALID_GATEWAY_RESPONSE", status_code=response.status_code)
        if response.status_code >= 400 or body.get("ok") is False:
            raise GatewayError(
                str(body.get("error") or body.get("code") or "Gateway command failed"),
                code=str(body.get("code") or "GATEWAY_COMMAND_FAILED"),
                status_code=response.status_code,
            )
        self.capabilities = dict(body.get("capabilities") or {})
        return body

    async def _get_json(self, path: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
        response = None
        for attempt in range(3):
            try:
                response = await self.client.get(path, params=params)
                if response.status_code >= 500 and attempt < 2:
                    await asyncio.sleep(0.05 * (2 ** attempt))
                    continue
                break
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                if attempt >= 2:
                    raise GatewayError(str(exc), code="GATEWAY_UNAVAILABLE") from exc
                await asyncio.sleep(0.05 * (2 ** attempt))
        assert response is not None
        if len(response.content) > self.max_response_bytes:
            raise GatewayError("Gateway response exceeds configured limit", code="RESPONSE_TOO_LARGE",
                                status_code=response.status_code)
        try:
            body = response.json()
        except ValueError as exc:
            raise GatewayError("Gateway returned non-JSON data", code="INVALID_GATEWAY_RESPONSE", status_code=response.status_code) from exc
        if not isinstance(body, dict):
            raise GatewayError("Gateway response must be an object", code="INVALID_GATEWAY_RESPONSE", status_code=response.status_code)
        if response.status_code >= 400 or body.get("ok") is False:
            raise GatewayError(str(body.get("error") or body.get("code") or "Gateway query failed"),
                               code=str(body.get("code") or "GATEWAY_QUERY_FAILED"), status_code=response.status_code)
        return body

    def supports(self, capability: str) -> bool:
        return bool(self.capabilities.get(capability, False))

    async def health(self) -> dict[str, Any]:
        response = None
        body = None
        for attempt in range(3):
            try:
                response = await self.client.get("/api/health")
                if response.status_code >= 500 and attempt < 2:
                    await asyncio.sleep(0.05 * (2 ** attempt))
                    continue
                if len(response.content) > self.max_response_bytes:
                    raise GatewayError("Gateway health response exceeds configured limit", code="RESPONSE_TOO_LARGE",
                                        status_code=response.status_code)
                body = response.json()
                break
            except (httpx.HTTPError, ValueError) as exc:
                if attempt >= 2:
                    raise GatewayError(str(exc), code="GATEWAY_UNAVAILABLE") from exc
                await asyncio.sleep(0.05 * (2 ** attempt))
        assert response is not None and body is not None
        if not isinstance(body, dict):
            raise GatewayError("Gateway health response must be an object", code="INVALID_GATEWAY_RESPONSE")
        if response.status_code >= 400:
            raise GatewayError(str(body.get("error") or "Gateway is not healthy"), code=str(body.get("code") or "GATEWAY_UNHEALTHY"), status_code=response.status_code)
        self.capabilities = dict(body.get("capabilities") or {})
        if body.get("protocolVersion") is not None:
            self.capabilities["protocolVersion"] = body["protocolVersion"]
        if body.get("operationCatalogVersion") is not None:
            self.capabilities["operationCatalogVersion"] = body["operationCatalogVersion"]
        return body

    async def history(self, document_id: str, direction: str, *, idempotency_key: str,
                      expected_revision: int | None = None) -> dict[str, Any]:
        if direction not in {"undo", "redo"}:
            raise ValueError("direction must be undo or redo")
        payload = {
            "protocolVersion": 1,
            "operation": f"document.{direction}",
            "documentId": document_id,
            "requestId": idempotency_key,
            "idempotencyKey": idempotency_key,
            "inputs": {},
            "parameters": {},
        }
        if expected_revision is not None:
            payload["baseRevision"] = expected_revision
        return await self._post(payload)

    async def summary(self, document_id: str) -> dict[str, Any]:
        return await self._post({
            "protocolVersion": 1,
            "operation": "document.summary",
            "documentId": document_id,
            "inputs": {},
            "parameters": {},
        }, read_only=True)

    async def view(self, document_id: str, *, offset: int = 0, limit: int = 50) -> dict[str, Any]:
        return await self._post({"protocolVersion": 1, "operation": "document.view", "documentId": document_id,
                                 "inputs": {}, "parameters": {"offset": offset, "limit": limit}}, read_only=True)

    async def property_list(self, document_id: str) -> dict[str, Any]:
        return await self._post({"protocolVersion": 1, "operation": "property.list", "documentId": document_id,
                                 "inputs": {}, "parameters": {}}, read_only=True)

    async def measure(
        self,
        document_id: str,
        body_id: str,
        selection_type: str = "body",
        selection_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._post({
            "protocolVersion": 1,
            "operation": "geometry.measure",
            "documentId": document_id,
            "inputs": {
                "bodyId": body_id,
                "selectionType": selection_type,
                "selectionId": selection_id or body_id,
            },
            "parameters": {},
        }, read_only=True)

    async def model_query(self, document_id: str, *, kind: str = "geometry-tree",
                          body_id: str | None = None, feature_id: str | None = None) -> dict[str, Any]:
        return await self._get_json("/api/agent/model/query", params={
            "documentId": document_id, "kind": kind, "bodyId": body_id or "", "featureId": feature_id or "",
        })

    async def check(self, document_id: str, body_id: str) -> dict[str, Any]:
        return await self._post({
            "protocolVersion": 1,
            "operation": "geometry.check",
            "documentId": document_id,
            "inputs": {"bodyId": body_id},
            "parameters": {},
        }, read_only=True)

    async def relation(self, document_id: str, body_a: str, body_b: str,
                       tolerance: float = 1.0e-6) -> dict[str, Any]:
        return await self._post({
            "protocolVersion": 1,
            "operation": "geometry.relation",
            "documentId": document_id,
            "inputs": {"bodyA": body_a, "bodyB": body_b},
            "parameters": {"tolerance": tolerance},
        }, read_only=True)

    async def execute(self, action: ActionEnvelope) -> Observation:
        started = perf_counter()
        cached = None
        if action.idempotency_key:
            cached = getattr(self, "idempotency", {}).get(action.idempotency_key)
        if cached is not None:
            return Observation.model_validate(cached)
        try:
            inputs, parameters = _gateway_arguments(action.arguments)
            request_payload = {
                "protocolVersion": 1,
                "operation": action.tool_name,
                "documentId": action.document_id,
                "requestId": action.action_id,
                "idempotencyKey": action.idempotency_key,
                "inputs": inputs,
                "parameters": parameters,
                "options": {"agentPlanId": action.run_id},
            }
            if action.expected_revision is not None: request_payload["baseRevision"] = action.expected_revision
            payload = await self._post(request_payload)
            result = Observation(
                action_id=action.action_id,
                success=True,
                result=payload,
                before_revision=action.expected_revision,
                after_revision=_revision(payload),
                duration_ms=int((perf_counter() - started) * 1000),
            )
        except GatewayError as exc:
            error_class = (
                ErrorClass.REVISION_CONFLICT if exc.status_code == 409 or exc.code in {"STALE_REVISION", "REVISION_CONFLICT"}
                else ErrorClass.TOOL_OUTCOME_UNKNOWN if exc.code in {"GATEWAY_TRANSPORT_UNKNOWN", "GATEWAY_OUTCOME_UNKNOWN"}
                else ErrorClass.PROTOCOL_INCOMPATIBLE if exc.code in {"INVALID_GATEWAY_RESPONSE", "PROTOCOL_INCOMPATIBLE", "RESPONSE_TOO_LARGE"}
                else ErrorClass.TOOL_TRANSIENT if exc.status_code is not None and exc.status_code >= 500
                else ErrorClass.NON_RECOVERABLE
            )
            result = Observation(
                action_id=action.action_id,
                success=False,
                before_revision=action.expected_revision,
                after_revision=action.expected_revision,
                duration_ms=int((perf_counter() - started) * 1000),
                error_code=exc.code,
                error_class=error_class,
                result={"error": str(exc), "status_code": exc.status_code},
            )
        if not hasattr(self, "idempotency"):
            self.idempotency: dict[str, dict[str, Any]] = {}
        self.idempotency[action.idempotency_key] = result.model_dump(mode="json")
        return result

    async def preview(self, action: ActionEnvelope) -> dict[str, Any]:
        inputs, parameters = _gateway_arguments(action.arguments)
        payload = {
            "protocolVersion": 1,
            "operation": action.tool_name,
            "documentId": action.document_id,
            "requestId": action.action_id,
            "inputs": inputs,
            "parameters": parameters,
            "options": {"preview": True, "agentPlanId": action.run_id},
        }
        if action.expected_revision is not None: payload["baseRevision"] = action.expected_revision
        return await self._post(payload, read_only=True)

    async def execute_batch(self, actions: list[ActionEnvelope]) -> list[Observation]:
        if not actions:
            return []
        document_ids = {action.document_id for action in actions}
        if len(document_ids) != 1:
            raise GatewayError("A batch cannot span documents", code="BATCH_DOCUMENT_MISMATCH")
        batch_id = canonical_hash({"actions": [action.action_hash for action in actions]})
        payload = {
            "protocolVersion": 1,
            "batchId": batch_id,
            "documentId": actions[0].document_id,
            "steps": [
                {
                    "stepId": action.step_id,
                    "operation": action.tool_name,
                    "requestId": action.action_id,
                    "idempotencyKey": action.idempotency_key,
                    "inputs": _gateway_arguments(action.arguments)[0],
                    "parameters": _gateway_arguments(action.arguments)[1],
                }
                for action in actions
            ],
        }
        if actions[0].expected_revision is not None: payload["baseRevision"] = actions[0].expected_revision
        try:
            response = await self.client.post("/api/command-batches", json=payload, headers={"X-Correlation-ID": batch_id})
            if len(response.content) > self.max_response_bytes:
                raise GatewayError("Gateway batch response exceeds configured limit", code="RESPONSE_TOO_LARGE",
                                   status_code=response.status_code)
            body = response.json()
        except (httpx.TimeoutException, httpx.NetworkError, ValueError) as exc:
            raise GatewayError(str(exc), code="BATCH_OUTCOME_UNKNOWN") from exc
        if not isinstance(body, dict):
            raise GatewayError("Gateway batch response must be an object", code="INVALID_BATCH_RESPONSE",
                               status_code=response.status_code)
        if response.status_code >= 400 or body.get("ok") is False:
            code = str(body.get("code") or "BATCH_FAILED")
            error_class = ErrorClass.REVISION_CONFLICT if code in {"REVISION_CONFLICT", "STALE_REVISION"} else ErrorClass.NON_RECOVERABLE
            return [Observation(action_id=action.action_id, success=False, error_code=code,
                                error_class=error_class, result=body) for action in actions]
        raw_results = body.get("results") if isinstance(body, dict) else None
        if not isinstance(raw_results, list) or len(raw_results) != len(actions):
            raise GatewayError("Batch response does not contain one result per action", code="INVALID_BATCH_RESPONSE")
        observations: list[Observation] = []
        for action, result in zip(actions, raw_results):
            ok = bool(result.get("ok", result.get("success", False))) if isinstance(result, dict) else False
            observations.append(Observation(
                action_id=action.action_id,
                success=ok,
                result=result if isinstance(result, dict) else {"value": result},
                before_revision=action.expected_revision,
                after_revision=_revision(result if isinstance(result, dict) else {}),
                error_code=None if ok else str(result.get("code") or "BATCH_STEP_FAILED"),
                error_class=None if ok else ErrorClass.NON_RECOVERABLE,
            ))
        return observations


def _revision(payload: dict[str, Any]) -> int | None:
    value = payload.get("revision")
    if value is None and isinstance(payload.get("result"), dict):
        value = payload["result"].get("revision")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
