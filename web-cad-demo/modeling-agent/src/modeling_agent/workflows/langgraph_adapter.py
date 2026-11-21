from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Callable

from modeling_agent.application.store import InMemoryRepository
from modeling_agent.context.engine import ContextEngine
from modeling_agent.agents.react import ModelPort, ReActBudget
from modeling_agent.agents.theory import build_theory_react_agent
from modeling_agent.agents.planner import StructuredPlanner, compile_planner_dag
from modeling_agent.domain.models import (
    ActionRequest,
    AgentRun,
    ApprovalDecision,
    AntennaGoal,
    ErrorClass,
    EventType,
    Observation,
    PolicyDecision,
    RiskLevel,
    RunStatus,
    SideEffect,
    Stage,
    TheoryAnalysisResult,
    new_id,
)
from modeling_agent.execution.service import ExecutionService, GeometryPort
from modeling_agent.capabilities.registry import CapabilityRegistry
from modeling_agent.verification.geometry import GeometryVerifier
from modeling_agent.theory.patch import RectangularPatchCalculator
from modeling_agent.telemetry import agent_span
from modeling_agent.modeling.parameters import validate_box_parameter_changes
from modeling_agent.modeling.templates import ModelingTemplateRegistry
from modeling_agent.workflows.recovery import RecoveryRoute, RecoveryRouter


@dataclass(slots=True)
class LangGraphRuntime:
    """Runtime dependencies injected into the graph's side-effect boundary."""

    repository: InMemoryRepository
    execution: ExecutionService
    geometry: GeometryPort
    registry: CapabilityRegistry
    verifier: GeometryVerifier
    theory_agent: Any | None = None
    planner: StructuredPlanner | None = None
    cancel_checker: Callable[[str], bool] | None = None

    @classmethod
    def create(
        cls,
        repository: InMemoryRepository,
        geometry: GeometryPort,
        registry: CapabilityRegistry | None = None,
        theory_model: ModelPort | None = None,
        planner_model: ModelPort | None = None,
        theory_budget: ReActBudget | None = None,
        cancel_checker: Callable[[str], bool] | None = None,
    ) -> "LangGraphRuntime":
        resolved_registry = registry or CapabilityRegistry()
        return cls(
            repository=repository,
            execution=ExecutionService(repository, resolved_registry, geometry, cancel_checker=cancel_checker),
            geometry=geometry,
            registry=resolved_registry,
            verifier=GeometryVerifier(),
            theory_agent=(
                build_theory_react_agent(theory_model, resolved_registry, budget=theory_budget)
                if theory_model is not None
                else None
            ),
            planner=(
                StructuredPlanner(planner_model, resolved_registry)
                if planner_model is not None
                else None
            ),
            cancel_checker=cancel_checker,
        )


def _parse_goal(message: str) -> dict[str, Any]:
    text = message.strip()
    frequency_match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(GHz|MHz|Hz)", text, re.I)
    frequency_hz = None
    if frequency_match:
        frequency_hz = float(frequency_match.group(1)) * {
            "ghz": 1e9,
            "mhz": 1e6,
            "hz": 1,
        }[frequency_match.group(2).lower()]
    thickness_match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*mm", text, re.I)
    goal = {
        "original_request": text,
        "antenna_type": "rectangular_patch" if "贴片" in text or "patch" in text.lower() else None,
        "center_frequency_hz": frequency_hz,
        "substrate_material": "FR-4" if "fr-4" in text.lower() else None,
        "substrate_thickness_m": (
            float(thickness_match.group(1)) / 1000 if thickness_match else None
        ),
        "success_criteria": [{"name": "body_exists", "operator": "eq", "target": True}],
    }
    return {key: value for key, value in goal.items() if value is not None}


def _run_for(runtime: LangGraphRuntime | None, run_id: str | None) -> AgentRun | None:
    if runtime is None or not run_id:
        return None
    try:
        return runtime.repository.get_run(run_id)
    except KeyError:
        return None


