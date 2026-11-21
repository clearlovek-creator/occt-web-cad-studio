from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex}"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=False)


class RunStatus(StrEnum):
    CREATED = "created"
    RUNNING = "running"
    WAITING_USER = "waiting_user"
    WAITING_APPROVAL = "waiting_approval"
    WAITING_EXTERNAL = "waiting_external"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PAUSED = "paused"


class Stage(StrEnum):
    INTAKE = "intake"
    REQUIREMENTS = "requirements"
    THEORY = "theory"
    PLANNING = "planning"
    POLICY = "policy"
    EXECUTION = "execution"
    OBSERVATION = "observation"
    VERIFICATION = "verification"
    COMPLETION = "completion"


class InputRoute(StrEnum):
    DIRECT_ANSWER = "direct_answer"
    READ_QUERY = "read_query"
    START_WORKFLOW = "start_workflow"
    CONTINUE_ACTIVE_RUN = "continue_active_run"
    CHANGE_ACTIVE_GOAL = "change_active_goal"
    APPROVAL_RESPONSE = "approval_response"
    CANCEL_RUN = "cancel_run"
    CLARIFY_ROUTE = "clarify_route"
    REJECTED = "rejected"


class SideEffect(StrEnum):
    PURE = "pure"
    READ = "read"
    WRITE = "write"


class RiskLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ApprovalDecision(StrEnum):
    APPROVE = "approve"
    REJECT = "reject"
    EDIT = "edit"


class ActionStatus(StrEnum):
    PROPOSED = "proposed"
    APPROVAL_PENDING = "approval_pending"
    APPROVED = "approved"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class EventType(StrEnum):
    RUN_CREATED = "run.created"
    RUN_STARTED = "run.started"
    STAGE_ENTERED = "stage.entered"
    GOAL_PARSED = "goal.parsed"
    USER_INPUT_REQUESTED = "user_input.requested"
    USER_INPUT_RECEIVED = "user_input.received"
    PLAN_CREATED = "plan.created"
    ACTION_PROPOSED = "action.proposed"
    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_DECIDED = "approval.decided"
    ACTION_STARTED = "action.started"
    ACTION_SUCCEEDED = "action.succeeded"
    ACTION_FAILED = "action.failed"
    OBSERVATION_RECORDED = "observation.recorded"
    VERIFICATION_PASSED = "verification.passed"
    VERIFICATION_FAILED = "verification.failed"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"
    RUN_CANCELLED = "run.cancelled"
    RUN_PAUSED = "run.paused"
    RUN_RESUMED = "run.resumed"
    ROLLBACK_STARTED = "rollback.started"
    ROLLBACK_SUCCEEDED = "rollback.succeeded"
    ROLLBACK_FAILED = "rollback.failed"
    REACT_COMPLETED = "react.completed"
    REACT_FAILED = "react.failed"
    RECOVERY_ROUTED = "recovery.routed"
    ROUTING_DECIDED = "routing.decided"
    POLICY_DECIDED = "policy.decided"


class ErrorClass(StrEnum):
    USER_FIXABLE = "user_fixable"
    LLM_RECOVERABLE = "llm_recoverable"
    TOOL_TRANSIENT = "tool_transient"
    REVISION_CONFLICT = "revision_conflict"
    POLICY_DENIED = "policy_denied"
    VERIFICATION_FAILED = "verification_failed"
    NON_RECOVERABLE = "non_recoverable"


class SuccessCriterion(StrictModel):
    name: str
    operator: str
    target: float | str
    unit: str | None = None
    required: bool = True


class AntennaGoal(StrictModel):
    original_request: str
    antenna_type: str | None = None
    center_frequency_hz: float | None = Field(default=None, gt=0)
    bandwidth_hz: float | None = Field(default=None, gt=0)
    min_gain_dbi: float | None = None
    max_s11_db: float | None = None
    substrate_material: str | None = None
    substrate_thickness_m: float | None = Field(default=None, gt=0)
    constraints: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    success_criteria: list[SuccessCriterion] = Field(default_factory=list)
    confirmed_fields: set[str] = Field(default_factory=set)


class RoutingDecision(StrictModel):
    decision_id: str = Field(default_factory=lambda: new_id("route"))
    route: InputRoute
    confidence: float = Field(ge=0, le=1)
    reason_codes: list[str] = Field(default_factory=list)
    target_run_id: str | None = None
    target_request_id: str | None = None
    extracted_payload: dict[str, Any] = Field(default_factory=dict)
    required_capabilities: list[str] = Field(default_factory=list)
    risk_hint: RiskLevel = RiskLevel.LOW
    router_version: str = "rules-2"
    candidate_routes: list[str] = Field(default_factory=list)
    llm_used: bool = False


class PolicyDecision(StrictModel):
    allowed: bool
    requires_approval: bool
    tool_name: str
    risk_level: RiskLevel
    side_effect: SideEffect
    reason: str
    policy_version: str = "policy-1"


