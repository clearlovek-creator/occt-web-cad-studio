from __future__ import annotations

import json
from pathlib import Path
from importlib.metadata import entry_points
from typing import Any, Iterable

from pydantic import BaseModel, Field


class SkillSpec(BaseModel):
    name: str
    version: str = "1"
    provider: str = "core"
    description: str
    prompt_template: str = ""
    tool_names: list[str] = Field(default_factory=list)
    input_schema: dict[str, Any] = Field(default_factory=dict)
    kind: str = "deterministic"


class SkillRegistry:
    def __init__(self, skills: Iterable[SkillSpec] = ()) -> None:
        self._skills: dict[str, SkillSpec] = {}
        for skill in skills:
            self.register(skill)

    def register(self, skill: SkillSpec) -> None:
        if skill.name in self._skills:
            raise ValueError(f"Duplicate Skill: {skill.name}")
        if skill.name.startswith("core.") and skill.provider != "core":
            raise ValueError(f"Extension cannot override core Skill: {skill.name}")
        self._skills[skill.name] = skill

    def get(self, name: str) -> SkillSpec | None:
        return self._skills.get(name)

    def list(self) -> list[SkillSpec]:
        return sorted(self._skills.values(), key=lambda item: item.name)

    @classmethod
    def discover(cls, *, enabled_providers: set[str] | None = None) -> "SkillRegistry":
        registry = cls()
        groups = entry_points()
        selected = groups.select(group="webcad_agent.skills") if hasattr(groups, "select") else groups.get("webcad_agent.skills", [])
        for item in selected:
            if item.name == "core":
                continue
            if enabled_providers is not None and item.name not in enabled_providers:
                continue
            values = item.load()()
            for raw in values:
                registry.register(_normalize_entry(raw, provider=item.name))
        # Built-in skills are always available and use the core namespace.
        if enabled_providers is None or not enabled_providers or "core" in enabled_providers:
            from ..extensions.builtin import provide_skills
            for raw in provide_skills():
                registry.register(_normalize_entry(raw, provider="core"))
        return registry

    @classmethod
    def from_path(cls, path: str | Path) -> "SkillRegistry":
        source = Path(path)
        raw = json.loads(source.read_text(encoding="utf-8")) if source.suffix.lower() == ".json" else _read_yaml(source)
        values = raw.get("skills", raw) if isinstance(raw, dict) else raw
        if not isinstance(values, list): raise ValueError("Skill file must contain a list or a skills list")
        return cls(SkillSpec.model_validate(item) for item in values)


def _read_yaml(path: Path) -> Any:
    try:
        import yaml
    except ImportError as exc:
        raise RuntimeError("YAML skill files require PyYAML; use JSON or install the optional dependency") from exc
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _normalize_entry(raw: Any, *, provider: str) -> SkillSpec:
    if isinstance(raw, SkillSpec):
        return raw
    if not isinstance(raw, dict):
        raise ValueError("Skill provider must return objects")
    value = dict(raw)
    value.setdefault("name", value.pop("skill_id", None))
    value.setdefault("description", value.get("kind", "Declarative CAD workflow"))
    value.setdefault("tool_names", value.pop("required_tools", []))
    value.setdefault("provider", provider)
    return SkillSpec.model_validate(value)
