from __future__ import annotations

from typing import Any

from ..domain.models import AgentPlan, AgentRun
from ..llm.protocol import LLMModel, complete_structured
from ..tools.registry import ToolRegistry
from .planner import validate_plan


class StructuredPlanner:
    """Optional model-backed planner; model output is data only and is revalidated."""

    def __init__(self, model: LLMModel, registry: ToolRegistry) -> None:
        self.model, self.registry = model, registry

    async def plan(self, *, run: AgentRun, user_goal: str, context: dict[str, Any]) -> AgentPlan:
        allowed_tools = context.get("available_tools")
        if not isinstance(allowed_tools, list) or not allowed_tools:
            allowed_tools = [item.model_dump(mode="json") for item in self.registry.list()]
        result = await complete_structured(
            self.model,
            system="Return only a JSON AgentPlan. Use only the supplied Tool names and preserve side_effect/risk metadata. Never emit HTTP requests or hidden reasoning.",
            user=user_goal,
            schema=AgentPlan,
            context={"run": run.model_dump(mode="json"), "allowed_tools": allowed_tools,
                     "allowed_skills": context.get("available_skills", []), **context},
        )
        if result.run_id != run.run_id or result.document_id != run.document_id:
            raise ValueError("Model plan cannot change run or document identity")
        result = result.model_copy(update={"registry_version": self.registry.version})
        return validate_plan(result, self.registry)
