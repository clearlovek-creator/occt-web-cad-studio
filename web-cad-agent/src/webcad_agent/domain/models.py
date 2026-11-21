from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex}"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RunStatus(StrEnum):
    CREATED = "created"
    RUNNING = "running"
    WAITING_USER = "waiting_user"
    WAITING_APPROVAL = "waiting_approval"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class SideEffect(StrEnum):
    PURE = "pure"
    READ = "read"
    WRITE = "write"
    DESTRUCTIVE = "destructive"


class RiskLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ActionStatus(StrEnum):
    PROPOSED = "proposed"
    APPROVAL_PENDING = "approval_pending"
    APPROVED = "approved"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class EventType(StrEnum):
    SESSION_CREATED = "session.created"
    SESSION_OPENED = "session.opened"
    MESSAGE_APPENDED = "message.appended"
    RUN_CREATED = "run.created"
    RUN_STARTED = "run.started"
    ROUTE_DECIDED = "route.decided"
    CONTEXT_BUILT = "context.built"
    PLAN_CREATED = "plan.created"
    GOAL_PARSED = "goal.parsed"
    INPUT_REQUESTED = "input.requested"
    INPUT_RECEIVED = "input.received"
    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_DECIDED = "approval.decided"
    ACTION_STARTED = "action.started"
    ACTION_SUCCEEDED = "action.succeeded"
    ACTION_FAILED = "action.failed"
    OBSERVATION_RECORDED = "observation.recorded"
    VERIFICATION_PASSED = "verification.passed"
    VERIFICATION_FAILED = "verification.failed"
    RUN_PAUSED = "run.paused"
    RUN_RESUMED = "run.resumed"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"
    RUN_CANCELLED = "run.cancelled"
    CONTEXT_COMPACTED = "context.compacted"


class ErrorClass(StrEnum):
    USER_FIXABLE = "user_fixable"
    LLM_RECOVERABLE = "llm_recoverable"
    TOOL_TRANSIENT = "tool_transient"
    TOOL_OUTCOME_UNKNOWN = "tool_outcome_unknown"
    REVISION_CONFLICT = "revision_conflict"
    POLICY_DENIED = "policy_denied"
    VERIFICATION_FAILED = "verification_failed"
    PROTOCOL_INCOMPATIBLE = "protocol_incompatible"
    NON_RECOVERABLE = "non_recoverable"


class AgentSession(StrictModel):
    session_id: str = Field(default_factory=lambda: new_id("session"))
    title: str = "Web CAD Session"
    gateway_origin: str
    document_id: str
    active_run_id: str | None = None
    last_document_revision: int | None = None
    rolling_summary: str = ""
    pinned_facts: list[dict[str, Any]] = Field(default_factory=list)
    user_preferences: dict[str, Any] = Field(default_factory=dict)
    status: Literal["active", "archived"] = "active"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    last_opened_at: datetime = Field(default_factory=utc_now)


class AgentRequest(StrictModel):
    request_id: str = Field(default_factory=lambda: new_id("request"))
    session_id: str
    text: str
    mode: Literal["readonly", "supervised", "auto"] = "supervised"
    document_id: str | None = None
    created_at: datetime = Field(default_factory=utc_now)


class Answer(StrictModel):
    text: str
    status: Literal["completed", "needs_input", "waiting_approval", "failed"] = "completed"
    document_id: str | None = None
    document_revision: int | None = None
    source_event_ids: list[str] = Field(default_factory=list)


class CadDocumentState(StrictModel):
    gateway_origin: str
    document_id: str
    revision: int | None = None
    captured_at: datetime = Field(default_factory=utc_now)
    gateway_protocol_version: int | None = None
    summary: dict[str, Any] = Field(default_factory=dict)
    entity_refs: list[dict[str, Any]] = Field(default_factory=list)
    source_fingerprint: str | None = None


class SessionMessage(StrictModel):
    message_id: str = Field(default_factory=lambda: new_id("msg"))
    session_id: str
    role: Literal["user", "assistant", "system"]
    content: str
    created_at: datetime = Field(default_factory=utc_now)
    run_id: str | None = None
    document_revision: int | None = None


