from __future__ import annotations

from dataclasses import dataclass

from ..domain.models import SessionMessage


@dataclass(frozen=True)
class CompactedContext:
    summary: str
    recent: list[SessionMessage]
    removed_message_ids: list[str]


class ContextCompactor:
    def __init__(self, recent_limit: int = 8) -> None:
        self.recent_limit = max(2, recent_limit)

    def compact(self, messages: list[SessionMessage], existing_summary: str = "") -> CompactedContext:
        if len(messages) <= self.recent_limit:
            return CompactedContext(existing_summary, list(messages), [])
        removed = messages[:-self.recent_limit]
        facts = [f"{item.role}: {item.content.strip()}" for item in removed if item.content.strip()]
        prefix = existing_summary.strip()
        new_summary = " | ".join(part for part in [prefix, *facts[-20:]] if part)
        return CompactedContext(new_summary[:6000], messages[-self.recent_limit:], [item.message_id for item in removed])
