from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from modeling_agent.domain.models import RiskLevel, SideEffect


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    name: str
    version: str
    description: str
    side_effect: SideEffect
    risk_level: RiskLevel
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    allowed_stages: frozenset[str]
    timeout_seconds: float = 30.0
    supports_idempotency: bool = True


class CapabilityRegistry:
    def __init__(self, tools: list[ToolDefinition] | None = None) -> None:
        self._tools = {tool.name: tool for tool in (tools or default_tools())}
        self.version = "phase1-registry-1"

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    def require(self, name: str, stage: str) -> ToolDefinition:
        tool = self.get(name)
        if tool is None:
            raise ValueError(f"Unknown Tool: {name}")
        if stage not in tool.allowed_stages:
            raise PermissionError(f"Tool {name} is not allowed in stage {stage}")
        return tool

    def validate_arguments(self, name: str, arguments: dict[str, Any], stage: str) -> dict[str, Any]:
        """Validate the small JSON-schema subset used by phase-one Tools."""
        tool = self.require(name, stage)
        schema = tool.input_schema or {}
        if not isinstance(arguments, dict):
            raise ValueError(f"Arguments for {name} must be an object")
        missing = [key for key in schema.get("required", []) if key not in arguments]
        if missing:
            raise ValueError(f"Missing required arguments for {name}: {', '.join(missing)}")
        for key, spec in (schema.get("properties") or {}).items():
            if key not in arguments:
                continue
            value = arguments[key]
            expected = spec.get("type") if isinstance(spec, dict) else None
            if expected == "number":
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise ValueError(f"Argument {key} for {name} must be a number")
                minimum = spec.get("minimum")
                maximum = spec.get("maximum")
                if minimum is not None and value < minimum or maximum is not None and value > maximum:
                    raise ValueError(f"Argument {key} for {name} is outside the allowed range")
            elif expected == "string" and not isinstance(value, str):
                raise ValueError(f"Argument {key} for {name} must be a string")
        return dict(arguments)

    def list_for_stage(self, stage: str) -> list[ToolDefinition]:
        return [tool for tool in self._tools.values() if stage in tool.allowed_stages]


def default_tools() -> list[ToolDefinition]:
    return [
        ToolDefinition(
            name="convert_unit",
            version="1",
            description="Convert a scalar between compatible units.",
            side_effect=SideEffect.PURE,
            risk_level=RiskLevel.LOW,
            input_schema={"type": "object"},
            output_schema={"type": "object"},
            allowed_stages=frozenset({"requirements", "theory"}),
        ),
        ToolDefinition(
            name="calculate_patch_initial_dimensions",
            version="1",
            description="Calculate initial dimensions for a rectangular patch antenna.",
            side_effect=SideEffect.PURE,
            risk_level=RiskLevel.LOW,
            input_schema={"type": "object"},
            output_schema={"type": "object"},
            allowed_stages=frozenset({"theory"}),
        ),
        ToolDefinition(
            name="modeling.build_rectangular_patch_stack",
            version="1",
            description="Build a validated substrate-plus-patch parameterized modeling plan without executing it.",
            side_effect=SideEffect.PURE,
            risk_level=RiskLevel.LOW,
            input_schema={"type": "object"},
            output_schema={"type": "object"},
            allowed_stages=frozenset({"planning"}),
        ),
        ToolDefinition(
            name="get_document_summary",
            version="1",
            description="Read the current geometry document summary.",
            side_effect=SideEffect.READ,
            risk_level=RiskLevel.LOW,
            input_schema={"type": "object"},
            output_schema={"type": "object"},
            allowed_stages=frozenset({"planning", "policy", "observation", "verification"}),
        ),
        ToolDefinition(
            name="geometry.create_box",
            version="1",
            description="Create one box in the current document.",
            side_effect=SideEffect.WRITE,
            risk_level=RiskLevel.MEDIUM,
            input_schema={
                "type": "object",
                "required": ["document_id", "width_m", "depth_m", "height_m"],
                "properties": {
                    "document_id": {"type": "string"},
                    "width_m": {"type": "number", "minimum": 1e-9, "maximum": 10.0},
                    "depth_m": {"type": "number", "minimum": 1e-9, "maximum": 10.0},
                    "height_m": {"type": "number", "minimum": 1e-9, "maximum": 10.0},
                },
            },
            output_schema={"type": "object"},
            allowed_stages=frozenset({"execution"}),
        ),
    ]
