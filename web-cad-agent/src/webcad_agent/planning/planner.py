from __future__ import annotations

import hashlib
import json
from typing import Any

from ..domain.models import AgentPlan, AgentRun, PlanStep, RiskLevel, SideEffect
from ..tools.registry import ToolRegistry


class PlanValidationError(ValueError):
    def __init__(self, message: str, *, code: str = "PLAN_INVALID") -> None:
        super().__init__(message)
        self.code = code


def _hash(plan: AgentPlan) -> str:
    payload = plan.model_dump(mode="json", exclude={"plan_hash", "status", "created_at", "updated_at"})
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate_plan(plan: AgentPlan, registry: ToolRegistry, *, max_steps: int = 32) -> AgentPlan:
    if not plan.steps or len(plan.steps) > max_steps:
        raise PlanValidationError(f"Plan must contain 1..{max_steps} steps", code="PLAN_STEP_LIMIT")
    ids = [step.step_id for step in plan.steps]
    if len(ids) != len(set(ids)):
        raise PlanValidationError("Plan step IDs must be unique", code="PLAN_DUPLICATE_STEP")
    step_ids = set(ids)
    for step in plan.steps:
        spec = registry.get(step.tool_name)
        if spec is None:
            raise PlanValidationError(f"Unknown Tool: {step.tool_name}", code="PLAN_UNKNOWN_TOOL")
        if step.tool_version != spec.version:
            raise PlanValidationError(f"Tool version mismatch for {step.tool_name}", code="PLAN_TOOL_VERSION")
        if not set(step.depends_on).issubset(step_ids):
            raise PlanValidationError(f"Step {step.step_id} has an unknown dependency", code="PLAN_UNKNOWN_DEPENDENCY")
        if spec.side_effect != step.side_effect or spec.risk_level != step.risk_level:
            raise PlanValidationError(f"Step {step.step_id} weakens Tool policy metadata", code="PLAN_POLICY_METADATA")
    _assert_acyclic(plan)
    plan.plan_hash = _hash(plan)
    return plan


def _assert_acyclic(plan: AgentPlan) -> None:
    graph = {step.step_id: set(step.depends_on) for step in plan.steps}
    visited: set[str] = set()
    active: set[str] = set()

    def visit(node: str) -> None:
        if node in active:
            raise PlanValidationError("Plan dependencies contain a cycle", code="PLAN_CYCLE")
        if node in visited:
            return
        active.add(node)
        for dependency in graph[node]:
            visit(dependency)
        active.remove(node)
        visited.add(node)

    for node in graph:
        visit(node)


class DeterministicPlanner:
    """Small, deterministic planner used before an LLM planner is enabled."""

    def __init__(self, registry: ToolRegistry) -> None:
        self.registry = registry

    def hollow_tube(self, run: AgentRun, *, outer_radius: float, inner_radius: float, height: float) -> AgentPlan:
        if not (outer_radius > inner_radius > 0 and height > 0):
            raise PlanValidationError("Require outer_radius > inner_radius > 0 and height > 0", code="INVALID_TUBE_DIMENSIONS")
        outer = self.registry.require("core.geometry.create_cylinder", stage="execute")
        inner = self.registry.require("core.geometry.create_cylinder", stage="execute")
        cut = self.registry.require("core.boolean.cut", stage="execute")
        steps = [
            PlanStep(step_id="outer-cylinder", ordinal=0, tool_name=outer.name, tool_version=outer.version,
                     arguments={"radius": outer_radius, "height": height, "label": "tube-outer"},
                     side_effect=outer.side_effect, risk_level=outer.risk_level, verifier="cylinder_geometry"),
            PlanStep(step_id="inner-cylinder", ordinal=1, tool_name=inner.name, tool_version=inner.version,
                     arguments={"radius": inner_radius, "height": height, "label": "tube-inner"},
                     side_effect=inner.side_effect, risk_level=inner.risk_level, verifier="cylinder_geometry"),
            PlanStep(step_id="cut", ordinal=2, tool_name=cut.name, tool_version=cut.version,
                     arguments={"inputs": {"targetBody": {"$ref": "outer-cylinder.body_id"}, "toolBody": {"$ref": "inner-cylinder.body_id"}}},
                     depends_on=["outer-cylinder", "inner-cylinder"], result_refs=["body_id"],
                     side_effect=cut.side_effect, risk_level=cut.risk_level, verifier="shape_valid"),
        ]
        plan = AgentPlan(run_id=run.run_id, document_id=run.document_id,
                         goal=run.goal, base_revision=run.document_revision, steps=steps,
                         registry_version=self.registry.version)
        return validate_plan(plan, self.registry)
