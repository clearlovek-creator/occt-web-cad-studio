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

const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8805;
const apiRoot = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), "occt-web-cad-feature-graph-recompute-" + process.pid + "-" + Date.now());
let gateway;

before(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  gateway = spawn(process.execPath, [path.join(demoRoot, "gateway", "server.mjs")], {
    cwd: demoRoot,
    env: { ...process.env, GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: dataDir },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Geometry gateway startup timed out.")), 10_000);
    gateway.once("error", reject);
    gateway.stdout.setEncoding("utf8");
    gateway.stdout.on("data", (chunk) => {
      if (chunk.includes("Geometry gateway ready")) { clearTimeout(timer); resolve(); }
    });
    gateway.stderr.setEncoding("utf8");
    gateway.stderr.on("data", (chunk) => {
      if (chunk.includes("Error")) { clearTimeout(timer); reject(new Error(chunk)); }
    });
  });
});

after(async () => {
  await stopTestChild(gateway);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function command(body) {
  const response = await fetch(`${apiRoot}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(observedClient.prepare(body, "", '/commands')),
  });
  return { response, payload: observedClient.observe(await response.json(), body.documentId) };
}

function xBounds(positions) {
  const xs = positions.filter((unused, index) => index % 3 === 0);
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

test("edits a Transform feature parameter and recomputes its result", async () => {
  const documentId = "transform_parameter_recompute";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 10, depth: 20, height: 30, reset: true },
  });
  const translated = await command({
    operation: "transform.translate", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId }, parameters: { dx: 5, dy: 0, dz: 0 },
  });
  const transformFeature = translated.payload.features.at(-1);
  const updated = await command({
    operation: "feature.update", documentId, baseRevision: translated.payload.revision,
    inputs: { featureId: transformFeature.id }, parameters: { dx: 10, dy: 0, dz: 0 },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.deepEqual(xBounds(updated.payload.positions), { min: 10, max: 20 });
  assert.equal(updated.payload.features.at(-1).numberParameters.dx, 10);
});
test("rejects an oversized direct Fillet without terminating the worker", async () => {
  const documentId = "oversized_direct_fillet";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 30, depth: 30, height: 30, reset: true },
  });
  const rejected = await command({
    operation: "detail.fillet", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId, edgeId: box.payload.edges[0].edgeId },
    parameters: { radius: 100 },
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.payload.code, "INVALID_PARAMETER");
  const health = await fetch(`${apiRoot}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});
test("edits Fillet parameters atomically and follows a proven generated boundary edge", async () => {
  const documentId = "fillet_parameter_recompute";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 30, depth: 30, height: 30, reset: true },
  });
  let result = await command({
    operation: "property.set", documentId, baseRevision: box.payload.revision,
    inputs: { kind: "body", bodyId: box.payload.bodyId, topologyId: "" },
    parameters: { key: "part.number", type: "expression", value: "P-001" },
  });
  const sourceEdge=box.payload.edges.find(edge=>edge.points.every((value,index)=>index%3===2 || Math.abs(value)<1e-8));assert.ok(sourceEdge);
  const fillet = await command({
    operation: "detail.fillet", documentId, baseRevision: result.payload.revision,
    inputs: { bodyId: box.payload.bodyId, edgeId: sourceEdge.edgeId },
    parameters: { radius: 2 },
  });
  const filletFeature = fillet.payload.features.at(-1);
  const boundary=fillet.payload.edges.find(edge=>edge.points.every((value,index)=>index%3===0?Math.abs(value-2)<1e-8:index%3===1?Math.abs(value)<1e-8:true));assert.ok(boundary,'The marker must be on the front/blend tangent boundary');
  result = await command({
    operation: "property.set", documentId, baseRevision: fillet.payload.revision,
    inputs: { kind: "edge", bodyId: box.payload.bodyId, topologyId: boundary.edgeId },
    parameters: { key: "edge.marker", type: "expression", value: "critical" },
  });

  const updated = await command({
    operation: "feature.update", documentId, baseRevision: result.payload.revision,
    inputs: { featureId: filletFeature.id }, parameters: { radius: 4 },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.features.at(-1).numberParameters.radius, 4);
  assert.equal(updated.payload.features.at(-1).computedRevision, updated.payload.revision);

  const properties = await command({ operation: "property.list", documentId, inputs: {} });
  assert.ok(properties.payload.propertyRecords.some(
    (item) => item.kind === "body" && item.state === "active"
      && item.values["part.number"]?.value === "P-001",
  ));
  const marker=properties.payload.propertyRecords.filter(item=>item.kind==='edge'&&item.state==='active'&&item.values['edge.marker']?.value==='critical');assert.equal(marker.length,1);
  const measured=await command({operation:'geometry.measure',documentId,inputs:{bodyId:box.payload.bodyId,selectionType:'edge',selectionId:marker[0].topologyId}});
  assert.ok(Math.abs(measured.payload.length-30)<1e-6);measured.payload.centroid.forEach((value,index)=>assert.ok(Math.abs(value-[4,0,15][index])<1e-10,'The same proven tangent boundary must move with radius 2 → 4'));

  const rejected = await command({
    operation: "feature.update", documentId, baseRevision: updated.payload.revision,
    inputs: { featureId: filletFeature.id }, parameters: { radius: 100 },
  });
  assert.equal(rejected.response.status, 400);
  assert.ok(["INVALID_PARAMETER", "BUILD_FAILED", "INVALID_RESULT"].includes(rejected.payload.code), JSON.stringify(rejected.payload));
  const summary = await command({ operation: "document.summary", documentId });
  assert.equal(summary.payload.revision, updated.payload.revision);

  const undone = await command({ operation: "document.undo", documentId });
  assert.equal(undone.payload.features.at(-1).numberParameters.radius, 2);
});

