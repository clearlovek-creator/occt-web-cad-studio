from __future__ import annotations

from datetime import timedelta
from typing import Any, Callable

from ..adapters.gateway import canonical_hash
from ..domain.models import (
    ActionEnvelope, ActionStatus, AgentPlan, AgentRun, ApprovalRequest, ErrorClass,
    EventType, Observation, PlanStatus, RunStatus, utc_now,
)
from ..policy import PolicyEngine
from ..ports import GeometryPort
from ..tools.registry import ToolRegistry
from ..tools.validation import validate_input
from ..verification.geometry import verify_cylinder, verify_operation_ack, verify_shape
from .planner import validate_plan


class PlanExecutor:
    def __init__(self, *, store: Any, geometry: GeometryPort, registry: ToolRegistry,
                 policy: PolicyEngine | None = None, emit: Callable[..., Any] | None = None) -> None:
        self.store = store
        self.geometry = geometry
        self.registry = registry
        self.policy = policy or PolicyEngine()
        self.emit = emit

    def _event(self, session_id: str, event_type: EventType, *, run_id: str, payload: dict[str, Any]) -> None:
        if self.emit:
            self.emit(session_id, event_type, run_id=run_id, payload=payload)

    def prepare_actions(self, plan: AgentPlan) -> list[ActionEnvelope]:
        validate_plan(plan, self.registry)
        actions: list[ActionEnvelope] = []
        for step in plan.steps:
            spec = self.registry.require(step.tool_name, stage="execute")
            validate_input(spec.input_schema, _flat_tool_arguments(step.arguments))
            success_criteria = [{"type": step.verifier}] if step.verifier else []
            if step.verifier == "cylinder_geometry":
                args = _flat_tool_arguments(step.arguments)
                success_criteria = [{"type": "cylinder_geometry", "radius": args.get("radius"),
                                     "height": args.get("height"), "x": args.get("x", 0),
                                     "y": args.get("y", 0), "z": args.get("z", 0)}]
            action_body = {
                "plan_id": plan.plan_id, "step_id": step.step_id, "run_id": plan.run_id,
                "document_id": plan.document_id, "tool": spec.name, "version": spec.version,
                "arguments": step.arguments, "expected_revision": plan.base_revision,
                "success_criteria": success_criteria,
            }
            action_hash = canonical_hash(action_body)
            actions.append(ActionEnvelope(
                run_id=plan.run_id, tool_name=spec.gateway_operation or spec.name, tool_version=spec.version,
                document_id=plan.document_id, arguments=step.arguments, side_effect=spec.side_effect,
                risk_level=spec.risk_level, expected_revision=plan.base_revision,
                idempotency_key=action_hash, action_hash=action_hash,
                reason=f"Plan {plan.plan_id} step {step.ordinal}: {spec.description}",
                step_id=step.step_id, success_criteria=success_criteria,
                arguments_hash=canonical_hash(step.arguments),
            ))
        return actions

    async def propose(self, *, session_id: str, run: AgentRun, plan: AgentPlan, approve: bool = False,
                      mode: str = "supervised") -> dict[str, Any]:
        actions = self.prepare_actions(plan)
        for action in actions:
            self.store.save_action(action)
        decisions = [self.policy.decide(action, mode=mode) for action in actions]
        denied = next((decision for decision in decisions if not decision.allowed), None)
        if denied:
            for action in actions:
                self.store.save_action(action.model_copy(update={"status": ActionStatus.FAILED}))
            plan.status = PlanStatus.FAILED; self.store.save_plan(plan)
            run.status = RunStatus.FAILED; run.last_error = {"code": "POLICY_DENIED", "reason": denied.reason}; self.store.save_run(run)
            return {"status": "failed", "plan": plan.model_dump(mode="json"), "run": run.model_dump(mode="json")}
        approval = ApprovalRequest(
            run_id=run.run_id, action_id=plan.plan_id, action_hash=plan.plan_hash,
            plan_id=plan.plan_id, batch_id=plan.plan_id, document_id=plan.document_id,
            before_revision=plan.base_revision,
            normalized_arguments={str(index): action.arguments for index, action in enumerate(actions)},
            parameter_sources={f"{action.step_id or index}.{key}": "plan" for index, action in enumerate(actions) for key in action.arguments},
            affected_entities=[{"kind": "document", "id": plan.document_id}],
            risk_level=max((action.risk_level for action in actions), key=lambda value: {"low": 0, "medium": 1, "high": 2}[value.value]),
            rollback={"strategy": "gateway.batch.rollback", "atomic": True, "requires_revision_match": True},
            summary=f"Execute {len(actions)} CAD steps as one batch",
            impact=[f"Document: {plan.document_id}",
                    *[f"{action.tool_name} risk={action.risk_level.value} arguments={action.arguments}" for action in actions]],
            expected_revision=plan.base_revision,
            expires_at=utc_now() + timedelta(minutes=15),
        )
        plan.approval_id = approval.approval_id
        plan.status = PlanStatus.APPROVAL_PENDING
        run.active_plan_id = plan.plan_id; run.status = RunStatus.WAITING_APPROVAL; run.waiting_reason = approval.approval_id
        self.store.save_plan(plan); self.store.save_approval(approval); self.store.save_run(run)
        for action in actions:
            action.status = ActionStatus.APPROVAL_PENDING
            self.store.save_action(action)
        self._event(session_id, EventType.PLAN_CREATED, run_id=run.run_id, payload={"plan": plan.model_dump(mode="json")})
        self._event(session_id, EventType.APPROVAL_REQUESTED, run_id=run.run_id,
                   payload={"approval": approval.model_dump(mode="json"), "plan_id": plan.plan_id})
        if not approve:
            return {"status": "approval_required", "run": run.model_dump(mode="json"),
                    "plan": plan.model_dump(mode="json"), "approval": approval.model_dump(mode="json"),
                    "actions": [action.model_dump(mode="json") for action in actions]}
        return await self.approve(session_id=session_id, run_id=run.run_id, plan_id=plan.plan_id, override=True)

    async def approve(self, *, session_id: str, run_id: str, plan_id: str, override: bool = False) -> dict[str, Any]:
        run = self.store.get_run(run_id); plan = self.store.get_plan(plan_id); approval = self._approval(run_id, plan_id)
        if run is None or plan is None or approval is None:
            raise ValueError("Plan approval state is incomplete")
        if not override and approval.expires_at <= utc_now():
            raise ValueError("Plan approval has expired")
        if approval.action_hash != plan.plan_hash:
            raise ValueError("Plan approval hash does not match current plan")
        current = await self.geometry.summary(plan.document_id)
        current_revision = _revision(current)
        if approval.expected_revision is not None and current_revision != approval.expected_revision:
            raise ValueError("Plan approval is invalid because the document revision changed")
        actions = self.prepare_actions(plan)
        for action in actions:
            self.store.save_action(action.model_copy(update={"status": ActionStatus.APPROVED}))
        approval.decision = "approve"; approval.decided_at = utc_now(); self.store.save_approval(approval)
        plan.status = PlanStatus.RUNNING; self.store.save_plan(plan)
        run.status = RunStatus.RUNNING; run.waiting_reason = None; self.store.save_run(run)
        self._event(session_id, EventType.APPROVAL_DECIDED, run_id=run_id, payload={"plan_id": plan_id, "decision": "approve"})
        observations = await self.geometry.execute_batch(actions)
        for action, observation in zip(actions, observations):
            self.store.save_action(action.model_copy(update={
                "status": ActionStatus.SUCCEEDED if observation.success else ActionStatus.FAILED
            }))
            if observation.success:
                self._event(session_id, EventType.ACTION_SUCCEEDED, run_id=run_id,
                            payload={"action_id": observation.action_id, "after_revision": observation.after_revision})
            self._event(session_id, EventType.OBSERVATION_RECORDED, run_id=run_id, payload=observation.model_dump(mode="json"))
        if not observations or not all(item.success for item in observations):
            plan.status = PlanStatus.FAILED; run.status = RunStatus.FAILED
            run.last_error = {"code": "BATCH_FAILED", "observations": [item.model_dump(mode="json") for item in observations]}
            self.store.save_plan(plan); self.store.save_run(run)
            self._event(session_id, EventType.RUN_FAILED, run_id=run_id, payload=run.last_error)
            return {"status": "failed", "plan": plan.model_dump(mode="json"), "run": run.model_dump(mode="json"),
                    "observations": [item.model_dump(mode="json") for item in observations]}
        # Verify every primitive step against its deterministic success criteria;
        # the final Boolean additionally receives a shape check below.
        for index, (action, observation) in enumerate(zip(actions, observations)):
            criteria = action.success_criteria[0] if action.success_criteria else {}
            if criteria.get("type") == "cylinder_geometry":
                body_id = _body_id(observation.result)
                # A batch can consume or mutate an intermediate primitive (for
                # example, the two cylinders used by a Boolean cut).  Adapters
                # may provide an execution-time measurement snapshot; otherwise
                # defer non-final primitive verification to the final result.
                inline = observation.result.get("measurement") if isinstance(observation.result, dict) else None
                if inline is None and index < len(actions) - 1:
                    continue
                measurement = inline if isinstance(inline, dict) else (
                    await self.geometry.measure(plan.document_id, body_id) if body_id else {}
                )
                cylinder_verification = verify_cylinder(
                    action_id=action.action_id, measurement=_unwrap(measurement),
                    radius=float(criteria["radius"]), height=float(criteria["height"]),
                    x=float(criteria.get("x", 0)), y=float(criteria.get("y", 0)), z=float(criteria.get("z", 0)),
                )
                if not cylinder_verification.passed:
                    plan.status = PlanStatus.FAILED; run.status = RunStatus.FAILED
                    run.last_error = {"code": "VERIFICATION_FAILED", "verification": cylinder_verification.model_dump(mode="json")}
                    self.store.save_plan(plan); self.store.save_run(run)
                    self._event(session_id, EventType.VERIFICATION_FAILED, run_id=run_id, payload=run.last_error)
                    return {"status": "failed", "plan": plan.model_dump(mode="json"), "run": run.model_dump(mode="json"),
                            "verification": cylinder_verification.model_dump(mode="json")}
        last_result = observations[-1].result
        body_id = _body_id(last_result)
        final_criteria = actions[-1].success_criteria[0] if actions[-1].success_criteria else {}
        if final_criteria.get("type") == "operation_ack":
            verification = verify_operation_ack(action_id=actions[-1].action_id,
                                                payload=_unwrap(last_result))
        else:
            shape = await self.geometry.check(plan.document_id, body_id) if body_id else {"valid": False}
            verification = verify_shape(action_id=actions[-1].action_id, check_payload=_unwrap(shape))
        if not verification.passed:
            plan.status = PlanStatus.FAILED; run.status = RunStatus.FAILED
            run.last_error = {"code": "VERIFICATION_FAILED", "verification": verification.model_dump(mode="json")}
            self.store.save_plan(plan); self.store.save_run(run)
            self._event(session_id, EventType.VERIFICATION_FAILED, run_id=run_id, payload=run.last_error)
            return {"status": "failed", "plan": plan.model_dump(mode="json"), "run": run.model_dump(mode="json"),
                    "verification": verification.model_dump(mode="json")}
        plan.status = PlanStatus.COMPLETED; run.status = RunStatus.COMPLETED; run.active_plan_id = plan.plan_id
        run.document_revision = observations[-1].after_revision
        self.store.save_plan(plan); self.store.save_run(run)
        self._event(session_id, EventType.VERIFICATION_PASSED, run_id=run_id, payload=verification.model_dump(mode="json"))
        self._event(session_id, EventType.RUN_COMPLETED, run_id=run_id, payload={"plan_id": plan_id, "body_id": body_id})
        return {"status": "completed", "plan": plan.model_dump(mode="json"), "run": run.model_dump(mode="json"),
                "observations": [item.model_dump(mode="json") for item in observations],
                "verification": verification.model_dump(mode="json"), "body_id": body_id}

    def _approval(self, run_id: str, plan_id: str) -> ApprovalRequest | None:
        approval = self.store.get_approval_for_run(run_id)
        return approval if approval and approval.action_id == plan_id else None


def _unwrap(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("result")
    return value if isinstance(value, dict) else payload


def _body_id(payload: dict[str, Any]) -> str | None:
    value = _unwrap(payload)
    for key in ("bodyId", "body_id", "id"):
        if value.get(key):
            return str(value[key])
    return None


def _revision(payload: dict[str, Any]) -> int | None:
    value = _unwrap(payload).get("revision")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _flat_tool_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    """Expose nested batch inputs/parameters to the declared Tool schema."""
    if "inputs" not in arguments and "parameters" not in arguments:
        return arguments
    merged = dict(arguments.get("inputs", {}))
    merged.update(arguments.get("parameters", {}))
    return merged