class AgentRun(StrictModel):
    run_id: str = Field(default_factory=lambda: new_id("run"))
    session_id: str
    document_id: str
    goal: str
    status: RunStatus = RunStatus.CREATED
    document_revision: int | None = None
    goal_version: int = 1
    registry_version: str = "core-1"
    config_snapshot_id: str | None = None
    pending_action_id: str | None = None
    active_plan_id: str | None = None
    waiting_reason: str | None = None
    last_error: dict[str, Any] | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Goal(StrictModel):
    goal_id: str = Field(default_factory=lambda: new_id("goal"))
    run_id: str
    text: str
    version: int = 1
    confirmed_parameters: dict[str, Any] = Field(default_factory=dict)
    constraints: list[str] = Field(default_factory=list)
    source: str = "user"
    created_at: datetime = Field(default_factory=utc_now)


class ElicitationRequest(StrictModel):
    request_id: str = Field(default_factory=lambda: new_id("input"))
    run_id: str
    question: str
    fields: list[str] = Field(default_factory=list)
    candidates: list[dict[str, Any]] = Field(default_factory=list)
    status: Literal["open", "answered", "cancelled"] = "open"
    answer: dict[str, Any] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)


class ArtifactRef(StrictModel):
    artifact_id: str = Field(default_factory=lambda: new_id("artifact"))
    kind: str
    uri: str
    media_type: str | None = None
    size_bytes: int | None = None
    sha256: str | None = None
    created_at: datetime = Field(default_factory=utc_now)


class ConfigSnapshot(StrictModel):
    snapshot_id: str = Field(default_factory=lambda: new_id("config"))
    agent_version: str
    mode: str
    model_name: str | None = None
    gateway_protocol_version: int | None = None
    policy_version: str = "policy-v1"
    prompt_version: str = "prompt-v1"
    created_at: datetime = Field(default_factory=utc_now)


class RouteDecision(StrictModel):
    path: Literal["control", "read", "execute"]
    needs_cad_context: bool = False
    target_run_id: str | None = None
    required_capabilities: list[str] = Field(default_factory=list)
    risk_hint: RiskLevel = RiskLevel.LOW
    confidence: float = Field(ge=0.0, le=1.0)
    reason_codes: list[str] = Field(default_factory=list)


class ActionEnvelope(StrictModel):
    action_id: str = Field(default_factory=lambda: new_id("action"))
    run_id: str
    tool_name: str
    tool_version: str = "1"
    document_id: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    side_effect: SideEffect
    risk_level: RiskLevel
    expected_revision: int | None = None
    idempotency_key: str
    action_hash: str
    reason: str
    step_id: str | None = None
    arguments_hash: str | None = None
    success_criteria: list[dict[str, Any]] = Field(default_factory=list)
    status: ActionStatus = ActionStatus.PROPOSED
    created_at: datetime = Field(default_factory=utc_now)


class PlanStatus(StrEnum):
    PROPOSED = "proposed"
    APPROVAL_PENDING = "approval_pending"
    APPROVED = "approved"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PlanStep(StrictModel):
    step_id: str
    ordinal: int = Field(ge=0)
    tool_name: str
    tool_version: str = "1"
    arguments: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)
    result_refs: list[str] = Field(default_factory=list)
    side_effect: SideEffect = SideEffect.READ
    risk_level: RiskLevel = RiskLevel.LOW
    verifier: str | None = None
    status: ActionStatus = ActionStatus.PROPOSED


class AgentPlan(StrictModel):
    plan_id: str = Field(default_factory=lambda: new_id("plan"))
    run_id: str
    document_id: str
    goal: str
    base_revision: int | None = None
    steps: list[PlanStep] = Field(default_factory=list)
    status: PlanStatus = PlanStatus.PROPOSED
    approval_id: str | None = None
    plan_hash: str = ""
    registry_version: str = ""
    policy_mode: str = "supervised"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ApprovalRequest(StrictModel):
    approval_id: str = Field(default_factory=lambda: new_id("approval"))
    run_id: str
    action_id: str
    action_hash: str
    plan_id: str | None = None
    batch_id: str | None = None
    document_id: str | None = None
    before_revision: int | None = None
    normalized_arguments: dict[str, Any] = Field(default_factory=dict)
    parameter_sources: dict[str, str] = Field(default_factory=dict)
    affected_entities: list[dict[str, Any]] = Field(default_factory=list)
    risk_level: RiskLevel | None = None
    rollback: dict[str, Any] = Field(default_factory=dict)
    summary: str
    impact: list[str] = Field(default_factory=list)
    expected_revision: int | None = None
    expires_at: datetime
    decision: Literal["approve", "reject"] | None = None
    decided_at: datetime | None = None


