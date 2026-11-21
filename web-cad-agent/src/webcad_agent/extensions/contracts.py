from __future__ import annotations

from typing import Any

from ..tools.spec import ToolSpec


def validate_tool_contract(spec: ToolSpec) -> list[str]:
    errors: list[str] = []
    if not spec.name or "." not in spec.name: errors.append("name must be qualified")
    if not spec.version: errors.append("version is required")
    if spec.side_effect in {"write", "destructive"} and not spec.supports_idempotency: errors.append("write tools must support idempotency")
    if spec.side_effect == "write" and not spec.verifier: errors.append("write tools require a verifier")
    if spec.supports_preview and spec.side_effect in {"write", "destructive"} and not spec.input_schema: errors.append("previewable writes require input_schema")
    return errors


def assert_tool_contract(spec: ToolSpec) -> None:
    errors = validate_tool_contract(spec)
    if errors: raise ValueError(f"Tool {spec.name} contract invalid: {'; '.join(errors)}")
