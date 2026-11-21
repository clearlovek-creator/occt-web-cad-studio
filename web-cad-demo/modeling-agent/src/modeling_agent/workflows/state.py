from typing import Any, TypedDict


class GraphState(TypedDict, total=False):
    run_id: str
    current_stage: str
    project_id: str | None
    document_id: str | None
    user_id: str | None
    context_pack: dict[str, Any] | None
    goal_version: int
    user_message: str
    structured_goal: dict[str, Any]
    missing_fields: list[str]
    validation_errors: list[str]
    user_response: Any
    theory_result: dict[str, Any]
    theory_repair_count: int
    react_result: dict[str, Any] | None
    plan: dict[str, Any]
    plan_errors: list[str]
    plan_repair_count: int
    parameter_overrides: dict[str, Any]
    template_id: str | None
    plan_approval_granted: bool
    next_action_index: int
    current_action_id: str | None
    requires_approval: bool
    policy_decision: dict[str, Any] | None
    pending_approval_id: str | None
    pending_request_id: str | None
    approval_decision: str | None
    last_observation: dict[str, Any] | None
    world_summary: dict[str, Any] | None
    last_verification: dict[str, Any] | None
    successful_action_ids: list[str]
    rollback_result: dict[str, Any] | None
    recovery_route: str | None
    retry_counts: dict[str, int]
    status: str
    error: dict[str, Any] | None
