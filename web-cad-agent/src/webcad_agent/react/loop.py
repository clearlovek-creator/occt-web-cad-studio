from __future__ import annotations

from dataclasses import dataclass, field
from time import monotonic
from typing import Any, Awaitable, Callable


@dataclass(frozen=True)
class ReactBudget:
    max_steps: int = 6
    max_tool_calls: int = 8
    max_write_actions: int = 2
    wall_clock_seconds: float = 30.0
    token_budget: int = 4000


@dataclass(frozen=True)
class ReactDecision:
    kind: str  # act | finish | clarify | replan | stop
    tool_name: str | None = None
    arguments: dict[str, Any] = field(default_factory=dict)
    reason: str = ""


@dataclass(frozen=True)
class ReactResult:
    status: str
    steps: list[dict[str, Any]]
    stop_reason: str


class BoundedReAct:
    """Structured Decide/Act/Observe/Verify loop with hard budgets."""

    def __init__(self, *, decide: Callable[[list[dict[str, Any]]], Awaitable[ReactDecision]],
                 act: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]],
                 observe: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
                 verify: Callable[[dict[str, Any]], Awaitable[bool]],
                 allowed_tools: set[str], write_tools: set[str] | None = None,
                 budget: ReactBudget | None = None) -> None:
        self.decide, self.act, self.observe, self.verify = decide, act, observe, verify
        self.allowed_tools = allowed_tools
        self.write_tools = write_tools or set()
        self.budget = budget or ReactBudget()

    async def run(self, initial: dict[str, Any]) -> ReactResult:
        started = monotonic(); trace: list[dict[str, Any]] = [{"stage": "input", "data": initial}]
        tool_calls = write_calls = 0
        for index in range(self.budget.max_steps):
            if monotonic() - started > self.budget.wall_clock_seconds:
                return ReactResult("stopped", trace, "wall_clock_budget")
            decision = await self.decide(trace)
            trace.append({"stage": "decide", "step": index, "decision": decision.__dict__})
            if decision.kind in {"finish", "clarify", "stop", "replan"}:
                return ReactResult(decision.kind, trace, decision.reason or decision.kind)
            if decision.kind != "act" or not decision.tool_name:
                return ReactResult("stopped", trace, "invalid_decision")
            if decision.tool_name not in self.allowed_tools:
                return ReactResult("stopped", trace, "tool_not_allowed")
            tool_calls += 1
            if decision.tool_name in self.write_tools:
                write_calls += 1
            if tool_calls > self.budget.max_tool_calls or write_calls > self.budget.max_write_actions:
                return ReactResult("stopped", trace, "tool_budget")
            observation = await self.act(decision.tool_name, decision.arguments)
            trace.append({"stage": "observe", "tool": decision.tool_name, "observation": observation})
            observed = await self.observe(observation)
            trace.append({"stage": "observed", "data": observed})
            if await self.verify(observed):
                return ReactResult("completed", trace, "verification_passed")
        return ReactResult("stopped", trace, "step_budget")
