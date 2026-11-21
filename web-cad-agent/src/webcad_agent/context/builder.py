from __future__ import annotations

from typing import Any

from ..domain.models import (
    AgentRun,
    AgentSession,
    ContextPack,
    ContextRequirements,
)
from ..ports import GeometryPort
from ..tools.registry import ToolRegistry
from ..skills.registry import SkillRegistry
from .budget import ContextBudgetExceeded, estimate_tokens, fit_items


class ContextBuilder:
    def __init__(self, geometry: GeometryPort, tools: ToolRegistry, skills: SkillRegistry | None = None) -> None:
        self.geometry = geometry
        self.tools = tools
        self.skills = skills or SkillRegistry()

    async def build(
        self,
        *,
        session: AgentSession,
        run: AgentRun,
        user_input: str,
        node_name: str,
        requirements: ContextRequirements,
        observations: list[dict[str, Any]] | None = None,
    ) -> ContextPack:
        document: dict[str, Any] | None = None
        requested_views = set(requirements.document_views)
        if requested_views:
            document = {}
            if "summary" in requested_views or not requested_views:
                document["summary"] = await self.geometry.summary(run.document_id)
            if "view" in requested_views:
                document["view"] = await self.geometry.view(run.document_id, offset=0, limit=50)
            if "properties" in requested_views:
                document["properties"] = await self.geometry.property_list(run.document_id)
            for kind in ("variables", "coordinates", "materials", "history", "properties", "property-types"):
                if kind in requested_views and hasattr(self.geometry, "model_query"):
                    document[kind] = await self.geometry.model_query(run.document_id, kind=kind)
        document_tokens = estimate_tokens(document) if document else 0
        mandatory = {"input": user_input,
                     "goal": {"text": run.goal, "goal_version": run.goal_version} if requirements.include_goal else None,
                     "policy": {"mode": "supervised", "revision": run.document_revision} if requirements.include_policy else None,
                     "pending": {"reason": run.waiting_reason, "status": run.status.value} if requirements.include_pending_interaction and run.waiting_reason else None,
                     "entity_refs": requirements.entity_refs}
        mandatory_tokens = estimate_tokens(mandatory)
        if mandatory_tokens + document_tokens > requirements.token_budget:
            raise ContextBudgetExceeded(
                f"Mandatory context requires {mandatory_tokens + document_tokens} tokens, "
                f"budget is {requirements.token_budget}")
        remaining = max(1, requirements.token_budget - mandatory_tokens - document_tokens)
        available_skills = [item.model_dump(mode="json") for item in self.skills.list()
                            if not requirements.skill_names or item.name in requirements.skill_names]
        # Skills are executable workflow contracts, not decorative prose.  Fit
        # them before the larger Tool catalog so adding a Tool output schema
        # cannot silently remove the only deterministic Skill from context.
        available_skills, skill_tokens = fit_items(available_skills, budget=remaining, reserved=0)
        available_tools = [
            item.model_dump(mode="json")
            for item in self.tools.for_names(requirements.tool_names)
        ]
        available_tools, tool_tokens = fit_items(available_tools,
                                                 budget=max(1, remaining - skill_tokens), reserved=0)
        bounded_observations = list(observations or [])[-requirements.observation_limit:] if requirements.observation_limit else []
        bounded_observations, observation_tokens = fit_items(
            list(bounded_observations), budget=max(1, remaining - tool_tokens - skill_tokens), reserved=0
        )
        entity_refs = [{"ref": ref} for ref in requirements.entity_refs]
        return ContextPack(
            run_id=run.run_id,
            node_name=node_name,
            current_input={"text": user_input},
            goal={"text": run.goal, "goal_version": run.goal_version} if requirements.include_goal else None,
            document=document,
            entity_refs=entity_refs,
            observations=bounded_observations,
            active_plan={"rolling_summary": session.rolling_summary, "pinned_facts": session.pinned_facts} if requirements.include_active_plan and (session.rolling_summary or session.pinned_facts) else None,
            available_tools=available_tools,
            available_skills=available_skills,
            policy={"mode": "supervised", "revision": run.document_revision} if requirements.include_policy else None,
            pending_interaction={"reason": run.waiting_reason, "status": run.status.value} if requirements.include_pending_interaction and run.waiting_reason else None,
            knowledge=([{"query": requirements.knowledge_query}] if requirements.knowledge_query else []),
            budgets={"token_budget": requirements.token_budget, "estimated_tokens": mandatory_tokens + tool_tokens + skill_tokens + document_tokens + observation_tokens,
                     "truncated": len(available_tools) < len(requirements.tool_names),
                     "skills_truncated": len(available_skills) < len([item for item in self.skills.list() if not requirements.skill_names or item.name in requirements.skill_names])},
            sources=[
                {
                    "source_id": f"session:{session.session_id}",
                    "source_type": "run_store",
                    "trust_level": "verified",
                },
                *([{
                    "source_id": f"gateway:{run.document_id}:{_document_revision(document)}",
                    "source_type": "gateway",
                    "trust_level": "authoritative",
                    "document_revision": _document_revision(document),
                }] if document is not None else []),
            ],
            freshness={
                "document_revision": _document_revision(document),
                "goal_version": run.goal_version,
                "registry_version": self.tools.version,
            },
        )


def _document_revision(document: dict[str, Any] | None) -> int | None:
    if not document:
        return None
    for value in (document.get("revision"), (document.get("summary") or {}).get("revision"),
                  (document.get("view") or {}).get("revision"),
                  *[(item or {}).get("revision") for item in document.values() if isinstance(item, dict)]):
        if value is not None:
            try:
                return int(value)
            except (TypeError, ValueError):
                continue
    return None