test("creates, edits, suppresses and restores a Chamfer feature", async () => {
  const documentId = "chamfer_feature_lifecycle";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 30, depth: 30, height: 30, reset: true },
  });
  const chamfer = await command({
    operation: "detail.chamfer", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId, edgeId: box.payload.edges[0].edgeId },
    parameters: { distance: 2 },
  });
  assert.equal(chamfer.response.status, 200, JSON.stringify(chamfer.payload));
  assert.ok(chamfer.payload.stats.faceCount > box.payload.stats.faceCount);
  const feature = chamfer.payload.features.at(-1);
  assert.equal(feature.type, "detail.chamfer");
  assert.equal(feature.numberParameters.distance, 2);

  const updated = await command({
    operation: "feature.update", documentId, baseRevision: chamfer.payload.revision,
    inputs: { featureId: feature.id }, parameters: { distance: 3 },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.features.at(-1).numberParameters.distance, 3);

  const suppressed = await command({
    operation: "feature.suppress", documentId, baseRevision: updated.payload.revision,
    inputs: { featureId: feature.id },
  });
  assert.equal(suppressed.response.status, 200, JSON.stringify(suppressed.payload));
  assert.equal(suppressed.payload.stats.faceCount, box.payload.stats.faceCount);
  assert.equal(suppressed.payload.features.at(-1).state, "suppressed");

  const restored = await command({
    operation: "feature.restore", documentId, baseRevision: suppressed.payload.revision,
    inputs: { featureId: feature.id },
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.ok(restored.payload.stats.faceCount > box.payload.stats.faceCount);
  assert.equal(restored.payload.features.at(-1).state, "valid");
});
test("creates and recomputes Shell and signed Offset features", async () => {
  const shellDocument = "shell_feature_lifecycle";
  const box = await command({
    operation: "primitive.box", documentId: shellDocument,
    parameters: { width: 30, depth: 30, height: 30, reset: true },
  });
  const openingFace = box.payload.triangleFaceIds[0];
  const shell = await command({
    operation: "detail.shell", documentId: shellDocument, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId, faceId: openingFace },
    parameters: { thickness: 2, inward: true },
  });
  assert.equal(shell.response.status, 200, JSON.stringify(shell.payload));
  assert.equal(shell.payload.bodyCount, 1);
  assert.ok(shell.payload.stats.faceCount > box.payload.stats.faceCount);
  const shellFeature = shell.payload.features.at(-1);
  assert.equal(shellFeature.type, "detail.shell");
  assert.equal(shellFeature.stringParameters.faceId, openingFace);

  const shellUpdated = await command({
    operation: "feature.update", documentId: shellDocument, baseRevision: shell.payload.revision,
    inputs: { featureId: shellFeature.id }, parameters: { thickness: 3 },
  });
  assert.equal(shellUpdated.response.status, 200, JSON.stringify(shellUpdated.payload));
  assert.equal(shellUpdated.payload.features.at(-1).numberParameters.thickness, 3);
  const shellSuppressed = await command({
    operation: "feature.suppress", documentId: shellDocument, baseRevision: shellUpdated.payload.revision,
    inputs: { featureId: shellFeature.id },
  });
  assert.equal(shellSuppressed.response.status, 200, JSON.stringify(shellSuppressed.payload));
  assert.equal(shellSuppressed.payload.stats.faceCount, box.payload.stats.faceCount);
  const shellRestored = await command({
    operation: "feature.restore", documentId: shellDocument, baseRevision: shellSuppressed.payload.revision,
    inputs: { featureId: shellFeature.id },
  });
  assert.equal(shellRestored.response.status, 200, JSON.stringify(shellRestored.payload));

  const offsetDocument = "offset_feature_lifecycle";
  const offsetBox = await command({
    operation: "primitive.box", documentId: offsetDocument,
    parameters: { width: 20, depth: 20, height: 20, reset: true },
  });
  const offsetVariable = await command({
    operation: "variable.set", documentId: offsetDocument, baseRevision: offsetBox.payload.revision,
    parameters: { name: "gap", type: "length", expression: "2 mm" },
  });
  const offset = await command({
    operation: "detail.offset", documentId: offsetDocument, baseRevision: offsetVariable.payload.revision,
    inputs: { bodyId: offsetBox.payload.bodyId }, parameters: { distance: "gap" },
  });
  assert.equal(offset.response.status, 200, JSON.stringify(offset.payload));
  assert.equal(offset.payload.features.at(-1).type, "detail.offset");
  assert.equal(offset.payload.features.at(-1).stringParameters["expr.distance"], "gap");
  const offsetFeature = offset.payload.features.at(-1);
  const offsetUpdated = await command({
    operation: "feature.update", documentId: offsetDocument, baseRevision: offset.payload.revision,
    inputs: { featureId: offsetFeature.id }, parameters: { distance: -1 },
  });
  assert.equal(offsetUpdated.response.status, 200, JSON.stringify(offsetUpdated.payload));
  assert.equal(offsetUpdated.payload.features.at(-1).numberParameters.distance, -1);
});

