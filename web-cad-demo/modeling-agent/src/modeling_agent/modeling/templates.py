from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from modeling_agent.domain.models import AntennaGoal, ModelingPlan, new_id
from modeling_agent.theory.patch import RectangularPatchCalculator


@dataclass(frozen=True, slots=True)
class RectangularPatchStackTemplate:
    """Build a deterministic two-solid patch stack plan without executing it."""

    template_id: str = "antenna.rectangular_patch_stack"
    version: str = "1"
    margin_factor: float = 6.0
    default_conductor_thickness_m: float = 35e-6

    def build(self, *, run_id: str, goal_version: int, goal: AntennaGoal, document_id: str) -> ModelingPlan:
        theory = RectangularPatchCalculator().calculate(goal)
        derived = {
            item["name"]: item.get("value_m")
            for item in theory.derived_parameters
            if item.get("name") and item.get("value_m") is not None
        }
        assumptions = {item["name"]: item.get("value") for item in theory.assumptions if item.get("name")}
        patch_width = float(derived["width"])
        patch_length = float(derived["length"])
        substrate_height = float(goal.substrate_thickness_m or 0.0016)
        conductor_height = self.default_conductor_thickness_m
        margin = max(0.003, self.margin_factor * substrate_height)
        substrate_width = patch_width + 2.0 * margin
        substrate_length = patch_length + 2.0 * margin
        patch_x = margin
        patch_y = margin
        actions = [
            {
                "tool_name": "geometry.create_box",
                "role": "substrate",
                "arguments": {
                    "document_id": document_id,
                    "width_m": substrate_width,
                    "depth_m": substrate_length,
                    "height_m": substrate_height,
                    "x_m": 0.0,
                    "y_m": 0.0,
                    "z_m": 0.0,
                },
                "success_criteria": [{"name": "substrate_exists", "operator": "eq", "target": True}],
            },
            {
                "tool_name": "geometry.create_box",
                "role": "patch_conductor",
                "arguments": {
                    "document_id": document_id,
                    "width_m": patch_width,
                    "depth_m": patch_length,
                    "height_m": conductor_height,
                    "x_m": patch_x,
                    "y_m": patch_y,
                    "z_m": substrate_height,
                },
                "success_criteria": [{"name": "patch_exists", "operator": "eq", "target": True}],
            },
        ]
        return ModelingPlan(
            plan_id=new_id("plan"),
            run_id=run_id,
            goal_version=goal_version,
            summary="Create a substrate solid and a conductor patch solid in dependency order.",
            template_id=self.template_id,
            template_version=self.version,
            resolved_parameters={
                "patch_width_m": patch_width,
                "patch_length_m": patch_length,
                "substrate_width_m": substrate_width,
                "substrate_length_m": substrate_length,
                "substrate_thickness_m": substrate_height,
                "conductor_thickness_m": conductor_height,
                "margin_m": margin,
            },
            dependencies=[
                {"before": "substrate", "after": "patch_conductor", "reason": "patch z origin depends on substrate thickness"},
            ],
            material_requirements=[
                {"role": "substrate", "material": goal.substrate_material or "FR-4", "relative_permittivity": float(assumptions.get("relative_permittivity", 4.3)), "assignment": "planned_only"},
                {"role": "patch_conductor", "material": "copper", "conductivity_s_per_m": 5.8e7, "assignment": "planned_only"},
            ],
            simulation_preflight={
                "status": "not_configured",
                "solver": None,
                "required_inputs": ["frequency_range", "boundary_conditions", "excitation", "mesh_policy", "output_requests"],
                "note": "Phase one stops at auditable geometry and material requirements; no solver is started.",
            },
            execution_boundary="geometry_only",
            actions=actions,
        )


class ModelingTemplateRegistry:
    def __init__(self) -> None:
        self._templates = {
            "antenna.rectangular_patch_stack": RectangularPatchStackTemplate(),
        }

    def get(self, template_id: str) -> RectangularPatchStackTemplate:
        try:
            return self._templates[template_id]
        except KeyError as exc:
            raise ValueError(f"Unknown modeling template: {template_id}") from exc
