from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from modeling_agent.application.store import InMemoryRepository
from modeling_agent.capabilities.registry import CapabilityRegistry
from modeling_agent.domain.models import ContextPack, ContextSource, new_id, utc_now


@dataclass(frozen=True, slots=True)
class ContextBudget:
    max_items: int = 24
    max_knowledge_items: int = 6
    max_recent_observations: int = 6
    max_chars: int = 24_000


class ContextStaleError(ValueError):
    """Raised when a ContextPack no longer describes the current Run."""


class ContextScopeError(ValueError):
    """Raised when supplied context data belongs to another project/document."""


class ContextBudgetExceeded(ValueError):
    """Raised when even the safety-critical context cannot fit its hard budget."""

    def __init__(self, *, used_chars: int, max_chars: int) -> None:
        self.used_chars = used_chars
        self.max_chars = max_chars
        super().__init__(f"ContextPack requires {used_chars} characters but the budget is {max_chars}")


class ContextEngine:
    def __init__(self, repository: InMemoryRepository, registry: CapabilityRegistry) -> None:
        self.repository = repository
        self.registry = registry

    def build(
        self,
        *,
        run_id: str,
        node_name: str,
        budget: ContextBudget | None = None,
        user_intent: dict[str, Any] | None = None,
        world_model: dict[str, Any] | None = None,
        plan: list[dict[str, Any]] | None = None,
        knowledge: list[dict[str, Any]] | None = None,
        plan_version: int | None = None,
        policy_version: str = "policy-1",
    ) -> ContextPack:
        budget = budget or ContextBudget()
        run = self.repository.get_run(run_id)
        goal = self.repository.get_goal(run_id, run.goal_version) or {}

        def check_scope(items: list[dict[str, Any]] | None, label: str) -> None:
            for item in items or []:
                if not isinstance(item, dict):
                    continue
                project_id = item.get("project_id")
                document_id = item.get("document_id")
                nested = item.get("arguments")
                if isinstance(nested, dict):
                    project_id = project_id if project_id is not None else nested.get("project_id")
                    document_id = document_id if document_id is not None else nested.get("document_id")
                if project_id is not None and str(project_id) != run.project_id:
                    raise ContextScopeError(f"{label} contains another project")
                if document_id is not None and str(document_id) != run.document_id:
                    raise ContextScopeError(f"{label} contains another document")

        check_scope(plan, "plan")
        check_scope(knowledge, "knowledge")
        if world_model:
            if world_model.get("project_id") is not None and str(world_model["project_id"]) != run.project_id:
                raise ContextScopeError("world_model contains another project")
            if world_model.get("document_id") is not None and str(world_model["document_id"]) != run.document_id:
                raise ContextScopeError("world_model contains another document")
        pending_interaction: dict[str, Any] | None = None
        if run.waiting_request_id:
            try:
                pending_interaction = self.repository.get_question(run.waiting_request_id).model_dump(mode="json")
            except KeyError:
                pending_interaction = {"request_id": run.waiting_request_id, "kind": "elicitation"}
        elif run.waiting_approval_id:
            try:
                pending_interaction = self.repository.get_approval(run.waiting_approval_id).model_dump(mode="json")
            except KeyError:
                pending_interaction = {"approval_id": run.waiting_approval_id, "kind": "approval"}
        applicable_constraints = [
            {"type": "user_constraint", "text": str(item), "source": f"goal:{run.goal_version}"}
            for item in goal.get("constraints", [])
        ]
        applicable_constraints.extend(
            {"type": "success_criterion", "criterion": item, "source": f"goal:{run.goal_version}"}
            for item in goal.get("success_criteria", [])
            if isinstance(item, dict)
        )
        events = self.repository.list_events(run_id)
        observations = [
            event.payload
            for event in events
            if event.event_type.value == "observation.recorded"
        ][-budget.max_recent_observations :]
        allowed_tools = [
            {
                "name": tool.name,
                "version": tool.version,
                "side_effect": tool.side_effect.value,
                "risk_level": tool.risk_level.value,
                "input_schema": tool.input_schema,
            }
            for tool in self.registry.list_for_stage(node_name)
        ]
        sources = [
            ContextSource(
                source_id=f"run:{run_id}",
                source_type="run",
                version=run.graph_version,
                trust_level="authoritative",
                document_revision=run.document_revision,
            ),
            ContextSource(
                source_id=f"goal:{run_id}:{run.goal_version}",
                source_type="goal",
                version=str(run.goal_version),
                trust_level="user_or_verified",
                document_revision=run.document_revision,
            ),
        ]
        world_summary = dict(world_model or {})
        # The repository/worker is authoritative for the revision. Never let a
        # caller accidentally re-introduce a revision from an older snapshot.
        world_summary["document_revision"] = run.document_revision
        pack = ContextPack(
            context_pack_id=new_id("ctx"),
            run_id=run_id,
            node_name=node_name,
            goal_snapshot=goal,
            current_user_intent=user_intent or {},
            world_model_summary=world_summary,
            active_plan_slice=(plan or [])[:budget.max_items],
            recent_observations=observations,
            applicable_constraints=applicable_constraints,
            available_tools=allowed_tools,
            knowledge_excerpts=(knowledge or [])[: budget.max_knowledge_items],
            pending_interaction=pending_interaction,
            budgets={"max_chars": budget.max_chars},
            sources=sources,
            freshness={
                "run_version": run.run_version,
                "goal_version": run.goal_version,
                "document_revision": run.document_revision,
                "tool_registry_version": self.registry.version,
                "built_at": utc_now().isoformat(),
            },
        )
        if plan_version is not None:
            pack.freshness["plan_version"] = plan_version
        if policy_version != "policy-1":
            pack.freshness["policy_version"] = policy_version
        return self._fit_budget(pack, budget.max_chars)

    def is_fresh(
        self,
        pack: ContextPack,
        *,
        run_id: str | None = None,
        node_name: str | None = None,
        plan_version: int | None = None,
        policy_version: str = "policy-1",
    ) -> bool:
        """Compare a snapshot with authoritative Run and registry versions."""
        try:
            run = self.repository.get_run(run_id or pack.run_id)
        except KeyError:
            return False
        freshness = pack.freshness
        if pack.run_id != run.id or (node_name is not None and pack.node_name != node_name):
            return False
        plan_ok = plan_version is None or freshness.get("plan_version") == plan_version
        policy_ok = policy_version == "policy-1" or freshness.get("policy_version") == policy_version
        return (
            freshness.get("run_version") == run.run_version
            and freshness.get("goal_version") == run.goal_version
            and freshness.get("document_revision") == run.document_revision
            and freshness.get("tool_registry_version") == self.registry.version
            and plan_ok
            and policy_ok
        )

    def require_fresh(
        self,
        pack: ContextPack,
        *,
        run_id: str | None = None,
        node_name: str | None = None,
        plan_version: int | None = None,
        policy_version: str = "policy-1",
    ) -> ContextPack:
        if not self.is_fresh(
            pack,
            run_id=run_id,
            node_name=node_name,
            plan_version=plan_version,
            policy_version=policy_version,
        ):
            raise ContextStaleError(
                f"ContextPack {pack.context_pack_id} is stale for run {run_id or pack.run_id}"
            )
        return pack

    @staticmethod
    def _fit_budget(pack: ContextPack, max_chars: int) -> ContextPack:
        """Trim least-authoritative sections and enforce the serialized hard budget."""
        def size(value: ContextPack) -> int:
            # Use the same human-readable JSON representation exposed to API
            # clients; the hard budget must not depend on serializer spacing.
            return len(json.dumps(value.model_dump(mode="json"), ensure_ascii=False))

        def trim_once(value: ContextPack) -> ContextPack | None:
            if value.knowledge_excerpts:
                return value.model_copy(update={"knowledge_excerpts": value.knowledge_excerpts[:-1]})
            if value.recent_observations:
                return value.model_copy(update={"recent_observations": value.recent_observations[:-1]})
            if value.active_plan_slice:
                return value.model_copy(update={"active_plan_slice": value.active_plan_slice[:-1]})
            if value.pending_interaction and not value.pending_interaction.get("_compact"):
                pending = value.pending_interaction
                compact = {"_compact": True}
                for key in ("kind", "request_id", "approval_id", "question", "reason_code", "action_id"):
                    if key in pending:
                        compact[key] = pending[key]
                return value.model_copy(update={"pending_interaction": compact})
            if value.current_user_intent and value.current_user_intent != {"_truncated": True}:
                return value.model_copy(update={"current_user_intent": {"_truncated": True}})
            if value.world_model_summary and value.world_model_summary != {"_truncated": True}:
                return value.model_copy(update={"world_model_summary": {"_truncated": True}})
            if value.goal_snapshot and value.goal_snapshot != {"_truncated": True}:
                return value.model_copy(update={"goal_snapshot": {"_truncated": True}})
            return None

        original_size = size(pack)
        while True:
            used_chars = size(pack)
            budgets = {
                **pack.budgets,
                "max_chars": max_chars,
                "used_chars": used_chars,
                "truncated": used_chars < original_size,
            }
            candidate = pack.model_copy(update={"budgets": budgets})
            # Updating used_chars itself changes serialized size by a few
            # characters; recompute once so the returned value is truthful.
            actual_size = size(candidate)
            candidate = candidate.model_copy(
                update={"budgets": {**budgets, "used_chars": actual_size}}
            )
            actual_size = size(candidate)
            if actual_size <= max_chars:
                return candidate

            trimmed = trim_once(pack)
            if trimmed is None or size(trimmed) >= used_chars:
                raise ContextBudgetExceeded(used_chars=actual_size, max_chars=max_chars)
            pack = trimmed
