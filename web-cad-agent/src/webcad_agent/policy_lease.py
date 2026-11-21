from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
from threading import RLock

from .domain.models import utc_now


@dataclass(frozen=True)
class Lease:
    document_id: str
    owner_id: str
    expires_at: datetime


class DocumentLeaseManager:
    """Process-local lease with an optional atomic file-backed cross-process lock."""

    def __init__(self, lease_dir: str | Path | None = None, *, default_ttl_seconds: int = 60) -> None:
        self._leases: dict[str, Lease] = {}
        self._lock = RLock()
        self.lease_dir = Path(lease_dir) if lease_dir else None
        self.default_ttl_seconds = max(1, default_ttl_seconds)
        if self.lease_dir:
            self.lease_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, document_id: str) -> Path | None:
        if not self.lease_dir:
            return None
        digest = hashlib.sha256(document_id.encode("utf-8")).hexdigest()
        return self.lease_dir / f"{digest}.lease"

    @staticmethod
    def _read(path: Path) -> Lease | None:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return Lease(document_id=str(raw["document_id"]), owner_id=str(raw["owner_id"]),
                         expires_at=datetime.fromisoformat(str(raw["expires_at"])))
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return None

    def acquire(self, document_id: str, owner_id: str, *, ttl_seconds: int | None = None) -> Lease:
        now = utc_now()
        ttl = ttl_seconds or self.default_ttl_seconds
        with self._lock:
            current = self._leases.get(document_id)
            if current and current.expires_at > now and current.owner_id != owner_id:
                raise RuntimeError(f"Document {document_id} is leased by another run")
            path = self._path(document_id)
            if path:
                disk = self._read(path) if path.exists() else None
                if disk and disk.expires_at > now and disk.owner_id != owner_id:
                    raise RuntimeError(f"Document {document_id} is leased by another process")
                lease = Lease(document_id, owner_id, now + timedelta(seconds=ttl))
                payload = json.dumps({"document_id": document_id, "owner_id": owner_id,
                                      "expires_at": lease.expires_at.isoformat()}, ensure_ascii=False)
                try:
                    if disk and disk.expires_at <= now:
                        path.unlink(missing_ok=True)
                    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    with os.fdopen(fd, "w", encoding="utf-8") as handle:
                        handle.write(payload)
                except FileExistsError:
                    latest = self._read(path)
                    if latest and latest.expires_at > now and latest.owner_id != owner_id:
                        raise RuntimeError(f"Document {document_id} is leased by another process")
                    path.write_text(payload, encoding="utf-8")
            else:
                lease = Lease(document_id, owner_id, now + timedelta(seconds=ttl))
            self._leases[document_id] = lease
            return lease

    def assert_owner(self, document_id: str, owner_id: str) -> None:
        with self._lock:
            lease = self._leases.get(document_id)
            path = self._path(document_id)
            disk = self._read(path) if path and path.exists() else None
            current = disk or lease
            if not current or current.expires_at <= utc_now() or current.owner_id != owner_id:
                raise RuntimeError("Document lease is missing or expired")

    def release(self, document_id: str, owner_id: str) -> None:
        with self._lock:
            lease = self._leases.get(document_id)
            if lease and lease.owner_id == owner_id:
                self._leases.pop(document_id, None)
            path = self._path(document_id)
            if path and path.exists():
                disk = self._read(path)
                if disk and disk.owner_id == owner_id:
                    path.unlink(missing_ok=True)
