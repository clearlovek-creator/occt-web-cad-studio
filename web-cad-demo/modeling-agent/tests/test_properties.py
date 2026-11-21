import unittest

try:
    from hypothesis import given, settings, strategies as st
except ImportError:  # pragma: no cover
    given = None
    st = None

from modeling_agent.adapters.geometry import FakeGeometryAdapter
from modeling_agent.domain.models import ActionRequest, RiskLevel, SideEffect
from modeling_agent.execution.service import canonical_hash


if given is not None:

    class PropertyTests(unittest.TestCase):
        @settings(max_examples=20, deadline=None)
        @given(st.dictionaries(st.sampled_from(["a", "b", "c", "d"]), st.integers(), max_size=4))
        def test_canonical_hash_is_independent_of_argument_insertion_order(self, values) -> None:
            reversed_values = dict(reversed(list(values.items())))
            self.assertEqual(
                canonical_hash("tool", values),
                canonical_hash("tool", reversed_values),
            )

        @settings(max_examples=20, deadline=None)
        @given(st.floats(min_value=-1e6, max_value=1e6, allow_nan=False, allow_infinity=False))
        def test_fake_geometry_rejects_non_positive_dimensions(self, width) -> None:
            geometry = FakeGeometryAdapter()
            arguments = {"document_id": "property-doc", "width_m": width, "depth_m": 0.1, "height_m": 0.1}
            action = ActionRequest(
                action_id="property-action",
                run_id="property-run",
                tool_name="geometry.create_box",
                arguments=arguments,
                side_effect=SideEffect.WRITE,
                risk_level=RiskLevel.MEDIUM,
                expected_document_revision=0,
                idempotency_key=f"property:{width!r}",
                reason="property test",
                action_hash=canonical_hash("geometry.create_box", arguments),
            )
            observation = geometry.execute(action)
            if width <= 0:
                self.assertFalse(observation.success)
                self.assertEqual(geometry.current_revision("property-doc"), 0)

else:

    class PropertyTests(unittest.TestCase):
        @unittest.skip("Hypothesis is an optional development dependency")
        def test_hypothesis_dependency_missing(self) -> None:
            pass


if __name__ == "__main__":
    unittest.main()
