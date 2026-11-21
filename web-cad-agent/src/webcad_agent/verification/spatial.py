from __future__ import annotations

from math import sqrt
from typing import Any

from ..domain.models import VerificationCheck, VerificationResult


def bounds_center(measurement: dict[str, Any]) -> list[float]:
    bounds = measurement.get("bounds") or {}
    return [(float(a) + float(b)) / 2 for a, b in zip(bounds.get("min", []), bounds.get("max", []))]


def center_distance(first: dict[str, Any], second: dict[str, Any]) -> float:
    a, b = bounds_center(first), bounds_center(second)
    if len(a) != 3 or len(b) != 3: raise ValueError("Both measurements require 3D bounds")
    return sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def aabb_relation(first: dict[str, Any], second: dict[str, Any]) -> str:
    a, b = first.get("bounds") or {}, second.get("bounds") or {}
    amin, amax, bmin, bmax = a.get("min", []), a.get("max", []), b.get("min", []), b.get("max", [])
    if not all(len(item) == 3 for item in (amin, amax, bmin, bmax)): return "unknown"
    overlap = all(float(amin[i]) <= float(bmax[i]) and float(bmin[i]) <= float(amax[i]) for i in range(3))
    if not overlap: return "disjoint"
    contains = all(float(amin[i]) <= float(bmin[i]) and float(amax[i]) >= float(bmax[i]) for i in range(3))
    contained = all(float(bmin[i]) <= float(amin[i]) and float(bmax[i]) >= float(amax[i]) for i in range(3))
    if contains: return "contains"
    if contained: return "contained_by"
    return "overlapping"


def verify_relation(*, action_id: str, actual: str, expected: str) -> VerificationResult:
    check = VerificationCheck(name="aabb_relation", passed=actual == expected, expected=expected, actual=actual)
    return VerificationResult(action_id=action_id, passed=check.passed, checks=[check],
                              failure_code=None if check.passed else "RELATION_MISMATCH")
