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
const port = 8804;
const apiRoot = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), "occt-web-cad-feature-history-" + process.pid + "-" + Date.now());
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
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    min = Math.min(min, positions[index]);
    max = Math.max(max, positions[index]);
  }
  return { min, max };
}

test("edits a primitive, recomputes its Transform chain and supports undo/redo", async () => {
  const documentId = "feature_recompute_history";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 10, depth: 20, height: 30, reset: true },
  });
  assert.equal(box.payload.canUndo, false);
  let result = await command({
    operation: "property.set", documentId, baseRevision: box.payload.revision,
    inputs: { kind: "face", bodyId: box.payload.bodyId, topologyId: box.payload.triangleFaceIds[0] },
    parameters: { key: "recompute.marker", type: "expression", value: "keep" },
  });
  result = await command({
    operation: "transform.translate", documentId, baseRevision: result.payload.revision,
    inputs: { bodyId: box.payload.bodyId }, parameters: { dx: 5, dy: 0, dz: 0 },
  });
  assert.equal(result.payload.revision, 3);

  result = await command({
    operation: "feature.update", documentId, baseRevision: result.payload.revision,
    inputs: { featureId: box.payload.features[0].id },
    parameters: { width: 20, depth: 20, height: 30 },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.revision, 4);
  assert.equal(result.payload.features.length, 2);
  assert.equal(result.payload.features[0].numberParameters.width, 20);
  assert.equal(result.payload.features[0].computedRevision, 4);
  assert.equal(result.payload.features[1].computedRevision, 4);
  assert.deepEqual(xBounds(result.payload.positions), { min: 5, max: 25 });
  assert.equal(result.payload.canUndo, true);

  const properties = await command({ operation: "property.list", documentId, inputs: {} });
  assert.ok(properties.payload.propertyRecords.some(
    (item) => item.kind === "face" && item.state === "active"
      && item.values["recompute.marker"]?.value === "keep" && /^face-4-\d+$/.test(item.topologyId),
  ));

  const undone = await command({ operation: "document.undo", documentId });
  assert.equal(undone.response.status, 200, JSON.stringify(undone.payload));
  assert.equal(undone.payload.revision, 3);
  assert.deepEqual(xBounds(undone.payload.positions), { min: 5, max: 15 });
  assert.equal(undone.payload.features[0].numberParameters.width, 10);
  assert.equal(undone.payload.canRedo, true);

  const redone = await command({ operation: "document.redo", documentId });
  assert.equal(redone.response.status, 200, JSON.stringify(redone.payload));
  assert.equal(redone.payload.revision, 4);
  assert.deepEqual(xBounds(redone.payload.positions), { min: 5, max: 25 });
  assert.equal(redone.payload.features[0].numberParameters.width, 20);
  assert.equal(redone.payload.canUndo, true);
});

test("recomputes a primitive across a Fillet and restores it with undo", async () => {
  const documentId = "unsupported_feature_recompute";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 30, depth: 30, height: 30, reset: true },
  });
  const fillet = await command({
    operation: "detail.fillet", documentId, baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId, edgeId: box.payload.edges[0].edgeId },
    parameters: { radius: 2 },
  });
  const updated = await command({
    operation: "feature.update", documentId, baseRevision: fillet.payload.revision,
    inputs: { featureId: box.payload.features[0].id },
    parameters: { width: 40 },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.revision, fillet.payload.revision + 1);
  assert.equal(updated.payload.features[0].numberParameters.width, 40);
  assert.equal(updated.payload.features.at(-1).type, "detail.fillet");
  const undone = await command({ operation: "document.undo", documentId });
  assert.equal(undone.payload.revision, fillet.payload.revision);
  assert.equal(undone.payload.features.length, 2);
  assert.equal(undone.payload.features[0].numberParameters.width, 30);
});
test("accepts the complete Box parameter payload emitted by the feature editor", async () => {
  const documentId = "box_feature_editor_payload";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 10, depth: 20, height: 30, x: 1, y: 2, z: 3, reset: true },
  });
  const updated = await command({
    operation: "feature.update", documentId, baseRevision: box.payload.revision,
    inputs: { featureId: box.payload.features[0].id },
    parameters: { width: 12, depth: 20, height: 30, x: 4, y: 2, z: 3 },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.deepEqual(xBounds(updated.payload.positions), { min: 4, max: 16 });
  assert.equal(updated.payload.features[0].numberParameters.x, 4);
  assert.equal(updated.payload.features[0].numberParameters.width, 12);
});
test("keeps an edited variable expression and recomputes when the variable changes", async () => {
  const documentId = "edited_feature_expression";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 10, depth: 20, height: 30, x: 0, y: 0, z: 0, reset: true },
  });
  const variable = await command({
    operation: "variable.set", documentId, baseRevision: box.payload.revision,
    parameters: { name: "span", type: "length", expression: "40 mm" },
  });
  const updated = await command({
    operation: "feature.update", documentId, baseRevision: variable.payload.revision,
    inputs: { featureId: box.payload.features[0].id },
    parameters: { width: "span + 5 mm", depth: "20 mm", height: "30 mm", x: "0 mm", y: "0 mm", z: "0 mm" },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.features[0].stringParameters["expr.width"], "span + 5 mm");
  assert.equal(updated.payload.features[0].numberParameters.width, 45);
  assert.deepEqual(xBounds(updated.payload.positions), { min: 0, max: 45 });

  const changed = await command({
    operation: "variable.set", documentId, baseRevision: updated.payload.revision,
    parameters: { name: "span", type: "length", expression: "60 mm" },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.features[0].stringParameters["expr.width"], "span + 5 mm");
  assert.equal(changed.payload.features[0].numberParameters.width, 65);
  assert.deepEqual(xBounds(changed.payload.positions), { min: 0, max: 65 });
});