test("creates a new Body from Face Thicken and supports lifecycle removal and restoration", async () => {
  const documentId = "thicken_feature_lifecycle";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 30, depth: 30, height: 30, reset: true },
  });
  const faceId = box.payload.triangleFaceIds[0];
  const thickened = await command({
    operation: "detail.thicken", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId, faceId },
    parameters: { thickness: 2, reverse: false },
  });
  assert.equal(thickened.response.status, 200, JSON.stringify(thickened.payload));
  assert.equal(thickened.payload.bodyCount, 2);
  assert.notEqual(thickened.payload.bodyId, box.payload.bodyId);
  const feature = thickened.payload.features.at(-1);
  assert.equal(feature.type, "detail.thicken");
  assert.equal(feature.stringParameters.sourceBody, box.payload.bodyId);

  const updated = await command({
    operation: "feature.update", documentId, baseRevision: thickened.payload.revision,
    inputs: { featureId: feature.id }, parameters: { thickness: 3 },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.features.at(-1).numberParameters.thickness, 3);

  const suppressed = await command({
    operation: "feature.suppress", documentId, baseRevision: updated.payload.revision,
    inputs: { featureId: feature.id },
  });
  assert.equal(suppressed.response.status, 200, JSON.stringify(suppressed.payload));
  assert.equal(suppressed.payload.bodyCount, 1);
  assert.equal(suppressed.payload.bodyMetadata[0].bodyId, box.payload.bodyId);

  const restored = await command({
    operation: "feature.restore", documentId, baseRevision: suppressed.payload.revision,
    inputs: { featureId: feature.id },
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.bodyCount, 2);

  const deleted = await command({
    operation: "feature.delete", documentId, baseRevision: restored.payload.revision,
    inputs: { featureId: feature.id },
  });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.bodyCount, 1);
  assert.equal(deleted.payload.features.some((item) => item.id === feature.id), false);
});
test("replays Boolean Cut when editing a consumed tool primitive", async () => {
  const documentId = "boolean_consumed_tool_recompute";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 30, depth: 30, height: 30, reset: true },
  });
  const cylinder = await command({
    operation: "primitive.cylinder", documentId,
    parameters: { radius: 5, height: 30, x: 15, y: 15, z: 0 },
  });
  const cut = await command({
    operation: "boolean.cut", documentId, baseRevision: cylinder.payload.revision,
    inputs: { targetBody: box.payload.bodyId, toolBody: cylinder.payload.bodyId },
    parameters: { keepTool: false },
  });
  assert.equal(cut.response.status, 200, JSON.stringify(cut.payload));
  assert.equal(cut.payload.bodyCount, 1);
  const cylinderFeature = cut.payload.features.find((feature) => feature.type === "primitive.cylinder");
  const booleanFeature = cut.payload.features.find((feature) => feature.type === "boolean.cut");

  const updated = await command({
    operation: "feature.update", documentId, baseRevision: cut.payload.revision,
    inputs: { featureId: cylinderFeature.id }, parameters: { radius: 8 },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.bodyCount, 1);
  assert.equal(updated.payload.features.find((feature) => feature.id === cylinderFeature.id).numberParameters.radius, 8);
  assert.equal(updated.payload.features.find((feature) => feature.id === booleanFeature.id).computedRevision, updated.payload.revision);
  assert.ok(updated.payload.stats.faceCount >= 7);

  const undone = await command({ operation: "document.undo", documentId });
  assert.equal(undone.payload.features.find((feature) => feature.id === cylinderFeature.id).numberParameters.radius, 5);
  const redone = await command({ operation: "document.redo", documentId });
  assert.equal(redone.payload.features.find((feature) => feature.id === cylinderFeature.id).numberParameters.radius, 8);
});
test("edits Boolean operation and input roles atomically", async () => {
  const documentId = "boolean_definition_recompute";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 30, depth: 30, height: 30, reset: true },
  });
  const cylinder = await command({
    operation: "primitive.cylinder", documentId,
    parameters: { radius: 8, height: 30, x: 22, y: 15, z: 0 },
  });
  const cut = await command({
    operation: "boolean.cut", documentId, baseRevision: cylinder.payload.revision,
    inputs: { targetBody: box.payload.bodyId, toolBody: cylinder.payload.bodyId },
    parameters: { keepTool: false, refine: true },
  });
  const boxFeature = cut.payload.features.find((feature) => feature.type === "primitive.box");
  const cylinderFeature = cut.payload.features.find((feature) => feature.type === "primitive.cylinder");
  const booleanFeature = cut.payload.features.at(-1);

  const updated = await command({
    operation: "feature.update", documentId, baseRevision: cut.payload.revision,
    inputs: { featureId: booleanFeature.id },
    parameters: {
      operationType: "boolean.common",
      targetBodies: cylinder.payload.bodyId,
      toolBodies: box.payload.bodyId,
      refine: false,
    },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  const edited = updated.payload.features.find((feature) => feature.id === booleanFeature.id);
  assert.equal(edited.type, "boolean.common");
  assert.equal(edited.stringParameters.targetBodies, cylinder.payload.bodyId);
  assert.equal(edited.stringParameters.toolBodies, box.payload.bodyId);
  assert.equal(edited.stringParameters.refine, "false");
  assert.deepEqual(edited.inputFeatures, [cylinderFeature.id, boxFeature.id]);
  assert.equal(edited.computedRevision, updated.payload.revision);

  const rejected = await command({
    operation: "feature.update", documentId, baseRevision: updated.payload.revision,
    inputs: { featureId: booleanFeature.id },
    parameters: { targetBodies: cylinder.payload.bodyId, toolBodies: "body-missing" },
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.payload.code, "INVALID_BOOLEAN_INPUT");
  const summary = await command({ operation: "document.summary", documentId });
  assert.equal(summary.payload.revision, updated.payload.revision);

  const undone = await command({ operation: "document.undo", documentId });
  const restored = undone.payload.features.find((feature) => feature.id === booleanFeature.id);
  assert.equal(restored.type, "boolean.cut");
  assert.equal(restored.stringParameters.targetBodies, box.payload.bodyId);
  assert.equal(restored.stringParameters.toolBodies, cylinder.payload.bodyId);
});
test("suppresses, restores and deletes Boolean features while preserving Body metadata and properties", async () => {
  const documentId = "boolean_lifecycle";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 30, depth: 30, height: 30, reset: true },
  });
  const cylinder = await command({
    operation: "primitive.cylinder", documentId,
    parameters: { radius: 6, height: 30, x: 15, y: 15, z: 0 },
  });
  let current = await command({
    operation: "body.update", documentId, baseRevision: cylinder.payload.revision,
    inputs: { bodyId: cylinder.payload.bodyId },
    parameters: { name: "Cutting Tool", color: "#cc5500", material: "Copper" },
  });
  current = await command({
    operation: "property.set", documentId, baseRevision: current.payload.revision,
    inputs: { kind: "body", bodyId: cylinder.payload.bodyId, topologyId: "" },
    parameters: { key: "tool.role", type: "expression", value: "drill" },
  });
  const cut = await command({
    operation: "boolean.cut", documentId, baseRevision: current.payload.revision,
    inputs: { targetBody: box.payload.bodyId, toolBody: cylinder.payload.bodyId },
    parameters: { keepTool: false, refine: true },
  });
  assert.equal(cut.response.status, 200, JSON.stringify(cut.payload));
  assert.equal(cut.payload.bodyCount, 1);
  const booleanFeature = cut.payload.features.at(-1);

  let properties = await command({ operation: "property.list", documentId, inputs: {} });
  assert.equal(properties.payload.propertyRecords.find((item) => item.bodyId === cylinder.payload.bodyId).state, "orphaned");

  const suppressed = await command({
    operation: "feature.suppress", documentId, baseRevision: cut.payload.revision,
    inputs: { featureId: booleanFeature.id },
  });
  assert.equal(suppressed.response.status, 200, JSON.stringify(suppressed.payload));
  assert.equal(suppressed.payload.bodyCount, 2);
  assert.equal(suppressed.payload.features.find((item) => item.id === booleanFeature.id).state, "suppressed");
  assert.deepEqual(
    new Set(suppressed.payload.bodyPresentations.map((body) => body.bodyId)),
    new Set([box.payload.bodyId, cylinder.payload.bodyId]),
  );
  const restoredToolMetadata = suppressed.payload.bodyMetadata.find((item) => item.bodyId === cylinder.payload.bodyId);
  assert.deepEqual(
    { name: restoredToolMetadata.name, color: restoredToolMetadata.color, material: restoredToolMetadata.material },
    { name: "Cutting Tool", color: "#cc5500", material: "Copper" },
  );
  properties = await command({ operation: "property.list", documentId, inputs: {} });
  assert.equal(properties.payload.propertyRecords.find((item) => item.bodyId === cylinder.payload.bodyId).state, "active");

  current = await command({
    operation: "body.update", documentId, baseRevision: suppressed.payload.revision,
    inputs: { bodyId: cylinder.payload.bodyId }, parameters: { name: "Edited Tool" },
  });
  const restored = await command({
    operation: "feature.restore", documentId, baseRevision: current.payload.revision,
    inputs: { featureId: booleanFeature.id },
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.bodyCount, 1);
  assert.equal(restored.payload.features.find((item) => item.id === booleanFeature.id).state, "valid");
  properties = await command({ operation: "property.list", documentId, inputs: {} });
  assert.equal(properties.payload.propertyRecords.find((item) => item.bodyId === cylinder.payload.bodyId).state, "orphaned");

  const deleted = await command({
    operation: "feature.delete", documentId, baseRevision: restored.payload.revision,
    inputs: { featureId: booleanFeature.id },
  });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.bodyCount, 2);
  assert.equal(deleted.payload.features.some((item) => item.id === booleanFeature.id), false);
  assert.equal(deleted.payload.bodyMetadata.find((item) => item.bodyId === cylinder.payload.bodyId).name, "Edited Tool");
  properties = await command({ operation: "property.list", documentId, inputs: {} });
  assert.equal(properties.payload.propertyRecords.find((item) => item.bodyId === cylinder.payload.bodyId).state, "active");

  const undone = await command({ operation: "document.undo", documentId });
  assert.equal(undone.response.status, 200);
  assert.equal(undone.payload.bodyCount, 1);
  assert.equal(undone.payload.features.some((item) => item.id === booleanFeature.id), true);
});
test("suppresses, restores and deletes unary features with graph rewiring and undo", async () => {
  const documentId = "feature_lifecycle";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 10, depth: 10, height: 10, reset: true },
  });
  const first = await command({
    operation: "transform.translate", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId }, parameters: { dx: 10, dy: 0, dz: 0 },
  });
  const firstFeature = first.payload.features.at(-1);
  const second = await command({
    operation: "transform.translate", documentId, baseRevision: first.payload.revision,
    inputs: { bodyId: box.payload.bodyId }, parameters: { dx: 5, dy: 0, dz: 0 },
  });
  const secondFeature = second.payload.features.at(-1);
  assert.ok(Math.abs(xBounds(second.payload.positions).min - 15) < 1e-7);

  const stale = await command({
    operation: "feature.suppress", documentId, baseRevision: first.payload.revision,
    inputs: { featureId: firstFeature.id },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "STALE_REVISION");

  const suppressed = await command({
    operation: "feature.suppress", documentId, baseRevision: second.payload.revision,
    inputs: { featureId: firstFeature.id },
  });
  assert.equal(suppressed.response.status, 200);
  assert.ok(Math.abs(xBounds(suppressed.payload.positions).min - 5) < 1e-7);
  assert.equal(suppressed.payload.features.find((feature) => feature.id === firstFeature.id).state, "suppressed");
  assert.equal(suppressed.payload.features.find((feature) => feature.id === secondFeature.id).computedRevision, suppressed.payload.revision);

  const restored = await command({
    operation: "feature.restore", documentId, baseRevision: suppressed.payload.revision,
    inputs: { featureId: firstFeature.id },
  });
  assert.equal(restored.response.status, 200);
  assert.ok(Math.abs(xBounds(restored.payload.positions).min - 15) < 1e-7);
  assert.equal(restored.payload.features.find((feature) => feature.id === firstFeature.id).state, "valid");

  const deleted = await command({
    operation: "feature.delete", documentId, baseRevision: restored.payload.revision,
    inputs: { featureId: firstFeature.id },
  });
  assert.equal(deleted.response.status, 200);
  assert.ok(Math.abs(xBounds(deleted.payload.positions).min - 5) < 1e-7);
  assert.equal(deleted.payload.features.some((feature) => feature.id === firstFeature.id), false);
  assert.deepEqual(
    deleted.payload.features.find((feature) => feature.id === secondFeature.id).inputFeatures,
    [box.payload.features.at(-1).id],
  );

  const undone = await command({ operation: "document.undo", documentId });
  assert.equal(undone.response.status, 200);
  assert.ok(Math.abs(xBounds(undone.payload.positions).min - 15) < 1e-7);
  assert.equal(undone.payload.features.some((feature) => feature.id === firstFeature.id), true);

  const unsupported = await command({
    operation: "feature.suppress", documentId, baseRevision: undone.payload.revision,
    inputs: { featureId: box.payload.features.at(-1).id },
  });
  assert.equal(unsupported.response.status, 400);
  assert.equal(unsupported.payload.code, "FEATURE_LIFECYCLE_UNSUPPORTED");
});
test("creates, edits and suppresses a Draft feature", async () => {
  const documentId = "draft_feature_recompute";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 40, depth: 30, height: 20, reset: true } });
  const faceId = box.payload.triangleFaceIds[0];
  const draft = await command({
    operation: "detail.draft", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId, faceId },
    parameters: { angleDegrees: "5 deg", neutralOriginX: 0, neutralOriginY: 0, neutralOriginZ: 0, neutralNormalX: 0, neutralNormalY: 0, neutralNormalZ: 1, directionX: 0, directionY: 0, directionZ: 1 },
  });
  assert.equal(draft.response.status, 200, JSON.stringify(draft.payload));
  const draftFeature = draft.payload.features.at(-1);
  assert.equal(draftFeature.type, "detail.draft");
  assert.equal(draftFeature.numberParameters.angleDegrees, 5);

  const edited = await command({ operation: "feature.update", documentId, baseRevision: draft.payload.revision, inputs: { featureId: draftFeature.id }, parameters: { angleDegrees: "8 deg", directionX: 0, directionY: 0, directionZ: 1 } });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.features.at(-1).numberParameters.angleDegrees, 8);

  const suppressed = await command({ operation: "feature.suppress", documentId, baseRevision: edited.payload.revision, inputs: { featureId: draftFeature.id } });
  assert.equal(suppressed.response.status, 200, JSON.stringify(suppressed.payload));
  assert.equal(suppressed.payload.features.at(-1).state, "suppressed");
});
test("creates, edits and manages a linear Pattern with dynamic Body outputs", async () => {
  const documentId = "linear_pattern_dynamic_bodies";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10, reset: true } });
  assert.equal(box.response.status, 200, JSON.stringify(box.payload));
  const pattern = await command({
    operation: "pattern.linear", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { count: 3, spacing: "50 mm", directionX: 1, directionY: 0, directionZ: 0 },
  });
  assert.equal(pattern.response.status, 200, JSON.stringify(pattern.payload));
  const patternFeature = pattern.payload.features.at(-1);
  assert.equal(patternFeature.type, "pattern.linear");
  assert.equal(pattern.payload.bodyCount, 3);
  assert.equal(pattern.payload.bodyPresentations.length, 3);
  assert.equal(patternFeature.outputBodies.length, 3);

  const edited = await command({
    operation: "feature.update", documentId, baseRevision: pattern.payload.revision,
    inputs: { featureId: patternFeature.id }, parameters: { count: 4, spacing: "40 mm", directionX: 1, directionY: 0, directionZ: 0 },
  });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.bodyCount, 4);
  assert.equal(edited.payload.bodyPresentations.length, 4);

  const suppressed = await command({ operation: "feature.suppress", documentId, baseRevision: edited.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(suppressed.response.status, 200, JSON.stringify(suppressed.payload));
  assert.equal(suppressed.payload.bodyCount, 1);
  assert.equal(suppressed.payload.features.at(-1).state, "suppressed");

  const restored = await command({ operation: "feature.restore", documentId, baseRevision: suppressed.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.bodyCount, 4);

  const deleted = await command({ operation: "feature.delete", documentId, baseRevision: restored.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.bodyCount, 1);
  assert.equal(deleted.payload.features.some((feature) => feature.id === patternFeature.id), false);
});

test("creates, edits and manages a circular Pattern with dynamic Body outputs", async () => {
  const documentId = "circular_pattern_dynamic_bodies";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10, reset: true } });
  const pattern = await command({
    operation: "pattern.circular", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { count: 4, angleDegrees: "90 deg", originX: 0, originY: 0, originZ: 0, axisX: 0, axisY: 0, axisZ: 1 },
  });
  assert.equal(pattern.response.status, 200, JSON.stringify(pattern.payload));
  const patternFeature = pattern.payload.features.at(-1);
  assert.equal(patternFeature.type, "pattern.circular");
  assert.equal(pattern.payload.bodyCount, 4);
  assert.equal(patternFeature.outputBodies.length, 4);

  const edited = await command({
    operation: "feature.update", documentId, baseRevision: pattern.payload.revision,
    inputs: { featureId: patternFeature.id },
    parameters: { count: 5, angleDegrees: "72 deg", originX: 0, originY: 0, originZ: 0, axisX: 0, axisY: 0, axisZ: 1 },
  });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.bodyCount, 5);
  assert.equal(edited.payload.features.at(-1).outputBodies.length, 5);

  const suppressed = await command({ operation: "feature.suppress", documentId, baseRevision: edited.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(suppressed.response.status, 200, JSON.stringify(suppressed.payload));
  assert.equal(suppressed.payload.bodyCount, 1);

  const restored = await command({ operation: "feature.restore", documentId, baseRevision: suppressed.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.bodyCount, 5);

  const deleted = await command({ operation: "feature.delete", documentId, baseRevision: restored.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.bodyCount, 1);
});


test("creates, edits and manages a rectangular Pattern with dynamic Body outputs", async () => {
  const documentId = "rectangular_pattern_dynamic_bodies";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10, reset: true } });
  const pattern = await command({
    operation: "pattern.rectangular", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { countX: 3, countY: 2, spacingX: "40 mm", spacingY: "30 mm", directionX: 1, directionY: 0, directionZ: 0, direction2X: 0, direction2Y: 1, direction2Z: 0 },
  });
  assert.equal(pattern.response.status, 200, JSON.stringify(pattern.payload));
  const patternFeature = pattern.payload.features.at(-1);
  assert.equal(patternFeature.type, "pattern.rectangular");
  assert.equal(pattern.payload.bodyCount, 6);
  assert.equal(patternFeature.outputBodies.length, 6);

  const edited = await command({
    operation: "feature.update", documentId, baseRevision: pattern.payload.revision,
    inputs: { featureId: patternFeature.id },
    parameters: { countX: 2, countY: 2, spacingX: "25 mm", spacingY: "35 mm", directionX: 1, directionY: 0, directionZ: 0, direction2X: 0, direction2Y: 1, direction2Z: 0 },
  });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.bodyCount, 4);
  assert.equal(edited.payload.features.at(-1).outputBodies.length, 4);
  assert.equal(edited.payload.features.at(-1).numberParameters.count, 4);

  const suppressed = await command({ operation: "feature.suppress", documentId, baseRevision: edited.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(suppressed.response.status, 200, JSON.stringify(suppressed.payload));
  assert.equal(suppressed.payload.bodyCount, 1);

  const restored = await command({ operation: "feature.restore", documentId, baseRevision: suppressed.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.bodyCount, 4);

  const deleted = await command({ operation: "feature.delete", documentId, baseRevision: restored.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.bodyCount, 1);
});


test("creates, edits and manages a Mirror Pattern with dynamic Body outputs", async () => {
  const documentId = "mirror_pattern_dynamic_bodies";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10, x: 20, reset: true } });
  const pattern = await command({
    operation: "pattern.mirror", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { originX: 0, originY: 0, originZ: 0, normalX: 1, normalY: 0, normalZ: 0 },
  });
  assert.equal(pattern.response.status, 200, JSON.stringify(pattern.payload));
  const patternFeature = pattern.payload.features.at(-1);
  assert.equal(patternFeature.type, "pattern.mirror");
  assert.equal(pattern.payload.bodyCount, 2);
  assert.equal(patternFeature.outputBodies.length, 2);

  const edited = await command({
    operation: "feature.update", documentId, baseRevision: pattern.payload.revision,
    inputs: { featureId: patternFeature.id },
    parameters: { originX: 5, originY: 0, originZ: 0, normalX: 1, normalY: 0, normalZ: 0 },
  });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.bodyCount, 2);

  const suppressed = await command({ operation: "feature.suppress", documentId, baseRevision: edited.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(suppressed.response.status, 200, JSON.stringify(suppressed.payload));
  assert.equal(suppressed.payload.bodyCount, 1);

  const restored = await command({ operation: "feature.restore", documentId, baseRevision: suppressed.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.bodyCount, 2);

  const deleted = await command({ operation: "feature.delete", documentId, baseRevision: restored.payload.revision, inputs: { featureId: patternFeature.id } });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.bodyCount, 1);
});


