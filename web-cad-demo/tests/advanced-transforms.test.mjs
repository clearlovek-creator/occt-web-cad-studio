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
const port = 8803;
const apiRoot = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), "occt-web-cad-advanced-transforms-" + process.pid + "-" + Date.now());
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

function bounds(positions) {
  const result = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      result.min[axis] = Math.min(result.min[axis], positions[index + axis]);
      result.max[axis] = Math.max(result.max[axis], positions[index + axis]);
    }
  }
  return result;
}

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
}

test("rotates, mirrors and uniformly scales a body while preserving face properties", async () => {
  const documentId = "advanced_transform_chain";
  const box = await command({
    operation: "primitive.box",
    documentId,
    parameters: { width: 10, depth: 20, height: 30, reset: true },
  });
  let result = await command({
    operation: "property.set",
    documentId,
    baseRevision: box.payload.revision,
    inputs: { kind: "face", bodyId: box.payload.bodyId, topologyId: box.payload.triangleFaceIds[0] },
    parameters: { key: "transform.marker", type: "expression", value: "keep" },
  });

  result = await command({
    operation: "transform.rotate",
    documentId,
    baseRevision: result.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { originX: 0, originY: 0, originZ: 0, axisX: 0, axisY: 0, axisZ: 1, angleDegrees: 90 },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.features.at(-1).type, "transform.rotate");
  let extent = bounds(result.payload.positions);
  near(extent.min[0], -20); near(extent.max[0], 0);
  near(extent.min[1], 0); near(extent.max[1], 10);

  result = await command({
    operation: "transform.mirror",
    documentId,
    baseRevision: result.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { originX: 0, originY: 0, originZ: 0, normalX: 1, normalY: 0, normalZ: 0 },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.features.at(-1).type, "transform.mirror");
  extent = bounds(result.payload.positions);
  near(extent.min[0], 0); near(extent.max[0], 20);

  result = await command({
    operation: "transform.scale",
    documentId,
    baseRevision: result.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { originX: 0, originY: 0, originZ: 0, factor: 2 },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.revision, 5);
  assert.equal(result.payload.features.at(-1).type, "transform.scale");
  extent = bounds(result.payload.positions);
  near(extent.max[0], 40); near(extent.max[1], 20); near(extent.max[2], 60);

  const properties = await command({ operation: "property.list", documentId, inputs: {} });
  const active = properties.payload.propertyRecords.find(
    (item) => item.kind === "face" && item.state === "active"
      && item.values["transform.marker"]?.value === "keep",
  );
  assert.ok(active, "face property should remain active through the transform chain");
  assert.match(active.topologyId, /^face-5-\d+$/);
});

test("rejects zero rotation axes and invalid scale factors without changing revision", async () => {
  const documentId = "advanced_transform_validation";
  const box = await command({
    operation: "primitive.box",
    documentId,
    parameters: { width: 10, depth: 10, height: 10, reset: true },
  });
  const badAxis = await command({
    operation: "transform.rotate",
    documentId,
    baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { axisX: 0, axisY: 0, axisZ: 0, angleDegrees: 30 },
  });
  assert.equal(badAxis.response.status, 400);
  assert.equal(badAxis.payload.code, "INVALID_PARAMETER");

  const badScale = await command({
    operation: "transform.scale",
    documentId,
    baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { factor: 0 },
  });
  assert.equal(badScale.response.status, 400);
  assert.equal(badScale.payload.code, "INVALID_PARAMETER");
  const summary = await command({ operation: "document.summary", documentId });
  assert.equal(summary.payload.revision, box.payload.revision);
});
