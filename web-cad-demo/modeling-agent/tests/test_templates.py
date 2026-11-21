import unittest

from modeling_agent.domain.models import AntennaGoal
from modeling_agent.modeling.templates import ModelingTemplateRegistry, RectangularPatchStackTemplate


class ParametricTemplateTests(unittest.TestCase):
    def test_patch_stack_plan_has_dependency_order_and_physical_offsets(self) -> None:
        goal = AntennaGoal(
            original_request="2.45 GHz patch",
            antenna_type="rectangular_patch",
            center_frequency_hz=2.45e9,
            substrate_material="FR-4",
            substrate_thickness_m=0.0016,
        )
        plan = RectangularPatchStackTemplate().build(
            run_id="run-1",
            goal_version=1,
            goal=goal,
            document_id="doc-1",
        )
        self.assertEqual(plan.template_id, "antenna.rectangular_patch_stack")
        self.assertEqual([item["role"] for item in plan.actions], ["substrate", "patch_conductor"])
        substrate = plan.actions[0]["arguments"]
        patch = plan.actions[1]["arguments"]
        self.assertEqual(substrate["z_m"], 0.0)
        self.assertEqual(patch["z_m"], substrate["height_m"])
        self.assertGreater(substrate["width_m"], patch["width_m"])
        self.assertGreater(substrate["depth_m"], patch["depth_m"])
        self.assertTrue(plan.dependencies)

    def test_registry_rejects_unknown_template(self) -> None:
        registry = ModelingTemplateRegistry()
        with self.assertRaises(ValueError):
            registry.get("antenna.unknown")


if __name__ == "__main__":
    unittest.main()