class Observation(StrictModel):
    action_id: str
    success: bool
    result: dict[str, Any] = Field(default_factory=dict)
    before_revision: int | None = None
    after_revision: int | None = None
    entity_refs: list[dict[str, Any]] = Field(default_factory=list)
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
    failure_code: str | None = None
    error_vector: list[float] | None = None
    recommended_capabilities: list[str] = Field(default_factory=list)
    document_diff: dict[str, Any] = Field(default_factory=dict)


class DocumentDiff(StrictModel):
    revision_before: int | None = None
    revision_after: int | None = None
    body_ids_added: list[str] = Field(default_factory=list)
    body_ids_removed: list[str] = Field(default_factory=list)
    feature_ids_added: list[str] = Field(default_factory=list)
    feature_ids_removed: list[str] = Field(default_factory=list)
    changed_properties: list[dict[str, Any]] = Field(default_factory=list)
    invalidated_refs: list[dict[str, Any]] = Field(default_factory=list)


class EntityRef(StrictModel):
    kind: Literal["body", "feature", "face", "edge"]
    entity_id: str
    label: str | None = None
    resolved_at_revision: int


class ExpectedGeometry(StrictModel):
    entity_id: str | None = None
    coordinate_system: str = "global"
    expected_origin: list[float] | None = None
    expected_bounds_min: list[float] | None = None
    expected_bounds_max: list[float] | None = None
    expected_center: list[float] | None = None
    expected_size: list[float] | None = None
    expected_volume: float | None = None
    expected_relations: list[dict[str, Any]] = Field(default_factory=list)
    absolute_tolerance: float = 1e-6
    relative_tolerance: float = 1e-6


class ContextRequirements(StrictModel):
    include_goal: bool = False
    include_pending_interaction: bool = False
    include_active_plan: bool = True
    document_views: list[str] = Field(default_factory=list)
    entity_refs: list[str] = Field(default_factory=list)
    tool_names: list[str] = Field(default_factory=list)
    skill_names: list[str] = Field(default_factory=list)
    include_policy: bool = False
    observation_limit: int = 0
    knowledge_query: str | None = None
    token_budget: int = 4000


class ContextPack(StrictModel):
    context_pack_id: str = Field(default_factory=lambda: new_id("ctx"))
    run_id: str
    node_name: str
    current_input: dict[str, Any] = Field(default_factory=dict)
    goal: dict[str, Any] | None = None
    document: dict[str, Any] | None = None
    active_plan: dict[str, Any] | None = None
    entity_refs: list[dict[str, Any]] = Field(default_factory=list)
    observations: list[dict[str, Any]] = Field(default_factory=list)
    available_tools: list[dict[str, Any]] = Field(default_factory=list)
    available_skills: list[dict[str, Any]] = Field(default_factory=list)
    policy: dict[str, Any] | None = None
    pending_interaction: dict[str, Any] | None = None
    knowledge: list[dict[str, Any]] = Field(default_factory=list)
    budgets: dict[str, Any] = Field(default_factory=dict)
    sources: list[dict[str, Any]] = Field(default_factory=list)
    freshness: dict[str, Any] = Field(default_factory=dict)
    context_schema_version: str = "1"


class CompactionCheckpoint(StrictModel):
    checkpoint_id: str = Field(default_factory=lambda: new_id("compact"))
    session_id: str
    through_message_id: str | None = None
    rolling_summary: str
    confirmed_facts: list[dict[str, Any]] = Field(default_factory=list)
    unresolved_questions: list[dict[str, Any]] = Field(default_factory=list)
    entity_refs: list[dict[str, Any]] = Field(default_factory=list)
    completed_run_summaries: list[dict[str, Any]] = Field(default_factory=list)
    source_message_ids: list[str] = Field(default_factory=list)
    summarizer_version: str = "deterministic-v1"
    created_at: datetime = Field(default_factory=utc_now)


class AgentEvent(StrictModel):
    event_id: str = Field(default_factory=lambda: new_id("event"))
    session_id: str
    run_id: str | None = None
    sequence_number: int
    event_type: EventType
    actor: str
    correlation_id: str
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime = Field(default_factory=utc_now)
