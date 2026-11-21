from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

from ..domain.models import ArtifactRef, new_id, utc_now


class ArtifactStore:
    """Bounded local artifact store; raw Gateway/model payloads never enter Run state."""

    def __init__(self, root: str | Path, *, max_bytes: int = 8 * 1024 * 1024) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max(1024, max_bytes)

    def save(self, *, run_id: str, data: bytes, media_type: str = "application/json", name: str = "payload") -> ArtifactRef:
        if len(data) > self.max_bytes:
            raise ValueError(f"Artifact exceeds {self.max_bytes} bytes")
        safe_name = "".join(char if char.isalnum() or char in "-_ ." else "_" for char in name).strip() or "payload"
        artifact_id = new_id("artifact")
        directory = (self.root / run_id).resolve()
        if not directory.is_relative_to(self.root):
            raise ValueError("Invalid run_id path")
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{artifact_id}-{safe_name}"
        fd, temporary = tempfile.mkstemp(prefix=".artifact-", dir=directory)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data); handle.flush(); os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
        return ArtifactRef(artifact_id=artifact_id, kind="gateway-response", uri=str(target),
                           media_type=media_type, size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                           created_at=utc_now())
