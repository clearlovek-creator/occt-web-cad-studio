from __future__ import annotations

from typing import Any

from ..domain.models import VerificationCheck, VerificationResult


def close(actual: float, expected: float, *, abs_tol: float = 1e-6, rel_tol: float = 1e-6) -> bool:
    tolerance = max(abs_tol, rel_tol * max(1.0, abs(expected)))
    return abs(actual - expected) <= tolerance


def vector_close(actual: list[float], expected: list[float], *, abs_tol: float = 1e-6, rel_tol: float = 1e-6) -> bool:
    return len(actual) == len(expected) and all(
        close(float(a), float(e), abs_tol=abs_tol, rel_tol=rel_tol)
        for a, e in zip(actual, expected)
    )


def verify_box(
    *,
    action_id: str,
    measurement: dict[str, Any],
    expected_min: list[float],
    expected_max: list[float],
    expected_volume: float,
    abs_tol: float = 1e-6,
    rel_tol: float = 1e-6,
) -> VerificationResult:
    bounds = measurement.get("bounds") or {}
    actual_min = [float(item) for item in bounds.get("min", [])]
    actual_max = [float(item) for item in bounds.get("max", [])]
    actual_size = [b - a for a, b in zip(actual_min, actual_max)]
    expected_size = [b - a for a, b in zip(expected_min, expected_max)]
    actual_volume = measurement.get("volume")
    checks = [
        VerificationCheck(
            name="bounds_min",
            passed=vector_close(actual_min, expected_min, abs_tol=abs_tol, rel_tol=rel_tol),
            expected=expected_min,
            actual=actual_min,
        ),
        VerificationCheck(
            name="bounds_max",
            passed=vector_close(actual_max, expected_max, abs_tol=abs_tol, rel_tol=rel_tol),
            expected=expected_max,
            actual=actual_max,
        ),
        VerificationCheck(
            name="size",
            passed=vector_close(actual_size, expected_size, abs_tol=abs_tol, rel_tol=rel_tol),
            expected=expected_size,
            actual=actual_size,
        ),
        VerificationCheck(
            name="volume",
            passed=actual_volume is not None and close(float(actual_volume), expected_volume, abs_tol=abs_tol, rel_tol=rel_tol),
            expected=expected_volume,
            actual=actual_volume,
        ),
    ]
    return VerificationResult(
        action_id=action_id,
        passed=all(check.passed for check in checks),
        checks=checks,
        failure_code=None if all(check.passed for check in checks) else "GEOMETRY_MISMATCH",
    )


def verify_shape(*, action_id: str, check_payload: dict[str, Any]) -> VerificationResult:
    valid = bool(check_payload.get("valid"))
    check = VerificationCheck(name="shape_valid", passed=valid, expected=True, actual=check_payload.get("valid"))
    return VerificationResult(action_id=action_id, passed=valid, checks=[check], failure_code=None if valid else "INVALID_SHAPE")


def verify_operation_ack(*, action_id: str, payload: dict[str, Any]) -> VerificationResult:
    """Verify a non-geometric Gateway mutation acknowledged its result.

    Metadata operations (variables, materials, coordinate systems and custom
    properties) do not necessarily return a Body that can be measured.  They
    still must return an explicit successful Gateway envelope; treating any
    non-empty response as success would make transport/protocol failures look
    successful, so the check is intentionally strict.
    """
    value = payload.get("ok")
    if value is None and isinstance(payload.get("result"), dict):
        value = payload["result"].get("ok")
    passed = value is True
    check = VerificationCheck(name="gateway_ack", passed=passed, expected=True, actual=value)
    return VerificationResult(action_id=action_id, passed=passed, checks=[check],
                              failure_code=None if passed else "GATEWAY_ACK_MISSING")


def verify_relation(*, action_id: str, payload: dict[str, Any],
                    expected_relation: str | None = None,
                    expected_distance: float | None = None,
                    tolerance: float = 1.0e-6) -> VerificationResult:
    relation = str(payload.get("relation", ""))
    distance_value = payload.get("distance")
    try:
        distance = float(distance_value)
    except (TypeError, ValueError):
        distance = float("nan")
    valid_relations = {"disjoint", "touching", "intersects", "contains", "inside"}
    checks = [
        VerificationCheck(name="relation", passed=relation in valid_relations
                          and (expected_relation is None or relation == expected_relation),
                          expected=expected_relation or "valid relation", actual=relation),
        VerificationCheck(name="distance", passed=distance >= 0.0 and distance == distance
                          and (expected_distance is None or abs(distance - expected_distance) <= tolerance),
                          expected=expected_distance, actual=distance_value),
        VerificationCheck(name="provenance", passed=isinstance(payload.get("source"), str)
                          and isinstance(payload.get("exact"), bool),
                          expected="source + exact", actual={"source": payload.get("source"), "exact": payload.get("exact")}),
    ]
    passed = all(item.passed for item in checks)
    return VerificationResult(action_id=action_id, passed=passed, checks=checks,
                              failure_code=None if passed else "RELATION_INVALID")


