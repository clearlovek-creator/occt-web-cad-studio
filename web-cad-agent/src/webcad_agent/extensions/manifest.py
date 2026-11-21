from __future__ import annotations

from pydantic import BaseModel, Field
from pathlib import Path
from typing import Any


class ExtensionManifest(BaseModel):
    extension_id: str
    version: str
    provider: str
    min_agent_version: str = "0.1.0"
    tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    sha256: str | None = None
    trusted: bool = False

    @classmethod
    def from_path(cls, path: str | Path) -> "ExtensionManifest":
        source = Path(path)
        if source.suffix.lower() == ".json":
            import json
            raw: Any = json.loads(source.read_text(encoding="utf-8"))
        else:
            try:
                import yaml
            except ImportError as exc:
                raise RuntimeError("YAML manifests require PyYAML; use JSON or install PyYAML") from exc
            raw = yaml.safe_load(source.read_text(encoding="utf-8"))
        return cls.model_validate(raw)


class RegistrySnapshot(BaseModel):
    registry_version: str
    agent_version: str
    extensions: list[ExtensionManifest] = Field(default_factory=list)
