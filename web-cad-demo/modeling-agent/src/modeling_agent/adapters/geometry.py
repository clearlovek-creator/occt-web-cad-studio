from __future__ import annotations

from copy import deepcopy
from time import perf_counter
from typing import Any

from modeling_agent.domain.models import ActionRequest, ErrorClass, Observation


class FakeGeometryAdapter:
    """Deterministic first-stage geometry adapter used by tests and local demos."""

    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {}
        self._idempotent: dict[str, Observation] = {}
        self._history: dict[str, list[dict[str, Any]]] = {}

    def _document(self, document_id: str) -> dict[str, Any]:
        return self.documents.setdefault(document_id, {"revision": 0, "bodies": []})

    def current_revision(self, document_id: str) -> int:
        return int(self._document(document_id)["revision"])

    def summary(self, document_id: str) -> dict[str, Any]:
        return deepcopy(self._document(document_id))

    def undo(self, document_id: str, expected_revision: int, idempotency_key: str) -> Observation:
        if idempotency_key in self._idempotent:
            return deepcopy(self._idempotent[idempotency_key])
        document = self._document(document_id)
        before = int(document["revision"])
        history = self._history.setdefault(document_id, [])
        if before != expected_revision:
            observation = Observation(action_id=idempotency_key, success=False, before_revision=before, after_revision=before, error_code="REVISION_CONFLICT", error_class=ErrorClass.REVISION_CONFLICT)
        elif not history:
            observation = Observation(action_id=idempotency_key, success=False, before_revision=before, after_revision=before, error_code="NOTHING_TO_UNDO", error_class=ErrorClass.NON_RECOVERABLE)
        else:
            previous = history.pop()
            document.clear()
            document.update(deepcopy(previous))
            observation = Observation(action_id=idempotency_key, success=True, before_revision=before, after_revision=int(document["revision"]), result={"document_revision": int(document["revision"])})
        self._idempotent[idempotency_key] = observation
        return deepcopy(observation)

    def execute(self, action: ActionRequest) -> Observation:
        started = perf_counter()
        if action.idempotency_key in self._idempotent:
            return self._idempotent[action.idempotency_key]
        document_id = str(action.arguments.get("document_id", "default"))
        document = self._document(document_id)
        before = int(document["revision"])
        if action.tool_name != "geometry.create_box":
            observation = Observation(
                action_id=action.action_id,
                success=False,
                before_revision=before,
                after_revision=before,
                error_code="UNKNOWN_GEOMETRY_TOOL",
            )
        else:
            required = ("width_m", "depth_m", "height_m")
            if any(float(action.arguments.get(key, 0)) <= 0 for key in required):
                observation = Observation(
                    action_id=action.action_id,
                    success=False,
                    before_revision=before,
                    after_revision=before,
                    error_code="INVALID_BOX_DIMENSIONS",
                )
            else:
                body_id = f"body-{len(document['bodies']) + 1}"
                body = {
                    "body_id": body_id,
                    "kind": "box",
                    "width_m": float(action.arguments["width_m"]),
                    "depth_m": float(action.arguments["depth_m"]),
                    "height_m": float(action.arguments["height_m"]),
                    "x_m": float(action.arguments.get("x_m", 0.0)),
                    "y_m": float(action.arguments.get("y_m", 0.0)),
                    "z_m": float(action.arguments.get("z_m", 0.0)),
                }
                self._history.setdefault(document_id, []).append(deepcopy(document))
                document["bodies"].append(body)
                document["revision"] = before + 1
                observation = Observation(
                    action_id=action.action_id,
                    success=True,
                    result={"body": body, "document_revision": document["revision"]},
                    before_revision=before,
                    after_revision=document["revision"],
                    duration_ms=int((perf_counter() - started) * 1000),
                )
        self._idempotent[action.idempotency_key] = observation
        return deepcopy(observation)
