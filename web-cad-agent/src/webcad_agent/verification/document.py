from __future__ import annotations

from typing import Any


def revision_from(payload: dict[str, Any]) -> int | None:
    value = payload.get("revision")
    if value is None and isinstance(payload.get("result"), dict):
        value = payload["result"].get("revision")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def document_diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    before_features = before.get("features", [])
    after_features = after.get("features", [])
    before_ids = {item.get("id") for item in before_features if isinstance(item, dict)}
    after_ids = {item.get("id") for item in after_features if isinstance(item, dict)}
    return {
        "revision": {"before": before.get("revision"), "after": after.get("revision")},
        "feature_ids_added": sorted(item for item in after_ids - before_ids if item),
        "feature_ids_removed": sorted(item for item in before_ids - after_ids if item),
        "body_count": {
            "before": len(before.get("bodyMetadata", before.get("bodies", [])) or []),
            "after": len(after.get("bodyMetadata", after.get("bodies", [])) or []),
        },
    }
