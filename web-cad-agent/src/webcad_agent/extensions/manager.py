from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Iterable

from .manifest import ExtensionManifest
from ..skills.registry import SkillRegistry


class ExtensionManager:
    """Loads declarative assets and records explicit trust decisions.

    Python entry points remain opt-in through the packaging environment; this
    manager never executes code from a manifest or arbitrary path.
    """

    def __init__(self, *, trusted_ids: Iterable[str] = (), state_path: str | Path | None = None) -> None:
        self.trusted_ids = set(trusted_ids)
        self.state_path = Path(state_path) if state_path else None
        self._enabled: set[str] = set()
        self._load_state()

    def _load_state(self) -> None:
        if not self.state_path or not self.state_path.exists():
            return
        raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("enabled"), list):
            self._enabled = {str(item) for item in raw["enabled"]}

    def _save_state(self) -> None:
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps({"enabled": sorted(self._enabled)}, ensure_ascii=False, indent=2), encoding="utf-8")

    @property
    def enabled_ids(self) -> set[str]:
        return set(self._enabled)

    def enable(self, manifest: ExtensionManifest, *, package_bytes: bytes | None = None) -> ExtensionManifest:
        checked = self.validate_manifest(manifest, package_bytes=package_bytes)
        self._enabled.add(checked.extension_id)
        self._save_state()
        return checked

    def disable(self, extension_id: str) -> None:
        self._enabled.discard(extension_id)
        self._save_state()

    def doctor(self, manifests: Iterable[ExtensionManifest] = ()) -> dict[str, object]:
        known = {item.extension_id for item in manifests}
        return {"enabled": sorted(self._enabled), "known": sorted(known),
                "missing": sorted(self._enabled - known)}

    def validate_manifest(self, manifest: ExtensionManifest, *, package_bytes: bytes | None = None,
                          agent_version: str = "0.1.0") -> ExtensionManifest:
        if manifest.extension_id.startswith("core."):
            raise ValueError("Extension IDs cannot use the core namespace")
        if manifest.provider == "core":
            raise ValueError("Third-party manifests cannot claim the core provider")
        if any(name.startswith("core.") for name in [*manifest.tools, *manifest.skills]):
            raise ValueError("Extensions cannot declare core Tool/Skill names")
        if manifest.extension_id not in self.trusted_ids and not manifest.trusted:
            raise PermissionError(f"Extension {manifest.extension_id} is not trusted")
        if _version_tuple(manifest.min_agent_version) > _version_tuple(agent_version):
            raise ValueError(f"Extension requires Agent >= {manifest.min_agent_version}")
        if manifest.sha256 and package_bytes is not None:
            actual = hashlib.sha256(package_bytes).hexdigest()
            if actual != manifest.sha256:
                raise ValueError("Extension hash does not match manifest")
        return manifest

    def load_skills(self, manifest: ExtensionManifest, path: str | Path) -> SkillRegistry:
        self.validate_manifest(manifest)
        registry = SkillRegistry.from_path(path)
        for skill in registry.list():
            if skill.provider != manifest.provider and not skill.name.startswith(f"{manifest.provider}."):
                raise ValueError(f"Skill {skill.name} is outside extension namespace")
        return registry


def _version_tuple(value: str) -> tuple[int, ...]:
    parts: list[int] = []
    for item in value.split("."):
        digits = "".join(char for char in item if char.isdigit())
        parts.append(int(digits or 0))
    return tuple((parts + [0, 0, 0])[:3])
