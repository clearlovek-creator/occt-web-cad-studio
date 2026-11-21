import { ObservedCommandClient } from "./helpers/observed-command-client.mjs";
const observedClient = new ObservedCommandClient();
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8806;
const apiRoot = `http://127.0.0.1:${port}/api`;
const dataDir = path.join(os.tmpdir(), `occt-web-cad-history-${process.pid}-${Date.now()}`);
let gateway;

async function startGateway(overrides={}) {
  const child = spawn(process.execPath, [path.join(demoRoot, "gateway", "server.mjs")], {
    cwd: demoRoot,
    env: {
      ...process.env,
      GEOMETRY_PORT: String(port),
      GEOMETRY_DATA_DIR: dataDir,
      ...overrides,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Geometry gateway startup timed out.")), 10_000);
    let stderr = "";
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Geometry gateway exited during startup with ${code}: ${stderr}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (chunk.includes("Geometry gateway ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
  });
  return child;
}

async function stopGateway(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

async function restartGateway() {
  await stopGateway(gateway);
  gateway = await startGateway();
}

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

before(() => fs.rmSync(dataDir, { recursive: true, force: true }));

after(async () => {
  await stopGateway(gateway);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("restores the current document and undo/redo stacks across gateway restarts", async () => {
  const documentId = "persistent_restart_history";
  gateway = await startGateway();
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 10, depth: 20, height: 30, reset: true },
  });
  assert.equal(box.response.status, 200, JSON.stringify(box.payload));
  const updated = await command({
    operation: "feature.update", documentId, baseRevision: box.payload.revision,
    inputs: { featureId: box.payload.features[0].id },
    parameters: { width: 20, depth: 20, height: 30 },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.canUndo, true);

  await restartGateway();
  const restored = await command({ operation: "document.view", documentId });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.revision, updated.payload.revision);
  assert.deepEqual(xBounds(restored.payload.positions), { min: 0, max: 20 });
  assert.equal(restored.payload.canUndo, true);

  const undone = await command({ operation: "document.undo", documentId });
  assert.equal(undone.response.status, 200, JSON.stringify(undone.payload));
  assert.equal(undone.payload.revision, box.payload.revision);
  assert.deepEqual(xBounds(undone.payload.positions), { min: 0, max: 10 });
  assert.equal(undone.payload.canRedo, true);

  await restartGateway();
  const afterUndoRestart = await command({ operation: "document.view", documentId });
  assert.equal(afterUndoRestart.payload.revision, box.payload.revision);
  assert.equal(afterUndoRestart.payload.canRedo, true);
  const redone = await command({ operation: "document.redo", documentId });
  assert.equal(redone.response.status, 200, JSON.stringify(redone.payload));
  assert.equal(redone.payload.revision, updated.payload.revision);
  assert.deepEqual(xBounds(redone.payload.positions), { min: 0, max: 20 });

  const manifestPath = path.join(dataDir, "history", documentId, "manifest.json");
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.version, 2);
  assert.match(manifest.current, /^state-\d+-\d+-\d+\.xbf$/);
  assert.equal(manifest.undo.length, 1);
  assert.equal(manifest.redo.length, 0);
  assert.equal(manifestText.includes(dataDir), false, "manifest paths must remain portable and relative");

  await stopGateway(gateway);
  gateway = undefined;
  fs.writeFileSync(path.join(path.dirname(manifestPath), manifest.current), "not-an-xbf", "utf8");
  gateway = await startGateway();
  const recovered = await command({ operation: "document.view", documentId });
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.payload));
  assert.equal(recovered.payload.revision, box.payload.revision);
  assert.deepEqual(xBounds(recovered.payload.positions), { min: 0, max: 10 });
  assert.equal(recovered.payload.canUndo, false);
  assert.equal(recovered.payload.canRedo, false);
  const recoveredManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.notEqual(recoveredManifest.current, manifest.current);
  assert.deepEqual(recoveredManifest.undo, []);
  assert.deepEqual(recoveredManifest.redo, []);
});

