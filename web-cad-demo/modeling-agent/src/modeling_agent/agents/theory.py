from __future__ import annotations

from typing import Any

from modeling_agent.agents.react import BoundedReActAgent, ModelPort, ReActBudget
from modeling_agent.capabilities.registry import CapabilityRegistry
from modeling_agent.domain.models import AntennaGoal
from modeling_agent.theory.patch import RectangularPatchCalculator


def calculate_patch_dimensions(arguments: dict[str, Any]) -> dict[str, Any]:
    """Pure, auditable theory Tool exposed to the theory ReAct subgraph."""
    payload = dict(arguments)
    if isinstance(payload.get("goal"), dict):
        payload = {**payload["goal"], **{key: value for key, value in payload.items() if key != "goal"}}
    goal = AntennaGoal.model_validate(
        {
            "original_request": str(payload.get("original_request", "")),
            "antenna_type": payload.get("antenna_type", "rectangular_patch"),
            "center_frequency_hz": payload.get("center_frequency_hz", payload.get("frequency_hz")),
            "substrate_material": payload.get("substrate_material"),
            "substrate_thickness_m": payload.get("substrate_thickness_m", 0.0016),
        }
    )
    return RectangularPatchCalculator().calculate(goal).model_dump(mode="json")


def build_theory_react_agent(
    model: ModelPort,
    registry: CapabilityRegistry | None = None,
    *,
    budget: ReActBudget | None = None,
) -> BoundedReActAgent:
    resolved_registry = registry or CapabilityRegistry()
    return BoundedReActAgent(
        model,
        resolved_registry,
        {"calculate_patch_initial_dimensions": calculate_patch_dimensions},
        stage="theory",
        budget=budget,
    )
