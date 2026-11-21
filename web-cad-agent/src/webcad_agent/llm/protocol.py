from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


@dataclass(frozen=True)
class ModelResponse:
    model: str
    content: str
    input_tokens: int = 0
    output_tokens: int = 0
    provider_request_id: str | None = None


class LLMModel(Protocol):
    async def complete(self, *, system: str, user: str, response_schema: dict[str, Any], context: dict[str, Any]) -> ModelResponse: ...


class StructuredModelError(ValueError):
    pass


async def complete_structured(model: LLMModel, *, system: str, user: str, schema: type[T], context: dict[str, Any]) -> T:
    response = await model.complete(system=system, user=user, response_schema=schema.model_json_schema(), context=context)
    try:
        raw = json.loads(response.content)
    except json.JSONDecodeError as exc:
        raise StructuredModelError("Model response is not valid JSON") from exc
    try:
        return schema.model_validate(raw)
    except Exception as exc:
        raise StructuredModelError(f"Model response does not match {schema.__name__}") from exc


class FakeModel:
    def __init__(self, responses: list[dict[str, Any]], model: str = "fake-model") -> None:
        self.responses = list(responses); self.model = model; self.calls = 0

    async def complete(self, *, system: str, user: str, response_schema: dict[str, Any], context: dict[str, Any]) -> ModelResponse:
        if not self.responses: raise RuntimeError("FakeModel has no response")
        self.calls += 1
        return ModelResponse(model=self.model, content=json.dumps(self.responses.pop(0), ensure_ascii=False),
                             provider_request_id=f"fake-{self.calls}")
