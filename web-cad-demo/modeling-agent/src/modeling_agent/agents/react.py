from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter
from typing import Any, Callable, Protocol

from pydantic import BaseModel, Field

from modeling_agent.capabilities.registry import CapabilityRegistry
from modeling_agent.telemetry import agent_span


class ToolCall(BaseModel):
    id: str | None = None
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ModelResponse(BaseModel):
    text: str = ""
    tool_calls: list[ToolCall] = Field(default_factory=list)
    structured_output: dict[str, Any] | None = None


class ModelPort(Protocol):
    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> ModelResponse: ...


ToolFunction = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True, slots=True)
class ReActBudget:
    max_iterations: int = 5
    max_tool_calls: int = 8
    max_duration_seconds: float = 30.0


class ReActResult(BaseModel):
    status: str
    text: str = ""
    structured_output: dict[str, Any] | None = None
    tool_calls: int = 0
    iterations: int = 0
    error: str | None = None


class BoundedReActAgent:
    """A small, auditable tool loop for a single workflow subgraph."""

    def __init__(
        self,
        model: ModelPort,
        registry: CapabilityRegistry,
        functions: dict[str, ToolFunction],
        *,
        stage: str,
        budget: ReActBudget | None = None,
    ) -> None:
        self.model = model
        self.registry = registry
        self.functions = functions
        self.stage = stage
        self.budget = budget or ReActBudget()

    def run(self, input_context: dict[str, Any]) -> ReActResult:
        messages: list[dict[str, Any]] = [{"role": "user", "content": input_context}]
        tool_definitions = [
            {
                "name": definition.name,
                "description": definition.description,
                "input_schema": definition.input_schema,
            }
            for definition in self.registry.list_for_stage(self.stage)
        ]
        tool_calls = 0
        started = perf_counter()
        for iteration in range(1, self.budget.max_iterations + 1):
            if perf_counter() - started >= self.budget.max_duration_seconds:
                return ReActResult(status="budget_exhausted", tool_calls=tool_calls, iterations=iteration - 1, error="max_duration_seconds exceeded")
            try:
                with agent_span("llm.complete", {"stage": self.stage, "iteration": iteration}):
                    response = self.model.complete(messages, tool_definitions)
            except Exception as exc:
                return ReActResult(status="model_failed", tool_calls=tool_calls, iterations=iteration, error=f"{type(exc).__name__}: {exc}")
            if response.structured_output is not None and not response.tool_calls:
                return ReActResult(
                    status="completed",
                    text=response.text,
                    structured_output=response.structured_output,
                    tool_calls=tool_calls,
                    iterations=iteration,
                )
            if not response.tool_calls:
                return ReActResult(
                    status="completed",
                    text=response.text,
                    tool_calls=tool_calls,
                    iterations=iteration,
                )
            messages.append({"role": "assistant", "content": response.text, "tool_calls": [call.model_dump(mode="json") for call in response.tool_calls]})
            for call in response.tool_calls:
                tool_calls += 1
                if tool_calls > self.budget.max_tool_calls:
                    return ReActResult(
                        status="budget_exhausted",
                        tool_calls=tool_calls,
                        iterations=iteration,
                        error="max_tool_calls exceeded",
                    )
                try:
                    definition = self.registry.require(call.name, self.stage)
                    function = self.functions.get(definition.name)
                    if function is None:
                        raise LookupError(f"No implementation registered for Tool {call.name}")
                    with agent_span("react.tool", {"stage": self.stage, "tool_name": definition.name}):
                        result = function(call.arguments)
                except Exception as exc:
                    return ReActResult(
                        status="tool_failed",
                        tool_calls=tool_calls,
                        iterations=iteration,
                        error=f"{type(exc).__name__}: {exc}",
                    )
                messages.append(
                    {
                        "role": "tool",
                        "name": call.name,
                        "tool_call_id": call.id or f"call-{tool_calls}",
                        "content": result,
                    }
                )
        return ReActResult(
            status="budget_exhausted",
            tool_calls=tool_calls,
            iterations=self.budget.max_iterations,
            error="max_iterations exceeded",
        )
