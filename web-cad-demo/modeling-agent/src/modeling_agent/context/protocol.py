from __future__ import annotations

from typing import Any, Protocol

from modeling_agent.domain.models import ContextPack
from modeling_agent.context.engine import ContextBudget


class ContextEnginePort(Protocol):
    """Dependency boundary for node-scoped context construction."""

    def build(
        self,
        *,
        run_id: str,
        node_name: str,
        budget: ContextBudget | None = None,
        user_intent: dict[str, Any] | None = None,
        world_model: dict[str, Any] | None = None,
        plan: list[dict[str, Any]] | None = None,
        knowledge: list[dict[str, Any]] | None = None,
        plan_version: int | None = None,
        policy_version: str = "policy-1",
    ) -> ContextPack: ...

    def is_fresh(
        self,
        pack: ContextPack,
        *,
        run_id: str | None = None,
        node_name: str | None = None,
        plan_version: int | None = None,
        policy_version: str = "policy-1",
    ) -> bool: ...
