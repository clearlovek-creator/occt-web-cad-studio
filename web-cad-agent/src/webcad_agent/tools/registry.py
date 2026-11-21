from __future__ import annotations

import hashlib
import json
from importlib.metadata import entry_points
from typing import Iterable

from .spec import ToolSpec
from ..extensions.manifest import RegistrySnapshot
from ..extensions.contracts import assert_tool_contract


class ToolRegistry:
    def __init__(self, specs: Iterable[ToolSpec] = ()) -> None:
        self._specs: dict[str, ToolSpec] = {}
        for spec in specs:
            self.register(spec)

    def register(self, spec: ToolSpec) -> None:
        assert_tool_contract(spec)
        if spec.name in self._specs:
            raise ValueError(f"Duplicate Tool: {spec.name}")
        if spec.name.startswith("core.") and spec.provider != "core":
            raise ValueError(f"Extension cannot override core Tool: {spec.name}")
        self._specs[spec.name] = spec

    def get(self, name: str) -> ToolSpec | None:
        return self._specs.get(name)

    def require(self, name: str, *, stage: str = "execute") -> ToolSpec:
        spec = self.get(name)
        if spec is None:
            raise ValueError(f"Unknown Tool: {name}")
        if stage not in spec.allowed_stages:
            raise PermissionError(f"Tool {name} is not allowed in stage {stage}")
        return spec

    def for_names(self, names: list[str]) -> list[ToolSpec]:
        return [self._specs[name] for name in names if name in self._specs]

    @property
    def version(self) -> str:
        payload = [item.model_dump(mode="json", exclude_none=True) for item in self._specs.values()]
        encoded = json.dumps(sorted(payload, key=lambda item: item["name"]), sort_keys=True, separators=(",", ":"))
        return f"registry-{hashlib.sha256(encoded.encode()).hexdigest()[:12]}"

    def list(self) -> list[ToolSpec]:
        return sorted(self._specs.values(), key=lambda item: item.name)

    def snapshot(self, *, agent_version: str = "0.1.0") -> RegistrySnapshot:
        grouped: dict[tuple[str, str], dict[str, object]] = {}
        for spec in self.list():
            key = (spec.provider, spec.version)
            item = grouped.setdefault(key, {
                "extension_id": spec.provider,
                "version": spec.version,
                "provider": spec.provider,
                "tools": [],
                "skills": [],
                "trusted": spec.provider == "core",
            })
            tools = item["tools"]
            if isinstance(tools, list):
                tools.append(spec.name)
        return RegistrySnapshot(registry_version=self.version, agent_version=agent_version,
                                extensions=list(grouped.values()))

    def assert_snapshot(self, snapshot: RegistrySnapshot) -> None:
        if snapshot.registry_version != self.version:
            raise RuntimeError(f"Registry snapshot mismatch: expected {snapshot.registry_version}, current {self.version}")

    @classmethod
    def discover(cls, *, include_builtin: bool = True, enabled_providers: set[str] | None = None) -> "ToolRegistry":
        registry = cls()
        if include_builtin:
            from ..extensions.builtin import provide_tools

            for spec in provide_tools():
                registry.register(spec)
        groups = entry_points()
        selected = groups.select(group="webcad_agent.tools") if hasattr(groups, "select") else groups.get("webcad_agent.tools", [])
        for item in selected:
            if item.name == "core":
                continue
            if enabled_providers is not None and item.name not in enabled_providers:
                continue
            provided = item.load()()
            for spec in provided:
                registry.register(spec)
        return registry