def verify_cylinder(*, action_id: str, measurement: dict[str, Any], radius: float, height: float,
                    x: float = 0.0, y: float = 0.0, z: float = 0.0,
                    abs_tol: float = 1e-6, rel_tol: float = 1e-6) -> VerificationResult:
    expected_min = [x - radius, y - radius, z]
    expected_max = [x + radius, y + radius, z + height]
    expected_volume = 3.141592653589793 * radius * radius * height
    bounds = measurement.get("bounds") or {}
    actual_min = [float(item) for item in bounds.get("min", [])]
    actual_max = [float(item) for item in bounds.get("max", [])]
    checks = [
        VerificationCheck(name="bounds_min", passed=vector_close(actual_min, expected_min, abs_tol=abs_tol, rel_tol=rel_tol), expected=expected_min, actual=actual_min),
        VerificationCheck(name="bounds_max", passed=vector_close(actual_max, expected_max, abs_tol=abs_tol, rel_tol=rel_tol), expected=expected_max, actual=actual_max),
        VerificationCheck(name="volume", passed=measurement.get("volume") is not None and close(float(measurement["volume"]), expected_volume, abs_tol=abs_tol, rel_tol=rel_tol), expected=expected_volume, actual=measurement.get("volume")),
    ]
    return VerificationResult(action_id=action_id, passed=all(check.passed for check in checks), checks=checks,
                              failure_code=None if all(check.passed for check in checks) else "CYLINDER_MISMATCH")


def verify_sphere(*, action_id: str, measurement: dict[str, Any], radius: float,
                  x: float = 0.0, y: float = 0.0, z: float = 0.0,
                  abs_tol: float = 1e-6, rel_tol: float = 1e-6) -> VerificationResult:
    return _verify_bounds_volume(action_id=action_id, measurement=measurement,
                                 expected_min=[x - radius, y - radius, z - radius],
                                 expected_max=[x + radius, y + radius, z + radius],
                                 expected_volume=4 * 3.141592653589793 * radius ** 3 / 3,
                                 code="SPHERE_MISMATCH", abs_tol=abs_tol, rel_tol=rel_tol)


def verify_cone(*, action_id: str, measurement: dict[str, Any], radius1: float, radius2: float,
                height: float, x: float = 0.0, y: float = 0.0, z: float = 0.0,
                abs_tol: float = 1e-6, rel_tol: float = 1e-6) -> VerificationResult:
    radius = max(radius1, radius2)
    volume = 3.141592653589793 * height * (radius1 ** 2 + radius1 * radius2 + radius2 ** 2) / 3
    return _verify_bounds_volume(action_id=action_id, measurement=measurement,
                                 expected_min=[x - radius, y - radius, z],
                                 expected_max=[x + radius, y + radius, z + height],
                                 expected_volume=volume, code="CONE_MISMATCH",
                                 abs_tol=abs_tol, rel_tol=rel_tol)


def verify_torus(*, action_id: str, measurement: dict[str, Any], major_radius: float, minor_radius: float,
                 x: float = 0.0, y: float = 0.0, z: float = 0.0,
                 abs_tol: float = 1e-6, rel_tol: float = 1e-6) -> VerificationResult:
    radius = major_radius + minor_radius
    return _verify_bounds_volume(action_id=action_id, measurement=measurement,
                                 expected_min=[x - radius, y - radius, z - minor_radius],
                                 expected_max=[x + radius, y + radius, z + minor_radius],
                                 expected_volume=2 * 3.141592653589793 ** 2 * major_radius * minor_radius ** 2,
                                 code="TORUS_MISMATCH", abs_tol=abs_tol, rel_tol=rel_tol)


def _verify_bounds_volume(*, action_id: str, measurement: dict[str, Any], expected_min: list[float],
                          expected_max: list[float], expected_volume: float, code: str,
                          abs_tol: float, rel_tol: float) -> VerificationResult:
    bounds = measurement.get("bounds") or {}
    actual_min = [float(item) for item in bounds.get("min", [])]
    actual_max = [float(item) for item in bounds.get("max", [])]
    checks = [
        VerificationCheck(name="bounds_min", passed=vector_close(actual_min, expected_min, abs_tol=abs_tol, rel_tol=rel_tol), expected=expected_min, actual=actual_min),
        VerificationCheck(name="bounds_max", passed=vector_close(actual_max, expected_max, abs_tol=abs_tol, rel_tol=rel_tol), expected=expected_max, actual=actual_max),
        VerificationCheck(name="volume", passed=measurement.get("volume") is not None and close(float(measurement["volume"]), expected_volume, abs_tol=abs_tol, rel_tol=rel_tol), expected=expected_volume, actual=measurement.get("volume")),
    ]
    return VerificationResult(action_id=action_id, passed=all(item.passed for item in checks), checks=checks,
                              failure_code=None if all(item.passed for item in checks) else code)


def verify_translation(*, action_id: str, before: dict[str, Any], after: dict[str, Any], delta: list[float],
                       abs_tol: float = 1e-6, rel_tol: float = 1e-6) -> VerificationResult:
    before_center = _measurement_center(before)
    after_center = _measurement_center(after)
    actual = [a - b for a, b in zip(after_center, before_center)]
    check = VerificationCheck(name="translation_delta", passed=vector_close(actual, delta, abs_tol=abs_tol, rel_tol=rel_tol),
                              expected=delta, actual=actual)
    return VerificationResult(
        action_id=action_id,
        passed=check.passed,
        checks=[check],
        failure_code=None if check.passed else "POSITION_MISMATCH",
        error_vector=[float(expected) - float(actual_value) for actual_value, expected in zip(actual, delta)],
        recommended_capabilities=[] if check.passed else ["geometry.translate"],
    )


def _measurement_center(value: dict[str, Any]) -> list[float]:
    direct = value.get("center") or value.get("centroid")
    if direct:
        return [float(item) for item in direct]
    bounds = value.get("bounds") or {}
    minimum, maximum = bounds.get("min", []), bounds.get("max", [])
    return [(float(a) + float(b)) / 2 for a, b in zip(minimum, maximum)]