test("Shape Check returns valid topology statistics without changing revision", async () => {
  const documentId = "shape_check";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 20, height: 30, reset: true } });
  const checked = await command({ operation: "geometry.check", documentId, inputs: { bodyId: box.payload.bodyId } });
  assert.equal(checked.response.status, 200, JSON.stringify(checked.payload));
  assert.equal(checked.payload.valid, true);
  assert.equal(checked.payload.faceCount, 6);
  assert.equal(checked.payload.edgeCount, 12);
  assert.equal(checked.payload.solidCount, 1);
  assert.equal(checked.payload.revision, box.payload.revision);
});

test("Pattern instances inherit Body and topology user properties", async () => {
  const documentId = "pattern_property_inheritance";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10, reset: true } });
  const saved = await command({
    operation: "property.set", documentId, baseRevision: box.payload.revision,
    inputs: { kind: "body", bodyId: box.payload.bodyId, topologyId: "" },
    parameters: { key: "role", type: "expression", value: "source" },
  });
  const pattern = await command({
    operation: "pattern.mirror", documentId, baseRevision: saved.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { originX: 0, originY: 0, originZ: 0, normalX: 1, normalY: 0, normalZ: 0 },
  });
  assert.equal(pattern.response.status, 200, JSON.stringify(pattern.payload));
  const listed = await command({ operation: "property.list", documentId, inputs: {} });
  const records = listed.payload.propertyRecords.filter((record) => record.kind === "body" && record.values.role);
  assert.ok(records.some((record) => record.bodyId === "body-1"));
  assert.ok(records.some((record) => record.bodyId === "body-2"));
});


