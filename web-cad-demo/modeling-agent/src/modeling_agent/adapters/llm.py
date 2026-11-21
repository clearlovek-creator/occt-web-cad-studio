from __future__ import annotations

import json
import time
from typing import Any

import httpx

from modeling_agent.agents.react import ModelResponse, ToolCall


class OpenAICompatibleModel:
    """Minimal Chat Completions adapter used by bounded cognitive subgraphs.

    The workflow does not depend on a vendor SDK. Any provider exposing the
    OpenAI-compatible ``/chat/completions`` contract can be injected here.
    """

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str | None,
        model: str,
        timeout_seconds: float = 60.0,
        retry_attempts: int = 2,
        retry_backoff_seconds: float = 0.25,
        system_prompt: str | None = None,
    ) -> None:
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=httpx.Timeout(timeout_seconds),
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
        )
        self.model = model
        self.retry_attempts = max(1, retry_attempts)
        self.retry_backoff_seconds = max(0.0, retry_backoff_seconds)
        self.system_prompt = system_prompt or (
            "You are a bounded engineering reasoning step. Use only the declared tools. "
            "When you have enough evidence, return only a JSON object matching the requested schema."
        )

    def close(self) -> None:
        self.client.close()

    def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ModelResponse:
        normalized: list[dict[str, Any]] = [{"role": "system", "content": self.system_prompt}]
        for message in messages:
            item = dict(message)
            content = item.get("content")
            if isinstance(content, (dict, list)):
                item["content"] = json.dumps(content, ensure_ascii=False, separators=(",", ":"))
            if item.get("role") == "assistant" and item.get("tool_calls"):
                item["tool_calls"] = [
                    {
                        "id": call.get("id") or f"call-{index}",
                        "type": "function",
                        "function": {
                            "name": call.get("name", ""),
                            "arguments": json.dumps(call.get("arguments", {}), ensure_ascii=False),
                        },
                    }
                    for index, call in enumerate(item["tool_calls"])
                ]
            if item.get("role") == "tool" and "tool_call_id" not in item:
                item["tool_call_id"] = f"call-{len(normalized)}"
            normalized.append(item)
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": normalized,
            "temperature": 0,
        }
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool.get("description", ""),
                        "parameters": tool.get("input_schema", {"type": "object"}),
                    },
                }
                for tool in tools
            ]
            payload["tool_choice"] = "auto"
        response: httpx.Response | None = None
        for attempt in range(self.retry_attempts):
            try:
                response = self.client.post("/chat/completions", json=payload)
                response.raise_for_status()
                break
            except (httpx.TimeoutException, httpx.NetworkError):
                if attempt + 1 >= self.retry_attempts:
                    raise
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code not in {408, 425, 429} and exc.response.status_code < 500:
                    raise
                if attempt + 1 >= self.retry_attempts:
                    raise
            if self.retry_backoff_seconds:
                time.sleep(self.retry_backoff_seconds * (2**attempt))
        if response is None:  # pragma: no cover - defensive guard
            raise RuntimeError("LLM request did not return a response")
        body = response.json()
        choice = (body.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        calls: list[ToolCall] = []
        for raw in message.get("tool_calls") or []:
            function = raw.get("function") or {}
            arguments = function.get("arguments", {})
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError as exc:
                    raise ValueError("Model returned invalid JSON tool arguments") from exc
            if not isinstance(arguments, dict):
                raise ValueError("Model tool arguments must be an object")
            calls.append(ToolCall(id=raw.get("id"), name=str(function.get("name", "")), arguments=arguments))
        content = message.get("content") or ""
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        structured: dict[str, Any] | None = None
        candidate = text.strip()
        if candidate.startswith("```"):
            candidate = candidate.strip("`").removeprefix("json").strip()
        if candidate.startswith("{"):
            try:
                decoded = json.loads(candidate)
            except json.JSONDecodeError:
                decoded = None
            if isinstance(decoded, dict):
                structured = decoded
        return ModelResponse(text=text, tool_calls=calls, structured_output=structured)
