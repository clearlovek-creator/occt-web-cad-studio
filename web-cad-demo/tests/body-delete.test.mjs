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
const port = 8810;
const apiRoot = "http://127.0.0.1:" + port + "/api";
const dataDir = path.join(os.tmpdir(), "occt-web-cad-delete-" + process.pid + "-" + Date.now());
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
  const response = await fetch(apiRoot + "/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(observedClient.prepare(body, "", '/commands')),
  });
  return { response, payload: observedClient.observe(await response.json(), body.documentId) };
}

test("deletes an independent body, its feature history and its user properties", async () => {
  const documentId = "delete_independent";
  const box = await command({
    operation: "primitive.box",
    documentId,
    parameters: { width: 40, depth: 30, height: 20, reset: true },
  });
  const sphere = await command({
    operation: "primitive.sphere",
    documentId,
    parameters: { radius: 8 },
  });
  assert.equal(sphere.payload.bodyCount, 2);

  const property = await command({
    operation: "property.set",
    documentId,
    baseRevision: sphere.payload.revision,
    inputs: { kind: "body", bodyId: sphere.payload.bodyId },
    parameters: { key: "density", type: "double", value: 7.85 },
  });
  const deleted = await command({
    operation: "body.delete",
    documentId,
    baseRevision: property.payload.revision,
    inputs: { bodyId: sphere.payload.bodyId },
  });

  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.bodyCount, 1);
  assert.equal(deleted.payload.featureCount, 1);
  assert.equal(deleted.payload.bodyId, box.payload.bodyId);
  assert.equal(deleted.payload.features[0].type, "primitive.box");

  const properties = await command({
    operation: "property.list",
    documentId,
    inputs: { bodyId: sphere.payload.bodyId },
  });
  assert.deepEqual(properties.payload.propertyRecords, []);
});

test("deleting the last body leaves a valid empty document", async () => {
  const documentId = "delete_last";
  const box = await command({
    operation: "primitive.box",
    documentId,
    parameters: { width: 20, depth: 20, height: 20, reset: true },
  });
  const deleted = await command({
    operation: "body.delete",
    documentId,
    baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
  });

  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.bodyCount, 0);
  assert.equal(deleted.payload.featureCount, 0);
  assert.equal(deleted.payload.activeBodyId, "");
  assert.deepEqual(deleted.payload.stats, { faceCount: 0, edgeCount: 0, triangleCount: 0 });

  const view = await command({ operation: "document.view", documentId });
  assert.equal(view.response.status, 200);
  assert.equal(view.payload.bodyCount, 0);
  assert.deepEqual(view.payload.features, []);
});

test("rejects deleting a body still retained by another Boolean history", async () => {
  const documentId = "delete_dependency";
  const box = await command({
    operation: "primitive.box",
    documentId,
    parameters: { width: 40, depth: 40, height: 40, reset: true },
  });
  const sphere = await command({
    operation: "primitive.sphere",
    documentId,
    parameters: { radius: 12 },
  });
  const cut = await command({
    operation: "boolean.cut",
    documentId,
    baseRevision: sphere.payload.revision,
    inputs: { targetBody: box.payload.bodyId, toolBody: sphere.payload.bodyId },
    parameters: { keepTool: true },
  });
  assert.equal(cut.response.status, 200, JSON.stringify(cut.payload));
  assert.equal(cut.payload.bodyCount, 2);

  const rejected = await command({
    operation: "body.delete",
    documentId,
    baseRevision: cut.payload.revision,
    inputs: { bodyId: sphere.payload.bodyId },
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.payload.code, "BODY_IN_USE");

  const deletedResult = await command({
    operation: "body.delete",
    documentId,
    baseRevision: cut.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
  });
  assert.equal(deletedResult.response.status, 200, JSON.stringify(deletedResult.payload));
  assert.equal(deletedResult.payload.bodyCount, 1);
  assert.equal(deletedResult.payload.bodyId, sphere.payload.bodyId);
  assert.equal(deletedResult.payload.features.length, 1);
  assert.equal(deletedResult.payload.features[0].type, "primitive.sphere");
});
