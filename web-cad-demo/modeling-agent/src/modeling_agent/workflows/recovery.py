from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from modeling_agent.domain.models import ErrorClass


class RecoveryRoute(StrEnum):
    RETRY_SAME_ACTION = "retry_same_action"
    QUERY_ACTION_STATUS = "query_action_status"
    REFRESH_WORLD_MODEL = "refresh_world_model"
    REPLAN_CURRENT_STAGE = "replan_current_stage"
    RETURN_TO_REQUIREMENTS = "return_to_requirements"
    WAIT_FOR_USER = "wait_for_user"
    ESCALATE_TO_HUMAN = "escalate_to_human"
    FAIL_RUN = "fail_run"


@dataclass(frozen=True, slots=True)
class RecoveryDecision:
    route: RecoveryRoute
    reason: str
    retryable: bool = False


class RecoveryRouter:
    """Deterministic safety router; it never grants permission to write."""

    def decide(self, error_class: ErrorClass | None, *, retry_count: int = 0, result_unknown: bool = False) -> RecoveryDecision:
        if error_class == ErrorClass.TOOL_TRANSIENT:
            if result_unknown:
                return RecoveryDecision(RecoveryRoute.QUERY_ACTION_STATUS, "write result is unknown")
            if retry_count < 2:
                return RecoveryDecision(RecoveryRoute.RETRY_SAME_ACTION, "transient tool failure within retry budget", True)
            return RecoveryDecision(RecoveryRoute.ESCALATE_TO_HUMAN, "transient retry budget exhausted")
        if error_class == ErrorClass.REVISION_CONFLICT:
            return RecoveryDecision(RecoveryRoute.REFRESH_WORLD_MODEL, "document revision changed")
        if error_class == ErrorClass.VERIFICATION_FAILED:
            return RecoveryDecision(RecoveryRoute.REPLAN_CURRENT_STAGE, "observed state failed verification")
        if error_class == ErrorClass.USER_FIXABLE:
            return RecoveryDecision(RecoveryRoute.WAIT_FOR_USER, "user input is required")
        if error_class == ErrorClass.LLM_RECOVERABLE and retry_count < 2:
            return RecoveryDecision(RecoveryRoute.REPLAN_CURRENT_STAGE, "structured model output can be repaired", True)
        return RecoveryDecision(RecoveryRoute.FAIL_RUN, "error is not automatically recoverable")
