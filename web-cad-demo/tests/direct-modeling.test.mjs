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
const port = 8802;
const apiRoot = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), `occt-web-cad-direct-${process.pid}-${Date.now()}`);
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

test("creates cylinder, cone, sphere and torus with valid topology", async () => {
  const cases = [
    ["primitive.cylinder", { radius: 12, height: 30 }],
    ["primitive.cone", { radius1: 14, radius2: 5, height: 28 }],
    ["primitive.sphere", { radius: 16 }],
    ["primitive.torus", { majorRadius: 24, minorRadius: 6 }],
  ];

  for (const [operation, parameters] of cases) {
    const documentId = `direct_${operation.split(".")[1]}`;
    const result = await command({ operation, documentId, parameters: { ...parameters, reset: true } });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.revision, 1);
    assert.equal(result.payload.bodyCount, 1);
    assert.equal(result.payload.features.at(-1).type, operation);
    assert.ok(result.payload.stats.faceCount > 0);
    assert.ok(result.payload.stats.edgeCount > 0);
    assert.ok(result.payload.stats.triangleCount > 0);
  }

  const invalid = await command({
    operation: "primitive.torus",
    documentId: "invalid_torus",
    parameters: { majorRadius: 5, minorRadius: 8, reset: true },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, "INVALID_PARAMETER");
});

test("returns render presentations for every body in a multi-body document", async () => {
  const documentId = "direct_multi_body_view";
  const box = await command({
    operation: "primitive.box",
    documentId,
    parameters: { width: 40, depth: 30, height: 20, reset: true },
  });
  const sphere = await command({
    operation: "primitive.sphere",
    documentId,
    parameters: { radius: 8, reset: false },
  });

  assert.equal(sphere.response.status, 200, JSON.stringify(sphere.payload));
  assert.equal(sphere.payload.bodyCount, 2);
  assert.equal(sphere.payload.bodyPresentations.length, 2);
  assert.deepEqual(
    new Set(sphere.payload.bodyPresentations.map((body) => body.bodyId)),
    new Set([box.payload.bodyId, sphere.payload.bodyId]),
  );
  assert.ok(sphere.payload.bodyPresentations.every((body) => body.positions.length > 0));

  const view = await command({ operation: "document.view", documentId });
  assert.equal(view.payload.bodyPresentations.length, 2);
});
test("translates a property-bearing cylinder and cuts a through-hole in a box", async () => {
  const documentId = "direct_hole_workflow";
  const box = await command({
    operation: "primitive.box",
    documentId,
    parameters: { width: 40, depth: 40, height: 40, reset: true },
  });
  const cylinder = await command({
    operation: "primitive.cylinder",
    documentId,
    parameters: { radius: 5, height: 40, reset: false },
  });
  assert.equal(cylinder.payload.revision, 2);

  const property = await command({
    operation: "property.set",
    documentId,
    baseRevision: cylinder.payload.revision,
    inputs: {
      kind: "face",
      bodyId: cylinder.payload.bodyId,
      topologyId: cylinder.payload.triangleFaceIds[0],
    },
    parameters: { key: "machining.role", type: "expression", value: "hole-wall" },
  });
  assert.equal(property.payload.revision, 3);

  const translated = await command({
    operation: "transform.translate",
    documentId,
    baseRevision: property.payload.revision,
    inputs: { bodyId: cylinder.payload.bodyId },
    parameters: { dx: 20, dy: 20, dz: 0 },
  });
  assert.equal(translated.response.status, 200, JSON.stringify(translated.payload));
  assert.equal(translated.payload.revision, 4);
  assert.equal(translated.payload.features.at(-1).type, "transform.translate");

  const properties = await command({ operation: "property.list", documentId, inputs: {} });
  const propagated = properties.payload.propertyRecords.find(
    (item) => item.kind === "face" && item.state === "active"
      && item.values["machining.role"]?.value === "hole-wall",
  );
  assert.ok(propagated, "face property should remain active after translation");
  assert.match(propagated.topologyId, /^face-4-\d+$/);

  const cut = await command({
    operation: "boolean.cut",
    documentId,
    baseRevision: translated.payload.revision,
    inputs: { targetBody: box.payload.bodyId, toolBody: cylinder.payload.bodyId },
    parameters: { keepTool: false },
  });
  assert.equal(cut.response.status, 200, JSON.stringify(cut.payload));
  assert.equal(cut.payload.revision, 5);
  assert.equal(cut.payload.bodyCount, 1);
  assert.equal(cut.payload.features.at(-1).type, "boolean.cut");
  assert.ok(cut.payload.stats.faceCount >= 7, "cut body should contain the cylindrical hole face");

  const sphereAfterConsumedTool = await command({
    operation: "primitive.sphere",
    documentId,
    parameters: { radius: 6, reset: false },
  });
  assert.equal(sphereAfterConsumedTool.response.status, 200, JSON.stringify(sphereAfterConsumedTool.payload));
  assert.equal(sphereAfterConsumedTool.payload.bodyCount, 2);
  assert.notEqual(sphereAfterConsumedTool.payload.bodyId, box.payload.bodyId);
  assert.notEqual(sphereAfterConsumedTool.payload.bodyId, cylinder.payload.bodyId);});

