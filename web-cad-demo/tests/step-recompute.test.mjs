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
const port = 8807;
const apiRoot = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), `occt-web-cad-step-recompute-${process.pid}-${Date.now()}`);
let gateway;

async function startGateway() {
  const child = spawn(process.execPath, [path.join(demoRoot, "gateway", "server.mjs")], {
    cwd: demoRoot,
    env: { ...process.env, GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: dataDir },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Geometry gateway startup timed out.")), 10_000);
    child.once("error", reject);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (chunk.includes("Geometry gateway ready")) { clearTimeout(timer); resolve(); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (chunk.includes("Error")) { clearTimeout(timer); reject(new Error(chunk)); }
    });
  });
  return child;
}

async function restartGateway() {
  await new Promise((resolve) => {
    if (!gateway || gateway.killed || gateway.exitCode !== null) { resolve(); return; }
    gateway.once("exit", resolve);
    gateway.kill();
  });
  gateway = await startGateway();
}

before(async () => { gateway = await startGateway(); });

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

test("replays a retained STEP import before recomputing a downstream Transform", async () => {
  const sourceId = "step_recompute_source";
  const source = await command({
    operation: "primitive.box", documentId: sourceId,
    parameters: { width: 30, depth: 20, height: 10, reset: true },
  });
  assert.equal(source.response.status, 200, JSON.stringify(source.payload));
  const exportedResponse = await fetch(`${apiRoot}/documents/${sourceId}/exports/step`, { method: "POST" });
  const exported = await exportedResponse.json();
  const stepBytes = new Uint8Array(await (await fetch(`http://127.0.0.1:${port}${exported.downloadUrl}`)).arrayBuffer());

  const documentId = "step_recompute_target";
  const importedResponse = await fetch(`${apiRoot}/documents/${documentId}/imports/step`, {
    method: "POST",
    headers: { "Content-Type": "application/step" },
    body: stepBytes,
  });
  const imported = await importedResponse.json();
  assert.equal(importedResponse.status, 200, JSON.stringify(imported));
  const importFeature = imported.features[0];
  const sourcePath = importFeature.stringParameters.sourcePath;
  assert.equal(importFeature.type, "import.step");
  assert.ok(sourcePath && fs.existsSync(sourcePath), "retained source should exist after import");

  await restartGateway();
  const restored = await command({ operation: "document.view", documentId });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.revision, imported.revision);

  const translated = await command({
    operation: "transform.translate", documentId, baseRevision: imported.revision,
    inputs: { bodyId: imported.activeBodyId }, parameters: { dx: 5, dy: 0, dz: 0 },
  });
  const transformFeature = translated.payload.features.at(-1);
  const updated = await command({
    operation: "feature.update", documentId, baseRevision: translated.payload.revision,
    inputs: { featureId: transformFeature.id }, parameters: { dx: 10, dy: 0, dz: 0 },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.deepEqual(xBounds(updated.payload.positions), { min: 10, max: 40 });
  assert.equal(updated.payload.features[0].type, "import.step");
  assert.equal(updated.payload.features.at(-1).numberParameters.dx, 10);

  fs.rmSync(sourcePath, { force: true });
  const rejected = await command({
    operation: "feature.update", documentId, baseRevision: updated.payload.revision,
    inputs: { featureId: transformFeature.id }, parameters: { dx: 15, dy: 0, dz: 0 },
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.payload.code, "STEP_REPLAY_SOURCE_MISSING");
  const view = await command({ operation: "document.view", documentId });
  assert.equal(view.payload.revision, updated.payload.revision);
  assert.deepEqual(xBounds(view.payload.positions), { min: 10, max: 40 });
});
