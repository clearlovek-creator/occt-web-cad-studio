from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class TuiSnapshot:
    session_id: str | None = None
    active_run_id: str | None = None
    phase: str = "idle"
    inspector: dict[str, Any] = field(default_factory=dict)
    conversation: list[str] = field(default_factory=list)
    last_sequence: int = 0


class TuiController:
    """Pure event consumer used by Textual and headless snapshot tests."""

    def __init__(self) -> None:
        self.snapshot = TuiSnapshot()

    def consume(self, event: Any) -> TuiSnapshot:
        self.snapshot.session_id = getattr(event, "session_id", self.snapshot.session_id)
        self.snapshot.active_run_id = getattr(event, "run_id", None) or self.snapshot.active_run_id
        self.snapshot.last_sequence = max(self.snapshot.last_sequence, int(getattr(event, "sequence_number", 0)))
        event_type = str(getattr(event, "event_type", ""))
        self.snapshot.phase = event_type.rsplit(".", 1)[-1] or self.snapshot.phase
        payload = getattr(event, "payload", {}) or {}
        if event_type.endswith("message.appended"):
            message = payload.get("message", {})
            if message.get("content"): self.snapshot.conversation.append(str(message["content"]))
        self.snapshot.inspector = {"event_type": event_type, **payload}
        return self.snapshot

    def render_snapshot(self, *, width: int = 120, height: int = 36) -> str:
        """Render a deterministic terminal snapshot for CI and narrow terminals."""
        width = max(40, width); height = max(8, height)
        if width < 90:
            left, right = 0, 0
            center = width - 2
        else:
            left = max(18, width // 5); right = max(20, width // 5); center = width - left - right - 4
        lines = ["Web CAD Agent · independent runtime".ljust(width)[:width], "─" * width]
        if left:
            lines.append(("Sessions / Runs".ljust(left) + "│" + " Conversation & Events".ljust(center) + "│" + " Inspector".ljust(right)).ljust(width)[:width])
            lines.append((f"{self.snapshot.session_id or 'no session'}".ljust(left) + "│" + " ".join(self.snapshot.conversation[-1:]).ljust(center) + "│" + f" phase={self.snapshot.phase}".ljust(right)).ljust(width)[:width])
        else:
            lines.append("Conversation & Events".ljust(width)[:width])
            lines.append(" ".join(self.snapshot.conversation[-1:]).ljust(width)[:width])
        lines.append("─" * width)
        lines.append(f"seq={self.snapshot.last_sequence}  run={self.snapshot.active_run_id or '-'}".ljust(width)[:width])
        while len(lines) < height - 1:
            lines.append("".ljust(width))
        lines.append("> ".ljust(width)[:width])
        return "\n".join(lines[:height])
