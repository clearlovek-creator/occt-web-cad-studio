from __future__ import annotations

from typing import Any

from modeling_agent.domain.models import ActionRequest, Observation, VerificationCheck, VerificationResult


class GeometryVerifier:
    """Verify geometry from worker facts, never from model-generated claims."""

    def verify_box(
        self,
        action: ActionRequest,
        observation: Observation,
        summary: dict[str, Any] | None = None,
        *,
        tolerance: float = 1e-9,
    ) -> VerificationResult:
        checks: list[VerificationCheck] = []
        body = self._body_from(observation, summary)
        checks.append(
            VerificationCheck(
                name="body_exists",
                passed=observation.success and body is not None,
                expected=True,
                actual=body is not None,
                message=None if body is not None else "Worker did not return a box body",
            )
        )
        expected = {
            "width_m": self._positive_float(action.arguments.get("width_m")),
            "depth_m": self._positive_float(action.arguments.get("depth_m")),
            "height_m": self._positive_float(action.arguments.get("height_m")),
        }
        actual = {
            key: self._positive_float(body.get(key)) if body else None
            for key in expected
        }
        for key, expected_value in expected.items():
            actual_value = actual[key]
            passed = (
                expected_value is not None
                and actual_value is not None
                and abs(actual_value - expected_value) <= tolerance
            )
            checks.append(
                VerificationCheck(
                    name=key,
                    passed=passed,
                    expected=expected_value,
                    actual=actual_value,
                    message=None if passed else f"{key} does not match the requested value",
                )
            )
        revision_advanced = (
            observation.before_revision is not None
            and observation.after_revision is not None
            and observation.after_revision > observation.before_revision
        )
        checks.append(
            VerificationCheck(
                name="revision_advanced",
                passed=revision_advanced,
                expected="after_revision > before_revision",
                actual={
                    "before": observation.before_revision,
                    "after": observation.after_revision,
                },
            )
        )
        passed = all(check.passed for check in checks)
        return VerificationResult(
            action_id=action.action_id,
            passed=passed,
            checks=checks,
            actual_values={"body": body, "summary_revision": (summary or {}).get("revision")},
            failure_reason=None if passed else next(
                (check.message for check in checks if not check.passed and check.message),
                "Geometry verification failed",
            ),
            recommended_route=None if passed else "replan",
        )

    @staticmethod
    def _body_from(observation: Observation, summary: dict[str, Any] | None) -> dict[str, Any] | None:
        result_body = observation.result.get("body")
        if isinstance(result_body, dict):
            return result_body
        result = observation.result.get("result")
        if isinstance(result, dict) and isinstance(result.get("body"), dict):
            return result["body"]
        bodies = (summary or {}).get("bodies")
        if isinstance(bodies, list) and bodies and isinstance(bodies[-1], dict):
            return bodies[-1]
        return None

    @staticmethod
    def _positive_float(value: Any) -> float | None:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        return number if number > 0 else None
