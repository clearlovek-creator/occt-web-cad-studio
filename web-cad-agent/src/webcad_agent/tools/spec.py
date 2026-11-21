from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ToolSpec(BaseModel):
    name: str
    version: str = "1"
    provider: str = "core"
    description: str
    gateway_operation: str | None = None
    input_schema: dict[str, Any] = Field(default_factory=dict)
    # Every Tool exposes an explicit envelope schema, even when the
    # operation-specific payload is Gateway-defined.  Extensions can replace
    # this with a stricter schema without changing the registry protocol.
    output_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})
    side_effect: Literal["pure", "read", "write", "destructive"] = "read"
    risk_level: Literal["low", "medium", "high"] = "low"
    allowed_stages: set[str] = Field(default_factory=lambda: {"read", "execute", "verify"})
    supports_preview: bool = False
    supports_idempotency: bool = True
    required_capabilities: list[str] = Field(default_factory=list)
    # Optional machine-readable hints consumed by planners and UI detail
    # panels.  They are deliberately additive JSON-Schema annotations: the
    # Gateway remains the authority for unit conversion and validation.
    parameter_units: dict[str, str] = Field(default_factory=dict)
    verification_contract: dict[str, Any] = Field(default_factory=dict)
    verifier: str | None = None
    min_agent_version: str = "0.1.0"


class ToolPlugin:
    spec: ToolSpec

    async def execute(self, **arguments: Any) -> dict[str, Any]:
        raise NotImplementedError
