from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from time import perf_counter
from typing import Any, Callable, Protocol

from modeling_agent.application.store import InMemoryRepository
from modeling_agent.capabilities.registry import CapabilityRegistry
from modeling_agent.domain.models import (
    ActionRequest,
    ActionStatus,
    AgentRun,
    ApprovalDecision,
    ApprovalRequest,
    EventType,
    ErrorClass,
    Observation,
    RiskLevel,
    SideEffect,
    new_id,
)
from modeling_agent.telemetry import agent_span


class GeometryPort(Protocol):
    def current_revision(self, document_id: str) -> int: ...

    def summary(self, document_id: str) -> dict[str, Any]: ...

    def execute(self, action: ActionRequest) -> Observation: ...

    def undo(self, document_id: str, expected_revision: int, idempotency_key: str) -> Observation: ...


def canonical_hash(tool_name: str, arguments: dict[str, Any]) -> str:
    raw = json.dumps({"tool": tool_name, "arguments": arguments}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class Policy:
    def requires_approval(self, action: ActionRequest, autonomy_level: str = "supervised") -> bool:
        if action.side_effect == SideEffect.WRITE:
            return autonomy_level != "trusted"
        return False


class ExecutionService:
    def __init__(
        self,
        repository: InMemoryRepository,
        registry: CapabilityRegistry,
        geometry: GeometryPort,
        policy: Policy | None = None,
        cancel_checker: Callable[[str], bool] | None = None,
    ) -> None:
        self.repository = repository
        self.registry = registry
        self.geometry = geometry
        self.policy = policy or Policy()
        self.cancel_checker = cancel_checker

    def propose(
        self,
        run: AgentRun,
        *,
        tool_name: str,
        arguments: dict[str, Any],
        reason: str,
        success_criteria: list[dict[str, Any]],
    ) -> ActionRequest:
        arguments = self.registry.validate_arguments(tool_name, arguments, "execution")
        tool = self.registry.require(tool_name, "execution")
        action_hash = canonical_hash(tool_name, arguments)
        action = ActionRequest(
            action_id=new_id("act"),
            run_id=run.id,
            tool_name=tool.name,
            tool_version=tool.version,
            arguments=arguments,
            side_effect=tool.side_effect,
            risk_level=tool.risk_level,
            expected_document_revision=run.document_revision,
            idempotency_key=f"{run.id}:{action_hash}",
            reason=reason,
            success_criteria=success_criteria,
            action_hash=action_hash,
        )
        self.repository.save_action(action)
        self.repository.append_event(run.id, EventType.ACTION_PROPOSED, action.model_dump(mode="json"))
        return action

    def request_approval(self, action: ActionRequest) -> ApprovalRequest:
        approval = ApprovalRequest(
            approval_id=new_id("approval"),
            run_id=action.run_id,
            action_id=action.action_id,
            action_hash=action.action_hash,
            summary=f"执行 {action.tool_name}，参数：{action.arguments}",
            impact=["当前 CAD 文档将产生一个新的 Revision"],
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=30),
        )
        action.status = ActionStatus.APPROVAL_PENDING
        self.repository.save_action(action)
        self.repository.save_approval(approval)
        self.repository.append_event(
            action.run_id,
            EventType.APPROVAL_REQUESTED,
            approval.model_dump(mode="json"),
        )
        return approval

    def decide_approval(
        self,
        approval_id: str,
        decision: ApprovalDecision,
        *,
        edited_arguments: dict[str, Any] | None = None,
    ) -> ApprovalRequest:
        approval = self.repository.get_approval(approval_id)
        if approval.decision is not None:
            raise ValueError("Approval has already been decided")
        if datetime.now(timezone.utc) >= approval.expires_at:
            raise ValueError("Approval has expired")
        action = self.repository.get_action(approval.action_id)
        if edited_arguments is not None:
            new_hash = canonical_hash(action.tool_name, edited_arguments)
            if new_hash != approval.action_hash:
                raise ValueError("Edited Action must create a new approval")
        if decision not in approval.allowed_decisions:
            raise PermissionError(f"Decision is not allowed: {decision}")
        approval.decision = decision
        approval.decision_payload = {"edited_arguments": edited_arguments}
        self.repository.save_approval(approval)
        self.repository.append_event(
            approval.run_id,
            EventType.APPROVAL_DECIDED,
            approval.model_dump(mode="json"),
        )
        action.status = ActionStatus.APPROVED if decision == ApprovalDecision.APPROVE else ActionStatus.CANCELLED
        self.repository.save_action(action)
        return approval

    def execute(self, action_id: str) -> Observation:
        action = self.repository.get_action(action_id)
        cached = self.repository.get_idempotent(action.idempotency_key)
        if cached is not None:
            return Observation.model_validate(cached)
        if self.cancel_checker is not None and self.cancel_checker(action.run_id):
            action.status = ActionStatus.CANCELLED
            self.repository.save_action(action)
            return Observation(
                action_id=action.action_id,
                success=False,
                error_code="RUN_CANCELLED",
                error_class=ErrorClass.USER_FIXABLE,
                result={"cancelled": True},
            )
        if action.side_effect == SideEffect.WRITE:
            approval = next(
                (
                    item
                    for item in self.repository.list_approvals(action.run_id)
                    if item.action_id == action_id
                    and item.decision == ApprovalDecision.APPROVE
                ),
                None,
            )
            if approval is None:
                raise PermissionError("Write Action requires an approved Approval")
        document_id = str(action.arguments.get("document_id", "default"))
        actual_revision = self.geometry.current_revision(document_id)
        if action.expected_document_revision is not None and actual_revision != action.expected_document_revision:
            raise RuntimeError(
                f"REVISION_CONFLICT expected={action.expected_document_revision} actual={actual_revision}"
            )
        # A cancellation can arrive while the revision check is running.
        # Check again immediately before crossing the external write boundary.
        if self.cancel_checker is not None and self.cancel_checker(action.run_id):
            action.status = ActionStatus.CANCELLED
            self.repository.save_action(action)
            return Observation(
                action_id=action.action_id,
                success=False,
                before_revision=actual_revision,
                after_revision=actual_revision,
                error_code="RUN_CANCELLED",
                error_class=ErrorClass.USER_FIXABLE,
                result={"cancelled": True},
            )
        action.status = ActionStatus.RUNNING
        self.repository.save_action(action)
        self.repository.append_event(action.run_id, EventType.ACTION_STARTED, {"action_id": action_id})
        started = perf_counter()
        with agent_span(
            "tool.execute",
            {"run_id": action.run_id, "action_id": action.action_id, "tool_name": action.tool_name},
        ):
            observation = self.geometry.execute(action)
        elapsed_ms = int((perf_counter() - started) * 1000)
        timeout_ms = int(self.registry.require(action.tool_name, "execution").timeout_seconds * 1000)
        if timeout_ms > 0 and elapsed_ms > timeout_ms and observation.success:
            observation = observation.model_copy(update={
                "success": False,
                "error_code": "TOOL_TIMEOUT_RESULT_UNKNOWN",
                "error_class": ErrorClass.TOOL_TRANSIENT,
                "result": {**observation.result, "timeout_seconds": timeout_ms / 1000, "result_unknown": True},
                "duration_ms": elapsed_ms,
            })
        elif observation.duration_ms == 0:
            observation = observation.model_copy(update={"duration_ms": elapsed_ms})
        if observation.error_class != ErrorClass.TOOL_TRANSIENT:
            self.repository.save_idempotent(action.idempotency_key, observation.model_dump(mode="json"))
        action.status = ActionStatus.SUCCEEDED if observation.success else ActionStatus.FAILED
        self.repository.save_action(action)
        self.repository.append_event(
            action.run_id,
            EventType.ACTION_SUCCEEDED if observation.success else EventType.ACTION_FAILED,
            observation.model_dump(mode="json"),
        )
        return observation
