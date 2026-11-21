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
import ts from "typescript";

const dragSource = fs.readFileSync(new URL("../app/modeling/grid-drag.ts", import.meta.url), "utf8");
const dragJs = ts.transpileModule(dragSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { makeGridDragCommand } = await import("data:text/javascript;base64," + Buffer.from(dragJs).toString("base64"));
const frameSource = fs.readFileSync(new URL("../app/modeling/construction-frame.ts", import.meta.url), "utf8");
const frameJs = ts.transpileModule(frameSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  .replace('"./grid-drag"', JSON.stringify("data:text/javascript;base64," + Buffer.from(dragJs).toString("base64")));
const { constructionFrame, constructionDragCommand, worldToConstruction } = await import("data:text/javascript;base64," + Buffer.from(frameJs).toString("base64"));

const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8799;
const apiRoot = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), "occt-web-cad-geometry-api-" + process.pid + "-" + Date.now());
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

async function post(pathname, body = {}) {
  const response = await fetch(`${apiRoot}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(observedClient.prepare(body, "", pathname)),
  });
  return { response, payload: observedClient.observe(await response.json(), body.documentId) };
}

test("all fourteen drag tools create kernel geometry without replacing previous Bodies", async () => {
  let count = 0;
  for (const kind of ["box","cylinder","cone","sphere","torus","wedge","prism","pyramid","tube","surface-rectangle","surface-disk","surface-cylinder","surface-cone","surface-sphere"]) {
    const command = makeGridDragCommand(kind, {x:0,y:0}, {x:30,y:20}, 1, 15);
    const {response,payload} = await post("/commands",{documentId:"drag-regression",operation:command.operation,parameters:command.parameters});
    assert.equal(response.status,200,`${kind}: ${JSON.stringify(payload)}`);
    assert.equal(payload.ok,true,`${kind}: ${JSON.stringify(payload)}`);
    assert.equal(payload.bodyCount,++count,kind);
    const {payload:presentation} = await post("/commands",{documentId:"drag-regression",operation:"body.presentation",inputs:{bodyId:payload.bodyId}});
    assert.ok(presentation.positions?.length>0,`${kind} must have renderable triangles`);
    const metadata=payload.bodyMetadata.find(body=>body.bodyId===payload.bodyId);
    if(['box','wedge','pyramid','surface-rectangle'].includes(kind)){
      // The displayed BRep bounding box may include the triangulation's
      // conservative deflection gap. Check the actual planar corner vertices.
      for(const axis of [0,1]){const coordinates=presentation.positions.filter((_,index)=>index%3===axis);assert.ok(Math.abs(Math.min(...coordinates))<1e-5,`${kind} minimum footprint must match its preview`);assert.ok(Math.abs(Math.max(...coordinates)-(axis===0?30:20))<1e-5,`${kind} maximum footprint must match its preview`);}
    }
    assert.equal(metadata.topologyNaming.namedFaceCount,metadata.faceCount,`${kind} face roles`);
    assert.equal(metadata.topologyNaming.namedEdgeCount,metadata.edgeCount,`${kind} edge roles`);
  }
});

test("all fourteen drag tools match their actual kernel footprint on rotated and legacy skew construction frames", async () => {
  const kinds = ["box","cylinder","cone","sphere","torus","wedge","prism","pyramid","tube","surface-rectangle","surface-disk","surface-cylinder","surface-cone","surface-sphere"];
  const coordinates = [
    { id: "rotated", name: "Rotated", origin: [100, 200, 50], xAxis: [0, 1, 0], yAxis: [0, 0, 1] },
    { id: "legacy", name: "Legacy", origin: [-100, 50, 25], xAxis: [2, 0, 0], yAxis: [1, 2, 0] },
  ];
  const extents = points => [0,1,2].flatMap(axis => {
    const values = points.map(point => point[axis]);
    return [Math.min(...values), Math.max(...values)];
  });
  const points = positions => Array.from({ length: positions.length / 3 }, (_, index) => positions.slice(index * 3, index * 3 + 3));
  for (const kind of kinds) {
    const referenceCommand = makeGridDragCommand(kind, { x: 10, y: 20 }, { x: 40, y: 60 }, .5, 15);
    const { payload: reference } = await post("/commands", { documentId: `drag-frame-reference-${kind}`, operation: referenceCommand.operation, parameters: referenceCommand.parameters });
    assert.equal(reference.ok, true, JSON.stringify(reference));
    const expected = extents(points(reference.positions));
    for (const coordinate of coordinates) {
      const documentId = `drag-frame-${coordinate.id}-${kind}`;
      const { payload: configured } = await post("/commands", { documentId, baseRevision: 0, operation: "coordinate.set", parameters: coordinate });
      assert.equal(configured.ok, true, JSON.stringify(configured));
      const frame = constructionFrame(coordinate);
      const command = constructionDragCommand(kind, { x: 10, y: 20 }, { x: 40, y: 60 }, .5, 15, frame);
      const { payload: actual } = await post("/commands", { documentId, baseRevision: configured.revision, operation: command.operation, parameters: command.parameters });
      assert.equal(actual.ok, true, JSON.stringify({ kind, coordinate, actual }));
      const observed = extents(points(actual.positions).map(point => worldToConstruction(frame, point)));
      observed.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-4,
        `${kind}/${coordinate.id} extent ${index}: ${value} != ${expected[index]}`));
      assert.equal(actual.features.at(-1).stringParameters.coordinateSystemId, coordinate.id);
    }
  }
});

test("invalid construction axes and Global overrides fail without modifying the project", async () => {
  const documentId = "construction-invalid-axes";
  const { payload: before } = await post("/commands", { documentId, operation: "document.view" });
  for (const parameters of [
    { id: "global", name: "Override", origin: [1,2,3], xAxis: [1,0,0], yAxis: [0,1,0] },
    { id: "zero", name: "Zero", origin: [0,0,0], xAxis: [0,0,0], yAxis: [0,1,0] },
    { id: "parallel", name: "Parallel", origin: [0,0,0], xAxis: [1,0,0], yAxis: [2,0,0] },
    { id: "overflow", name: "Overflow", origin: [0,0,0], xAxis: [1e200,0,0], yAxis: [0,1,0] },
  ]) {
    const { payload } = await post("/commands", { documentId, baseRevision: before.revision, operation: "coordinate.set", parameters });
    assert.equal(payload.ok, false, JSON.stringify(payload));
    assert.notEqual(payload.code, "INVALID_JSON", "Reject the coordinate itself, not a malformed test request");
    const { payload: after } = await post("/commands", { documentId, operation: "document.view" });
    assert.equal(after.revision, before.revision);
    assert.equal(after.stateToken, before.stateToken);
    assert.deepEqual(after.coordinateSystems, before.coordinateSystems);
  }
});

test("face and edge instances retain their constructor identity when every primitive/surface is edited",async()=>{
  const edits={box:{width:80},cylinder:{radius:50},cone:{radius1:50},sphere:{radius:50},torus:{majorRadius:50},wedge:{width:80},prism:{radius:50},pyramid:{baseWidth:80},tube:{outerRadius:50},"surface-rectangle":{width:80},"surface-disk":{radius:50},"surface-cylinder":{radius:50},"surface-cone":{radius1:50},"surface-sphere":{radius:50}};
  for(const [kind,edit] of Object.entries(edits)) {
    const documentId=`name-edit-${kind}`;let revision=0;
    const run=async(operation,parameters={},inputs={})=>{const result=await post("/commands",{documentId,operation,baseRevision:revision,parameters,inputs});assert.equal(result.response.status,200,`${kind}: ${JSON.stringify(result.payload)}`);revision=result.payload.revision;return result.payload;};
    const drag=makeGridDragCommand(kind,{x:0,y:0},{x:30,y:20},1,15),created=await run(drag.operation,drag.parameters);
    const targets=[{kind:"face",bodyId:created.bodyId,topologyId:created.triangleFaceIds[0]},{kind:"edge",bodyId:created.bodyId,topologyId:created.edges.find(edge=>edge.points.length>=6).edgeId}];
    for(const target of targets){const type=await run("property.type.create",{key:`${target.kind}Tag`,targetScope:target.kind,association:"required",fields:[{key:"priority",type:"int"}]});await run("property.instance.create",{typeId:type.type.typeId,value:{priority:7},target});}
    await run("feature.update",edit,{featureId:created.features[0].id});
    const instances=(await run("property.instance.list")).instances;assert.equal(instances.length,2);
    for(const instance of instances){assert.equal(instance.state,"active",`${kind}: ${JSON.stringify(instance)}`);assert.equal(instance.value.priority,7);assert.notEqual(instance.target.topologyId,instance.association.anchor.topologyId);const measured=await run("geometry.measure",{},{bodyId:instance.target.bodyId,selectionType:instance.target.kind,selectionId:instance.target.topologyId});assert.equal(measured.selectionId,instance.target.topologyId);}
  }
});

test("creates a selectable box and applies a revision-safe fillet", async () => {
  const healthResponse = await fetch(`${apiRoot}/health`);
  assert.equal(healthResponse.status, 200);

  const box = await post("/box", { width: 100, depth: 80, height: 50 });
  assert.equal(box.response.status, 200);
  assert.equal(box.payload.protocolVersion, 1);
  assert.equal(box.payload.revision, 1);
  assert.equal(box.payload.bodyId, "body-1");
  assert.equal(box.payload.stats.faceCount, 6);
  assert.equal(box.payload.stats.edgeCount, 12);
  assert.equal(box.payload.stats.triangleCount, 12);
  assert.equal(box.payload.features[0].type, "primitive.box");
  assert.ok(Math.abs(box.payload.bodyMetadata[0].volume-400000)<1e-7,'Volume must be compared at integration precision, not rounded JSON equality');
  box.payload.bodyMetadata[0].centroid.forEach((value,index)=>assert.ok(Math.abs(value-[50,40,25][index])<1e-10));
  if(box.payload.spatialPolicy?.version===1)assert.deepEqual(box.payload.bodyMetadata[0].bounds,{min:[0,0,0],max:[100,80,50]});
  else assert.equal(box.payload.bodyMetadata[0].bounds.min[0] < 0, true,'Legacy worker bounds include tolerance');

  const mesh = await post("/documents/default/mesh/jobs", {});
  assert.equal(mesh.response.status, 200);
  assert.equal(mesh.payload.meshJob.selection.kind, "all");
  assert.equal(mesh.payload.meshJob.visible, false);
  assert.equal(mesh.payload.meshJob.bodyTopologyRevisions[box.payload.bodyId], 1);
  assert.equal(mesh.payload.mesh.render.kind, "wire");
  assert.equal(mesh.payload.mesh.render.ownership.mode, "occt-history-index");
  assert.deepEqual(mesh.payload.mesh.render.ownership.unmappedBodyIds, []);
  assert.equal(mesh.payload.mesh.render.ownership.assignments[0].solidIndex, 0);
  assert.ok(mesh.payload.mesh.render.groups?.some((group) => group.kind === "solid" && group.bodyId === box.payload.bodyId && group.solidIndex === 0));
  assert.ok(mesh.payload.mesh.render.groups?.[0]?.faces?.some((face) => face.kind === "face"));
  assert.ok(mesh.payload.mesh.nodeCount > 0);
  const bodyMesh = await post("/documents/default/mesh/jobs", { selection: { kind: "body", bodyId: box.payload.bodyId } });
  assert.equal(bodyMesh.response.status, 409);
  assert.equal(bodyMesh.payload.code, "MESH_CONFORMAL_SCOPE_REQUIRED");
  const faceId = box.payload.triangleFaceIds[0];
  const faceMesh = await post("/documents/default/mesh/jobs", { selection: { kind: "face", bodyId: box.payload.bodyId, topologyId: faceId } });
  assert.equal(faceMesh.response.status, 409);
  assert.equal(faceMesh.payload.code, "MESH_CONFORMAL_SCOPE_REQUIRED");
  const jobsResponse = await fetch(apiRoot + "/documents/default/mesh/jobs");
  const jobsPayload = await jobsResponse.json();
  assert.equal(jobsResponse.status, 200);
  assert.equal(jobsPayload.jobs.length, 1);
  assert.equal(mesh.payload.meshJob.freshness.status,"current");
  assert.equal(mesh.payload.mesh.render.groups[0].bodyIdentity,box.payload.bodyMetadata[0].bodyIdentity);
  const visibility = await post("/mesh/jobs/" + mesh.payload.meshJob.jobId + "/visibility", { visible: true });
  assert.equal(visibility.response.status, 200);
  assert.equal(visibility.payload.meshJob.visible, true);

  const fillet = await post("/fillet", {
    revision: box.payload.revision,
    bodyId: box.payload.bodyId,
    edgeId: box.payload.edges[0].edgeId,
    radius: 5,
  });
  assert.equal(fillet.response.status, 200);
  assert.equal(fillet.payload.revision, 2);
  assert.equal(fillet.payload.features.at(-1).type, "detail.fillet");
  assert.ok(fillet.payload.stats.faceCount > box.payload.stats.faceCount);

  const stale = await post("/fillet", {
    revision: box.payload.revision,
    bodyId: box.payload.bodyId,
    edgeId: box.payload.edges[0].edgeId,
    radius: 2,
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "STALE_REVISION");
});

test("persists Body opacity and rejects invalid display values", async () => {
  const documentId = "body_opacity_" + Date.now();
  const box = await post("/commands", {
    operation: "primitive.box",
    documentId,
    parameters: { width: 12, depth: 10, height: 8, reset: true },
  });
  assert.equal(box.response.status, 200);
  const update = await post("/commands", {
    operation: "body.update",
    documentId,
    baseRevision: box.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { opacity: 0.35 },
  });
  assert.equal(update.response.status, 200, JSON.stringify(update.payload));
  assert.equal(update.payload.bodyMetadata[0].opacity, 0.35);
  const invalid = await post("/commands", {
    operation: "body.update",
    documentId,
    baseRevision: update.payload.revision,
    inputs: { bodyId: box.payload.bodyId },
    parameters: { opacity: 1.2 },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, "INVALID_BODY_OPACITY");
});
test("keeps multiple bodies and restores an XBF document snapshot", async () => {
  const id = "multi_body_test";
  let result = await post("/commands", { operation: "document.create", documentId: id });
  assert.equal(result.payload.revision, 0);

  for (const width of [20, 40]) {
    result = await post("/commands", {
      operation: "primitive.box",
      documentId: id,
      parameters: { width, depth: 30, height: 10, reset: false },
    });
    assert.equal(result.response.status, 200);
  }
  let summaryResponse = await fetch(`${apiRoot}/documents/${id}`);
  let summary = await summaryResponse.json();
  assert.equal(summary.bodyCount, 2);
  assert.equal(summary.featureCount, 2);
  assert.equal(summary.revision, 2);
  assert.deepEqual(summary.bodies.map((body) => body.id), ["body-1", "body-2"]);

  const conformalMesh = await post("/documents/" + id + "/mesh/jobs", { repairMode: "conservative" });
  assert.equal(conformalMesh.response.status, 200, JSON.stringify(conformalMesh.payload));
  assert.equal(conformalMesh.payload.meshJob.selection.kind, "all");
  assert.ok(conformalMesh.payload.mesh.nodeCount > 0);
  assert.ok(conformalMesh.payload.mesh.elementCount > 0);
  assert.equal(conformalMesh.payload.mesh.render.kind, "wire");

  const snapshot = await post(`/documents/${id}/snapshot`);
  assert.equal(snapshot.response.status, 200);
  const projectSave = await fetch(`${apiRoot}/documents/${id}/project/save`, { method: "POST" });
  assert.equal(projectSave.status, 200);
  assert.match(projectSave.headers.get("content-type") || "", /application\/vnd.webcad.project/);
  const projectBytes = await projectSave.arrayBuffer();
  assert.ok(projectBytes.byteLength > 32);

  await post("/commands", {
    operation: "primitive.box",
    documentId: id,
    parameters: { width: 60, depth: 30, height: 10, reset: false },
  });
  const projectOpen = await fetch(`${apiRoot}/documents/${id}/project/open`, { method: "POST", headers: { "Content-Type": "application/x-occt-xbf" }, body: projectBytes });
  const projectOpenPayload = await projectOpen.json();
  assert.equal(projectOpen.status, 200, JSON.stringify(projectOpenPayload));
  assert.equal(projectOpenPayload.bodyCount, 2);
  assert.equal(projectOpenPayload.featureCount, 2);

  const restore = await post(`/documents/${id}/restore`);
  assert.equal(restore.response.status, 200);
  assert.equal(restore.payload.bodyCount, 2);
  assert.equal(restore.payload.featureCount, 2);
  assert.equal(restore.payload.revision, 2);

  summaryResponse = await fetch(`${apiRoot}/documents/${id}`);
  summary = await summaryResponse.json();
  assert.equal(summary.bodyCount, 2);
  assert.equal(summary.features[1].type, "primitive.box");
});

test("worker transaction reports commit and restores after a failed reset mutation", async () => {
  const documentId = `transaction_${Date.now()}`;
  const created = await post("/commands", {
    operation: "primitive.box",
    documentId,
    parameters: { width: 20, depth: 20, height: 20, reset: true },
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.payload));
  assert.equal(created.payload.transaction.state, "committed");
  assert.equal(created.payload.transaction.beforeRevision, 0);
  assert.equal(created.payload.transaction.afterRevision, 1);

  const failed = await post("/commands", {
    operation: "primitive.box",
    documentId,
    parameters: { width: -1, depth: 20, height: 20, reset: true },
  });
  assert.equal(failed.response.status, 400);
  assert.equal(failed.payload.code, "INVALID_PARAMETER");

  const summary = await fetch(`${apiRoot}/documents/${documentId}`);
  const payload = await summary.json();
  assert.equal(payload.revision, 1);
  assert.equal(payload.bodies.length, 1);
  assert.equal(payload.bodies[0].id, created.payload.bodyId);
  assert.deepEqual(payload.entityIdentities, created.payload.entityIdentities, "Failed reset must restore identity evidence as well as geometry");
});

test("returns exact OCCT BRep distance and relation for two bodies", async () => {
  const documentId = `relation_${Date.now()}`;
  const first = await post("/commands", {
    operation: "primitive.box", documentId,
    parameters: { width: 10, depth: 10, height: 10, x: 0, y: 0, z: 0, reset: true },
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  const second = await post("/commands", {
    operation: "primitive.box", documentId,
    parameters: { width: 10, depth: 10, height: 10, x: 20, y: 0, z: 0, reset: false },
  });
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  const relation = await post("/commands", {
    operation: "geometry.relation", documentId,
    inputs: { bodyA: first.payload.bodyId, bodyB: second.payload.bodyId },
    parameters: { tolerance: 1e-6 },
  });
  assert.equal(relation.response.status, 200, JSON.stringify(relation.payload));
  assert.equal(relation.payload.bodyA, first.payload.bodyId);
  assert.equal(relation.payload.bodyB, second.payload.bodyId);
  assert.equal(relation.payload.relation, "disjoint");
  assert.ok(Math.abs(relation.payload.distance - 10) < 1e-6);
  assert.equal(relation.payload.source, "occt-brep");
  assert.equal(relation.payload.exact, true);
  assert.equal(relation.payload.commonVolume, 0);
});

test("persists transaction events, replays idempotent commands, and rejects invalid envelopes", async () => {
  const documentId = `gateway_events_${Date.now()}`;
  const requestId = `box-once-${Date.now()}`;
  const command = {
    operation: "primitive.box",
    documentId,
    requestId,
    parameters: { width: 12, depth: 10, height: 8, reset: true },
  };

  const first = await post("/commands", command);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.history.lastEvent.operation, "primitive.box");
  assert.equal(first.payload.history.lastEvent.requestId, requestId);
  assert.equal(first.payload.history.eventId, first.payload.history.lastEvent.eventId);

  const replay = await post("/commands", {
    ...command,
    parameters: { width: 12, depth: 10, height: 8, reset: true },
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.revision, first.payload.revision);
  assert.equal(replay.payload.bodyId, first.payload.bodyId);
  assert.equal(replay.payload.history.eventId, first.payload.history.eventId);

  const summary = await fetch(`${apiRoot}/documents/${documentId}`);
  const summaryPayload = await summary.json();
  assert.equal(summaryPayload.bodyCount, 1);
  assert.equal(summaryPayload.revision, 1);

  const second = await post("/commands", {
    operation: "primitive.box",
    documentId,
    requestId: `box-two-${Date.now()}`,
    parameters: { width: 20, depth: 10, height: 8, reset: false },
  });
  assert.equal(second.response.status, 200);

  const undo = await post("/commands", {
    operation: "document.undo",
    documentId,
    requestId: `undo-${Date.now()}`,
  });
  assert.equal(undo.response.status, 200);
  assert.equal(undo.payload.history.lastEvent.operation, "document.undo");

  const invalidRevision = await post("/commands", {
    operation: "primitive.box",
    documentId,
    baseRevision: -1,
    parameters: { width: 1, depth: 1, height: 1 },
  });
  assert.equal(invalidRevision.response.status, 400);
  assert.equal(invalidRevision.payload.code, "INVALID_REVISION");
  assert.equal(invalidRevision.payload.protocolVersion, 1);
  assert.equal(invalidRevision.payload.recoverable, true);

  const invalidParameters = await post("/commands", {
    operation: "primitive.box",
    documentId,
    parameters: [],
  });
  assert.equal(invalidParameters.response.status, 400);
  assert.equal(invalidParameters.payload.code, "INVALID_PARAMETERS");

  const unsupportedProtocol = await post("/commands", {
    protocolVersion: 2,
    operation: "primitive.box",
    documentId,
    parameters: { width: 1, depth: 1, height: 1 },
  });
  assert.equal(unsupportedProtocol.response.status, 400);
  assert.equal(unsupportedProtocol.payload.code, "UNSUPPORTED_PROTOCOL");
  assert.equal(unsupportedProtocol.payload.protocolVersion, 1);
  assert.equal(unsupportedProtocol.payload.recoverable, false);

  const missingBoxField = await post("/commands", {
    operation: "primitive.box",
    documentId,
    parameters: { width: 1, depth: 1 },
  });
  assert.equal(missingBoxField.response.status, 400);
  assert.equal(missingBoxField.payload.code, "SCHEMA_VALIDATION_FAILED");

  const unsupportedOperation = await post("/commands", {
    operation: "agent.execute",
    documentId,
  });
  assert.equal(unsupportedOperation.response.status, 400);
  assert.equal(unsupportedOperation.payload.code, "UNSUPPORTED_OPERATION");
});

test("preview executes and restores without changing revision or history", async () => {
  const documentId = `preview_${Date.now()}`;
  const created = await post("/commands", {
    operation: "primitive.box", documentId,
    parameters: { width: 10, depth: 10, height: 10, reset: true },
  });
  assert.equal(created.response.status, 200);
  const preview = await post("/commands", {
    operation: "primitive.sphere", documentId,
    options: { preview: true },
    parameters: { radius: 4, reset: false },
  });
  assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
  assert.equal(preview.payload.preview.state, "preview");
  assert.equal(preview.payload.revision, created.payload.revision);
  assert.equal(preview.payload.transaction.afterRevision, created.payload.revision);
  const summary = await fetch(`${apiRoot}/documents/${documentId}`);
  const payload = await summary.json();
  assert.equal(payload.bodyCount, 1);
  assert.equal(payload.revision, created.payload.revision);
  assert.equal(payload.canUndo, false);
  assert.deepEqual(payload.entityIdentities, created.payload.entityIdentities, "Preview must not consume or replace persistent identities");
});

test("document.create starts a clean project context", async () => {
  const documentId = `new_project_${Date.now()}`;
  const create = await post("/commands", { documentId, operation: "primitive.box", parameters: { width: 10, depth: 10, height: 10, reset: true } });
  assert.equal(create.response.status, 200);
  const propertyType = await post("/commands", { documentId, operation: "property.type.create", parameters: { key: "WavePort", name: "Wave Port", targetScope: "face", association: "required" } });
  assert.equal(propertyType.response.status, 200);
  const fresh = await post("/commands", { documentId, operation: "document.create" });
  assert.equal(fresh.response.status, 200);
  assert.equal(fresh.payload.bodyCount, 0);
  assert.equal(fresh.payload.canUndo, false);
  const types = await post("/commands", { documentId, operation: "property.type.list" });
  assert.equal(types.response.status, 200);
  assert.deepEqual(types.payload.types, []);
});
