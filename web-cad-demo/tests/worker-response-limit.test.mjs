import assert from "node:assert/strict";
import {stopTestChild} from './helpers/stop-test-child.mjs';
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8821;
const apiRoot = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), `occt-web-cad-response-limit-${process.pid}-${Date.now()}`);
let gateway;

before(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  gateway = spawn(process.execPath, [path.join(demoRoot, "gateway", "server.mjs")], {
    cwd: demoRoot,
    env: {
      ...process.env,
      GEOMETRY_PORT: String(port),
      GEOMETRY_DATA_DIR: dataDir,
      GEOMETRY_WORKER_RESPONSE_LIMIT_BYTES: "1024",
      GEOMETRY_REQUEST_TIMEOUT_MS: "15000",
      GEOMETRY_WORKER_TIMEOUT_MS: "15000",
    },
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
      if (chunk.includes("ReferenceError") || chunk.includes("SyntaxError")) { clearTimeout(timer); reject(new Error(chunk)); }
    });
  });
});

after(async () => {
  await stopTestChild(gateway);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("returns a controlled error and restarts the worker for oversized responses", async () => {
  const response = await fetch(`${apiRoot}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "primitive.box", documentId: "oversized_response", parameters: { width: 30, depth: 20, height: 10, reset: true } }),
  });
  const payload = await response.json();
  assert.equal(response.status, 502);
  assert.equal(payload.code, "WORKER_RESPONSE_TOO_LARGE");
  assert.match(payload.error, /body presentation|response exceeded/i);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const healthResponse = await fetch(`${apiRoot}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "health.ping" }),
  });
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200, JSON.stringify(health));
  assert.equal(health.ok, true);
});
