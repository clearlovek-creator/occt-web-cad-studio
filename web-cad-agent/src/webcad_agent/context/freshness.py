from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class FreshnessDecision:
    valid: bool
    reason: str
    current_revision: int | None


def validate_revision(*, expected: int | None, current: int | None) -> FreshnessDecision:
    if expected is None or current is None:
        return FreshnessDecision(True, "revision_unavailable", current)
    if expected == current:
        return FreshnessDecision(True, "revision_match", current)
    return FreshnessDecision(False, "revision_changed", current)


def invalidate_entity_refs(refs: list[dict[str, Any]], *, current_revision: int | None) -> list[dict[str, Any]]:
    return [ref for ref in refs if ref.get("resolved_at_revision") == current_revision]