test("Mirror Pattern participates in document Undo/Redo", async () => {
  const documentId = "mirror_pattern_undo";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10, reset: true } });
  await command({
    operation: "pattern.mirror", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { originX: 0, originY: 0, originZ: 0, normalX: 1, normalY: 0, normalZ: 0 },
  });
  const undone = await command({ operation: "document.undo", documentId });
  assert.equal(undone.response.status, 200, JSON.stringify(undone.payload));
  assert.equal(undone.payload.bodyCount, 1);
  const redone = await command({ operation: "document.redo", documentId });
  assert.equal(redone.response.status, 200, JSON.stringify(redone.payload));
  assert.equal(redone.payload.bodyCount, 2);
});


test("Measure returns volume, area, length and bounding box", async () => {
  const documentId = "measure_box";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 20, height: 30, reset: true } });
  const measured = await command({ operation: "geometry.measure", documentId, inputs: { bodyId: box.payload.bodyId } });
  assert.equal(measured.response.status, 200, JSON.stringify(measured.payload));
  assert.ok(Math.abs(measured.payload.volume - 6000) < 1e-6);
  assert.ok(Math.abs(measured.payload.area - 2200) < 1e-6);
  assert.deepEqual(measured.payload.bounds.min, [0, 0, 0]);
  assert.deepEqual(measured.payload.bounds.max, [10, 20, 30]);
  assert.ok(["occt-brep-obb", "occt-exact", "aabb-derived"].includes(measured.payload.obb.source));
  assert.equal(measured.payload.obb.exact, measured.payload.obb.source === "occt-exact");
  assert.deepEqual([...measured.payload.obb.halfSizes].sort((a, b) => a - b), [5, 10, 15]);
  assert.equal(measured.payload.revision, box.payload.revision);
});


