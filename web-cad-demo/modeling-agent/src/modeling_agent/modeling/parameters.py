from __future__ import annotations

from typing import Any


BOX_PARAMETER_LIMITS = {
    "width_m": (1e-9, 10.0),
    "depth_m": (1e-9, 10.0),
    "height_m": (1e-9, 10.0),
}


def validate_box_parameter_changes(changes: dict[str, Any]) -> dict[str, float]:
    normalized: dict[str, float] = {}
    for name, raw_value in changes.items():
        if name not in BOX_PARAMETER_LIMITS:
            raise ValueError(f"Unsupported box parameter: {name}")
        try:
            value = float(raw_value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Parameter {name} must be numeric") from exc
        lower, upper = BOX_PARAMETER_LIMITS[name]
        if not lower <= value <= upper:
            raise ValueError(f"Parameter {name} must be between {lower} and {upper} meters")
        normalized[name] = value
    if not normalized:
        raise ValueError("At least one parameter must be changed")
    return normalized
