from __future__ import annotations

import re


_LENGTHS = {"mm": 1.0, "millimeter": 1.0, "millimeters": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4, "inch": 25.4, "ft": 304.8}
_ANGLES = {"deg": 1.0, "degree": 1.0, "degrees": 1.0, "rad": 57.29577951308232}


def parse_length(value: float | int | str, *, default_unit: str = "mm") -> float:
    if isinstance(value, (int, float)): return float(value)
    match = re.fullmatch(r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([A-Za-z]*)\s*", value)
    if not match: raise ValueError(f"Invalid length: {value}")
    number, unit = float(match.group(1)), (match.group(2) or default_unit).lower()
    if unit not in _LENGTHS: raise ValueError(f"Unsupported length unit: {unit}")
    return number * _LENGTHS[unit]


def parse_angle(value: float | int | str, *, default_unit: str = "deg") -> float:
    if isinstance(value, (int, float)): return float(value)
    match = re.fullmatch(r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([A-Za-z]*)\s*", value)
    if not match: raise ValueError(f"Invalid angle: {value}")
    number, unit = float(match.group(1)), (match.group(2) or default_unit).lower()
    if unit not in _ANGLES: raise ValueError(f"Unsupported angle unit: {unit}")
    return number * _ANGLES[unit]