test("repairs a deleted live checkpoint before the next modeling command", async () => {
  if (!gateway || gateway.killed || gateway.exitCode !== null) gateway = await startGateway();
  const documentId = "live_missing_checkpoint";
  const box = await command({
    operation: "primitive.box", documentId,
    parameters: { width: 12, depth: 14, height: 16, reset: true },
  });
  assert.equal(box.response.status, 200, JSON.stringify(box.payload));

  const manifestPath = path.join(dataDir, "history", documentId, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.rmSync(path.join(path.dirname(manifestPath), manifest.current));

  const sphere = await command({
    operation: "primitive.sphere", documentId,
    parameters: { radius: 4, reset: false },
  });
  assert.equal(sphere.response.status, 200, JSON.stringify(sphere.payload));
  assert.equal(sphere.payload.bodyCount, 2);
  assert.equal(sphere.payload.canUndo, true);
});

test("replays persisted idempotency records and rejects payload conflicts", async () => {
  if (!gateway || gateway.killed || gateway.exitCode !== null) gateway = await startGateway();
  const documentId = "persistent_idempotency";
  const requestId = "persisted-box-request";
  const first = await command({
    operation: "primitive.box", documentId, requestId,
    parameters: { width: 11, depth: 12, height: 13, reset: true },
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  await restartGateway();
  const replay = await command({
    operation: "primitive.box", documentId, requestId,
    parameters: { width: 11, depth: 12, height: 13, reset: true },
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload.revision, first.payload.revision);
  assert.equal(replay.payload.bodyId, first.payload.bodyId);
  const conflict = await command({
    operation: "primitive.box", documentId, requestId,
    parameters: { width: 12, depth: 12, height: 12, reset: true },
  });
  assert.equal(conflict.response.status, 400);
  assert.equal(conflict.payload.code, "IDEMPOTENCY_CONFLICT");
  const manifestPath = path.join(dataDir, "history", documentId, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.idempotency.length, 1);
  assert.equal(manifest.idempotency[0].key, `${documentId}:primitive.box:${requestId}`);
});

test("an older accepted request survives unrelated edits and a restart without creating duplicate geometry", async () => {
  const documentId="retained_idempotency",input={operation:"primitive.box",documentId,requestId:"accepted-once",parameters:{width:11,depth:12,height:13}};
  const first=await command(input);assert.equal(first.payload.ok,true);
  const second=await command({operation:"primitive.sphere",documentId,requestId:"other-edit",parameters:{radius:3,x:40}});assert.equal(second.payload.ok,true);
  await restartGateway();
  const manifestFile=path.join(dataDir,'history',documentId,'manifest.json'),beforeManifest=fs.readFileSync(manifestFile);
  const replay=await command(input);assert.deepEqual(replay.payload,first.payload,"An accepted request must replay its exact original model and history, not execute again or mix in a later event");
  assert.deepEqual(fs.readFileSync(manifestFile),beforeManifest,'Result replay must not open a new write transaction or rewrite the manifest');
  const current=await command({operation:"document.summary",documentId});assert.equal(current.payload.bodyCount,2);assert.equal(current.payload.stateToken,second.payload.stateToken);
});

test("Undo retries survive a new branch and never undo an unrelated later edit",async()=>{
  const documentId='undo_replay_branch';await command({operation:'primitive.box',documentId,parameters:{width:10,depth:10,height:10}});await command({operation:'primitive.sphere',documentId,parameters:{radius:3,x:40}});
  const input={operation:'document.undo',documentId,requestId:'undo-once'},undone=await command(input);assert.equal(undone.payload.ok,true);
  const branch=await command({operation:'primitive.cylinder',documentId,requestId:'new-branch',parameters:{radius:2,height:8,x:30}});assert.equal(branch.payload.bodyCount,2);await restartGateway();
  const replay=await command(input);assert.deepEqual(replay.payload,undone.payload);const current=await command({operation:'document.summary',documentId});assert.equal(current.payload.bodyCount,2);assert.equal(current.payload.stateToken,branch.payload.stateToken);
});

test("a missing durable outcome refuses to re-execute its command, before and after restart",async()=>{
  const documentId='missing_outcome',input={operation:'primitive.box',documentId,requestId:'missing-once',parameters:{width:10,depth:10,height:10}};await command(input);
  const edited=await command({operation:'primitive.sphere',documentId,requestId:'other',parameters:{radius:2,x:30}}),directory=path.join(dataDir,'history',documentId),manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'))),entry=manifest.idempotency.find(item=>item.key.endsWith(':missing-once'));
  assert.ok(entry.responseRef);assert.equal(Object.hasOwn(entry,'response'),false);fs.rmSync(path.join(directory,'outcomes',entry.responseRef.file));
  for(let i=0;i<2;i++){if(i)await restartGateway();const replay=await command(input);assert.equal(replay.payload.ok,false);assert.equal(replay.payload.code,'IDEMPOTENCY_RESULT_UNAVAILABLE');const current=await command({operation:'document.summary',documentId});assert.equal(current.payload.bodyCount,2);assert.equal(current.payload.stateToken,edited.payload.stateToken);}
});

test("outcome persistence failure does not acknowledge success and safely permits an explicit retry",async()=>{
  const documentId='blocked_outcomes',first=await command({operation:'primitive.box',documentId,parameters:{width:10,depth:10,height:10}}),blocked=path.join(dataDir,'history',documentId,'outcomes');fs.writeFileSync(blocked,'injected storage failure');
  const input={operation:'primitive.sphere',documentId,requestId:'retry-after-storage-repair',parameters:{radius:3,x:30}};
  const failed=await command(input);assert.equal(failed.payload.ok,false);const current=await command({operation:'document.summary',documentId});assert.equal(current.payload.bodyCount,1);assert.equal(current.payload.stateToken,first.payload.stateToken);
  fs.rmSync(blocked);const retried=await command(input);assert.equal(retried.payload.ok,true);assert.equal(retried.payload.bodyCount,2);assert.equal((await command(input)).payload.revision,retried.payload.revision);
});

test("batch duplicate step IDs or request keys are rejected before executing any modeling step",async()=>{
  for(const duplicate of ['step','key']){
    const documentId='duplicate_'+duplicate,steps=[0,1].map(index=>({stepId:duplicate==='step'?'same':'step-'+index,operation:'primitive.box',idempotencyKey:duplicate==='key'?'same':'key-'+index,parameters:{width:10,depth:10,height:10}}));
    const response=await fetch(apiRoot+'/command-batches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId,batchId:'duplicates',steps})}),payload=await response.json();assert.equal(payload.ok,false);assert.equal(payload.code,'INVALID_BATCH');assert.equal((await command({operation:'document.summary',documentId})).payload.bodyCount,0);
  }
});

test("concurrent identical writes execute once, and invalid request keys cannot become unbounded manifest metadata",async()=>{
  const documentId='concurrent_outcome',input={documentId,operation:'primitive.box',requestId:'concurrent-once',parameters:{width:10,depth:10,height:10}},[first,second]=await Promise.all([command(input),command(input)]);assert.equal(first.payload.ok,true);assert.deepEqual(first.payload,second.payload);assert.equal((await command({documentId,operation:'document.summary'})).payload.bodyCount,1);
  for(const key of ['x'.repeat(513),'line\nbreak',42,{}]){const failed=await command({...input,requestId:'new-request',options:{idempotencyKey:key}});assert.equal(failed.payload.code,'INVALID_REQUEST_KEY');}
  assert.equal((await command({documentId,operation:'document.summary'})).payload.bodyCount,1);
});

test("batch replay retains exact step outcomes and detects conflicts after later single edits and restart",async()=>{
  const documentId='batch_retention',input={documentId,batchId:'batch-once',steps:[{operation:'primitive.box',parameters:{width:10,depth:10,height:10}},{operation:'primitive.sphere',parameters:{radius:2,x:30}}]},post=async body=>{const response=await fetch(apiRoot+'/command-batches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return response.json();};
  const first=await post(input);assert.equal(first.ok,true);const later=await command({documentId,operation:'primitive.cylinder',requestId:'after-batch',parameters:{radius:3,height:10,x:50}});await restartGateway();
  const replay=await post(input);assert.equal(replay.ok,true);assert.equal(replay.batch.state,'replayed');assert.deepEqual(replay.results,first.results);assert.equal(replay.bodyCount,3);assert.equal(replay.stateToken,later.payload.stateToken);
  const conflict=await post({...input,steps:[{...input.steps[0],parameters:{width:11,depth:10,height:10}},input.steps[1]]});assert.equal(conflict.code,'IDEMPOTENCY_CONFLICT');assert.equal((await command({documentId,operation:'document.summary'})).payload.bodyCount,3);
});

test("an oversized batch outcome rolls back every step instead of committing an unreplayable partial window",async()=>{
  await stopGateway(gateway);gateway=await startGateway({GEOMETRY_IDEMPOTENCY_BYTES:'4096'});
  try{
    const documentId='small_outcome_budget',baseline=await command({documentId,operation:'primitive.box',parameters:{width:10,depth:10,height:10}}),response=await fetch(apiRoot+'/command-batches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId,batchId:'too-large',baseStateToken:baseline.payload.stateToken,steps:[{operation:'primitive.sphere',parameters:{radius:5,x:30}},{operation:'primitive.sphere',parameters:{radius:5,x:60}}]})}),failed=await response.json();
    assert.equal(failed.ok,false);assert.equal(failed.code,'BATCH_ROLLED_BACK');assert.equal(failed.causeCode,'BATCH_RESULT_TOO_LARGE');assert.ok(failed.results.every(result=>result.ok===false));
    const current=await command({documentId,operation:'document.summary'});assert.equal(current.payload.bodyCount,1);assert.equal(current.payload.stateToken,baseline.payload.stateToken);
    const directory=path.join(dataDir,'history',documentId),manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json')));assert.equal(manifest.idempotency.length,0);assert.deepEqual(fs.readdirSync(path.join(directory,'outcomes')),[]);
  }finally{await restartGateway();}
});

test("aggregate batch response limits abort early and never publish or execute later steps",async()=>{
  await stopGateway(gateway);gateway=await startGateway({GEOMETRY_BATCH_RESULT_BYTES:'1024'});
  try{
    const documentId='bounded_batch_response',baseline=await command({documentId,operation:'primitive.box',parameters:{width:10,depth:10,height:10}}),response=await fetch(apiRoot+'/command-batches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId,batchId:'bounded-output',steps:[{operation:'primitive.sphere',parameters:{radius:5,x:30}},{operation:'primitive.box',parameters:{width:2,depth:2,height:2,x:70}}]})}),failed=await response.json();
    assert.equal(failed.ok,false);assert.equal(failed.causeCode,'BATCH_RESULT_TOO_LARGE');assert.equal(failed.results[0].status,'rolled-back');assert.equal(failed.results[1].status,'not-executed');const current=await command({documentId,operation:'document.summary'});assert.equal(current.payload.bodyCount,1);assert.equal(current.payload.stateToken,baseline.payload.stateToken);
  }finally{await restartGateway();}
});

test("verified live recovery quarantines corrupt checkpoint bytes and preserves undo",async()=>{
  if(!gateway || gateway.killed || gateway.exitCode!==null)gateway=await startGateway();
  const documentId="live_corrupt_checkpoint";
  const box=await command({operation:"primitive.box",documentId,parameters:{width:12,depth:13,height:14,reset:true}});assert.equal(box.response.status,200);
  const directory=path.join(dataDir,"history",documentId),manifest=JSON.parse(fs.readFileSync(path.join(directory,"manifest.json"),"utf8"));fs.writeFileSync(path.join(directory,manifest.current),"corrupt-but-retained");
  const next=await command({operation:"primitive.sphere",documentId,parameters:{radius:3,reset:false}});assert.equal(next.response.status,200,JSON.stringify(next.payload));assert.equal(next.payload.bodyCount,2);assert.ok(next.payload.warnings.some(message=>message.includes("检查点")));
  const quarantine=path.join(dataDir,"history-quarantine",documentId);assert.ok(fs.readdirSync(quarantine).some(file=>fs.readFileSync(path.join(quarantine,file),"utf8")==="corrupt-but-retained"));
  const undone=await command({operation:"document.undo",documentId});assert.equal(undone.payload.bodyCount,1);assert.equal(undone.payload.revision,box.payload.revision);
});
