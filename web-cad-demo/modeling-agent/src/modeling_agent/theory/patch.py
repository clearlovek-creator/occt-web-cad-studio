from __future__ import annotations

import math

from modeling_agent.domain.models import AntennaGoal, TheoryAnalysisResult


MATERIAL_RELATIVE_PERMITTIVITY: dict[str, float] = {
    "fr-4": 4.3,
    "rogers ro4003c": 3.55,
    "rogers rt/duroid 5880": 2.2,
    "air": 1.0,
}


class RectangularPatchCalculator:
    """Hammerstad-style first estimate for a rectangular microstrip patch.

    This is an initial sizing calculation, not a substitute for a full EM
    solver. All lengths in the result are meters and the input frequency is Hz.
    """

    speed_of_light_m_s = 299_792_458.0

    def calculate(self, goal: AntennaGoal) -> TheoryAnalysisResult:
        frequency = goal.center_frequency_hz
        if frequency is None or frequency <= 0:
            raise ValueError("center_frequency_hz must be provided")
        thickness = goal.substrate_thickness_m or 0.0016
        if thickness <= 0:
            raise ValueError("substrate_thickness_m must be positive")
        epsilon_r = self._relative_permittivity(goal.substrate_material)
        width = self.speed_of_light_m_s / (2.0 * frequency) * math.sqrt(2.0 / (epsilon_r + 1.0))
        effective_epsilon = (epsilon_r + 1.0) / 2.0 + (epsilon_r - 1.0) / 2.0 * (
            1.0 + 12.0 * thickness / width
        ) ** -0.5
        width_ratio = width / thickness
        delta_length_ratio = 0.412 * (
            (effective_epsilon + 0.3) * (width_ratio + 0.264)
            / ((effective_epsilon - 0.258) * (width_ratio + 0.8))
        )
        delta_length = delta_length_ratio * thickness
        effective_length = self.speed_of_light_m_s / (2.0 * frequency * math.sqrt(effective_epsilon))
        length = effective_length - 2.0 * delta_length
        if length <= 0:
            raise ValueError("calculated patch length is not positive; check frequency and substrate")
        warnings = [
            "Initial closed-form estimate only; validate with a full-wave solver.",
            "FR-4 permittivity is frequency- and batch-dependent when the default value is used.",
        ]
        if goal.substrate_material is None:
            warnings.append("Substrate material was not specified; FR-4 relative permittivity was assumed.")
        return TheoryAnalysisResult(
            method="rectangular_microstrip_patch_closed_form_v1",
            assumptions=[
                {"name": "relative_permittivity", "value": epsilon_r, "source": "material_default"},
                {"name": "substrate_thickness_m", "value": thickness, "source": "goal_or_default"},
            ],
            derived_parameters=[
                {"name": "width", "value_m": width},
                {"name": "length", "value_m": length},
                {"name": "effective_permittivity", "value": effective_epsilon},
                {"name": "fringing_extension_m", "value_m": delta_length},
            ],
            warnings=warnings,
            confidence=0.7,
            requires_user_confirmation=goal.substrate_material is None,
        )

    @classmethod
    def _relative_permittivity(cls, material: str | None) -> float:
        if not material:
            return MATERIAL_RELATIVE_PERMITTIVITY["fr-4"]
        normalized = material.strip().lower()
        if normalized in MATERIAL_RELATIVE_PERMITTIVITY:
            return MATERIAL_RELATIVE_PERMITTIVITY[normalized]
        raise ValueError(
            f"Unknown substrate material {material!r}; provide a supported material or explicit material data"
        )
