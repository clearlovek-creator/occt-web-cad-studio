from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import httpx

from .protocol import ModelResponse


class HttpJsonModel:
    """Provider-neutral structured model adapter for a configured local/remote endpoint."""

    def __init__(self, endpoint: str, *, timeout_seconds: float = 60.0, client: httpx.AsyncClient | None = None,
                 max_response_bytes: int = 4 * 1024 * 1024, allow_insecure_remote: bool = False) -> None:
        self.endpoint = endpoint
        parsed = urlparse(endpoint)
        if (client is None and parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
                and not allow_insecure_remote):
            raise ValueError("Remote model endpoint must use HTTPS unless allow_insecure_remote=True")
        self.max_response_bytes = max(1024, max_response_bytes)
        self.client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._owns_client = client is None

    async def close(self) -> None:
        if self._owns_client: await self.client.aclose()

    async def complete(self, *, system: str, user: str, response_schema: dict[str, Any], context: dict[str, Any]) -> ModelResponse:
        try:
            response = await self.client.post(self.endpoint, json={"system": system, "user": user,
                                                                     "response_schema": response_schema, "context": context})
            if len(response.content) > self.max_response_bytes:
                raise RuntimeError("Structured model response exceeds configured limit")
            response.raise_for_status(); payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise RuntimeError(f"Structured model request failed: {exc}") from exc
        if not isinstance(payload, dict): raise RuntimeError("Structured model response must be a JSON object")
        content = payload.get("content") or payload.get("output_text") or payload.get("text")
        if not isinstance(content, str): raise RuntimeError("Structured model response has no text content")
        return ModelResponse(model=str(payload.get("model") or "http-json"), content=content,
                             input_tokens=int(payload.get("input_tokens") or 0), output_tokens=int(payload.get("output_tokens") or 0),
                             provider_request_id=str(payload.get("request_id")) if payload.get("request_id") else None)
