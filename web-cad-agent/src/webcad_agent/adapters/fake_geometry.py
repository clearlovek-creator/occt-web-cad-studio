from __future__ import annotations

from copy import deepcopy
from math import pi
from typing import Any

from ..domain.models import ActionEnvelope, Observation, utc_now


class FakeGeometryAdapter:
    """Deterministic in-memory Gateway substitute used by tests and demos."""

    def __init__(self, document_id: str = "demo-document") -> None:
        self.document_id = document_id
        self.revision = 0
        self.bodies: dict[str, dict[str, Any]] = {}
        self.variables: dict[str, dict[str, Any]] = {}
        self.coordinate_systems: dict[str, dict[str, Any]] = {}
        self.materials: dict[str, dict[str, Any]] = {}
        self.properties: dict[str, dict[str, Any]] = {}
        self.property_types: dict[str, dict[str, Any]] = {}
        self.property_instances: dict[str, dict[str, Any]] = {}
        self.history_events: list[dict[str, Any]] = []
        self._counter = 0

    async def health(self) -> dict[str, Any]:
        return {"ok": True, "service": "fake-gateway", "capabilities": {"preview": True, "batches": True, "history": True,
                "spatialObb": "aabb-derived"}}

    async def summary(self, document_id: str) -> dict[str, Any]:
        return {
            "documentId": document_id,
            "revision": self.revision,
            "bodyCount": len(self.bodies),
            "bodies": [{"id": key, "label": item["label"]} for key, item in self.bodies.items()],
            "variables": list(self.variables.values()),
            "coordinateSystems": list(self.coordinate_systems.values()),
            "materials": list(self.materials.values()),
            "properties": list(self.properties.values()),
        }

    async def view(self, document_id: str, *, offset: int = 0, limit: int = 50) -> dict[str, Any]:
        return await self.summary(document_id)

    async def property_list(self, document_id: str) -> dict[str, Any]:
        return {"documentId": document_id, "properties": []}

    async def model_query(self, document_id: str, *, kind: str = "geometry-tree",
                          body_id: str | None = None, feature_id: str | None = None) -> dict[str, Any]:
        if kind in {"variables", "coordinates", "materials", "history", "properties", "property-types"}:
            key = {"variables": "variables", "coordinates": "coordinateSystems",
                   "materials": "materials", "history": "history", "properties": "properties",
                   "property-types": "propertyTypes"}[kind]
            value: Any = {
                "variables": list(self.variables.values()),
                "coordinateSystems": list(self.coordinate_systems.values()),
                "materials": list(self.materials.values()),
                "properties": list(self.properties.values()),
                "propertyTypes": list(self.property_types.values()),
                "history": {"events": list(self.history_events), "canUndo": bool(self.history_events), "canRedo": False},
            }[key]
            return {"ok": True, "documentId": document_id, "revision": self.revision,
                    "query": {"revision": self.revision, key: value}}
        selected = self.bodies if kind == "geometry-tree" else ({body_id: self.bodies[body_id]} if body_id in self.bodies else {})
        bodies = [{"bodyId": key, "name": value["label"], "spatial": {
            "bounds": {"min": value["min"], "max": value["max"]},
            "center": value["center"], "size": [b - a for a, b in zip(value["min"], value["max"])],
            "obb": {"center": value["center"], "axes": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    "halfSizes": [(b - a) / 2 for a, b in zip(value["min"], value["max"])],
                    "source": "aabb-derived", "exact": False},
            "volume": value["volume"],
        }} for key, value in selected.items()]
        return {"ok": True, "documentId": document_id, "revision": self.revision,
                "query": {"revision": self.revision, "bodies": bodies}}

    async def measure(self, document_id: str, body_id: str, selection_type: str = "body", selection_id: str | None = None) -> dict[str, Any]:
        body = self.bodies[body_id]
        return {"bodyId": body_id, "bounds": {"min": body["min"], "max": body["max"]},
                "volume": body["volume"], "center": body["center"],
                "obb": {"center": body["center"], "axes": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                        "halfSizes": [(b - a) / 2 for a, b in zip(body["min"], body["max"])],
                        "source": "aabb-derived", "exact": False}}

    async def check(self, document_id: str, body_id: str) -> dict[str, Any]:
        return {"bodyId": body_id, "valid": body_id in self.bodies}

    async def relation(self, document_id: str, body_a: str, body_b: str,
                       tolerance: float = 1.0e-6) -> dict[str, Any]:
        first, second = self.bodies[body_a], self.bodies[body_b]
        gaps = [max(first["min"][index] - second["max"][index],
                    second["min"][index] - first["max"][index], 0.0) for index in range(3)]
        distance = sum(value * value for value in gaps) ** 0.5
        return {"bodyA": body_a, "bodyB": body_b, "distance": distance,
                "relation": "touching" if distance <= tolerance else "disjoint",
                "tolerance": tolerance, "commonVolume": 0.0,
                "source": "aabb-derived", "exact": False}

    async def history(self, document_id: str, direction: str, *, idempotency_key: str,
                      expected_revision: int | None = None) -> dict[str, Any]:
        if expected_revision is not None and expected_revision != self.revision:
            raise ValueError("Revision changed before history operation")
        if direction == "undo" and self.bodies:
            self.bodies.popitem()
            self.revision += 1
        return {"ok": True, "revision": self.revision, "direction": direction}

    async def execute(self, action: ActionEnvelope) -> Observation:
        if action.idempotency_key in {item.get("idempotency") for item in self.bodies.values()}:
            body_id = next(key for key, item in self.bodies.items() if item.get("idempotency") == action.idempotency_key)
            return Observation(action_id=action.action_id, success=True, result={"bodyId": body_id, "idempotent": True}, after_revision=self.revision)
        if action.tool_name != "primitive.box":
            if action.tool_name == "primitive.cylinder":
                return self._create_cylinder(action)
            if action.tool_name == "primitive.cone":
                return self._create_cone(action)
            if action.tool_name == "primitive.sphere":
                return self._create_sphere(action)
            if action.tool_name == "primitive.torus":
                return self._create_torus(action)
            if action.tool_name == "boolean.cut":
                return self._cut(action)
            if action.tool_name in {"boolean.fuse", "boolean.common"}:
                return self._boolean(action)
            if action.tool_name == "transform.translate":
                return self._translate(action)
            if action.tool_name == "transform.scale":
                return self._scale(action)
            if action.tool_name == "transform.rotate":
                return self._rotate(action)
            if action.tool_name == "geometry.relation":
                inputs = action.arguments.get("inputs", action.arguments)
                params = action.arguments.get("parameters", action.arguments)
                try:
                    result = await self.relation(self.document_id, str(inputs["bodyA"]), str(inputs["bodyB"]),
                                                 float(params.get("tolerance", 1.0e-6)))
                except (KeyError, ValueError):
                    return Observation(action_id=action.action_id, success=False, error_code="ENTITY_NOT_FOUND")
                return Observation(action_id=action.action_id, success=True, result=result,
                                   before_revision=self.revision, after_revision=self.revision)
            if action.tool_name in {"detail.fillet", "detail.chamfer"}:
                return self._detail(action)
            if action.tool_name.startswith("pattern."):
                return self._pattern(action)
            if action.tool_name in {"variable.set", "coordinate.set", "material.set", "body.update",
                                    "property.set", "property.delete", "material.property.set",
                                    "material.property.delete", "property.type.create", "property.type.update",
                                    "property.type.delete", "property.instance.create", "property.instance.update",
                                    "property.instance.retarget", "property.instance.delete"}:
                return self._metadata_mutation(action)
            return Observation(action_id=action.action_id, success=False, error_code="UNSUPPORTED_OPERATION")
        args = action.arguments
        width, depth, height = (float(args[key]) for key in ("width", "depth", "height"))
        x, y, z = (float(args.get(key, 0.0)) for key in ("x", "y", "z"))
        self._counter += 1
        body_id = f"body-{self._counter}"
        self.bodies[body_id] = {
            "label": str(args.get("label", body_id)),
            "min": [x, y, z], "max": [x + width, y + depth, z + height],
            "center": [x + width / 2, y + depth / 2, z + height / 2],
            "volume": width * depth * height, "idempotency": action.idempotency_key,
        }
        before = self.revision
        self.revision += 1
        return Observation(action_id=action.action_id, success=True, result={"bodyId": body_id}, before_revision=before, after_revision=self.revision, duration_ms=1)

    async def preview(self, action: ActionEnvelope) -> dict[str, Any]:
        return {"ok": True, "preview": True, "operation": action.tool_name, "parameters": action.arguments,
                "revision": self.revision}

    def _metadata_ack(self, action: ActionEnvelope, kind: str = "metadata") -> Observation:
        before = self.revision
        self.revision += 1
        self.history_events.append({"operation": action.tool_name, "revision": self.revision})
        return Observation(action_id=action.action_id, success=True,
                           result={"ok": True, "operation": action.tool_name, "kind": kind,
                                   "revision": self.revision}, before_revision=before, after_revision=self.revision)

    def _pattern(self, action: ActionEnvelope) -> Observation:
        inputs = action.arguments.get("inputs", action.arguments)
        body_id = str(inputs.get("bodyId", ""))
        if body_id not in self.bodies:
            return Observation(action_id=action.action_id, success=False, error_code="ENTITY_NOT_FOUND")
        return self._metadata_ack(action, "pattern")

    def _metadata_mutation(self, action: ActionEnvelope) -> Observation:
        inputs = action.arguments.get("inputs", action.arguments)
        params = action.arguments.get("parameters", action.arguments)
        operation = action.tool_name
        if operation == "variable.set":
            self.variables[str(params["name"])] = {"name": str(params["name"]), "type": params["type"], "expression": params["expression"]}
        elif operation == "coordinate.set":
            self.coordinate_systems[str(params["id"])] = dict(params)
        elif operation == "material.set":
            self.materials[str(params["name"])] = dict(params)
        elif operation == "body.update":
            body = self.bodies.get(str(inputs.get("bodyId")))
            if body is None:
                return Observation(action_id=action.action_id, success=False, error_code="ENTITY_NOT_FOUND")
            body.update({key: value for key, value in params.items() if key in {"name", "label", "material", "visible", "color"}})
        elif operation in {"property.set", "property.delete"}:
            key = f"{inputs.get('kind')}:{inputs.get('bodyId')}:{inputs.get('topologyId', '')}:{params.get('key')}"
            if operation == "property.set": self.properties[key] = {"key": key, **inputs, **params}
            else: self.properties.pop(key, None)
        elif operation.startswith("property.type."):
            key = str(params.get("key") or inputs.get("typeId") or "")
            if operation == "property.type.delete": self.property_types.pop(key, None)
            else: self.property_types[key] = {**inputs, **params, "typeId": key}
        elif operation.startswith("property.instance."):
            key = str(params.get("instanceId") or inputs.get("instanceId") or self._counter + 1)
            if operation == "property.instance.delete": self.property_instances.pop(key, None)
            else: self.property_instances[key] = {**inputs, **params, "instanceId": key}
        return self._metadata_ack(action)

    def _create_cylinder(self, action: ActionEnvelope) -> Observation:
        args = action.arguments
        radius, height = float(args["radius"]), float(args["height"])
        x, y, z = (float(args.get(key, 0.0)) for key in ("x", "y", "z"))
        self._counter += 1
        body_id = f"body-{self._counter}"
        self.bodies[body_id] = {
            "label": str(args.get("label", body_id)), "kind": "cylinder",
            "min": [x - radius, y - radius, z], "max": [x + radius, y + radius, z + height],
            "center": [x, y, z + height / 2], "volume": 3.141592653589793 * radius * radius * height,
            "idempotency": action.idempotency_key,
        }
        before = self.revision; self.revision += 1
        measurement = {"bodyId": body_id, "bounds": {"min": list(self.bodies[body_id]["min"]), "max": list(self.bodies[body_id]["max"])},
                       "center": list(self.bodies[body_id]["center"]), "volume": self.bodies[body_id]["volume"]}
        return Observation(action_id=action.action_id, success=True, result={"bodyId": body_id, "measurement": measurement}, before_revision=before, after_revision=self.revision)

    def _new_body(self, action: ActionEnvelope, *, minimum: list[float], maximum: list[float],
                  center: list[float], volume: float, kind: str) -> Observation:
        self._counter += 1
        body_id = f"body-{self._counter}"
        self.bodies[body_id] = {"label": str(action.arguments.get("label", body_id)), "kind": kind,
                                "min": minimum, "max": maximum, "center": center,
                                "volume": max(0.0, float(volume)), "idempotency": action.idempotency_key}
        before = self.revision; self.revision += 1
        measurement = {"bodyId": body_id, "bounds": {"min": list(minimum), "max": list(maximum)},
                       "center": list(center), "volume": max(0.0, float(volume))}
        return Observation(action_id=action.action_id, success=True,
                           result={"bodyId": body_id, "measurement": measurement},
                           before_revision=before, after_revision=self.revision)

    def _create_cone(self, action: ActionEnvelope) -> Observation:
        args = action.arguments; r1 = float(args["radius1"]); r2 = float(args["radius2"]); height = float(args["height"])
        x, y, z = (float(args.get(key, 0.0)) for key in ("x", "y", "z"))
        radius = max(r1, r2)
        volume = pi * height * (r1 * r1 + r1 * r2 + r2 * r2) / 3
        return self._new_body(action, minimum=[x - radius, y - radius, z], maximum=[x + radius, y + radius, z + height],
                              center=[x, y, z + height / 2], volume=volume, kind="cone")

    def _create_sphere(self, action: ActionEnvelope) -> Observation:
        args = action.arguments; radius = float(args["radius"])
        x, y, z = (float(args.get(key, 0.0)) for key in ("x", "y", "z"))
        return self._new_body(action, minimum=[x - radius, y - radius, z - radius],
                              maximum=[x + radius, y + radius, z + radius], center=[x, y, z],
                              volume=4 * pi * radius ** 3 / 3, kind="sphere")

    def _create_torus(self, action: ActionEnvelope) -> Observation:
        args = action.arguments; major = float(args["majorRadius"]); minor = float(args["minorRadius"])
        x, y, z = (float(args.get(key, 0.0)) for key in ("x", "y", "z"))
        radius = major + minor
        return self._new_body(action, minimum=[x - radius, y - radius, z - minor],
                              maximum=[x + radius, y + radius, z + minor], center=[x, y, z],
                              volume=2 * pi ** 2 * major * minor ** 2, kind="torus")

    def _cut(self, action: ActionEnvelope) -> Observation:
        args = action.arguments.get("inputs", action.arguments)
        target_id, tool_id = str(args["targetBody"]), str(args["toolBody"])
        if target_id not in self.bodies or tool_id not in self.bodies:
            return Observation(action_id=action.action_id, success=False, error_code="ENTITY_NOT_FOUND")
        target, tool = self.bodies[target_id], self.bodies[tool_id]
        target["volume"] = max(0.0, float(target["volume"]) - float(tool["volume"]))
        target["kind"] = "cut"
        self.bodies.pop(tool_id)
        before = self.revision; self.revision += 1
        return Observation(action_id=action.action_id, success=True, result={"bodyId": target_id}, before_revision=before, after_revision=self.revision)

    def _boolean(self, action: ActionEnvelope) -> Observation:
        args = action.arguments.get("inputs", action.arguments)
        target_id, tool_id = str(args["targetBody"]), str(args["toolBody"])
        if target_id not in self.bodies or tool_id not in self.bodies:
            return Observation(action_id=action.action_id, success=False, error_code="ENTITY_NOT_FOUND")
        target, tool = self.bodies[target_id], self.bodies[tool_id]
        if action.tool_name == "boolean.fuse":
            target["volume"] = float(target["volume"]) + float(tool["volume"])
            target["min"] = [min(a, b) for a, b in zip(target["min"], tool["min"])]
            target["max"] = [max(a, b) for a, b in zip(target["max"], tool["max"])]
        else:
            target["volume"] = max(0.0, min(float(target["volume"]), float(tool["volume"])))
        target["kind"] = action.tool_name.rsplit(".", 1)[-1]
        self.bodies.pop(tool_id)
        before = self.revision; self.revision += 1
        return Observation(action_id=action.action_id, success=True, result={"bodyId": target_id}, before_revision=before, after_revision=self.revision)

    def _translate(self, action: ActionEnvelope) -> Observation:
        inputs = action.arguments.get("inputs", action.arguments); params = action.arguments.get("parameters", action.arguments)
        body_id = str(inputs["bodyId"]); body = self.bodies.get(body_id)
        if body is None: return Observation(action_id=action.action_id, success=False, error_code="ENTITY_NOT_FOUND")
        delta = [float(params[key]) for key in ("dx", "dy", "dz")]
        body["min"] = [value + shift for value, shift in zip(body["min"], delta)]
        body["max"] = [value + shift for value, shift in zip(body["max"], delta)]
        body["center"] = [value + shift for value, shift in zip(body["center"], delta)]
        before = self.revision; self.revision += 1
        return Observation(action_id=action.action_id, success=True, result={"bodyId": body_id}, before_revision=before, after_revision=self.revision)

    def _scale(self, action: ActionEnvelope) -> Observation:
        inputs = action.arguments.get("inputs", action.arguments); body_id = str(inputs["bodyId"]); body = self.bodies.get(body_id)
        if body is None: return Observation(action_id=action.action_id, success=False, error_code="ENTITY_NOT_FOUND")
        factor = float(action.arguments.get("parameters", action.arguments).get("factor", 1.0))
        if factor <= 0: return Observation(action_id=action.action_id, success=False, error_code="INVALID_PARAMETER")
        center = body["center"]
        body["min"] = [c + (v - c) * factor for v, c in zip(body["min"], center)]
        body["max"] = [c + (v - c) * factor for v, c in zip(body["max"], center)]
        body["volume"] = float(body["volume"]) * factor ** 3
        before = self.revision; self.revision += 1
        return Observation(action_id=action.action_id, success=True, result={"bodyId": body_id}, before_revision=before, after_revision=self.revision)

    def _rotate(self, action: ActionEnvelope) -> Observation:
        inputs = action.arguments.get("inputs", action.arguments); body_id = str(inputs["bodyId"])
        if body_id not in self.bodies: return Observation(action_id=action.action_id, success=False, error_code="ENTITY_NOT_FOUND")
        before = self.revision; self.revision += 1
        return Observation(action_id=action.action_id, success=True, result={"bodyId": body_id}, before_revision=before, after_revision=self.revision)

    def _detail(self, action: ActionEnvelope) -> Observation:
        inputs = action.arguments.get("inputs", action.arguments); body_id = str(inputs["bodyId"])
        if body_id not in self.bodies: return Observation(action_id=action.action_id, success=False, error_code="ENTITY_NOT_FOUND")
        before = self.revision; self.revision += 1
        self.bodies[body_id]["kind"] = action.tool_name.rsplit(".", 1)[-1]
        return Observation(action_id=action.action_id, success=True, result={"bodyId": body_id}, before_revision=before, after_revision=self.revision)

    async def execute_batch(self, actions: list[ActionEnvelope]) -> list[Observation]:
        results: dict[str, dict[str, Any]] = {}
        observations: list[Observation] = []
        snapshot = (deepcopy(self.bodies), self.revision, self._counter)
        for action in actions:
            resolved = _resolve_refs(action.arguments, results)
            observation = await self.execute(action.model_copy(update={"arguments": resolved}))
            observations.append(observation)
            if action.step_id:
                results[action.step_id] = observation.result
            if not observation.success:
                self.bodies, self.revision, self._counter = snapshot
                return [Observation(action_id=item.action_id, success=False, error_code="BATCH_ROLLED_BACK",
                                    error_class=observation.error_class, result={"failed": observation.result})
                        for item in actions]
        return observations


def _resolve_refs(value: Any, results: dict[str, dict[str, Any]]) -> Any:
    if isinstance(value, list):
        return [_resolve_refs(item, results) for item in value]
    if isinstance(value, dict):
        if isinstance(value.get("$ref"), str):
            step_id, field = value["$ref"].split(".", 1)
            source = results[step_id]
            return source.get(field) if field in source else source.get("bodyId") if field == "body_id" else source[field]
        return {key: _resolve_refs(item, results) for key, item in value.items()}
    return value
