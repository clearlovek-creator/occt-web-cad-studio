from __future__ import annotations

import json
from collections import deque
from typing import Any

from pydantic import Field

from modeling_agent.agents.react import ModelPort
from modeling_agent.capabilities.registry import CapabilityRegistry
from modeling_agent.domain.models import ModelingPlan, StrictModel, new_id


class PlannerTask(StrictModel):
    """One semantic task proposed by the LLM planner."""

    task_id: str
    title: str
    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)
    reason: str = ""
    success_criteria: list[dict[str, Any]] = Field(default_factory=list)
    approval_group: str = "default"


class PlannerDAG(StrictModel):
    """Structured, auditable task graph returned by the planning model."""

    schema_version: str = "1"
    summary: str
    assumptions: list[str] = Field(default_factory=list)
    tasks: list[PlannerTask] = Field(min_length=1)
    success_criteria: list[dict[str, Any]] = Field(default_factory=list)
    approval_groups: list[dict[str, Any]] = Field(default_factory=list)
    execution_boundary: str = "geometry_only"


class PlannerValidationError(ValueError):
    pass


def _topological_order(tasks: list[PlannerTask]) -> list[PlannerTask]:
    by_id = {task.task_id: task for task in tasks}
    if len(by_id) != len(tasks):
        raise PlannerValidationError("planner returned duplicate task_id values")
    indegree = {task.task_id: 0 for task in tasks}
    outgoing: dict[str, list[str]] = {task.task_id: [] for task in tasks}
    for task in tasks:
        if task.task_id in task.depends_on:
            raise PlannerValidationError(f"task {task.task_id} cannot depend on itself")
        for dependency in task.depends_on:
            if dependency not in by_id:
                raise PlannerValidationError(f"task {task.task_id} depends on unknown task {dependency}")
            indegree[task.task_id] += 1
            outgoing[dependency].append(task.task_id)
    ready = deque(task.task_id for task in tasks if indegree[task.task_id] == 0)
    ordered: list[PlannerTask] = []
    while ready:
        task_id = ready.popleft()
        ordered.append(by_id[task_id])
        for child in outgoing[task_id]:
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(child)
    if len(ordered) != len(tasks):
        raise PlannerValidationError("planner returned a cyclic task graph")
    return ordered


class StructuredPlanner:
    """Ask an LLM for a task DAG, then validate it against registered Tools."""

    def __init__(self, model: ModelPort, registry: CapabilityRegistry, *, max_tasks: int = 32) -> None:
        self.model = model
        self.registry = registry
        self.max_tasks = max(1, max_tasks)

    def plan(self, context: dict[str, Any]) -> PlannerDAG:
        schema = PlannerDAG.model_json_schema()
        tool_catalog = [
            {
                "name": definition.name,
                "description": definition.description,
                "input_schema": definition.input_schema,
                "side_effect": definition.side_effect.value,
                "risk_level": definition.risk_level.value,
            }
            for definition in self.registry.list_for_stage("execution")
        ]
        system = (
            "You are the CAD task decomposition planner. Return only a JSON object matching the supplied schema. "
            "Build a dependency-aware DAG of concrete registered Tools. Do not invent tools, parameters, geometry, "
            "or simulation results. Keep units explicit in argument names. Each task must have a stable task_id, "
            "a reason, success criteria, and an approval_group. The executor will validate every write."
        )
        request = {
            "goal": context.get("goal", {}),
            "theory": context.get("theory", {}),
            "document": context.get("document", {}),
            "user_request": context.get("user_request", ""),
            "available_tools": tool_catalog,
            "output_schema": schema,
        }
        response = self.model.complete(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": request},
            ],
            [],
        )
        payload = response.structured_output
        if payload is None:
            candidate = response.text.strip()
            try:
                payload = json.loads(candidate)
            except (TypeError, json.JSONDecodeError) as exc:
                raise PlannerValidationError("planner did not return structured JSON") from exc
        dag = PlannerDAG.model_validate(payload)
        if len(dag.tasks) > self.max_tasks:
            raise PlannerValidationError(f"planner returned {len(dag.tasks)} tasks; maximum is {self.max_tasks}")
        ordered = _topological_order(dag.tasks)
        expected_document_id = context.get("document_id")
        for task in ordered:
            if expected_document_id is not None and task.arguments.get("document_id") not in {None, expected_document_id}:
                raise PlannerValidationError(
                    f"task {task.task_id}: document_id must remain scoped to {expected_document_id}"
                )
            try:
                self.registry.validate_arguments(task.tool_name, task.arguments, "execution")
            except (ValueError, PermissionError) as exc:
                raise PlannerValidationError(f"task {task.task_id}: {exc}") from exc
        groups = {task.approval_group for task in ordered}
        declared_groups = {str(item.get("group_id")) for item in dag.approval_groups if isinstance(item, dict)}
        undeclared = groups - declared_groups if declared_groups else set()
        if undeclared:
            raise PlannerValidationError(f"planner omitted approval groups: {sorted(undeclared)}")
        return dag.model_copy(update={"tasks": ordered})


def compile_planner_dag(dag: PlannerDAG, *, run_id: str, goal_version: int) -> ModelingPlan:
    """Compile the validated DAG into the existing execution plan contract."""

    dependencies = [
        {"before": dependency, "after": task.task_id, "reason": f"{task.task_id} depends on {dependency}"}
        for task in dag.tasks
        for dependency in task.depends_on
    ]
    actions = [
        {
            "task_id": task.task_id,
            "title": task.title,
            "tool_name": task.tool_name,
            "arguments": task.arguments,
            "reason": task.reason,
            "success_criteria": task.success_criteria,
            "approval_group": task.approval_group,
            "depends_on": task.depends_on,
        }
        for task in dag.tasks
    ]
    return ModelingPlan(
        plan_id=new_id("plan"),
        run_id=run_id,
        goal_version=goal_version,
        summary=dag.summary,
        actions=actions,
        approval_groups=dag.approval_groups,
        dependencies=dependencies,
        simulation_preflight={"success_criteria": dag.success_criteria},
        execution_boundary=dag.execution_boundary,
    )
