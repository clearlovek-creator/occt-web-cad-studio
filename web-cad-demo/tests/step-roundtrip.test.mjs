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
const port = 8801;
const apiRoot = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), "occt-web-cad-step-roundtrip-" + process.pid + "-" + Date.now());
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

test("exports, downloads, uploads and continues modeling an imported STEP part", async () => {
  const sourceId = "step_export_source";
  const source = await command({
    operation: "primitive.box",
    documentId: sourceId,
    parameters: { width: 30, depth: 20, height: 10, reset: true },
  });
  assert.equal(source.response.status, 200);

  const exportResponse = await fetch(`${apiRoot}/documents/${sourceId}/exports/step`, { method: "POST" });
  const exported = await exportResponse.json();
  assert.equal(exportResponse.status, 200, JSON.stringify(exported));
  assert.equal(exported.ok, true);
  assert.equal(exported.userPropertiesIncluded, false);
  assert.equal(exported.downloadUrl, `/api/exports/${sourceId}/download`);

  const downloadResponse = await fetch(`http://127.0.0.1:${port}${exported.downloadUrl}`);
  const stepBytes = new Uint8Array(await downloadResponse.arrayBuffer());
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get("content-type"), /application\/step/);
  assert.ok(stepBytes.length > 1000);
  assert.match(new TextDecoder().decode(stepBytes.slice(0, 64)), /ISO-10303-21/);

  const importedId = "step_import_target";
  const importResponse = await fetch(`${apiRoot}/documents/${importedId}/imports/step`, {
    method: "POST",
    headers: { "Content-Type": "application/step" },
    body: stepBytes,
  });
  const imported = await importResponse.json();
  assert.equal(importResponse.status, 200);
  assert.equal(imported.ok, true);
  assert.equal(imported.revision, 1);
  assert.equal(imported.bodyCount, 1);
  assert.equal(imported.features[0].type, "import.step");
  assert.equal(imported.presentationMode, "lazy");
  assert.equal(imported.positions, undefined);
  assert.equal(imported.activeBodyId, "body-1");

  const presentation = await command({
    operation: "body.presentation",
    documentId: importedId,
    inputs: { bodyId: imported.activeBodyId },
  });
  assert.equal(presentation.response.status, 200, JSON.stringify(presentation.payload));
  assert.equal(presentation.payload.stats.faceCount, 6);
  assert.equal(presentation.payload.stats.edgeCount, 12);

  const fillet = await command({
    operation: "detail.fillet",
    documentId: importedId,
    baseRevision: imported.revision,
    inputs: { bodyId: imported.activeBodyId, edgeId: presentation.payload.edges[0].edgeId },
    parameters: { radius: 1 },
  });
  assert.equal(fillet.response.status, 200);
  assert.equal(fillet.payload.features.at(-1).type, "detail.fillet");
});

test("rejects empty STEP uploads", async () => {
  const response = await fetch(`${apiRoot}/documents/empty_step/imports/step`, {
    method: "POST",
    headers: { "Content-Type": "application/step" },
    body: new Uint8Array(),
  });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.code, "EMPTY_UPLOAD");
  assert.match(payload.error, /为空/);
});
