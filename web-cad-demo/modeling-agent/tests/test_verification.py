import unittest

from modeling_agent.adapters.geometry import FakeGeometryAdapter
from modeling_agent.domain.models import ActionRequest, Observation, RiskLevel, SideEffect
from modeling_agent.execution.service import canonical_hash
from modeling_agent.verification.geometry import GeometryVerifier


class GeometryVerificationTests(unittest.TestCase):
    def test_box_dimensions_and_revision_are_verified_from_worker_facts(self) -> None:
        arguments = {
            "document_id": "doc-1",
            "width_m": 0.061,
            "depth_m": 0.061,
            "height_m": 0.0016,
        }
        action = ActionRequest(
            action_id="action-1",
            run_id="run-1",
            tool_name="geometry.create_box",
            arguments=arguments,
            side_effect=SideEffect.WRITE,
            risk_level=RiskLevel.MEDIUM,
            expected_document_revision=0,
            idempotency_key="run-1:box",
            reason="test",
            action_hash=canonical_hash("geometry.create_box", arguments),
        )
        adapter = FakeGeometryAdapter()
        observation = adapter.execute(action)
        result = GeometryVerifier().verify_box(action, observation, adapter.summary("doc-1"))
        self.assertTrue(result.passed)
        self.assertTrue(all(check.passed for check in result.checks))

    def test_mismatched_dimension_fails(self) -> None:
        arguments = {
            "document_id": "doc-1",
            "width_m": 0.061,
            "depth_m": 0.061,
            "height_m": 0.0016,
        }
        action = ActionRequest(
            action_id="action-2",
            run_id="run-1",
            tool_name="geometry.create_box",
            arguments=arguments,
            side_effect=SideEffect.WRITE,
            risk_level=RiskLevel.MEDIUM,
            expected_document_revision=0,
            idempotency_key="run-1:box-2",
            reason="test",
            action_hash=canonical_hash("geometry.create_box", arguments),
        )
        observation = Observation(
            action_id=action.action_id,
            success=True,
            result={"body": {"body_id": "body-1", "width_m": 0.062, "depth_m": 0.061, "height_m": 0.0016}},
            before_revision=0,
            after_revision=1,
        )
        result = GeometryVerifier().verify_box(action, observation)
        self.assertFalse(result.passed)
        self.assertEqual(result.recommended_route, "replan")


if __name__ == "__main__":
    unittest.main()