test("Measure supports Face and Edge selections", async () => {
  const documentId = "measure_topology";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 20, height: 30, reset: true } });
  const face = await command({
    operation: "geometry.measure", documentId,
    inputs: { bodyId: box.payload.bodyId, selectionType: "face", selectionId: "face-1-1" },
  });
  assert.equal(face.response.status, 200, JSON.stringify(face.payload));
  assert.equal(face.payload.selectionType, "face");
  assert.ok(face.payload.area > 0);
  assert.ok(face.payload.perimeter > 0);
  assert.equal(face.payload.centroid.length, 3);
  const edge = await command({
    operation: "geometry.measure", documentId,
    inputs: { bodyId: box.payload.bodyId, selectionType: "edge", selectionId: "edge-1-1" },
  });
  assert.equal(edge.response.status, 200, JSON.stringify(edge.payload));
  assert.equal(edge.payload.selectionType, "edge");
  assert.ok(edge.payload.length > 0);
  assert.equal(edge.payload.curveType, "line");
  assert.equal(edge.payload.endpoints.length, 2);
  assert.equal(edge.payload.endpoints[0].length, 3);
});test("Revolve creates an editable body-creating feature", async () => {
  const documentId = "revolve_lifecycle";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 20, height: 30, reset: true } });
  const revolve = await command({
    operation: "detail.revolve", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId, faceId: "face-1-1" },
    parameters: { angleDegrees: "360 deg", originX: 0, originY: 0, originZ: 0, axisX: 0, axisY: 0, axisZ: 1 },
  });
  assert.equal(revolve.response.status, 200, JSON.stringify(revolve.payload));
  assert.equal(revolve.payload.bodyCount, 2);
  const feature = revolve.payload.features.find((item) => item.type === "detail.revolve");
  assert.ok(feature);
  const edited = await command({
    operation: "feature.update", documentId, baseRevision: revolve.payload.revision,
    inputs: { featureId: feature.id },
    parameters: { angleDegrees: "180 deg" },
  });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.bodyCount, 2);
  const suppressed = await command({
    operation: "feature.suppress", documentId, baseRevision: edited.payload.revision,
    inputs: { featureId: feature.id },
  });
  assert.equal(suppressed.response.status, 200, JSON.stringify(suppressed.payload));
  assert.equal(suppressed.payload.bodyCount, 1);
  const restored = await command({
    operation: "feature.restore", documentId, baseRevision: suppressed.payload.revision,
    inputs: { featureId: feature.id },
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.bodyCount, 2);
  const deleted = await command({
    operation: "feature.delete", documentId, baseRevision: restored.payload.revision,
    inputs: { featureId: feature.id },
  });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.bodyCount, 1);
});
