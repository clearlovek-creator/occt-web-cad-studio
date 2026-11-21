from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..domain.models import EntityRef


@dataclass(frozen=True)
class ResolutionResult:
    status: str  # resolved | ambiguous | missing | stale
    entity: EntityRef | None = None
    candidates: list[dict[str, Any]] | None = None
    reason: str = ""


class EntityResolver:
    """Resolves explicit IDs or unique summary matches; never guesses ties."""

    def resolve(self, reference: str, *, summary: dict[str, Any], revision: int | None,
                kind: str = "body") -> ResolutionResult:
        value = reference.strip()
        if not value:
            return ResolutionResult("missing", reason="empty_reference")
        bodies = summary.get("bodies") or summary.get("bodyMetadata") or summary.get("bodyPresentations") or []
        if not isinstance(bodies, list): bodies = []
        explicit = next((item for item in bodies if str(item.get("id") or item.get("bodyId")) == value), None)
        if explicit:
            entity_id = str(explicit.get("id") or explicit.get("bodyId"))
            return ResolutionResult("resolved", EntityRef(kind=kind, entity_id=entity_id,
                                                            label=explicit.get("label"), resolved_at_revision=revision or 0))
        needle = value.removeprefix("@body/").removeprefix("@body:").lower()
        candidates = [item for item in bodies if needle in str(item.get("label") or item.get("name") or "").lower()]
        if len(candidates) == 1:
            item = candidates[0]
            entity_id = str(item.get("id") or item.get("bodyId"))
            return ResolutionResult("resolved", EntityRef(kind=kind, entity_id=entity_id,
                                                            label=item.get("label") or item.get("name"), resolved_at_revision=revision or 0))
        if len(candidates) > 1:
            return ResolutionResult("ambiguous", candidates=candidates, reason="multiple_matches")
        return ResolutionResult("missing", candidates=[], reason="no_match")

    @staticmethod
    def is_fresh(reference: EntityRef, current_revision: int | None) -> bool:
        return current_revision is None or reference.resolved_at_revision == current_revision
