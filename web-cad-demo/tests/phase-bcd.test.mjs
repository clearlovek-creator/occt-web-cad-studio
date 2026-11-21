import { ObservedCommandClient } from "./helpers/observed-command-client.mjs";
import {stopTestChild} from './helpers/stop-test-child.mjs';
const observedClient = new ObservedCommandClient();
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8811;
const api = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), `occt-phase-bcd-${process.pid}-${Date.now()}`);
let gateway;

before(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  gateway = spawn(process.execPath, [path.join(root, "gateway", "server.mjs")], {
    cwd: root,
    env: { ...process.env, GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: dataDir },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway startup timeout")), 10_000);
    gateway.once("error", reject);
    gateway.stdout.setEncoding("utf8");
    gateway.stdout.on("data", (chunk) => { if (chunk.includes("Geometry gateway ready")) { clearTimeout(timer); resolve(); } });
    gateway.stderr.setEncoding("utf8");
    gateway.stderr.on("data", (chunk) => { if (chunk.includes("Error")) { clearTimeout(timer); reject(new Error(chunk)); } });
  });
});

after(async () => {
  await stopTestChild(gateway);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function command(body) {
  const response = await fetch(`${api}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(observedClient.prepare(body, "", '/commands')) });
  return { response, payload: observedClient.observe(await response.json(), body.documentId) };
}

function axisBounds(positions, axis = 0) {
  const values = [];
  for (let index = axis; index < positions.length; index += 3) values.push(positions[index]);
  return { min: Math.min(...values), max: Math.max(...values) };
}

function near(actual, expected, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
}

test("phase B evaluates scalar expressions and atomically recomputes dependent geometry", async () => {
  const documentId = "phase_b_variables";
  let result = await command({ operation: "document.create", documentId });
  result = await command({ operation: "variable.set", documentId, baseRevision: result.payload.revision, parameters: { name: "width", type: "length", expression: "40 mm" } });
  result = await command({ operation: "variable.set", documentId, baseRevision: result.payload.revision, parameters: { name: "clearance", type: "length", expression: "5 mm" } });
  result = await command({ operation: "primitive.box", documentId, parameters: { width: "width + 2 * clearance", depth: "20 mm", height: "10 mm" } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  near(axisBounds(result.payload.positions).max, 50);
  assert.equal(result.payload.features[0].stringParameters["expr.width"], "width + 2 * clearance");

  result = await command({ operation: "variable.set", documentId, baseRevision: result.payload.revision, parameters: { name: "width", type: "length", expression: "60 mm" } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  near(axisBounds(result.payload.positions).max, 70);

  const undefinedVariable = await command({ operation: "primitive.sphere", documentId, parameters: { radius: "missingRadius" } });
  assert.equal(undefinedVariable.response.status, 400);
  assert.match(undefinedVariable.payload.error, /Undefined scalar variable/i);

  result = await command({ operation: "variable.set", documentId, baseRevision: result.payload.revision, parameters: { name: "ratio", type: "dimensionless", expression: "0.25" } });
  assert.equal(result.payload.variables.find((item) => item.name === "ratio").type, "dimensionless");
  result = await command({ operation: "primitive.box", documentId, baseRevision: result.payload.revision, parameters: { width: "ratio * 40 mm", depth: "10 mm", height: "10 mm" } });
  near(axisBounds(result.payload.positions).max, 10);
  result = await command({ operation: "variable.set", documentId, baseRevision: result.payload.revision, parameters: { name: "countA", type: "integer", expression: "2" } });
  result = await command({ operation: "variable.set", documentId, baseRevision: result.payload.revision, parameters: { name: "countB", type: "integer", expression: "countA" } });
  const cycle = await command({ operation: "variable.set", documentId, baseRevision: result.payload.revision, parameters: { name: "countA", type: "integer", expression: "countB" } });
  assert.equal(cycle.response.status, 400);
  assert.match(cycle.payload.error, /cycle/i);
});

test("phase B accepts plain numeric variables and preserves numeric primitive history", async () => {
  const documentId = "phase_b_numeric_history";
  let result = await command({ operation: "primitive.box", documentId, parameters: { width: 100, depth: 80, height: 50 } });
  result = await command({ operation: "variable.set", documentId, baseRevision: result.payload.revision, parameters: { name: "wall", type: "length", expression: "12" } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.variables.find((item) => item.name === "wall").type, "length");
  assert.equal(result.payload.variables.find((item) => item.name === "wall").value, 12);
  result = await command({ operation: "variable.set", documentId, baseRevision: result.payload.revision, parameters: { name: "tilt", type: "angle", expression: "15" } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.variables.find((item) => item.name === "tilt").value, 15);
});

test("a saved missing variable remains available when the retried primitive has another error", async () => {
  const documentId = "variable_retry_after_invalid_geometry";
  const initial = await command({ operation: "document.create", documentId });
  const missing = await command({ operation: "primitive.box", documentId, parameters: { width: "newWidth", depth: 0, height: 10 } });
  assert.equal(missing.response.status, 400);
  assert.match(missing.payload.error, /Undefined scalar variable/i);

  const saved = await command({ operation: "variable.set", documentId, baseRevision: initial.payload.revision, parameters: { name: "newWidth", type: "length", expression: "25 mm" } });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.variables.find((item) => item.name === "newWidth")?.value, 25);
  assert.ok(saved.payload.revision > initial.payload.revision);

  const invalid = await command({ operation: "primitive.box", documentId, baseRevision: saved.payload.revision, parameters: { width: "newWidth", depth: 0, height: 10 } });
  assert.equal(invalid.response.status, 400);
  const fixed = await command({ operation: "primitive.box", documentId, baseRevision: saved.payload.revision, parameters: { width: "newWidth", depth: 12, height: 10 } });
  assert.equal(fixed.response.status, 200, JSON.stringify(fixed.payload));
  near(axisBounds(fixed.payload.positions).max, 25);
});
test("phase B persists Three-Point coordinates and recomputes referenced primitives", async () => {
  const documentId = "phase_b_coordinates";
  let result = await command({ operation: "document.create", documentId });
  result = await command({ operation: "coordinate.set", documentId, baseRevision: result.payload.revision, parameters: { id: "fixture", name: "Fixture", kind: "threePoint", origin: [100, 0, 0], xPoint: [101, 0, 0], planePoint: [100, 1, 0] } });
  assert.equal(result.payload.coordinateSystems.find((item) => item.id === "fixture").kind, "threePoint");
  result = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10, coordinateSystemId: "fixture" } });
  near(axisBounds(result.payload.positions).min, 100);
  result = await command({ operation: "coordinate.set", documentId, baseRevision: result.payload.revision, parameters: { id: "fixture", name: "Fixture", kind: "threePoint", origin: [150, 0, 0], xPoint: [151, 0, 0], planePoint: [150, 1, 0] } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  near(axisBounds(result.payload.positions).min, 150);
});

test("phase B derives a persistent coordinate frame from a selected Face", async () => {
  const documentId = "phase_b_face_coordinate";
  let result = await command({ operation: "primitive.box", documentId, parameters: { width: 20, depth: 15, height: 10 } });
  const faceId = result.payload.triangleFaceIds[0];
  result = await command({ operation: "coordinate.set", documentId, baseRevision: result.payload.revision, parameters: { id: "faceFrame", name: "FaceFrame", kind: "face", referenceBodyId: result.payload.bodyId, referenceTopologyId: faceId } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const frame = result.payload.coordinateSystems.find((item) => item.id === "faceFrame");
  assert.equal(frame.kind, "face");
  assert.equal(frame.referenceTopologyId, faceId);
  assert.ok(frame.origin.every(Number.isFinite));
});
test("phase C stores Body presentation metadata and restores it with undo", async () => {
  const documentId = "phase_c_body";
  let result = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10 } });
  result = await command({ operation: "body.update", documentId, baseRevision: result.payload.revision, inputs: { bodyId: result.payload.bodyId }, parameters: { name: "Housing", visible: false, color: "#cc5500", material: "Copper", activate: true } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const metadata = result.payload.bodyMetadata.find((item) => item.bodyId === result.payload.bodyId);
  assert.deepEqual({ name: metadata.name, visible: metadata.visible, color: metadata.color, material: metadata.material }, { name: "Housing", visible: false, color: "#cc5500", material: "Copper" });
  const undone = await command({ operation: "document.undo", documentId });
  assert.equal(undone.payload.bodyMetadata[0].visible, true);
});

test("phase C manages the material library and protects materials in use", async () => {
  const documentId = "phase_c_materials";
  let result = await command({ operation: "document.create", documentId });
  assert.ok(result.payload.materials.some((item) => item.name === "Copper" && item.builtIn));
  result = await command({ operation: "material.set", documentId, baseRevision: result.payload.revision, parameters: { name: "FR4", category: "dielectric", relativePermittivity: 4.3, conductivity: 0.02, color: "#123456", customProperties: { isotropic: { type: "bool", value: true }, layerCount: { type: "int", value: 4 }, lossTangent: { type: "double", value: 0.02 }, thickness: { type: "expression", expression: "1.6 mm", dimension: "length" } } } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.materials.find((item) => item.name === "FR4").relativePermittivity, 4.3);
  assert.equal(result.payload.materials.find((item) => item.name === "FR4").customProperties.layerCount.value, 4);
  assert.equal(result.payload.materials.find((item) => item.name === "FR4").customProperties.thickness.resolvedValue, 1.6);
  result = await command({ operation: "material.property.set", documentId, baseRevision: result.payload.revision, parameters: { materialName: "FR4", key: "isMagnetic", type: "bool", value: false } });
  assert.equal(result.payload.materials.find((item) => item.name === "FR4").customProperties.isMagnetic.value, false);
  result = await command({ operation: "material.property.delete", documentId, baseRevision: result.payload.revision, parameters: { materialName: "FR4", key: "isMagnetic" } });
  assert.equal(result.payload.materials.find((item) => item.name === "FR4").customProperties.isMagnetic, undefined);
  result = await command({ operation: "primitive.box", documentId, baseRevision: result.payload.revision, parameters: { width: 10, depth: 10, height: 10 } });
  result = await command({ operation: "body.update", documentId, baseRevision: result.payload.revision, inputs: { bodyId: result.payload.bodyId }, parameters: { material: "FR4" } });
  const inUse = await command({ operation: "material.delete", documentId, baseRevision: result.payload.revision, inputs: { name: "FR4" } });
  assert.equal(inUse.response.status, 400);
  assert.equal(inUse.payload.code, "MATERIAL_IN_USE");
  result = await command({ operation: "body.update", documentId, baseRevision: result.payload.revision, inputs: { bodyId: result.payload.bodyId }, parameters: { material: "" } });
  result = await command({ operation: "material.delete", documentId, baseRevision: result.payload.revision, inputs: { name: "FR4" } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const builtIn = await command({ operation: "material.delete", documentId, baseRevision: result.payload.revision, inputs: { name: "Copper" } });
  assert.equal(builtIn.response.status, 400);
  assert.equal(builtIn.payload.code, "BUILT_IN_MATERIAL");
});
test("phase D creates all added primitives and advanced transforms", async () => {
  for (const [kind, parameters] of Object.entries({
    wedge: { width: 30, depth: 20, height: 15, topLength: 10 },
    prism: { radius: 10, sides: 6, height: 20 },
    pyramid: { baseWidth: 20, baseDepth: 18, topWidth: 8, topDepth: 6, height: 20 },
    tube: { outerRadius: 12, innerRadius: 7, height: 20 },
  })) {
    const result = await command({ operation: `primitive.${kind}`, documentId: `phase_d_${kind}`, parameters });
    assert.equal(result.response.status, 200, `${kind}: ${JSON.stringify(result.payload)}`);
    assert.equal(result.payload.features.at(-1).type, `primitive.${kind}`);
    assert.ok(result.payload.stats.faceCount > 0);
  }

  const documentId = "phase_d_transforms";
  let result = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 20, height: 30 } });
  const originalBody = result.payload.bodyId;
  result = await command({ operation: "transform.copy", documentId, baseRevision: result.payload.revision, inputs: { bodyId: originalBody }, parameters: { dx: "20 mm", dy: 0, dz: 0 } });
  assert.equal(result.payload.bodyCount, 2);
  assert.notEqual(result.payload.bodyId, originalBody);
  result = await command({ operation: "transform.scale_non_uniform", documentId, baseRevision: result.payload.revision, inputs: { bodyId: result.payload.bodyId }, parameters: { factorX: "2", factorY: "1", factorZ: "0.5" } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  result = await command({ operation: "transform.align", documentId, baseRevision: result.payload.revision, inputs: { bodyId: result.payload.bodyId }, parameters: { targetX: 0, targetY: 0, targetZ: 0, mode: "center" } });
  const x = axisBounds(result.payload.positions, 0);
  near((x.min + x.max) / 2, 0);
  result = await command({ operation: "transform.mirror", documentId, baseRevision: result.payload.revision, inputs: { bodyId: result.payload.bodyId }, parameters: { mode: "point", originX: 0, originY: 0, originZ: 0 } });
  assert.equal(result.payload.features.at(-1).stringParameters.mode, "point");
});

test("phase D executes Section, Split and multi-input Fragments", async () => {
  async function boxes(documentId, count = 2) {
    let last;
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      last = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10, x: index * 5 } });
      ids.push(last.payload.bodyId);
    }
    return { last, ids };
  }

  let setup = await boxes("phase_d_section");
  let result = await command({ operation: "boolean.section", documentId: "phase_d_section", baseRevision: setup.last.payload.revision, inputs: { targetBodies: [setup.ids[0]], toolBodies: [setup.ids[1]] }, parameters: { keepTarget: true, keepTool: true } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.features.at(-1).type, "boolean.section");

  setup = await boxes("phase_d_split");
  result = await command({ operation: "boolean.split", documentId: "phase_d_split", baseRevision: setup.last.payload.revision, inputs: { targetBodies: [setup.ids[0]], toolBodies: [setup.ids[1]] }, parameters: { keepTool: true, refine: true } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));

  setup = await boxes("phase_d_fragments", 3);
  result = await command({ operation: "boolean.fragments", documentId: "phase_d_fragments", baseRevision: setup.last.payload.revision, inputs: { targetBodies: [setup.ids[0], setup.ids[1]], toolBodies: [setup.ids[2]] }, parameters: { keepTarget: false, keepTool: false, refine: true } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.features.at(-1).stringParameters.targetBodies.split(",").sort(), [setup.ids[0], setup.ids[1]].sort());
});
