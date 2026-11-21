from __future__ import annotations

import json
from typing import Any


class ContextBudgetExceeded(RuntimeError):
    """Raised when mandatory context alone cannot fit the node budget."""


def estimate_tokens(value: Any) -> int:
    """Conservative offline estimate; exact tokenizer is model-provider specific."""
    return max(1, (len(json.dumps(value, ensure_ascii=False, separators=(",", ":"))) + 3) // 4)


def fit_items(items: list[dict[str, Any]], *, budget: int, reserved: int = 0) -> tuple[list[dict[str, Any]], int]:
    selected: list[dict[str, Any]] = []
    used = reserved
    for item in items:
        cost = estimate_tokens(item)
        if used + cost > budget:
            break
        selected.append(item); used += cost
    return selected, used
