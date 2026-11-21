import unittest

from modeling_agent.domain.models import AntennaGoal
from modeling_agent.theory.patch import RectangularPatchCalculator


class PatchTheoryTests(unittest.TestCase):
    def test_fr4_245ghz_dimensions_are_positive_and_auditable(self) -> None:
        result = RectangularPatchCalculator().calculate(
            AntennaGoal(
                original_request="2.45 GHz patch",
                antenna_type="rectangular_patch",
                center_frequency_hz=2.45e9,
                substrate_material="FR-4",
                substrate_thickness_m=0.0016,
            )
        )
        values = {item["name"]: item.get("value_m") for item in result.derived_parameters}
        self.assertEqual(result.method, "rectangular_microstrip_patch_closed_form_v1")
        self.assertGreater(values["width"], 0.03)
        self.assertLess(values["width"], 0.05)
        self.assertGreater(values["length"], 0.02)
        self.assertLess(values["length"], 0.04)
        self.assertTrue(any(item["name"] == "relative_permittivity" for item in result.assumptions))

    def test_unknown_material_is_rejected_instead_of_silently_assumed(self) -> None:
        with self.assertRaises(ValueError):
            RectangularPatchCalculator().calculate(
                AntennaGoal(
                    original_request="patch",
                    antenna_type="rectangular_patch",
                    center_frequency_hz=2.45e9,
                    substrate_material="UnknownBoard",
                    substrate_thickness_m=0.0016,
                )
            )


if __name__ == "__main__":
    unittest.main()