class AgentRun(StrictModel):
    id: str
    project_id: str
    document_id: str
    user_id: str
    status: RunStatus = RunStatus.CREATED
    current_stage: Stage = Stage.INTAKE
    run_version: int = 0
    goal_version: int = 0
    graph_version: str = "phase1-local-1"
    config_snapshot_id: str
    document_revision: int = 0
    waiting_request_id: str | None = None
    waiting_approval_id: str | None = None
    paused_from_status: RunStatus | None = None
    last_error: dict[str, Any] | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ConfigSnapshot(StrictModel):
    snapshot_id: str
    graph_version: str
    tool_registry_version: str
    policy_version: str = "policy-1"
    settings: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)


class ActionRequest(StrictModel):
    action_id: str
    run_id: str
    tool_name: str
    tool_version: str = "1"
    arguments: dict[str, Any] = Field(default_factory=dict)
    side_effect: SideEffect
    risk_level: RiskLevel
    expected_document_revision: int | None = None
    idempotency_key: str
    reason: str
    success_criteria: list[dict[str, Any]] = Field(default_factory=list)
    action_hash: str
    status: ActionStatus = ActionStatus.PROPOSED
    created_at: datetime = Field(default_factory=utc_now)


class Observation(StrictModel):
    action_id: str
    success: bool
    result: dict[str, Any] = Field(default_factory=dict)
    before_revision: int | None = None
    after_revision: int | None = None
    artifact_refs: list[str] = Field(default_factory=list)
    duration_ms: int = 0
    error_code: str | None = None
    error_class: ErrorClass | None = None


class VerificationCheck(StrictModel):
    name: str
    passed: bool
    expected: Any = None
    actual: Any = None
    message: str | None = None


class VerificationResult(StrictModel):
    action_id: str
    passed: bool
    checks: list[VerificationCheck] = Field(default_factory=list)
    actual_values: dict[str, Any] = Field(default_factory=dict)
    failure_reason: str | None = None
    recommended_route: str | None = None


class ApprovalRequest(StrictModel):
    approval_id: str
    run_id: str
    action_id: str
    action_hash: str
    summary: str
    impact: list[str] = Field(default_factory=list)
    expires_at: datetime
    allowed_decisions: list[ApprovalDecision] = Field(
        default_factory=lambda: [ApprovalDecision.APPROVE, ApprovalDecision.REJECT, ApprovalDecision.EDIT]
    )
    decision: ApprovalDecision | None = None
    decision_payload: dict[str, Any] = Field(default_factory=dict)


class ElicitationRequest(StrictModel):
    request_id: str
    run_id: str
    reason_code: str
    question: str
    expected_schema: dict[str, Any]
    choices: list[dict[str, Any]] | None = None
    current_value: Any = None
    recommended_value: Any = None


class AgentEvent(StrictModel):
    event_id: str
    run_id: str
    sequence_number: int
    event_type: EventType
    actor: str
    correlation_id: str
    causation_id: str | None = None
    schema_version: str = "1"
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime = Field(default_factory=utc_now)


class TheoryAnalysisResult(StrictModel):
    method: str
    assumptions: list[dict[str, Any]] = Field(default_factory=list)
    derived_parameters: list[dict[str, Any]] = Field(default_factory=list)
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    requires_user_confirmation: bool = False


class ModelingPlan(StrictModel):
    plan_id: str
    run_id: str
    goal_version: int
    summary: str
    actions: list[dict[str, Any]]
    template_id: str | None = None
    template_version: str | None = None
    resolved_parameters: dict[str, Any] = Field(default_factory=dict)
    dependencies: list[dict[str, Any]] = Field(default_factory=list)
    approval_groups: list[dict[str, Any]] = Field(default_factory=list)
    material_requirements: list[dict[str, Any]] = Field(default_factory=list)
    simulation_preflight: dict[str, Any] = Field(default_factory=dict)
    execution_boundary: str = "geometry_only"
    status: str = "validated"


class ContextSource(StrictModel):
    source_id: str
    source_type: str
    version: str | None = None
    trust_level: str
    captured_at: datetime = Field(default_factory=utc_now)
    document_revision: int | None = None


class ContextPack(StrictModel):
    context_pack_id: str
    run_id: str
    node_name: str
    goal_snapshot: dict[str, Any] = Field(default_factory=dict)
    current_user_intent: dict[str, Any] = Field(default_factory=dict)
    world_model_summary: dict[str, Any] = Field(default_factory=dict)
    active_plan_slice: list[dict[str, Any]] = Field(default_factory=list)
    recent_observations: list[dict[str, Any]] = Field(default_factory=list)
    applicable_constraints: list[dict[str, Any]] = Field(default_factory=list)
    available_tools: list[dict[str, Any]] = Field(default_factory=list)
    knowledge_excerpts: list[dict[str, Any]] = Field(default_factory=list)
    pending_interaction: dict[str, Any] | None = None
    budgets: dict[str, Any] = Field(default_factory=dict)
    sources: list[ContextSource] = Field(default_factory=list)
    freshness: dict[str, Any] = Field(default_factory=dict)
    context_schema_version: str = "1"
