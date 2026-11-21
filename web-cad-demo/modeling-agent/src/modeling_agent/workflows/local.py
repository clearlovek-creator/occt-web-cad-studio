from __future__ import annotations

import math
import re
from typing import Any

from modeling_agent.adapters.geometry import FakeGeometryAdapter
from modeling_agent.application.store import InMemoryRepository
from modeling_agent.capabilities.registry import CapabilityRegistry
from modeling_agent.context.engine import ContextEngine
from modeling_agent.domain.models import (
    AgentRun,
    ConfigSnapshot,
    AntennaGoal,
    ApprovalDecision,
    ElicitationRequest,
    EventType,
    ModelingPlan,
    RunStatus,
    Stage,
    SuccessCriterion,
    TheoryAnalysisResult,
    new_id,
)
from modeling_agent.execution.service import ExecutionService
from modeling_agent.theory.patch import RectangularPatchCalculator
from modeling_agent.modeling.parameters import validate_box_parameter_changes
from modeling_agent.verification.geometry import GeometryVerifier
from modeling_agent.workflows.router import InputRouter


class LocalWorkflowEngine:
    """A deterministic first-stage engine.

    It mirrors the LangGraph node boundaries. The optional LangGraph adapter
    can later delegate these same node functions to a durable graph runtime.
    """

    def __init__(
        self,
        repository: InMemoryRepository | None = None,
        geometry: Any | None = None,
        registry: CapabilityRegistry | None = None,
    ) -> None:
        self.repository = repository or InMemoryRepository()
        self.geometry = geometry or FakeGeometryAdapter()
        self.registry = registry or CapabilityRegistry()
        self.router = InputRouter()
        self.context = ContextEngine(self.repository, self.registry)
        self.execution = ExecutionService(self.repository, self.registry, self.geometry)
        self.pending_goals: dict[str, AntennaGoal] = {}

    def create_run(
        self,
        *,
        project_id: str,
        document_id: str,
        user_id: str,
        message: str,
        template_id: str | None = None,
        autonomy_level: str = "supervised",
        client_creation: dict[str, Any] | None = None,
    ) -> AgentRun:
        snapshot = ConfigSnapshot(
            snapshot_id=new_id("config"),
            graph_version="phase1-local-1",
            tool_registry_version=self.registry.version,
            settings={"workflow_engine": "local", "autonomy_level": autonomy_level,
                      **({"client_creation": client_creation} if client_creation else {})},
        )
        self.repository.save_config_snapshot(snapshot)
        run = AgentRun(
            id=client_creation["client_run_id"] if client_creation else new_id("run"),
            project_id=project_id,
            document_id=document_id,
            user_id=user_id,
            config_snapshot_id=snapshot.snapshot_id,
            document_revision=self.geometry.current_revision(document_id),
        )
        self.repository.create_run(run)
        self.repository.append_event(run.id, EventType.RUN_STARTED, {"message": message})
        self.run(run.id, message)
        return self.repository.get_run(run.id)

    def get_status(self, run_id: str) -> AgentRun:
        return self.repository.get_run(run_id)

    def run(self, run_id: str, message: str) -> AgentRun:
        run = self.repository.get_run(run_id)
        if run.status in {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}:
            return run
        if run.status == RunStatus.CREATED:
            self.repository.transition(run_id, RunStatus.RUNNING)
        self.repository.append_event(run_id, EventType.STAGE_ENTERED, {"stage": Stage.REQUIREMENTS})
        goal = self._parse_goal(message)
        self.repository.save_goal(run_id, 1, goal.model_dump(mode="json"))
        run = self.repository.get_run(run_id)
        run.goal_version = 1
        self.repository.update_run(run)
        self.repository.append_event(run_id, EventType.GOAL_PARSED, goal.model_dump(mode="json"))
        missing = self._missing_fields(goal)
        if missing:
            question = ElicitationRequest(
                request_id=new_id("question"),
                run_id=run_id,
                reason_code="required_fields_missing",
                question=f"还缺少这些信息：{', '.join(missing)}。请补充。",
                expected_schema={"fields": missing},
            )
            self.repository.save_question(question)
            run = self.repository.get_run(run_id)
            run.status = RunStatus.WAITING_USER
            run.current_stage = Stage.REQUIREMENTS
            run.waiting_request_id = question.request_id
            self.repository.update_run(run)
            self.repository.append_event(
                run_id,
                EventType.USER_INPUT_REQUESTED,
                question.model_dump(mode="json"),
            )
            return run
        return self._continue_after_requirements(run_id, goal)

    def respond(
        self, run_id: str, request_id: str, response: Any, *, expected_run_version: int | None = None
    ) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status != RunStatus.WAITING_USER or run.waiting_request_id != request_id:
            raise ValueError("The Run is not waiting for this request")
        self.repository.append_event(run_id, EventType.USER_INPUT_RECEIVED, {"response": response})
        old_goal = AntennaGoal.model_validate(self.repository.get_goal(run_id, run.goal_version))
        try:
            goal = self._merge_response(old_goal, response)
        except ValueError as exc:
            question = ElicitationRequest(
                request_id=new_id("question"),
                run_id=run_id,
                reason_code="invalid_response",
                question="刚才的回答无法通过参数校验，请按提示修正天线类型、频率或单位后重试。",
                expected_schema={"fields": ["antenna_type", "center_frequency_hz"], "error": str(exc)},
            )
            self.repository.save_question(question)
            run.status = RunStatus.WAITING_USER
            run.current_stage = Stage.REQUIREMENTS
            run.waiting_request_id = question.request_id
            run.last_error = {"code": "INVALID_USER_RESPONSE", "detail": str(exc)}
            self.repository.update_run(run)
            self.repository.append_event(run_id, EventType.USER_INPUT_REQUESTED, question.model_dump(mode="json"))
            return run
        new_version = run.goal_version + 1
        self.repository.save_goal(run_id, new_version, goal.model_dump(mode="json"))
        run.goal_version = new_version
        run.status = RunStatus.RUNNING
        run.waiting_request_id = None
        self.repository.update_run(run)
        if self._missing_fields(goal):
            return self.run(run_id, response)
        return self._continue_after_requirements(run_id, goal)

    def decide_approval(
        self,
        run_id: str,
        approval_id: str,
        decision: ApprovalDecision,
        *,
        expected_run_version: int | None = None,
    ) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status != RunStatus.WAITING_APPROVAL or run.waiting_approval_id != approval_id:
            raise ValueError("The Run is not waiting for this approval")
        approval = self.execution.decide_approval(approval_id, decision)
        run = self.repository.get_run(run_id)
        run.waiting_approval_id = None
        if decision != ApprovalDecision.APPROVE:
            question = ElicitationRequest(
                request_id=new_id("question"),
                run_id=run_id,
                reason_code="approval_rejected",
                question="本次建模审批未通过。请说明要修改的建模目标或参数，系统会重新生成计划。",
                expected_schema={"fields": ["goal_or_parameter_changes"]},
            )
            self.repository.save_question(question)
            run.status = RunStatus.WAITING_USER
            run.current_stage = Stage.REQUIREMENTS
            run.waiting_request_id = question.request_id
            run.last_error = {"code": "ACTION_REJECTED", "action_id": approval.action_id}
            self.repository.update_run(run)
            self.repository.append_event(run_id, EventType.USER_INPUT_REQUESTED, question.model_dump(mode="json"))
            return run
        run.status = RunStatus.RUNNING
        self.repository.update_run(run)
        return self._execute_current_action(run_id, action_id=approval.action_id)

    def change_parameters(
        self, run_id: str, changes: dict[str, Any], *, expected_run_version: int | None = None
    ) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status not in {RunStatus.COMPLETED, RunStatus.FAILED}:
            raise ValueError("Parameters can only be changed after the current run is terminal")
        normalized = validate_box_parameter_changes(changes)
        previous = max(
            self.repository.list_actions(run_id),
            key=lambda item: item.created_at,
            default=None,
        )
        if previous is None:
            raise ValueError("No previous modeling action exists for this Run")
        arguments = dict(previous.arguments)
        arguments.update(normalized)
        run.status = RunStatus.RUNNING
        run.current_stage = Stage.PLANNING
        run.waiting_request_id = None
        run.waiting_approval_id = None
        self.repository.update_run(run)
        action = self.execution.propose(
            run,
            tool_name=previous.tool_name,
            arguments=arguments,
            reason="User requested a parameter change; create a new revision after approval.",
            success_criteria=[{"name": "body_exists", "operator": "eq", "target": True}],
        )
        approval = self.execution.request_approval(action)
        run = self.repository.get_run(run_id)
        run.status = RunStatus.WAITING_APPROVAL
        run.current_stage = Stage.POLICY
        run.waiting_approval_id = approval.approval_id
        self.repository.update_run(run)
        return run

    def cancel(self, run_id: str, *, expected_run_version: int | None = None) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status in {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}:
            return run
        run.status = RunStatus.CANCELLED
        run.waiting_request_id = None
        run.waiting_approval_id = None
        run.paused_from_status = None
        self.repository.update_run(run)
        self.repository.append_event(run_id, EventType.RUN_CANCELLED, {})
        return run

    def pause(self, run_id: str, *, expected_run_version: int | None = None) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status == RunStatus.PAUSED:
            return run
        if run.status not in {RunStatus.WAITING_USER, RunStatus.WAITING_APPROVAL, RunStatus.WAITING_EXTERNAL}:
            raise ValueError("A Run can only pause at a safe waiting boundary")
        run.paused_from_status = run.status
        run.status = RunStatus.PAUSED
        self.repository.update_run(run)
        self.repository.append_event(run_id, EventType.RUN_PAUSED, {"from_status": run.paused_from_status.value})
        return run

    def resume(self, run_id: str, *, expected_run_version: int | None = None) -> AgentRun:
        run = self.repository.get_run(run_id)
        self._assert_run_version(run, expected_run_version)
        if run.status != RunStatus.PAUSED:
            raise ValueError("A Run is not paused")
        previous = run.paused_from_status or RunStatus.WAITING_USER
        run.status = previous
        run.paused_from_status = None
        self.repository.update_run(run)
        self.repository.append_event(run_id, EventType.RUN_RESUMED, {"to_status": previous.value})
        return run

    def _continue_after_requirements(self, run_id: str, goal: AntennaGoal) -> AgentRun:
        self.repository.append_event(run_id, EventType.STAGE_ENTERED, {"stage": Stage.THEORY})
        theory = self._theory(goal)
        self.repository.append_event(run_id, EventType.GOAL_PARSED, {"theory": theory.model_dump(mode="json")})
        width = next(item["value_m"] for item in theory.derived_parameters if item["name"] == "width")
        depth = next(item["value_m"] for item in theory.derived_parameters if item["name"] in {"length", "depth"})
        height = goal.substrate_thickness_m or 0.0016
        plan = ModelingPlan(
            plan_id=new_id("plan"),
            run_id=run_id,
            goal_version=self.repository.get_run(run_id).goal_version,
            summary="创建一个基础矩形体作为第一阶段参数化建模样例",
            actions=[
                {
                    "tool_name": "geometry.create_box",
                    "arguments": {
                        "document_id": self.repository.get_run(run_id).document_id,
                        "width_m": width,
                        "depth_m": depth,
                        "height_m": height,
                    },
                }
            ],
        )
        self.repository.append_event(run_id, EventType.PLAN_CREATED, plan.model_dump(mode="json"))
        run = self.repository.get_run(run_id)
        action = self.execution.propose(
            run,
            tool_name="geometry.create_box",
            arguments=plan.actions[0]["arguments"],
            reason=plan.summary,
            success_criteria=[{"name": "body_exists", "operator": "eq", "target": True}],
        )
        approval = self.execution.request_approval(action)
        run = self.repository.get_run(run_id)
        run.status = RunStatus.WAITING_APPROVAL
        run.current_stage = Stage.POLICY
        run.waiting_approval_id = approval.approval_id
        self.repository.update_run(run)
        return run

    def _execute_current_action(self, run_id: str, *, action_id: str | None = None) -> AgentRun:
        run = self.repository.get_run(run_id)
        if action_id is not None:
            action = self.repository.get_action(action_id)
        else:
            action = self.repository.list_actions(run_id)[-1]
        observation = self.execution.execute(action.action_id)
        self.repository.append_event(run_id, EventType.OBSERVATION_RECORDED, observation.model_dump(mode="json"))
        run = self.repository.get_run(run_id)
        if not observation.success:
            run.status = RunStatus.FAILED
            run.last_error = {"code": observation.error_code or "ACTION_FAILED"}
            self.repository.update_run(run)
            self.repository.append_event(run_id, EventType.RUN_FAILED, run.last_error)
            return run
        run.document_revision = observation.after_revision or run.document_revision
        run.current_stage = Stage.VERIFICATION
        summary = self.geometry.summary(str(action.arguments.get("document_id", run.document_id)))
        verification = GeometryVerifier().verify_box(action, observation, summary)
        verification_passed = verification.passed
        self.repository.append_event(
            run_id,
            EventType.VERIFICATION_PASSED if verification_passed else EventType.VERIFICATION_FAILED,
            verification.model_dump(mode="json"),
        )
        run.status = RunStatus.COMPLETED if verification_passed else RunStatus.FAILED
        run.current_stage = Stage.COMPLETION if verification_passed else Stage.VERIFICATION
        self.repository.update_run(run)
        self.repository.append_event(
            run_id,
            EventType.RUN_COMPLETED if verification_passed else EventType.RUN_FAILED,
            {"document_revision": run.document_revision},
        )
        return run

    @staticmethod
    def _assert_run_version(run: AgentRun, expected_run_version: int | None) -> None:
        if expected_run_version is not None and run.run_version != expected_run_version:
            raise ValueError(
                f"Run version conflict: expected {expected_run_version}, current {run.run_version}"
            )

    @staticmethod
    def _parse_goal(message: str) -> AntennaGoal:
        text = message.strip()
        frequency_match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(GHz|MHz|Hz)", text, re.I)
        frequency_hz = None
        if frequency_match:
            value = float(frequency_match.group(1))
            multiplier = {"ghz": 1e9, "mhz": 1e6, "hz": 1}[frequency_match.group(2).lower()]
            frequency_hz = value * multiplier
        thickness_match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*mm", text, re.I)
        thickness_m = float(thickness_match.group(1)) / 1000 if thickness_match else None
        return AntennaGoal(
            original_request=text,
            antenna_type="rectangular_patch" if "贴片" in text or "patch" in text.lower() else None,
            center_frequency_hz=frequency_hz,
            substrate_material="FR-4" if "fr-4" in text.lower() else None,
            substrate_thickness_m=thickness_m,
            success_criteria=[
                SuccessCriterion(name="body_exists", operator="eq", target=True)
            ],
        )

    @staticmethod
    def _missing_fields(goal: AntennaGoal) -> list[str]:
        missing = []
        if goal.antenna_type is None:
            missing.append("antenna_type")
        if goal.center_frequency_hz is None:
            missing.append("center_frequency_hz")
        return missing

    @staticmethod
    def _merge_response(goal: AntennaGoal, response: Any) -> AntennaGoal:
        if isinstance(response, dict):
            candidate = goal.model_dump(mode="json")
            candidate.update(response)
            return AntennaGoal.model_validate(candidate)
        response = str(response)
        frequency_match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(GHz|MHz|Hz)", response, re.I)
        thickness_match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*mm", response, re.I)
        updates: dict[str, Any] = {}
        if frequency_match:
            updates["center_frequency_hz"] = float(frequency_match.group(1)) * {
                "ghz": 1e9, "mhz": 1e6, "hz": 1
            }[frequency_match.group(2).lower()]
        if thickness_match:
            updates["substrate_thickness_m"] = float(thickness_match.group(1)) / 1000
        if "贴片" in response or "patch" in response.lower():
            updates["antenna_type"] = "rectangular_patch"
        candidate = goal.model_dump(mode="json")
        candidate.update(updates)
        return AntennaGoal.model_validate(candidate)

    @staticmethod
    def _theory(goal: AntennaGoal) -> TheoryAnalysisResult:
        return RectangularPatchCalculator().calculate(goal)