def build_langgraph(
    checkpointer: Any = None,
    *,
    runtime: LangGraphRuntime | None = None,
) -> Any:
    """Build the phase-one graph.

    Without ``runtime`` the graph is a deterministic protocol test double. When
    runtime dependencies are supplied, the same graph creates a real Action,
    requests a real Approval, calls the GeometryPort, observes the document and
    runs GeometryVerifier before completing.
    """
    try:
        from langgraph.graph import END, START, StateGraph
        from langgraph.types import interrupt
    except ImportError as exc:
        raise RuntimeError(
            "LangGraph is not installed. Install modeling-agent dependencies first."
        ) from exc

    from modeling_agent.workflows.state import GraphState

    def load_run_context(state: dict[str, Any]) -> dict[str, Any]:
        run = _run_for(runtime, state.get("run_id"))
        if run is None:
            return {"current_stage": "requirements"}
        context = ContextEngine(runtime.repository, runtime.registry).build(
            run_id=run.id,
            node_name="requirements",
            user_intent={"message": state.get("user_message", "")},
        )
        return {
            "current_stage": "requirements",
            "project_id": run.project_id,
            "document_id": run.document_id,
            "user_id": run.user_id,
            "goal_version": run.goal_version,
            "context_pack": context.model_dump(mode="json"),
        }

    def parse_requirement(state: dict[str, Any]) -> dict[str, Any]:
        goal = dict(state.get("structured_goal") or {})
        if not goal and state.get("user_message"):
            goal.update(_parse_goal(str(state["user_message"])))
        parameter_overrides = dict(state.get("parameter_overrides") or {})
        response = state.get("user_response")
        if isinstance(response, dict):
            goal_fields = set(AntennaGoal.model_fields)
            goal.update({key: value for key, value in response.items() if key in goal_fields})
            parameter_overrides.update({key: value for key, value in response.items() if key not in goal_fields})
        elif response:
            parsed_response = _parse_goal(str(response))
            parsed_response.pop("original_request", None)
            goal.update(parsed_response)
        return {
            "structured_goal": goal,
            "parameter_overrides": parameter_overrides,
            "current_stage": "requirements",
            "user_response": None,
            "validation_errors": [],
        }

    def validate_requirement(state: dict[str, Any]) -> dict[str, Any]:
        goal = state.get("structured_goal") or {}
        missing = [field for field in ("antenna_type", "center_frequency_hz") if not goal.get(field)]
        errors: list[str] = []
        try:
            AntennaGoal.model_validate({"original_request": "", **goal})
        except ValueError as exc:
            errors = [str(exc)]
        return {"missing_fields": missing, "validation_errors": errors}

    def route_after_validation(state: dict[str, Any]) -> str:
        return "request_user_input" if state.get("missing_fields") or state.get("validation_errors") else "theory_analysis"

    def request_user_input(state: dict[str, Any]) -> dict[str, Any]:
        errors = state.get("validation_errors", [])
        question = (
            "请补充必填的天线类型和中心频率（例如：rectangular_patch，2.45 GHz）。"
            if errors
            else "请补充缺失的必填建模参数。"
        )
        response = interrupt({
            "kind": "elicitation",
            "reason_code": "invalid_response" if errors else "required_fields_missing",
            "question": question,
            "missing_fields": state.get("missing_fields", []),
            "validation_errors": errors,
        })
        return {"user_response": response, "missing_fields": [], "validation_errors": []}

    def theory_analysis(state: dict[str, Any]) -> dict[str, Any]:
        goal = AntennaGoal.model_validate({
            "original_request": "",
            **(state.get("structured_goal") or {}),
        })
        if runtime is not None and runtime.theory_agent is not None:
            repair_count = int(state.get("theory_repair_count", 0))
            schema_error: str | None = None
            while True:
                context = {
                    "goal": goal.model_dump(mode="json"),
                    "required_output_schema": TheoryAnalysisResult.model_json_schema(),
                    "schema_repair_attempt": repair_count,
                }
                if schema_error:
                    context["previous_schema_error"] = schema_error
                react_result = runtime.theory_agent.run(context)
                result = {
                    "status": react_result.status,
                    "text": react_result.text,
                    "tool_calls": react_result.tool_calls,
                    "iterations": react_result.iterations,
                    "error": react_result.error,
                    "schema_repair_attempt": repair_count,
                }
                react_run = _run_for(runtime, state.get("run_id"))
                if react_run is not None:
                    runtime.repository.append_event(
                        react_run.id,
                        EventType.REACT_COMPLETED if react_result.status == "completed" else EventType.REACT_FAILED,
                        result,
                    )
                if react_result.status != "completed" or react_result.structured_output is None:
                    return {
                        "current_stage": "theory",
                        "react_result": result,
                        "theory_repair_count": repair_count,
                        "status": "failed",
                        "error": {"code": "THEORY_REACT_FAILED", "detail": result},
                    }
                try:
                    theory = TheoryAnalysisResult.model_validate(react_result.structured_output)
                except Exception as exc:
                    schema_error = str(exc)
                    if repair_count >= 2:
                        return {
                            "current_stage": "theory",
                            "react_result": result,
                            "theory_repair_count": repair_count,
                            "status": "failed",
                            "error": {"code": "THEORY_SCHEMA_INVALID", "detail": schema_error, "repair_count": repair_count},
                        }
                    repair_count += 1
                    continue
                return {
                    "current_stage": "theory",
                    "theory_result": theory.model_dump(mode="json"),
                    "theory_repair_count": repair_count,
                    "react_result": {**result, "structured_output": theory.model_dump(mode="json")},
                }
        theory = RectangularPatchCalculator().calculate(goal)
        return {"current_stage": "theory", "theory_result": theory.model_dump(mode="json"), "theory_repair_count": 0}

    def route_after_theory(state: dict[str, Any]) -> str:
        return "fail_run" if state.get("status") == "failed" or state.get("error") else "build_plan"

    def record_observation_event(observation: Observation | dict[str, Any], run_id: str | None, *, actor: str) -> None:
        if runtime is None or not run_id:
            return
        run = _run_for(runtime, run_id)
        if run is None:
            return
        payload = observation.model_dump(mode="json") if isinstance(observation, Observation) else dict(observation)
        runtime.repository.append_event(
            run.id,
            EventType.OBSERVATION_RECORDED,
            payload,
            actor=actor,
        )

    def build_plan(state: dict[str, Any]) -> dict[str, Any]:
        goal = AntennaGoal.model_validate({
            "original_request": "",
            **(state.get("structured_goal") or {}),
        })
        if runtime is not None and runtime.planner is not None:
            try:
                document_id = str(state.get("document_id") or goal.model_dump().get("document_id") or "default")
                dag = runtime.planner.plan({
                    "goal": goal.model_dump(mode="json"),
                    "theory": state.get("theory_result") or {},
                    "document_id": document_id,
                    "document": runtime.geometry.summary(document_id),
                    "user_request": str(state.get("user_message") or goal.original_request),
                })
                plan_model = compile_planner_dag(
                    dag,
                    run_id=str(state.get("run_id", "preview")),
                    goal_version=int(state.get("goal_version", 1)),
                )
                runtime.repository.append_event(
                    str(state.get("run_id")),
                    EventType.PLAN_CREATED,
                    {"planner": "llm", "dag": dag.model_dump(mode="json"), "plan": plan_model.model_dump(mode="json")},
                    actor="planner",
                )
                return {
                    "current_stage": "planning",
                    "plan": plan_model.model_dump(mode="json"),
                    "plan_errors": [],
                    "plan_repair_count": int(state.get("plan_repair_count", 0)),
                    "plan_approval_granted": False,
                    "next_action_index": 0,
                    "successful_action_ids": [],
                    "retry_counts": {},
                }
            except Exception as exc:
                return {
                    "current_stage": "planning",
                    "status": "failed",
                    "error": {"code": "PLANNER_INVALID_OUTPUT", "detail": str(exc)},
                    "plan_errors": [str(exc)],
                }
        template_id = state.get("template_id")
        if template_id:
            plan_model = ModelingTemplateRegistry().get(str(template_id)).build(
                run_id=str(state.get("run_id", "preview")),
                goal_version=int(state.get("goal_version", 1)),
                goal=goal,
                document_id=str(state.get("document_id") or "default"),
            )
            plan = plan_model.model_dump(mode="json")
            return {"current_stage": "planning", "plan": plan, "plan_errors": [], "plan_repair_count": int(state.get("plan_repair_count", 0)), "plan_approval_granted": False, "next_action_index": 0, "successful_action_ids": [], "retry_counts": {}}
        if runtime is not None and runtime.planner is None and (
            "贴片" in str(state.get("user_message") or "")
            or "patch" in str(state.get("user_message") or "").lower()
        ):
            return {
                "current_stage": "planning",
                "status": "failed",
                "error": {
                    "code": "PLANNER_REQUIRED",
                    "detail": "Natural-language Patch tasks require a configured structured LLM Planner.",
                },
                "plan_errors": ["planner is not configured"],
            }
        theory = state.get("theory_result") or {}
        parameters = {
            item["name"]: item["value_m"]
            for item in theory.get("derived_parameters", [])
            if "name" in item and "value_m" in item
        }
        document_id = state.get("document_id") or goal.model_dump().get("document_id") or "default"
        action_arguments = {
            "document_id": document_id,
            "width_m": parameters.get("width", 0.061),
            "depth_m": parameters.get("length", parameters.get("depth", 0.061)),
            "height_m": goal.substrate_thickness_m or 0.0016,
        }
        overrides = state.get("parameter_overrides") or {}
        if overrides:
            action_arguments.update(validate_box_parameter_changes(dict(overrides)))
        return {
            "current_stage": "planning",
            "plan": {
                "plan_id": new_id("plan"),
                "run_id": str(state.get("run_id", "")),
                "goal_version": int(state.get("goal_version", 1)),
                "summary": "Create a parameterized phase-one rectangular solid.",
                "actions": [{"tool_name": "geometry.create_box", "arguments": action_arguments}],
            },
            "next_action_index": 0,
            "plan_approval_granted": False,
            "successful_action_ids": [],
            "retry_counts": {},
            "plan_errors": [],
            "plan_repair_count": int(state.get("plan_repair_count", 0)),
        }

    def validate_plan(state: dict[str, Any]) -> dict[str, Any]:
        plan = state.get("plan") or {}
        errors: list[str] = []
        actions = plan.get("actions") if isinstance(plan, dict) else None
        if not isinstance(actions, list) or not actions:
            errors.append("plan.actions must contain at least one action")
        else:
            for index, action in enumerate(actions):
                if not isinstance(action, dict):
                    errors.append(f"plan.actions[{index}] must be an object")
                    continue
                tool_name = action.get("tool_name")
                arguments = action.get("arguments")
                if not isinstance(tool_name, str):
                    errors.append(f"plan.actions[{index}].tool_name is required")
                    continue
                if not isinstance(arguments, dict):
                    errors.append(f"plan.actions[{index}].arguments must be an object")
                    continue
                try:
                    runtime.registry.validate_arguments(tool_name, arguments, "execution") if runtime is not None else None
                except (ValueError, PermissionError) as exc:
                    errors.append(f"plan.actions[{index}]: {exc}")
        return {"plan_errors": errors, "status": "failed" if errors else "running"}

    def route_after_plan_validation(state: dict[str, Any]) -> str:
        if not state.get("plan_errors"):
            return "prepare_action"
        if int(state.get("plan_repair_count", 0)) < 1:
            return "repair_plan"
        return "fail_run"

    def repair_plan(state: dict[str, Any]) -> dict[str, Any]:
        return {
            "plan_repair_count": int(state.get("plan_repair_count", 0)) + 1,
            "status": "running",
            "error": None,
        }

    def prepare_action(state: dict[str, Any]) -> dict[str, Any]:
        plan = state.get("plan") or {}
        actions = plan.get("actions") or [{}]
        index = int(state.get("next_action_index", 0))
        if index >= len(actions):
            raise ValueError("No pending action remains in the modeling plan")
        planned = actions[index]
        if runtime is None:
            return {"current_stage": "policy", "current_action_id": f"action-{state.get('run_id', 'test')}", "pending_approval_id": None, "approval_decision": None}
        run = _run_for(runtime, state.get("run_id"))
        if run is None:
            return {"current_stage": "policy", "current_action_id": f"action-{state.get('run_id', 'test')}", "pending_approval_id": None, "approval_decision": None}
        action = runtime.execution.propose(
            run,
            tool_name=str(planned.get("tool_name", "geometry.create_box")),
            arguments=dict(planned.get("arguments", {})),
            reason=str(planned.get("reason") or plan.get("summary", "planned modeling action")) + (f" [{planned.get('title')}]" if planned.get("title") else ""),
            success_criteria=list(planned.get("success_criteria") or [{"name": "body_exists", "operator": "eq", "target": True}]),
        )
        if (plan.get("template_id") or plan.get("approval_groups")) and state.get("plan_approval_granted"):
            # The stack was approved as one unit. Keep the per-action audit
            # trail required by ExecutionService, but do not interrupt the
            # user again for the remaining dependent writes.
            batch_approval = runtime.execution.request_approval(action)
            batch_approval.summary = "已包含在 Patch 天线堆叠审批中。"
            batch_approval.impact = ["该动作沿用本次堆叠审批，继续产生一个 CAD Revision"]
            runtime.repository.save_approval(batch_approval)
            runtime.execution.decide_approval(batch_approval.approval_id, ApprovalDecision.APPROVE)
        return {"current_stage": "policy", "current_action_id": action.action_id, "pending_approval_id": None, "approval_decision": None}

    def evaluate_policy(state: dict[str, Any]) -> dict[str, Any]:
        plan = state.get("plan") or {}
        is_batch_plan = bool(plan.get("template_id") or plan.get("approval_groups"))
        stack_approval_pending = is_batch_plan and not bool(state.get("plan_approval_granted"))
        if runtime is None:
            decision = PolicyDecision(
                allowed=True,
                requires_approval=stack_approval_pending if is_batch_plan else True,
                tool_name=str(plan.get("actions", [{}])[0].get("tool_name", "unknown")),
                risk_level=RiskLevel.MEDIUM,
                side_effect=SideEffect.WRITE,
                reason="protocol test mode requires supervised approval",
            )
        else:
            action = runtime.repository.get_action(str(state.get("current_action_id")))
            try:
                tool = runtime.registry.require(action.tool_name, "execution")
                decision = PolicyDecision(
                    allowed=True,
                    requires_approval=(
                        stack_approval_pending
                        if is_batch_plan
                        else (tool.side_effect.value == "write" or tool.risk_level.value != "low")
                    ),
                    tool_name=tool.name,
                    risk_level=tool.risk_level,
                    side_effect=tool.side_effect,
                    reason="write or non-low-risk action requires supervised approval" if tool.side_effect.value == "write" or tool.risk_level.value != "low" else "read-only low-risk action",
                )
            except (KeyError, ValueError, PermissionError) as exc:
                decision = PolicyDecision(
                    allowed=False,
                    requires_approval=False,
                    tool_name=action.tool_name,
                    risk_level=RiskLevel.HIGH,
                    side_effect=SideEffect.WRITE,
                    reason=str(exc),
                )
            runtime.repository.append_event(
                action.run_id,
                EventType.POLICY_DECIDED,
                decision.model_dump(mode="json"),
                actor="policy",
            )
        return {
            "requires_approval": decision.requires_approval,
            "policy_decision": decision.model_dump(mode="json"),
            "status": "running" if decision.allowed else "failed",
            "error": None if decision.allowed else {"code": "POLICY_DENIED", "reason": decision.reason},
        }

    def route_after_policy(state: dict[str, Any]) -> str:
        decision = state.get("policy_decision") or {}
        if not decision.get("allowed", False):
            return "fail_run"
        return "request_approval" if state.get("requires_approval") else "execute_action"

    def request_approval(state: dict[str, Any]) -> dict[str, Any]:
        if runtime is not None and runtime.cancel_checker is not None and runtime.cancel_checker(str(state.get("run_id", ""))):
            return {"status": "cancelled", "approval_decision": None, "pending_approval_id": None}
        plan = state.get("plan") or {}
        is_batch_approval = bool(plan.get("template_id") or plan.get("approval_groups"))
        approval_summary = (
            "批准 Patch 天线堆叠：基板与贴片导体将按依赖顺序连续创建。"
            if is_batch_approval
            else "Approve the parameterized geometry write."
        )
        approval_id = state.get("pending_approval_id")
        if runtime is not None and not approval_id:
            action_id = state.get("current_action_id")
            if action_id:
                action = runtime.repository.get_action(str(action_id))
                existing = next(
                    (
                        item
                        for item in runtime.repository.list_approvals(action.run_id)
                        if item.action_id == action.action_id and item.decision is None
                    ),
                    None,
                )
                approval = existing or runtime.execution.request_approval(action)
                if is_batch_approval:
                    approval.summary = approval_summary
                    approval.impact = ["将连续创建基板与贴片导体，并产生两个 CAD Revision"]
                    runtime.repository.save_approval(approval)
                approval_id = approval.approval_id
        decision = interrupt({
            "kind": "approval",
            "approval_id": approval_id,
            "action_id": state.get("current_action_id"),
            "summary": approval_summary,
        })
        if runtime is not None and approval_id:
            resolved = ApprovalDecision(str(decision))
            try:
                runtime.execution.decide_approval(str(approval_id), resolved)
            except ValueError as exc:
                if "expired" not in str(exc).lower():
                    raise
                # Expiry terminates the old approval and opens a new one. The
                # old decision is never reused, even if the Action is unchanged.
                expired = runtime.repository.get_approval(str(approval_id))
                expired.decision = ApprovalDecision.REJECT
                expired.decision_payload = {"reason": "expired"}
                runtime.repository.save_approval(expired)
                runtime.repository.append_event(
                    expired.run_id,
                    EventType.APPROVAL_DECIDED,
                    expired.model_dump(mode="json"),
                )
                action = runtime.repository.get_action(str(state.get("current_action_id")))
                fresh = runtime.execution.request_approval(action)
                fresh_decision = interrupt({
                    "kind": "approval",
                    "approval_id": fresh.approval_id,
                    "action_id": action.action_id,
                    "summary": "The previous approval expired; approve the current action again.",
                    "reason_code": "approval_expired",
                })
                runtime.execution.decide_approval(fresh.approval_id, ApprovalDecision(str(fresh_decision)))
                return {
                    "approval_decision": str(fresh_decision),
                    "pending_approval_id": fresh.approval_id,
                    "plan_approval_granted": is_batch_approval and str(fresh_decision) == ApprovalDecision.APPROVE.value,
                }
        return {
            "approval_decision": str(decision),
            "pending_approval_id": approval_id,
            "plan_approval_granted": bool(state.get("plan_approval_granted")) or (
                is_batch_approval and str(decision) == ApprovalDecision.APPROVE.value
            ),
        }

    def route_after_approval(state: dict[str, Any]) -> str:
        if state.get("status") == "cancelled":
            return "cancel_run"
        return "execute_action" if str(state.get("approval_decision")) == ApprovalDecision.APPROVE.value else "request_replan"

    def request_replan(state: dict[str, Any]) -> dict[str, Any]:
        response = interrupt({
            "kind": "elicitation",
            "reason_code": "approval_rejected",
            "question": "The proposed action was not approved. What should be changed in the current modeling goal or parameters?",
            "missing_fields": [],
        })
        return {
            "user_response": response,
            "approval_decision": None,
            "current_stage": "requirements",
            "status": "running",
        }

    def execute_action(state: dict[str, Any]) -> dict[str, Any]:
        if runtime is None:
            return {"current_stage": "execution", "last_observation": {"success": True}}
        action_id = state.get("current_action_id")
        try:
            observation = runtime.execution.execute(str(action_id))
        except RuntimeError as exc:
            observation = Observation(
                action_id=str(action_id),
                success=False,
                error_code="REVISION_CONFLICT" if "REVISION_CONFLICT" in str(exc) else "EXECUTION_FAILED",
                error_class=(ErrorClass.REVISION_CONFLICT if "REVISION_CONFLICT" in str(exc) else ErrorClass.NON_RECOVERABLE),
            )
        except Exception as exc:
            observation = Observation(
                action_id=str(action_id),
                success=False,
                error_code="EXECUTION_FAILED",
                error_class=ErrorClass.NON_RECOVERABLE,
                result={"error": str(exc)},
            )
        record_observation_event(observation, str(state.get("run_id") or ""), actor="observer")
        recovery = RecoveryRouter().decide(observation.error_class)
        recovery_run = _run_for(runtime, state.get("run_id"))
        if recovery_run is not None and not observation.success:
            runtime.repository.append_event(
                recovery_run.id,
                EventType.RECOVERY_ROUTED,
                {"action_id": str(action_id), "route": recovery.route.value, "reason": recovery.reason},
            )
        return {
            "current_stage": "execution",
            "last_observation": observation.model_dump(mode="json"),
            "recovery_route": recovery.route.value if not observation.success else None,
        }

    def observe_world(state: dict[str, Any]) -> dict[str, Any]:
        if runtime is None:
            return {"current_stage": "observation"}
        document_id = str(state.get("document_id") or "default")
        summary = runtime.geometry.summary(document_id)
        run = _run_for(runtime, state.get("run_id"))
        if run is not None and summary.get("revision") is not None:
            run.document_revision = int(summary["revision"])
            runtime.repository.update_run(run)
        return {"current_stage": "observation", "world_summary": summary}

    def route_after_observation(state: dict[str, Any]) -> str:
        observation = state.get("last_observation") or {}
        if observation.get("error_code") == "RUN_CANCELLED":
            return "cancel_run"
        if observation.get("error_class") == ErrorClass.REVISION_CONFLICT.value:
            return "refresh_world_model"
        return "recover_transient" if observation.get("error_class") == ErrorClass.TOOL_TRANSIENT.value else "verify_result"

    def refresh_world_model(state: dict[str, Any]) -> dict[str, Any]:
        if runtime is None:
            return {"status": "failed", "error": {"code": "REVISION_CONFLICT"}}
        run = _run_for(runtime, state.get("run_id"))
        document_id = str(state.get("document_id") or (run.document_id if run else "default"))
        counts = dict(state.get("retry_counts") or {})
        refresh_count = int(counts.get("__revision_refresh__", 0)) + 1
        counts["__revision_refresh__"] = refresh_count
        if refresh_count > 2:
            return {
                "status": "failed",
                "retry_counts": counts,
                "error": {"code": "REVISION_CONFLICT_RETRY_EXHAUSTED", "retry_count": refresh_count},
            }
        summary = runtime.geometry.summary(document_id)
        if run is not None and summary.get("revision") is not None:
            run.document_revision = int(summary["revision"])
            runtime.repository.update_run(run)
        # The old Action/Approval are intentionally not reused. A fresh plan
        # creates a new hash and requires a new approval at the current revision.
        return {
            "current_stage": "planning",
            "world_summary": summary,
            "next_action_index": 0,
            "current_action_id": None,
            "pending_approval_id": None,
            "approval_decision": None,
            "retry_counts": counts,
            "status": "running",
        }

    def route_after_refresh(state: dict[str, Any]) -> str:
        return "fail_run" if state.get("status") == "failed" or state.get("error") else "build_plan"

    def recover_transient(state: dict[str, Any]) -> dict[str, Any]:
        if runtime is None:
            return {"recovery_route": RecoveryRoute.FAIL_RUN.value}
        action_id = str(state.get("current_action_id") or "")
        previous = state.get("last_observation") or {}
        previous_result = previous.get("result") or {}
        if previous.get("error_code") in {"TOOL_TIMEOUT_RESULT_UNKNOWN", "GEOMETRY_TRANSPORT_UNKNOWN"} or previous_result.get("result_unknown"):
            return {
                "current_stage": "observation",
                "last_observation": previous,
                "recovery_route": RecoveryRoute.QUERY_ACTION_STATUS.value,
            }
        action = runtime.repository.get_action(action_id)
        counts = dict(state.get("retry_counts") or {})
        attempt = int(counts.get(action_id, 0))
        counts[action_id] = attempt + 1
        summary = state.get("world_summary") or {}
        expected = action.expected_document_revision
        observed_revision = summary.get("revision")
        if expected is not None and observed_revision is not None and int(observed_revision) > int(expected):
            observation = Observation(
                action_id=action_id,
                success=True,
                before_revision=expected,
                after_revision=int(observed_revision),
                result={"recovered_by_observation": True, "document_revision": int(observed_revision)},
            )
        elif attempt >= 2:
            observation = Observation(
                action_id=action_id,
                success=False,
                before_revision=expected,
                error_code="TOOL_TRANSIENT_RETRY_EXHAUSTED",
                error_class=ErrorClass.TOOL_TRANSIENT,
                result={"retry_count": attempt},
            )
        else:
            observation = runtime.execution.execute(action_id)
        record_observation_event(observation, str(state.get("run_id") or ""), actor="recovery")
        recovery = RecoveryRouter().decide(
            observation.error_class,
            retry_count=attempt,
            result_unknown=not observation.success and observation.error_class == ErrorClass.TOOL_TRANSIENT,
        )
        return {
            "current_stage": "execution",
            "last_observation": observation.model_dump(mode="json"),
            "retry_counts": counts,
            "recovery_route": recovery.route.value if not observation.success else None,
        }

    def route_after_recovery(state: dict[str, Any]) -> str:
        observation = state.get("last_observation") or {}
        result = observation.get("result") or {}
        unknown = bool(result.get("result_unknown")) or observation.get("error_code") in {
            "TOOL_TIMEOUT_RESULT_UNKNOWN",
            "GEOMETRY_TRANSPORT_UNKNOWN",
        }
        if unknown:
            return "query_action_status"
        if observation.get("success") or int((state.get("retry_counts") or {}).get(str(state.get("current_action_id")), 0)) >= 2:
            return "verify_result"
        return "observe_world"

    def route_after_action_status(state: dict[str, Any]) -> str:
        observation = state.get("last_observation") or {}
        if observation.get("success"):
            return "verify_result"
        return "fail_run"

    def query_action_status(state: dict[str, Any]) -> dict[str, Any]:
        """Resolve an unknown write outcome without issuing another write."""
        if runtime is None:
            return {
                "current_stage": "observation",
                "status": "failed",
                "error": {"code": "ACTION_STATUS_UNKNOWN"},
            }
        action_id = str(state.get("current_action_id") or "")
        action = runtime.repository.get_action(action_id)
        cached = runtime.repository.get_idempotent(action.idempotency_key)
        if cached is not None:
            observation = Observation.model_validate(cached)
            record_observation_event(observation, str(state.get("run_id") or ""), actor="action-status")
            return {
                "current_stage": "observation",
                "last_observation": observation.model_dump(mode="json"),
                "recovery_route": None,
                "status": "running",
            }
        # The current Gateway contract has no action-status endpoint. Do not
        # infer success merely because the document revision changed: that
        # change may have come from another actor. Leave an explicit manual
        # reconciliation record instead of replaying a write.
        observation = Observation(
            action_id=action_id,
            success=False,
            error_code="ACTION_STATUS_UNKNOWN",
            error_class=ErrorClass.NON_RECOVERABLE,
            result={
                "idempotency_key": action.idempotency_key,
                "requires_manual_reconciliation": True,
            },
        )
        record_observation_event(observation, str(state.get("run_id") or ""), actor="action-status")
        return {
            "current_stage": "observation",
            "last_observation": observation.model_dump(mode="json"),
            "recovery_route": RecoveryRoute.ESCALATE_TO_HUMAN.value,
            "status": "failed",
            "error": {"code": "ACTION_STATUS_UNKNOWN", "action_id": action_id},
        }

    def verify_result(state: dict[str, Any]) -> dict[str, Any]:
        observation_data = state.get("last_observation") or {"action_id": str(state.get("current_action_id")), "success": False}
        if runtime is None:
            passed = bool(observation_data.get("success"))
            return {
                "current_stage": "verification",
                "last_verification": {"passed": passed},
                "next_action_index": int(state.get("next_action_index", 0)) + 1 if passed else int(state.get("next_action_index", 0)),
            }
        action = runtime.repository.get_action(str(state.get("current_action_id")))
        observation = Observation.model_validate(observation_data)
        result = runtime.verifier.verify_box(action, observation, state.get("world_summary") or {})
        completed = list(state.get("successful_action_ids") or [])
        if observation.success and str(action.action_id) not in completed:
            completed.append(str(action.action_id))
        update = {"current_stage": "verification", "last_verification": result.model_dump(mode="json"), "successful_action_ids": completed}
        if result.passed:
            update["next_action_index"] = int(state.get("next_action_index", 0)) + 1
        return update

    def route_after_verification(state: dict[str, Any]) -> str:
        if not (state.get("last_verification") or {}).get("passed"):
            plan = state.get("plan") or {}
            if (plan.get("template_id") or plan.get("approval_groups")) and state.get("successful_action_ids"):
                return "rollback_actions"
            return "fail_run"
        plan = state.get("plan") or {}
        if int(state.get("next_action_index", 0)) < len(plan.get("actions") or []):
            return "prepare_action"
        return "complete_run"

    def rollback_actions(state: dict[str, Any]) -> dict[str, Any]:
        action_ids = list(state.get("successful_action_ids") or [])
        if runtime is None or not action_ids:
            return {"rollback_result": {"attempted": 0, "succeeded": 0, "failed": 0}, "status": "failed"}
        document_id = str(state.get("document_id") or "default")
        run = _run_for(runtime, state.get("run_id"))
        if run is not None:
            runtime.repository.append_event(run.id, EventType.ROLLBACK_STARTED, {"action_ids": action_ids, "document_id": document_id})
        results: list[dict[str, Any]] = []
        current_revision = int((state.get("world_summary") or {}).get("revision", runtime.geometry.current_revision(document_id)))
        for index, _action_id in enumerate(reversed(action_ids)):
            key = f"{state.get('run_id', 'run')}:rollback:{index}:{current_revision}"
            result = runtime.geometry.undo(document_id, current_revision, key)
            results.append(result.model_dump(mode="json"))
            if not result.success:
                break
            if result.after_revision is None:
                current_revision = runtime.geometry.current_revision(document_id)
            else:
                current_revision = int(result.after_revision)
        succeeded = sum(1 for item in results if item.get("success"))
        rollback = {"attempted": len(action_ids), "succeeded": succeeded, "failed": len(results) - succeeded, "results": results}
        if run is not None:
            run.document_revision = current_revision
            runtime.repository.update_run(run)
            runtime.repository.append_event(run.id, EventType.ROLLBACK_SUCCEEDED if succeeded == len(action_ids) else EventType.ROLLBACK_FAILED, rollback)
        return {"rollback_result": rollback, "status": "failed", "error": {"code": "VERIFICATION_FAILED_ROLLED_BACK", "rollback": rollback}}

    def cancel_run(state: dict[str, Any]) -> dict[str, Any]:
        if runtime is not None:
            run = _run_for(runtime, state.get("run_id"))
            if run is not None and run.status != RunStatus.CANCELLED:
                run.status = RunStatus.CANCELLED
                run.current_stage = Stage.COMPLETION
                runtime.repository.update_run(run)
                runtime.repository.append_event(run.id, EventType.RUN_CANCELLED, {"reason": "cancel_requested"})
        return {"current_stage": "completion", "status": "cancelled"}

    def complete_run(state: dict[str, Any]) -> dict[str, Any]:
        if runtime is not None:
            run = _run_for(runtime, state.get("run_id"))
            if run is not None:
                run.status = RunStatus.COMPLETED
                run.current_stage = Stage.COMPLETION
                observation = state.get("last_observation") or {}
                if observation.get("after_revision") is not None:
                    run.document_revision = int(observation["after_revision"])
                runtime.repository.update_run(run)
        return {"current_stage": "completion", "status": "completed"}

    def fail_run(state: dict[str, Any]) -> dict[str, Any]:
        # Preserve the stage where the workflow actually failed.  Previously
        # every failure was normalized to verification, which made planner
        # and requirements failures look as if geometry had already run.
        result_stage = str(state.get("current_stage") or "verification")
        valid_stages = {stage.value for stage in Stage}
        if result_stage not in valid_stages:
            result_stage = Stage.VERIFICATION.value
        if runtime is not None:
            run = _run_for(runtime, state.get("run_id"))
            if run is not None:
                run.status = RunStatus.FAILED
                run.current_stage = Stage(result_stage)
                run.last_error = state.get("error") or {"code": "WORKFLOW_FAILED"}
                runtime.repository.update_run(run)
        return {
            "status": "failed",
            "current_stage": result_stage,
            "error": state.get("error") or {"code": "WORKFLOW_FAILED"},
        }

    graph = StateGraph(GraphState)
    nodes = {
        "load_run_context": load_run_context,
        "parse_requirement": parse_requirement,
        "validate_requirement": validate_requirement,
        "request_user_input": request_user_input,
        "theory_analysis": theory_analysis,
        "build_plan": build_plan,
        "validate_plan": validate_plan,
        "repair_plan": repair_plan,
        "prepare_action": prepare_action,
        "evaluate_policy": evaluate_policy,
        "request_approval": request_approval,
        "request_replan": request_replan,
        "execute_action": execute_action,
        "observe_world": observe_world,
        "refresh_world_model": refresh_world_model,
        "recover_transient": recover_transient,
        "query_action_status": query_action_status,
        "verify_result": verify_result,
        "rollback_actions": rollback_actions,
        "cancel_run": cancel_run,
        "complete_run": complete_run,
        "fail_run": fail_run,
    }

    def traced_node(name: str, node: Any) -> Any:
        stage_by_node = {
            "load_run_context": "requirements",
            "parse_requirement": "requirements",
            "validate_requirement": "requirements",
            "request_user_input": "requirements",
            "request_replan": "requirements",
            "theory_analysis": "theory",
            "build_plan": "planning",
            "validate_plan": "planning",
            "repair_plan": "planning",
            "prepare_action": "policy",
            "evaluate_policy": "policy",
            "request_approval": "policy",
            "execute_action": "execution",
            "observe_world": "observation",
            "refresh_world_model": "planning",
            "recover_transient": "execution",
            "query_action_status": "observation",
            "verify_result": "verification",
            "rollback_actions": "execution",
            "cancel_run": "completion",
            "complete_run": "completion",
            "fail_run": "completion",
        }

        def invoke(state: dict[str, Any]) -> dict[str, Any]:
            with agent_span(
                f"graph.node.{name}",
                {"run_id": str(state.get("run_id", "")), "node_name": name},
            ):
                working_state = dict(state)
                context_pack = None
                run = _run_for(runtime, state.get("run_id"))
                if runtime is not None and run is not None:
                    stage_name = stage_by_node.get(name, name)
                    try:
                        stage = Stage(stage_name)
                    except ValueError:
                        stage = run.current_stage
                    if run.current_stage != stage:
                        run.current_stage = stage
                        runtime.repository.update_run(run)
                    runtime.repository.append_event(
                        run.id,
                        EventType.STAGE_ENTERED,
                        {"stage": stage.value, "node": name},
                        actor="workflow",
                    )
                    context_pack = ContextEngine(runtime.repository, runtime.registry).build(
                        run_id=run.id,
                        node_name=stage_by_node.get(name, name),
                        user_intent={"message": state.get("user_message", "")},
                        world_model=state.get("world_summary") or {},
                        plan=list((state.get("plan") or {}).get("actions") or []),
                        plan_version=(state.get("plan") or {}).get("goal_version"),
                    )
                    working_state["context_pack"] = context_pack.model_dump(mode="json")
                update = node(working_state)
                if context_pack is not None:
                    # A node may have changed Goal/Revision/Plan. Rebuild after
                    # the node so downstream nodes never receive a pre-write
                    # snapshot masquerading as fresh context.
                    after_run = _run_for(runtime, state.get("run_id"))
                    if after_run is not None:
                        refreshed = ContextEngine(runtime.repository, runtime.registry).build(
                            run_id=after_run.id,
                            node_name=stage_by_node.get(name, name),
                            user_intent={"message": state.get("user_message", "")},
                            world_model=update.get("world_summary") or state.get("world_summary") or {},
                            plan=list(((update.get("plan") or state.get("plan") or {}).get("actions") or [])),
                            plan_version=(update.get("plan") or state.get("plan") or {}).get("goal_version"),
                        )
                        update = {**update, "context_pack": refreshed.model_dump(mode="json")}
                    else:
                        update = {**update, "context_pack": context_pack.model_dump(mode="json")}
                return update
        return invoke

    for name, node in nodes.items():
        graph.add_node(name, traced_node(name, node))
    graph.add_edge(START, "load_run_context")
    graph.add_edge("load_run_context", "parse_requirement")
    graph.add_edge("parse_requirement", "validate_requirement")
    graph.add_conditional_edges("validate_requirement", route_after_validation)
    graph.add_edge("request_user_input", "parse_requirement")
    graph.add_conditional_edges("theory_analysis", route_after_theory)
    graph.add_edge("build_plan", "validate_plan")
    graph.add_conditional_edges("validate_plan", route_after_plan_validation)
    graph.add_edge("repair_plan", "build_plan")
    graph.add_edge("prepare_action", "evaluate_policy")
    graph.add_conditional_edges("evaluate_policy", route_after_policy)
    graph.add_conditional_edges("request_approval", route_after_approval)
    graph.add_edge("request_replan", "parse_requirement")
    graph.add_edge("execute_action", "observe_world")
    graph.add_conditional_edges("observe_world", route_after_observation)
    graph.add_conditional_edges("refresh_world_model", route_after_refresh)
    graph.add_conditional_edges("recover_transient", route_after_recovery)
    graph.add_conditional_edges("query_action_status", route_after_action_status)
    graph.add_conditional_edges("verify_result", route_after_verification)
    graph.add_edge("rollback_actions", "fail_run")
    graph.add_edge("cancel_run", END)
    graph.add_edge("complete_run", END)
    graph.add_edge("fail_run", END)
    return graph.compile(checkpointer=checkpointer)
