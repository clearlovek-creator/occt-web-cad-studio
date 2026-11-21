from __future__ import annotations

from urllib.parse import urlencode


def viewer_url(*, origin: str = "http://127.0.0.1:3000", document_id: str, revision: int | None = None,
               body_id: str | None = None) -> str:
    query = {"documentId": document_id}
    if revision is not None: query["revision"] = str(revision)
    if body_id: query["bodyId"] = body_id
    return f"{origin.rstrip('/')}/?{urlencode(query)}"
