import { ObservedCommandClient } from "./helpers/observed-command-client.mjs";
import {stopTestChild} from './helpers/stop-test-child.mjs';
const observedClient = new ObservedCommandClient();
﻿import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8837;
const api = `http://127.0.0.1:${port}/api`;
const data = path.join(os.tmpdir(), `occt-sweep-loft-${process.pid}-${Date.now()}`);
let gateway;
before(async () => {
  fs.rmSync(data, { recursive: true, force: true });
  gateway = spawn(process.execPath, [path.join(root, "gateway", "server.mjs")], { cwd: root, env: { ...process.env, GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: data }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway startup timed out")), 10000);
    gateway.stdout.setEncoding("utf8"); gateway.stderr.setEncoding("utf8");
    gateway.stdout.on("data", (chunk) => { if (chunk.includes("Geometry gateway ready")) { clearTimeout(timer); resolve(); } });
    gateway.stderr.on("data", (chunk) => { if (chunk.includes("Error")) { clearTimeout(timer); reject(new Error(chunk)); } });
    gateway.once("error", reject);
  });
});
after(async () => { await stopTestChild(gateway); fs.rmSync(data, { recursive: true, force: true }); });
async function command(body) {
  const response = await fetch(`${api}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(observedClient.prepare(body, "", '/commands')) });
  return { response, payload: observedClient.observe(await response.json(), body.documentId) };
}
test("creates and recomputes a Sweep/Pipe body from a selected Face", async () => {
  const documentId = "sweep_pipe";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10, reset: true } });
  const sweep = await command({ operation: "detail.sweep", documentId, baseRevision: box.payload.revision, inputs: { bodyId: box.payload.bodyId, faceId: "face-1-1" }, parameters: { pathX: 0, pathY: 0, pathZ: 15 } });
  assert.equal(sweep.response.status, 200, JSON.stringify(sweep.payload));
  assert.equal(sweep.payload.features.at(-1).type, "detail.sweep");
  const edited = await command({ operation: "feature.update", documentId, baseRevision: sweep.payload.revision, inputs: { featureId: sweep.payload.features.at(-1).id }, parameters: { pathZ: 25 } });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.features.at(-1).numberParameters.pathZ, 25);
});
test("creates a multi-section Loft body", async () => {
  const documentId = "loft_sections";
  const first = await command({ operation: "surface.rectangle", documentId, parameters: { width: 10, height: 10 } });
  const second = await command({ operation: "surface.rectangle", documentId, parameters: { width: 20, height: 8, x: 2, y: 2, z: 12 } });
  const loft = await command({ operation: "detail.loft", documentId, baseRevision: second.payload.revision, inputs: { sections: [{bodyId:first.payload.bodyId,faceId:first.payload.triangleFaceIds[0]},{bodyId:second.payload.bodyId,faceId:second.payload.triangleFaceIds[0]}] }, parameters: {} });
  assert.equal(loft.response.status, 200, JSON.stringify(loft.payload));
  assert.equal(loft.payload.features.at(-1).type, "detail.loft");
  assert.equal(loft.payload.bodyCount, 3);
});
