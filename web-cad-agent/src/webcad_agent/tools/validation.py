from __future__ import annotations

from typing import Any


class ToolInputError(ValueError):
    """Raised when a Tool call does not satisfy its declared JSON-like schema."""


def validate_input(schema: dict[str, Any], value: Any, *, path: str = "arguments") -> None:
    """Validate the intentionally small JSON Schema subset used by ToolSpec.

    The Agent does not depend on a permissive model-side validator.  This
    deterministic validator covers the schemas supported by the built-in
    catalog and fails closed for malformed declarations.
    """
    if not schema:
        return
    expected = schema.get("type")
    if isinstance(expected, list):
        if not any(_matches_json_type(value, item) for item in expected):
            raise ToolInputError(f"{path} must have one of the types {expected}")
        # A union schema may still carry enum/length constraints, but there
        # is no single branch-specific shape to recurse into here.
        if "enum" in schema and value not in schema["enum"]:
            raise ToolInputError(f"{path} must be one of {schema['enum']}")
        return
    if expected == "object":
        if not isinstance(value, dict):
            raise ToolInputError(f"{path} must be an object")
        required = schema.get("required", [])
        if not isinstance(required, list):
            raise ToolInputError(f"{path}: invalid Tool schema required declaration")
        for name in required:
            if name not in value:
                raise ToolInputError(f"{path}.{name} is required")
        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            raise ToolInputError(f"{path}: invalid Tool schema properties declaration")
        if schema.get("additionalProperties") is False:
            unknown = sorted(set(value) - set(properties))
            if unknown:
                raise ToolInputError(f"{path} contains unknown fields: {', '.join(unknown)}")
        for name, item in value.items():
            child = properties.get(name)
            if child is not None:
                validate_input(child, item, path=f"{path}.{name}")
        return
    if expected == "array":
        if not isinstance(value, list):
            raise ToolInputError(f"{path} must be an array")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                validate_input(item_schema, item, path=f"{path}[{index}]")
        return
    if expected == "string" and not isinstance(value, str):
        raise ToolInputError(f"{path} must be a string")
    if expected == "boolean" and not isinstance(value, bool):
        raise ToolInputError(f"{path} must be a boolean")
    if expected == "number" and (isinstance(value, bool) or not isinstance(value, (int, float))):
        raise ToolInputError(f"{path} must be a number")
    if expected == "integer" and (isinstance(value, bool) or not isinstance(value, int)):
        raise ToolInputError(f"{path} must be an integer")
    if "enum" in schema and value not in schema["enum"]:
        raise ToolInputError(f"{path} must be one of {schema['enum']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            raise ToolInputError(f"{path} must be greater than {schema['exclusiveMinimum']}")
        if "minimum" in schema and value < schema["minimum"]:
            raise ToolInputError(f"{path} must be at least {schema['minimum']}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            raise ToolInputError(f"{path} is shorter than the minimum length")


def _matches_json_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "null":
        return value is None
    return True