test("creates analytical and planar Sheet Bodies with editable history", async () => {
  const cases = [
    ["surface.rectangle", { width: "40 mm", height: "20 mm" }],
    ["surface.disk", { radius: "12 mm" }],
    ["surface.cylinder", { radius: "10 mm", height: "30 mm" }],
    ["surface.cone", { radius1: "15 mm", radius2: "5 mm", height: "25 mm" }],
    ["surface.sphere", { radius: "14 mm" }],
  ];
  for (const [operation, parameters] of cases) {
    const documentId = `surface_${operation.split(".")[1]}`;
    const result = await command({ operation, documentId, parameters: { ...parameters, coordinateSystemId: "global", reset: true } });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.bodyMetadata[0].kind, "sheet");
    assert.equal(result.payload.stats.faceCount, 1);
    assert.ok(result.payload.stats.edgeCount > 0);
    assert.equal(result.payload.features.at(-1).type, operation);
  }

  const created = await command({ operation: "surface.rectangle", documentId: "surface_edit", parameters: { width: 20, height: 10, reset: true } });
  const updated = await command({ operation: "feature.update", documentId: "surface_edit", baseRevision: created.payload.revision, inputs: { featureId: created.payload.features[0].id }, parameters: { width: "50 mm" } });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.features[0].numberParameters.width, 50);
  assert.equal(updated.payload.bodyMetadata[0].kind, "sheet");
});

test("thickens a Sheet Body into a new Solid and rejects Shell on a Sheet", async () => {
  const documentId = "surface_thicken";
  const sheet = await command({ operation: "surface.rectangle", documentId, parameters: { width: 40, height: 30, reset: true } });
  const faceId = sheet.payload.triangleFaceIds[0];
  const thickened = await command({
    operation: "detail.thicken", documentId, baseRevision: sheet.payload.revision,
    inputs: { bodyId: sheet.payload.bodyId, faceId }, parameters: { thickness: "4 mm", reverse: false },
  });
  assert.equal(thickened.response.status, 200, JSON.stringify(thickened.payload));
  assert.equal(thickened.payload.bodyCount, 2);
  assert.deepEqual(thickened.payload.bodyMetadata.map((body) => body.kind).sort(), ["sheet", "solid"]);

  const rejected = await command({
    operation: "detail.shell", documentId, baseRevision: thickened.payload.revision,
    inputs: { bodyId: sheet.payload.bodyId, faceId }, parameters: { thickness: 2 },
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.payload.code, "BODY_KIND_MISMATCH");
});
