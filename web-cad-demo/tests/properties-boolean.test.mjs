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
const port = 8800;
const apiRoot = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), "occt-web-cad-properties-boolean-" + process.pid + "-" + Date.now());
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

async function post(pathname, body = {}) {
  const response = await fetch(`${apiRoot}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(observedClient.prepare(body, "", pathname)),
  });
  return { response, payload: observedClient.observe(await response.json(), body.documentId) };
}

async function cad(documentId,operation,parameters={},inputs={}) {
  const current=await command({documentId,operation:"document.summary"});
  const result=await command({documentId,operation,baseRevision:current.payload.revision,parameters,inputs});
  assert.equal(result.response.status,200,JSON.stringify(result.payload));return result.payload;
}
async function faceAt(documentId,shape,axis,position) {
  for(const topologyId of new Set(shape.triangleFaceIds)) {
    const measured=await cad(documentId,"geometry.measure",{}, {bodyId:shape.bodyId,selectionType:"face",selectionId:topologyId});
    if(Math.abs(measured.centroid[axis]-position)<1e-6)return topologyId;
  }
  throw new Error(`No face at axis ${axis}=${position}`);
}

test("Boolean lineage splits properties across every result Body without guessing face indexes",async()=>{
  const id="lineage_split",box=await cad(id,"primitive.box",{width:100,depth:100,height:100});
  const top=await faceAt(id,box,2,100);
  await cad(id,"property.set",{key:"port",type:"int",value:7},{kind:"face",bodyId:box.bodyId,topologyId:top});
  const type=await cad(id,"property.type.create",{key:"WavePort",targetScope:"face",association:"required",fields:[{key:"frequency",type:"double"}]});
  const instance=await cad(id,"property.instance.create",{typeId:type.type.typeId,name:"Port",value:{frequency:3},target:{kind:"face",bodyId:box.bodyId,topologyId:top}});
  const tool=await cad(id,"primitive.box",{width:20,depth:120,height:120,x:40,y:-10,z:-10});
  const cut=await cad(id,"boolean.cut",{splitResults:true},{targetBody:box.bodyId,toolBody:tool.bodyId});
  assert.equal(cut.bodyCount,2);
  const lineage=cut.features.at(-1).topologyLineage;
  assert.equal(lineage.state,"current");assert.equal(lineage.basis,"occt-history");
  const entry=lineage.entries.find(entry=>entry.sourceBodyId===box.bodyId && entry.sourceTopologyId===top);assert.equal(entry.destinations.length,2);
  const properties=(await cad(id,"property.list")).propertyRecords.filter(record=>record.state==="active" && record.values.port);
  assert.equal(properties.length,2);assert.equal(new Set(properties.map(record=>record.bodyId)).size,2);
  for(const record of properties){const face=await cad(id,"geometry.measure",{}, {bodyId:record.bodyId,selectionType:"face",selectionId:record.topologyId});assert.ok(Math.abs(face.centroid[2]-100)<1e-6);assert.ok(Math.abs(face.area-4000)<1e-6);}
  const split=(await cad(id,"property.instance.list")).instances.find(item=>item.instanceId===instance.instance.instanceId);
  assert.equal(split.state,"needs-review");assert.equal(split.association.candidates.length,2);assert.deepEqual(split.value,{frequency:3});
  const saved=await post(`/documents/${id}/snapshot`);assert.equal(saved.response.status,200);
  const restored=await post(`/documents/${id}/restore`);assert.deepEqual(restored.payload.features.at(-1).topologyLineage,lineage);
});

test("deleted original faces are orphaned rather than rebound to a same-index cut face",async()=>{
  const id="lineage_delete",box=await cad(id,"primitive.box",{width:100,depth:100,height:100});
  const removed=await faceAt(id,box,0,0);await cad(id,"property.set",{key:"deleted",type:"bool",value:true},{kind:"face",bodyId:box.bodyId,topologyId:removed});
  const tool=await cad(id,"primitive.box",{width:60,depth:120,height:120,x:-10,y:-10,z:-10});
  const cut=await cad(id,"boolean.cut",{}, {targetBody:box.bodyId,toolBody:tool.bodyId});
  const entry=cut.features.at(-1).topologyLineage.entries.find(entry=>entry.sourceBodyId===box.bodyId && entry.sourceTopologyId===removed);assert.deepEqual(entry.destinations,[]);
  const properties=(await cad(id,"property.list")).propertyRecords.filter(item=>item.values.deleted);assert.equal(properties.length,1);assert.equal(properties[0].state,"orphaned");
});

test("refined coplanar Fuse reports conflicting values and Keep retains original face properties",async()=>{
  const id="lineage_fuse",a=await cad(id,"primitive.box",{width:10,depth:10,height:10}),b=await cad(id,"primitive.box",{width:10,depth:10,height:10,x:10});
  const topA=await faceAt(id,a,2,10),topB=await faceAt(id,b,2,10);
  await cad(id,"property.set",{key:"boundary",type:"int",value:1},{kind:"face",bodyId:a.bodyId,topologyId:topA});
  await cad(id,"property.set",{key:"boundary",type:"int",value:2},{kind:"face",bodyId:b.bodyId,topologyId:topB});
  const fuse=await cad(id,"boolean.fuse",{refine:true,keepTarget:true,keepTool:true},{targetBody:a.bodyId,toolBody:b.bodyId});
  const properties=(await cad(id,"property.list")).propertyRecords;
  assert.equal(properties.find(item=>item.bodyId===a.bodyId && item.topologyId===topA).state,"active");
  assert.equal(properties.find(item=>item.bodyId===b.bodyId && item.topologyId===topB).state,"active");
  const conflict=properties.find(item=>item.bodyId===fuse.bodyId && item.state==="conflict");assert.ok(conflict);
  const face=await cad(id,"geometry.measure",{},{bodyId:fuse.bodyId,selectionType:"face",selectionId:conflict.topologyId});assert.ok(Math.abs(face.area-200)<1e-10);assert.ok(Math.abs(face.centroid[2]-10)<1e-6);
});

test("typed references follow consecutive Cuts, undo/redo, a portable project and semantic recompute",async()=>{
  const id="lineage_chain",box=await cad(id,"primitive.box",{width:100,depth:100,height:20}),top=await faceAt(id,box,2,20);
  const type=await cad(id,"property.type.create",{key:"Boundary",targetScope:"face",association:"required",fields:[{key:"enabled",type:"bool"}]});
  const instance=await cad(id,"property.instance.create",{typeId:type.type.typeId,name:"TopBoundary",value:{enabled:true},target:{kind:"face",bodyId:box.bodyId,topologyId:top}});
  const first=await cad(id,"primitive.cylinder",{radius:5,height:30,x:20,y:20,z:-5});
  await cad(id,"boolean.cut",{}, {targetBody:box.bodyId,toolBody:first.bodyId});
  const second=await cad(id,"primitive.cylinder",{radius:5,height:30,x:70,y:70,z:-5});
  const final=await cad(id,"boolean.cut",{}, {targetBody:box.bodyId,toolBody:second.bodyId});
  const resolve=async(document=id)=>(await cad(document,"property.instance.list")).instances.find(item=>item.instanceId===instance.instance.instanceId);
  const resolved=await resolve();assert.equal(resolved.state,"active");assert.notEqual(resolved.target.topologyId,top);assert.equal(resolved.association.status,"remapped");
  const face=await cad(id,"geometry.measure",{}, {bodyId:resolved.target.bodyId,selectionType:"face",selectionId:resolved.target.topologyId});assert.ok(Math.abs(face.centroid[2]-20)<1e-6);
  const undone=await command({documentId:id,operation:"document.undo"});assert.equal(undone.response.status,200);assert.ok(undone.payload.revision<final.revision);const previous=await resolve();assert.equal(previous.state,"active");assert.notEqual(previous.target.topologyId,resolved.target.topologyId);
  const redone=await command({documentId:id,operation:"document.redo"});assert.equal(redone.response.status,200);assert.equal(redone.payload.revision,final.revision);assert.deepEqual((await resolve()).target,resolved.target);
  const saved=await fetch(`${apiRoot}/documents/${id}/project/save`,{method:"POST"});assert.equal(saved.status,200);
  const opened=await fetch(`${apiRoot}/documents/lineage_portable/project/open`,{method:"POST",headers:{"Content-Type":"application/vnd.webcad.project"},body:Buffer.from(await saved.arrayBuffer())});const restored=await opened.json();assert.equal(restored.ok,true,JSON.stringify(restored));
  assert.deepEqual((await resolve("lineage_portable")).target,resolved.target);
  await cad("lineage_portable","feature.update",{width:140},{featureId:box.features[0].id});
  const portable=await resolve("lineage_portable");assert.equal(portable.state,"active");
  const portableTop=await cad("lineage_portable","geometry.measure",{}, {bodyId:portable.target.bodyId,selectionType:"face",selectionId:portable.target.topologyId});assert.ok(Math.abs(portableTop.area-(14000-50*Math.PI))<1e-5);
  await cad(id,"feature.update",{width:120},{featureId:box.features[0].id});
  const updated=await resolve();assert.equal(updated.state,"active");assert.equal(updated.value.enabled,true);
  const topAfter=await cad(id,"geometry.measure",{}, {bodyId:updated.target.bodyId,selectionType:"face",selectionId:updated.target.topologyId});assert.ok(Math.abs(topAfter.area-(12000-50*Math.PI))<1e-5);assert.ok(Math.abs(topAfter.centroid[2]-20)<1e-6);
  await cad(id,"feature.update",{height:25},{featureId:box.features[0].id});const repeated=await resolve();assert.equal(repeated.state,"active");
  const repeatedTop=await cad(id,"geometry.measure",{}, {bodyId:repeated.target.bodyId,selectionType:"face",selectionId:repeated.target.topologyId});assert.ok(Math.abs(repeatedTop.centroid[2]-25)<1e-6);
  const failed=await command({documentId:id,operation:"feature.update",baseRevision:(await cad(id,"document.summary")).revision,inputs:{featureId:box.features[0].id},parameters:{width:0}});assert.equal(failed.payload.ok,false);assert.deepEqual((await resolve()).target,repeated.target);
  assert.equal((await command({documentId:id,operation:"document.undo"})).response.status,200);const reverted=await resolve();assert.equal(reverted.state,"active");assert.equal((await cad(id,"geometry.measure",{}, {bodyId:reverted.target.bodyId,selectionType:"face",selectionId:reverted.target.topologyId})).centroid[2],20);
  assert.equal((await command({documentId:id,operation:"document.redo"})).response.status,200);assert.deepEqual((await resolve()).target,repeated.target);
  const withEvolution=await fetch(`${apiRoot}/documents/${id}/project/save`,{method:"POST"});assert.equal(withEvolution.status,200);
  const openedEvolution=await fetch(`${apiRoot}/documents/lineage_after_edits/project/open`,{method:"POST",headers:{"Content-Type":"application/vnd.webcad.project"},body:Buffer.from(await withEvolution.arrayBuffer())});assert.equal((await openedEvolution.json()).ok,true);
  assert.deepEqual((await resolve("lineage_after_edits")).target,repeated.target);
  await cad("lineage_after_edits","feature.update",{depth:80},{featureId:box.features[0].id});const fromSavedEvolution=await resolve("lineage_after_edits");assert.equal(fromSavedEvolution.state,"active");
  const afterSaved=await cad("lineage_after_edits","geometry.measure",{}, {bodyId:fromSavedEvolution.target.bodyId,selectionType:"face",selectionId:fromSavedEvolution.target.topologyId});assert.ok(Math.abs(afterSaved.area-(9600-50*Math.PI))<1e-5);assert.ok(Math.abs(afterSaved.centroid[2]-25)<1e-6);
  assert.ok(final.features.filter(feature=>feature.type==="boolean.cut").every(feature=>feature.topologyLineage.state==="current"));
});

test("multi-Target group Fuse, Cut and Refine compose their exact histories",async()=>{
  const id="lineage_group",targets=[];
  for(let index=0;index<3;index++) {
    const shape=await cad(id,"primitive.box",{width:10,depth:10,height:10,x:index*10});targets.push(shape.bodyId);
    const top=await faceAt(id,shape,2,10);
    await cad(id,"property.set",{key:`part${index}`,type:"bool",value:true},{kind:"face",bodyId:shape.bodyId,topologyId:top});
  }
  const tool=await cad(id,"primitive.cylinder",{radius:2,height:20,x:15,y:5,z:-5});
  const result=await cad(id,"boolean.cut",{refine:true},{targetBodies:targets,toolBody:tool.bodyId});
  const records=(await cad(id,"property.list")).propertyRecords.filter(record=>record.bodyId===result.bodyId && record.state==="active" && record.kind==="face");
  const top=records.find(record=>record.values.part0 && record.values.part1 && record.values.part2);assert.ok(top,"All grouped Target faces must reach the refined top face");
  const measured=await cad(id,"geometry.measure",{}, {bodyId:result.bodyId,selectionType:"face",selectionId:top.topologyId});
  assert.ok(Math.abs(measured.area-(300-Math.PI*4))<1e-5);assert.ok(Math.abs(measured.centroid[2]-10)<1e-6);
  for(const targetBodies of [[],[""],"body-1",Array.from({length:257},()=>"body-1")]) {
    const invalid=await command({documentId:id,operation:"boolean.cut",baseRevision:result.revision,inputs:{targetBodies,toolBody:tool.bodyId}});assert.equal(invalid.payload.code,"SCHEMA_VALIDATION_FAILED");
  }
  assert.equal((await cad(id,"document.summary")).revision,result.revision);
});

test("variable, coordinate and non-uniform transform recompute retain Face and Edge instance identities",async()=>{
  const id="name_frames";
  await cad(id,"variable.set",{name:"span",type:"length",expression:"40 mm"});
  await cad(id,"coordinate.set",{id:"fixture",name:"Fixture",kind:"cartesian",origin:[0,0,0],xAxis:[1,0,0],yAxis:[0,1,0]});
  const box=await cad(id,"primitive.box",{width:"span",depth:30,height:10,coordinateSystemId:"fixture"});
  const top=await faceAt(id,box,2,10),ids=[];
  for(const target of [{kind:"face",bodyId:box.bodyId,topologyId:top},{kind:"edge",bodyId:box.bodyId,topologyId:box.edges.find(edge=>edge.points.length>=6).edgeId}]){
    const type=await cad(id,"property.type.create",{key:`${target.kind}Label`,targetScope:target.kind,association:"required",fields:[{key:"enabled",type:"bool"}]});const instance=await cad(id,"property.instance.create",{typeId:type.type.typeId,value:{enabled:true},target});ids.push(instance.instance.instanceId);
  }
  await cad(id,"transform.translate",{dx:100,dy:20,dz:5},{bodyId:box.bodyId});
  await cad(id,"transform.scale_non_uniform",{factorX:2,factorY:3,factorZ:1.5,originX:0,originY:0,originZ:0},{bodyId:box.bodyId});
  assert.ok((await cad(id,"property.instance.list")).instances.every(instance=>instance.state==="active"));
  await cad(id,"variable.set",{name:"span",type:"length",expression:"60 mm"});
  await cad(id,"coordinate.set",{id:"fixture",name:"Fixture",kind:"cartesian",origin:[1000,0,100],xAxis:[1,0,0],yAxis:[0,1,0]});
  const instances=(await cad(id,"property.instance.list")).instances;assert.ok(instances.every(instance=>ids.includes(instance.instanceId)&&instance.state==="active"&&instance.value.enabled));
  const face=instances.find(instance=>instance.target.kind==="face").target,measured=await cad(id,"geometry.measure",{}, {bodyId:face.bodyId,selectionType:"face",selectionId:face.topologyId});
  assert.ok(Math.abs(measured.area-10800)<1e-5);assert.deepEqual(measured.centroid,[2260,105,172.5]);
});

test("moving a consumed Boolean Tool cannot transfer a disappearing hole attribute to the other hole",async()=>{
  const id="name_hole_removed",box=await cad(id,"primitive.box",{width:100,depth:100,height:20});
  const first=await cad(id,"primitive.cylinder",{radius:5,height:30,x:20,y:20,z:-5});await cad(id,"boolean.cut",{}, {targetBody:box.bodyId,toolBody:first.bodyId});
  const second=await cad(id,"primitive.cylinder",{radius:5,height:30,x:70,y:70,z:-5}),result=await cad(id,"boolean.cut",{}, {targetBody:box.bodyId,toolBody:second.bodyId});
  const hole=await faceAt(id,result,0,20),top=await faceAt(id,result,2,20);
  const type=await cad(id,"property.type.create",{key:"Port",targetScope:"face",association:"required",fields:[{key:"number",type:"int"}]});
  const a=await cad(id,"property.instance.create",{typeId:type.type.typeId,name:"FirstHole",value:{number:1},target:{kind:"face",bodyId:box.bodyId,topologyId:hole}});
  const b=await cad(id,"property.instance.create",{typeId:type.type.typeId,name:"Top",value:{number:2},target:{kind:"face",bodyId:box.bodyId,topologyId:top}});
  await cad(id,"feature.update",{x:200},{featureId:first.features.at(-1).id});
  const instances=(await cad(id,"property.instance.list")).instances,disappeared=instances.find(instance=>instance.instanceId===a.instance.instanceId),survived=instances.find(instance=>instance.instanceId===b.instance.instanceId);
  assert.equal(disappeared.state,"needs-review");assert.equal(disappeared.association.candidates.length,0);assert.equal(disappeared.value.number,1);assert.equal(survived.state,"active");
  const measured=await cad(id,"geometry.measure",{}, {bodyId:survived.target.bodyId,selectionType:"face",selectionId:survived.target.topologyId});assert.ok(Math.abs(measured.area-(10000-25*Math.PI))<1e-5);
});

test("persists typed body, face and edge properties and makes topology loss explicit", async () => {
  const documentId = "property_boolean_test";
  await command({ operation: "document.create", documentId });
  const target = await command({
    operation: "primitive.box",
    documentId,
    parameters: { width: 100, depth: 100, height: 100, reset: false },
  });
  const tool = await command({
    operation: "primitive.box",
    documentId,
    parameters: { width: 40, depth: 40, height: 40, reset: false },
  });
  assert.equal(tool.payload.revision, 2);

  let revision = tool.payload.revision;
  let result = await command({
    operation: "property.set",
    documentId,
    baseRevision: revision,
    inputs: { kind: "body", bodyId: target.payload.bodyId },
    parameters: { key: "material", type: "expression", value: "Aluminum 6061" },
  });
  assert.equal(result.response.status, 200);
  revision = result.payload.revision;

  result = await command({
    operation: "property.set",
    documentId,
    baseRevision: revision,
    inputs: {
      kind: "face",
      bodyId: target.payload.bodyId,
      topologyId: target.payload.triangleFaceIds[0],
    },
    parameters: { key: "surface.roughness", type: "double", value: 1.6 },
  });
  revision = result.payload.revision;

  result = await command({
    operation: "property.set",
    documentId,
    baseRevision: revision,
    inputs: {
      kind: "edge",
      bodyId: target.payload.bodyId,
      topologyId: target.payload.edges[0].edgeId,
    },
    parameters: { key: "inspection.required", type: "bool", value: true },
  });
  revision = result.payload.revision;

  result = await command({
    operation: "property.set",
    documentId,
    baseRevision: revision,
    inputs: { kind: "body", bodyId: tool.payload.bodyId },
    parameters: { key: "role", type: "expression", value: "cutting-tool" },
  });
  revision = result.payload.revision;
  assert.equal(revision, 6);

  let listed = await command({ operation: "property.list", documentId, inputs: {} });
  assert.equal(listed.payload.propertyRecords.length, 4);
  assert.equal(listed.payload.propertyRecords.find((item) => item.kind === "face").values["surface.roughness"].type, "double");
  assert.equal(listed.payload.propertyRecords.find((item) => item.kind === "edge").values["inspection.required"].value, true);

  const snapshot = await post(`/documents/${documentId}/snapshot`);
  assert.equal(snapshot.response.status, 200);

  const booleanResult = await command({
    operation: "boolean.cut",
    documentId,
    baseRevision: revision,
    inputs: { targetBody: target.payload.bodyId, toolBody: tool.payload.bodyId },
    parameters: { keepTool: false },
  });
  assert.equal(booleanResult.response.status, 200);
  assert.equal(booleanResult.payload.revision, 7);
  assert.equal(booleanResult.payload.bodyCount, 1);
  assert.equal(booleanResult.payload.features.at(-1).type, "boolean.cut");

  listed = await command({ operation: "property.list", documentId, inputs: {} });
  const bodyProperty = listed.payload.propertyRecords.find(
    (item) => item.kind === "body" && item.bodyId === target.payload.bodyId,
  );
  const faceProperty = listed.payload.propertyRecords.find((item) => item.kind === "face");
  const edgeProperty = listed.payload.propertyRecords.find((item) => item.kind === "edge");
  const toolProperty = listed.payload.propertyRecords.find((item) => item.bodyId === tool.payload.bodyId);
  assert.equal(bodyProperty.state, "active");
  assert.ok(["superseded", "orphaned"].includes(faceProperty.state));
  assert.ok(["superseded", "orphaned"].includes(edgeProperty.state));
  assert.equal(toolProperty.state, "orphaned");
  const propagatedFace = listed.payload.propertyRecords.find(
    (item) => item.kind === "face" && item.state === "active"
      && item.values["surface.roughness"]?.value === 1.6,
  );
  const propagatedEdge = listed.payload.propertyRecords.find(
    (item) => item.kind === "edge" && item.state === "active"
      && item.values["inspection.required"]?.value === true,
  );
  assert.ok(propagatedFace, "face property should propagate through Boolean history");
  assert.ok(propagatedEdge, "edge property should propagate through Boolean history");

  const restored = await post(`/documents/${documentId}/restore`);
  assert.equal(restored.response.status, 200);
  assert.equal(restored.payload.revision, 6);
  assert.equal(restored.payload.bodyCount, 2);
  assert.equal(restored.payload.propertyRecords.length, 4);
  assert.ok(restored.payload.propertyRecords.every((item) => item.state === "active"));

  const deleted = await command({
    operation: "property.delete",
    documentId,
    baseRevision: restored.payload.revision,
    inputs: { kind: "body", bodyId: target.payload.bodyId },
    parameters: { key: "material" },
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.payload.deleted, true);
  assert.equal(deleted.payload.revision, 7);
});

test("propagates face properties through Fillet and invalidates the consumed edge", async () => {
  const documentId = "fillet_property_history_test";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 80, depth: 60, height: 40, reset: true },
  });
  let revision = box.payload.revision;
  let result = await command({
    operation: "property.set", documentId, baseRevision: revision,
    inputs: { kind: "face", bodyId: box.payload.bodyId, topologyId: box.payload.triangleFaceIds[0] },
    parameters: { key: "finish", type: "expression", value: "painted" },
  });
  revision = result.payload.revision;
  result = await command({
    operation: "property.set", documentId, baseRevision: revision,
    inputs: { kind: "edge", bodyId: box.payload.bodyId, topologyId: box.payload.edges[0].edgeId },
    parameters: { key: "edge.note", type: "expression", value: "remove-on-fillet" },
  });
  revision = result.payload.revision;

  const fillet = await command({
    operation: "detail.fillet", documentId, baseRevision: revision,
    inputs: { bodyId: box.payload.bodyId, edgeId: box.payload.edges[0].edgeId },
    parameters: { radius: 4 },
  });
  assert.equal(fillet.response.status, 200);
  assert.equal(fillet.payload.revision, 4);

  let listed = await command({ operation: "property.list", documentId, inputs: {} });
  const oldEdge = listed.payload.propertyRecords.find(
    (item) => item.topologyId === box.payload.edges[0].edgeId,
  );
  const propagatedFace = listed.payload.propertyRecords.find(
    (item) => item.kind === "face" && item.state === "active"
      && item.values.finish?.value === "painted",
  );
  assert.equal(oldEdge.state, "orphaned");
  assert.ok(propagatedFace);
  assert.match(propagatedFace.topologyId, /^face-4-\d+$/);

  await post(`/documents/${documentId}/snapshot`);
  await command({
    operation: "property.set", documentId, baseRevision: fillet.payload.revision,
    inputs: { kind: "body", bodyId: box.payload.bodyId },
    parameters: { key: "temporary", type: "bool", value: true },
  });
  const restored = await post(`/documents/${documentId}/restore`);
  assert.equal(restored.payload.revision, 4);
  listed = await command({ operation: "property.list", documentId, inputs: {} });
  assert.ok(listed.payload.propertyRecords.some(
    (item) => item.kind === "face" && item.state === "active" && item.values.finish?.value === "painted",
  ));
  assert.ok(listed.payload.propertyRecords.some(
    (item) => item.kind === "edge" && item.state === "orphaned",
  ));
});

test("rejects stale and mismatched topology property writes", async () => {
  const documentId = "property_validation_test";
  const box = await command({
    operation: "primitive.box",
    documentId,
    parameters: { width: 20, depth: 20, height: 20, reset: true },
  });
  const stale = await command({
    operation: "property.set",
    documentId,
    baseRevision: 0,
    inputs: { kind: "body", bodyId: box.payload.bodyId },
    parameters: { key: "name", type: "expression", value: "stale" },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "STALE_REVISION");

  const invalidFace = await command({
    operation: "property.set",
    documentId,
    baseRevision: box.payload.revision,
    inputs: { kind: "face", bodyId: box.payload.bodyId, topologyId: "face-999-1" },
    parameters: { key: "name", type: "expression", value: "wrong topology" },
  });
  assert.equal(invalidFace.response.status, 400);
  assert.equal(invalidFace.payload.code, "FACE_NOT_FOUND");
});

test("Body Face and Edge properties support typed custom values", async () => {
  const documentId = "typed_custom_properties";
  const box = await command({ operation: "primitive.box", documentId, parameters: { width: 10, depth: 10, height: 10, reset: true } });
  let revision = box.payload.revision;
  for (const [key, type, value] of [
    ["is_magnetic", "bool", true],
    ["priority", "int", 3],
    ["roughness", "double", 0.125],
    ["formula", "expression", "width * 2"],
  ]) {
    const result = await command({ operation: "property.set", documentId, baseRevision: revision, inputs: { kind: "body", bodyId: box.payload.bodyId }, parameters: { key, type, value } });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    revision = result.payload.revision;
  }
  const listed = await command({ operation: "property.list", documentId, inputs: { kind: "body", bodyId: box.payload.bodyId } });
  const values = listed.payload.propertyRecords[0].values;
  assert.equal(values.is_magnetic.type, "bool");
  assert.equal(values.priority.type, "int");
  assert.equal(values.roughness.type, "double");
  assert.equal(values.formula.type, "expression");

  for (const legacyType of ["string", "integer", "real", "boolean"]) {
    const rejected = await command({ operation: "property.set", documentId, baseRevision: revision, inputs: { kind: "body", bodyId: box.payload.bodyId }, parameters: { key: "legacy_" + legacyType, type: legacyType, value: legacyType === "boolean" ? true : legacyType === "string" ? "legacy" : 1 } });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.payload.code, "INVALID_PROPERTY_TYPE");
  }
});
