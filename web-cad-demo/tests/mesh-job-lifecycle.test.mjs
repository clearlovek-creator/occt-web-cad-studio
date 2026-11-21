import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {EventEmitter} from 'node:events';
import {ProjectMeshService} from "../gateway/project-mesh-service.mjs";
import {MeshJobStore} from "../gateway/mesh-job-store.mjs";
import {captureMeshSource} from "../shared/mesh-source.mjs";
import {diagnosticFixture} from "./helpers/mesh-preparation-fixture.mjs";

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function until(predicate){const end=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<end,"Condition did not settle");await new Promise(resolve=>setImmediate(resolve));}}
test('a computed mesh is not published complete while its dedicated worker exit remains unconfirmed',async()=>{const f=fixture({holdExit:true});try{const accepted=await f.service.create('exitproof',{background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId);await until(()=>f.workers[0]?.command);f.workers[0].finish();await until(()=>f.workers[0].stops>0);assert.notEqual(job.state,'complete');assert.notEqual(JSON.parse(fs.readFileSync(path.join(f.service.store.directory(job),'metadata.json'))).state,'complete');assert.equal(fs.existsSync(path.join(f.service.store.directory(job),'completion.json')),false);f.workers[0].exit.resolve();await until(()=>job.state==='complete');assert.equal(fs.existsSync(path.join(f.service.store.directory(job),'completion.json')),true);}finally{await f.cleanup();}});

test('a denied final metadata replacement cannot delete a sealed computed result or start a second worker',async t=>{
  const f=fixture();try{const accepted=await f.service.create('locked_completion',{background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId);await until(()=>f.workers[0]?.command);const file=path.join(f.service.store.directory(job),'metadata.json'),before=fs.readFileSync(file),rename=fs.renameSync;
    t.mock.method(fs,'renameSync',(source,target)=>{if(target===file&&JSON.parse(fs.readFileSync(source)).state==='complete')throw Object.assign(Error('SECRET blocked metadata'),{code:'EPERM'});return rename(source,target);});
    const pending=job.completion;f.workers[0].finish();const result=await pending;assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.payload.meshJob.state,'complete');assert.equal(result.payload.meshJob.persistence.metadataSynchronized,false);assert.equal(f.workers.length,1);assert.equal(fs.existsSync(f.service.store.output(job)),true);assert.deepEqual(fs.readFileSync(file),before);
    const restored=new ProjectMeshService(f.options);try{await restored.ready;assert.equal(restored.jobs.get(job.jobId).state,'complete');assert.equal(restored.jobs.get(job.jobId).visible,false);}finally{await restored.close();}
  }finally{await f.cleanup();}
});

test('failure to publish the completion receipt retains computed files but never reports or renders success',async t=>{
  const f=fixture();try{const accepted=await f.service.create('uncommitted_completion',{background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId);await until(()=>f.workers[0]?.command);const receipt=path.join(f.service.store.directory(job),'completion.json'),rename=fs.renameSync;
    t.mock.method(fs,'renameSync',(source,target)=>{if(target===receipt)throw Object.assign(Error('SECRET receipt blocked'),{code:'ENOSPC'});return rename(source,target);});
    const pending=job.completion;f.workers[0].finish();const result=await pending;assert.equal(result.status,503);assert.equal(result.payload.code,'MESH_COMPLETION_UNCOMMITTED');assert.equal(job.state,'failed');assert.equal(job.visible,false);assert.equal(f.workers.length,1);assert.equal(fs.existsSync(f.service.store.output(job)),true);assert.equal(fs.existsSync(path.join(f.service.store.directory(job),'result.json')),true);assert.equal(fs.existsSync(receipt),false);assert.doesNotMatch(JSON.stringify(result),/SECRET/);
    assert.equal((await f.service.outputAccess(path.basename(f.service.store.output(job)))).status,409);
  }finally{await f.cleanup();}
});

test('an exit timeout holds the global mesh slot until the exact old child later proves exit through read-only reconciliation',async()=>{const f=fixture(),child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.pid=123;try{const accepted=await f.service.create('uncertain',{background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId);await until(()=>f.workers[0]?.command);f.workers[0].children=new Set([child]);f.workers[0].closeAndWait=async()=>{throw Object.assign(Error('injected stop observation timeout'),{code:'MESH_WORKER_STOP_TIMEOUT'});};f.workers[0].finish();await until(()=>job.stopUnconfirmed);assert.equal(job.state,'cancelling');const queued=await f.service.create('other',{background:true}),next=f.service.jobs.get(queued.payload.meshJob.jobId);await until(()=>next.state==='queued');assert.equal(f.workers.length,1);await f.service.handle('GET','/api/documents/uncertain/mesh/jobs');assert.equal(job.state,'cancelling');assert.equal(f.workers.length,1);child.exitCode=0;child.emit('exit',0);await f.service.handle('GET','/api/documents/uncertain/mesh/jobs');assert.equal(job.state,'interrupted');await until(()=>f.workers[1]?.command);assert.equal(f.workers.length,2);assert.equal(fs.existsSync(f.service.store.output(job)),false);}finally{child.exitCode=0;child.emit('exit',0);await f.cleanup();}});
function fixture({exportGate,holdExit=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cad-mesh-lifecycle-")),workers=[],calls=[];
  const views=new Map(),view=id=>{if(!views.has(id))views.set(id,{ok:true,documentId:id,revision:2,bodyCount:1,bodyMetadata:[{bodyId:"body-1",kind:"solid",bodyIdentity:"a".repeat(32),topologyIdentity:"b".repeat(32),topologyRevision:2,volume:10,centroid:[0,0,0]}]});return views.get(id);};
  const options={dataDir:root,serializeDocument:async(_id,action)=>action(),command:async(operation,fields)=>{
    calls.push({operation,documentId:fields.documentId});const current=view(fields.documentId);
    if(operation==="document.summary")return structuredClone(current);
    if(exportGate)await exportGate.promise;
    fs.writeFileSync(fields.parameters.path,"BREP fixture");fs.writeFileSync(fields.parameters.manifestPath,JSON.stringify({...current,format:"brep",bodies:current.bodyMetadata}));return {ok:true};
  },worker:{close(){throw new Error("The unrelated shared file-tool worker must not be closed");}},workerFactory:()=>{
    const work=deferred(),exit=deferred();const client={work,exit,stops:0,command:null,
      request(command){this.command=command;return work.promise;},
      async closeAndWait(){this.stops++;work.reject(new Error("Dedicated worker stopped"));if(holdExit&&workers[0]===this)await exit.promise;},
      finish(){fs.mkdirSync(path.dirname(this.command.parameters.outputPath),{recursive:true});fs.writeFileSync(this.command.parameters.outputPath,"MSH fixture");work.resolve({ok:true,requestId:this.command.requestId,mesh:{dimension:3,nodeCount:4,elementCount:1,outputPath:this.command.parameters.outputPath,render:{kind:"wire",positions:[],groups:[{kind:"solid",bodyId:"body-1",groupId:"solid-1",wirePositions:[0,0,0,1,1,1]}]}}});}};
    workers.push(client);return client;
  }};
  const service=new ProjectMeshService(options);
  const cleanup=async()=>{exportGate?.resolve();for(const worker of workers)worker.exit.resolve();await service.closeAndWait();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});};
  return {root,workers,calls,view,options,service,cleanup};
}

async function uncertainWorker(f,id='background',count=1){const accepted=await f.service.create(id,{background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId);await until(()=>f.workers[0]?.command);const children=Array.from({length:count},(_,index)=>Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,pid:123+index}));f.workers[0].children=new Set(children);f.workers[0].closeAndWait=async()=>{throw Object.assign(Error('injected observation timeout'),{code:'MESH_WORKER_STOP_TIMEOUT'});};f.workers[0].finish();await until(()=>job.state==='cancelling'&&job.stopUnconfirmed);return {job,children};}
const exitChild=child=>{child.exitCode=0;child.emit('exit',0);};

test('disk reservations remain held across unknown exit and release only after confirmed retirement',async()=>{const f=fixture();let held=0,children=[];f.service.storageBudget={reserve:async()=>{held++;let released=false;return {bytes:65536,verify:async()=>{},release:()=>{if(!released){released=true;held--;}}};}};try{const uncertain=await uncertainWorker(f);children=uncertain.children;assert.equal(held,1);await f.service.reconcileWorkerStops();assert.equal(held,1);exitChild(children[0]);await until(()=>uncertain.job.state==='interrupted');assert.equal(held,0);}finally{children.forEach(exitChild);await f.service.handle('GET','/api/documents/background/mesh/jobs');await f.cleanup();}});

test('a late native exit resumes the original queue without any browser or status request',async()=>{const f=fixture();let children=[];try{const uncertain=await uncertainWorker(f);children=uncertain.children;const queued=await f.service.create('queued',{background:true}),next=f.service.jobs.get(queued.payload.meshJob.jobId);await until(()=>next.state==='queued');assert.equal(f.workers.length,1);exitChild(children[0]);await until(()=>uncertain.job.state==='interrupted');await until(()=>f.workers[1]?.command);assert.equal(f.workers.length,2);assert.equal(fs.existsSync(f.service.store.output(uncertain.job)),false);}finally{children.forEach(exitChild);await f.service.handle('GET','/api/documents/background/mesh/jobs');await f.cleanup();}});

test('every exact captured child must exit; a sibling exit cannot release an uncertain mesh slot',async()=>{const f=fixture();let children=[];try{const uncertain=await uncertainWorker(f,'background',2);children=uncertain.children;exitChild(children[0]);await new Promise(resolve=>setImmediate(resolve));assert.equal(uncertain.job.state,'cancelling');assert.equal(uncertain.job.stopUnconfirmed,true);exitChild(children[1]);await until(()=>uncertain.job.state==='interrupted');assert.equal(uncertain.job.stopUnconfirmed,false);}finally{children.forEach(exitChild);await f.service.handle('GET','/api/documents/background/mesh/jobs');await f.cleanup();}});

test('shutdown waits for a live late-exit observation and cannot start queued work afterward',async()=>{const f=fixture();let children=[],closing;try{const uncertain=await uncertainWorker(f);children=uncertain.children;const queued=await f.service.create('queued',{background:true}),next=f.service.jobs.get(queued.payload.meshJob.jobId);await until(()=>next.state==='queued');let closed=false;closing=f.service.closeAndWait().then(()=>{closed=true;});closing.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);exitChild(children[0]);await closing;assert.equal(uncertain.job.state,'interrupted');assert.equal(next.state,'interrupted');assert.equal(f.workers.length,1);}finally{children.forEach(exitChild);await f.service.handle('GET','/api/documents/background/mesh/jobs');await closing?.catch(()=>{});await f.cleanup();}});

test("queued cancellation never starts a worker; running cancellation waits for its own process exit",async()=>{
  const f=fixture({holdExit:true});
  try {
    const first=await f.service.create("first",{background:true});assert.equal(first.status,202);
    await until(()=>f.workers[0]?.command);const a=f.service.jobs.get(first.payload.meshJob.jobId);
    const duplicate=await f.service.create("first",{background:true});assert.equal(duplicate.payload.code,"MESH_JOB_ALREADY_RUNNING");
    const second=await f.service.create("second",{background:true});const b=f.service.jobs.get(second.payload.meshJob.jobId);await until(()=>b.state==="queued");
    const cancelledQueue=await f.service.cancel(b);assert.equal(cancelledQueue.payload.meshJob.state,"cancelled");assert.equal(f.workers.length,1);assert.equal(f.workers[0].stops,0);
    const third=await f.service.create("third",{background:true});const c=f.service.jobs.get(third.payload.meshJob.jobId);await until(()=>c.state==="queued");
    let finished=false;const cancellation=f.service.cancel(a).then(value=>{finished=true;return value;});
    await until(()=>f.workers[0].stops>0);assert.equal(a.state,"cancelling");assert.equal(finished,false);assert.equal(f.workers.length,1);
    const repeated=await f.service.cancel(a);assert.equal(repeated.status,202);assert.equal(repeated.payload.meshJob.state,"cancelling");assert.equal(f.workers[0].stops,1);assert.equal(finished,false);
    f.workers[0].exit.resolve();assert.equal((await cancellation).payload.meshJob.state,"cancelled");
    await until(()=>f.workers[1]?.command);f.workers[1].finish();assert.equal((await c.completion).status,200);
    assert.equal(c.state,"complete");assert.equal(fs.existsSync(f.service.store.output(a)),false);assert.equal(fs.existsSync(f.service.store.output(b)),false);
    assert.equal(f.workers.length,2);assert.deepEqual(fs.readdirSync(path.join(f.root,"mesh-sources")),[]);
  } finally {await f.cleanup();}
});

test("cancelling a BREP preparation is cooperative and never kills the CAD worker",async()=>{
  const gate=deferred(),f=fixture({exportGate:gate});
  try {
    const accepted=await f.service.create("preparing",{background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId);
    await until(()=>f.calls.some(call=>call.operation==="mesh.prepare"));
    const cancelled=await f.service.cancel(job);assert.equal(cancelled.status,202);assert.equal(job.state,"cancelling");assert.equal(f.workers.length,0);
    gate.resolve();await job.completion;assert.equal(job.state,"cancelled");assert.equal(f.workers.length,0);
    assert.deepEqual(fs.readdirSync(path.join(f.root,"mesh-sources")),[]);
  } finally {await f.cleanup();}
});

test('service close waits for preparation and never publishes a late preview or launches a queued worker',async()=>{
  const gate=deferred(),f=fixture({exportGate:gate});
  try{const accepted=await f.service.create('preparing-stop',{background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId);await until(()=>f.calls.some(call=>call.operation==='mesh.prepare'));let finished=false;const closed=f.service.closeAndWait().then(()=>finished=true);assert.equal(job.state,'cancelling');assert.equal(finished,false);gate.resolve();await closed;assert.equal(job.state,'interrupted');assert.equal(f.workers.length,0);assert.equal(fs.existsSync(path.join(f.service.store.directory(job),'result.json')),false);}
  finally{await f.cleanup();}
});
test('service close does not mark a running worker interrupted before its exit barrier',async()=>{
  const f=fixture({holdExit:true});
  try{const accepted=await f.service.create('running-stop',{background:true});await until(()=>f.workers[0]?.command);const job=f.service.jobs.get(accepted.payload.meshJob.jobId);let finished=false;const closed=f.service.closeAndWait().then(()=>finished=true);await until(()=>f.workers[0].stops>0);assert.equal(job.state,'cancelling');assert.equal(finished,false);assert.equal(JSON.parse(fs.readFileSync(path.join(f.service.store.directory(job),'metadata.json'))).state,'cancelling');f.workers[0].exit.resolve();await closed;assert.equal(job.state,'interrupted');assert.equal(finished,true);}
  finally{await f.cleanup();}
});

test("cancelling a diagnostic preview publishes no report or BREP artifact and never starts Gmsh",async()=>{
  const gate=deferred(),f=fixture({exportGate:gate});
  try{
    const accepted=await f.service.create("preview_cancel",{kind:"preparation",background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId);
    await until(()=>f.calls.some(call=>call.operation==="mesh.prepare"));assert.equal(job.kind,"preparation");assert.equal(job.source.bodies.length,1);
    assert.equal((await f.service.cancel(job)).status,202);gate.resolve();await job.completion;
    assert.equal(job.state,"cancelled");assert.equal(f.workers.length,0);assert.equal(fs.existsSync(path.join(f.service.store.directory(job),"result.json")),false);assert.equal(fs.existsSync(f.service.store.preparedBrep(job)),false);
    const recovered=new ProjectMeshService(f.options);await recovered.ready;assert.equal(recovered.jobs.get(job.jobId).state,"cancelled");await recovered.close();
  }finally{await f.cleanup();}
});

test("using a prepared snapshot passes the sealed BREP bytes to Gmsh without running native preparation again",async()=>{
  const f=fixture(),command=f.service.command;let preparations=0;
  f.service.command=async(operation,fields)=>{const result=await command(operation,fields);if(operation!=="mesh.prepare")return result;preparations++;return {...result,...diagnosticFixture(captureMeshSource(f.view(fields.documentId),fields.documentId))};};
  try{
    const ready=await f.service.create("exact_reuse",{kind:"preparation",deepCheck:false});assert.equal(ready.status,200,JSON.stringify(ready));
    const preview=f.service.jobs.get(ready.payload.meshJob.jobId),bytes=fs.readFileSync(f.service.store.preparedBrep(preview));
    const accepted=await f.service.create("exact_reuse",{preparationJobId:preview.jobId,background:true});assert.equal(accepted.status,202);
    const job=f.service.jobs.get(accepted.payload.meshJob.jobId);await until(()=>f.workers[0]?.command);
    assert.equal(preparations,1);assert.deepEqual(fs.readFileSync(f.workers[0].command.parameters.inputPath),bytes);
    f.workers[0].finish();const completed=await job.completion;assert.equal(completed.status,200);assert.equal(completed.payload.meshJob.preparationJobId,preview.jobId);
  }finally{await f.cleanup();}
});

test('source-file verification waits outside the live CAD queue and cooperative cancellation starts no mesh worker',async()=>{
  const f=fixture(),lease=await f.service.computeGate.acquire({kind:'quality'});let inDocumentQueue=false;
  f.service.serializeDocument=async(_id,action)=>{assert.equal(inDocumentQueue,false);inDocumentQueue=true;try{return await action();}finally{inDocumentQueue=false;}};
  try{
    const accepted=await f.service.create('source_wait',{background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId);
    await until(()=>f.service.computeGate.status().waiting===1);
    assert.equal(inDocumentQueue,false,'disk work must not block edits on the live CAD document');
    assert.equal((await f.service.live('source_wait')).ok,true);
    const completion=job.completion;await f.service.cancel(job);await completion;
    assert.equal(job.state,'cancelled');assert.equal(f.workers.length,0);
    assert.equal(f.service.computeGate.status().active,'quality');
    assert.deepEqual(fs.readdirSync(path.join(f.root,'mesh-sources')),[]);
  }finally{lease.release();await f.cleanup();}
});

test('geometry edits while snapshot I/O waits produce a hidden stale result rather than relabelling the exported source',async()=>{
  const f=fixture(),lease=await f.service.computeGate.acquire({kind:'quality'});
  try{
    const accepted=await f.service.create('prepare_edit',{background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId),completion=job.completion;
    await until(()=>f.service.computeGate.status().waiting===1);
    const exportedIdentity=job.source.bodies[0].topologyIdentity;
    f.view('prepare_edit').revision++;f.view('prepare_edit').bodyMetadata[0].topologyIdentity='c'.repeat(32);
    lease.release();await until(()=>f.workers[0]?.command);f.workers[0].finish();
    const done=await completion;assert.equal(done.status,200);assert.equal(done.payload.meshJob.freshness.status,'stale');assert.equal(done.payload.meshJob.visible,false);
    assert.equal(done.payload.meshJob.source.bodies[0].topologyIdentity,exportedIdentity);
    assert.equal((await f.service.handle('POST',`/api/mesh/jobs/${job.jobId}/visibility`,{visible:true})).payload.code,'MESH_SOURCE_STALE');
  }finally{lease.release();await f.cleanup();}
});

test('deleting a preview cancels a queued reuse for either owner and never starts Gmsh with partial copied inputs',async()=>{
  const f=fixture(),command=f.service.command;let lease;
  f.service.command=async(operation,fields)=>{const result=await command(operation,fields);return operation==='mesh.prepare'?{...result,...diagnosticFixture(captureMeshSource(f.view(fields.documentId),fields.documentId))}:result;};
  try{
    const ready=await f.service.create('preview_delete',{kind:'preparation',deepCheck:false});assert.equal(ready.status,200,JSON.stringify(ready));
    const preview=f.service.jobs.get(ready.payload.meshJob.jobId);lease=await f.service.computeGate.acquire({kind:'quality'});
    const accepted=await f.service.create('preview_delete',{preparationJobId:preview.jobId,background:true}),job=f.service.jobs.get(accepted.payload.meshJob.jobId),completion=job.completion;
    await until(()=>f.service.computeGate.status().waiting===1);
    const deleting=f.service.handle('DELETE',`/api/mesh/jobs/${preview.jobId}`);
    const failed=await completion;assert.equal(failed.payload.code,'MESH_ARTIFACT_CANCELLED');assert.equal(job.state,'failed');
    assert.equal(f.workers.length,0);assert.equal(fs.existsSync(f.service.sourcePaths(job).sourcePath),false);
    lease.release();assert.equal((await deleting).status,200);assert.equal(f.service.jobs.has(preview.jobId),false);
  }finally{lease?.release();await f.cleanup();}
});

test("completed mesh artifacts survive service reconstruction, remain hidden and reject corrupt MSH",async()=>{
  const f=fixture();
  try {
    const accepted=await f.service.create("saved",{background:true});await until(()=>f.workers[0]?.command);f.workers[0].finish();
    const done=await f.service.jobs.get(accepted.payload.meshJob.jobId).completion,key=done.payload.meshJob.jobId;
    await f.service.handle("POST",`/api/mesh/jobs/${key}/visibility`,{visible:true});
    const restored=new ProjectMeshService(f.options);assert.equal(f.workers.length,1);
    const result=await restored.handle("GET",`/api/mesh/jobs/${key}`);assert.equal(result.payload.meshJob.state,"complete");assert.equal(result.payload.meshJob.visible,false);assert.equal(result.payload.meshJob.freshness.status,"current");assert.equal(result.payload.meshJob.recovered,true);
    assert.equal(result.payload.mesh.render.groups[0].bodyIdentity,"a".repeat(32));
    f.view("saved").bodyMetadata[0].topologyIdentity="c".repeat(32);
    assert.equal((await restored.handle("GET",`/api/mesh/jobs/${key}`)).payload.meshJob.freshness.status,"stale");
    fs.appendFileSync(restored.store.output(restored.jobs.get(key)),"damage");
    const invalid=await restored.handle("GET",`/api/mesh/jobs/${key}`);assert.equal(invalid.status,409);assert.equal(invalid.payload.code,"MESH_ARTIFACT_INVALID");assert.equal(invalid.payload.meshJob.state,"failed");
    assert.equal(fs.existsSync(restored.store.output(restored.jobs.get(key))),true,"Damaged artifact must remain available for diagnosis");
    assert.equal(f.workers.length,1,"Recovery and integrity failures must never remesh automatically");
  } finally {await f.cleanup();}
});

test("crash recovery interrupts every unfinished state without replaying queued work",async()=>{
  const f=fixture();let recovered;
  try {
    // The production data-directory owner allows one recovery writer. Finish
    // the initial empty recovery and stop it before staging crash materials.
    await f.service.ready;assert.equal(f.service.catalogStatus().state,'ready');await f.service.closeAndWait();
    const store=new MeshJobStore(f.root);
    for(const state of ["preparing","queued","running","cancelling"])store.save({jobId:"mesh-"+crypto.randomUUID(),documentId:"crashed",state,createdAt:new Date().toISOString()});
    recovered=new ProjectMeshService(f.options);await recovered.ready;assert.equal(recovered.catalogStatus().state,'ready');
    assert.equal(recovered.jobs.size,4);assert.equal(f.workers.length,0);assert.equal(f.calls.length,0);
    for(const job of recovered.jobs.values()){assert.equal(job.state,"interrupted");assert.equal(job.errorCode,"MESH_SERVICE_INTERRUPTED");assert.equal(JSON.parse(fs.readFileSync(path.join(store.directory(job),"metadata.json"))).state,"interrupted");}
  } finally {await recovered?.closeAndWait();await f.cleanup();}
});

test("corrupt metadata remains visible in its real project and original evidence is preserved",async()=>{
  const f=fixture();let restored;
  try {
    await f.service.ready;assert.equal(f.service.catalogStatus().state,'ready');await f.service.closeAndWait();
    const record={jobId:"mesh-"+crypto.randomUUID(),documentId:"damaged",state:"queued",createdAt:new Date().toISOString()};
    f.service.store.save(record);const file=path.join(f.service.store.directory(record),"metadata.json");fs.writeFileSync(file,"damaged JSON");
    restored=new ProjectMeshService(f.options);await restored.ready;assert.equal(restored.catalogStatus().state,'ready');const job=restored.jobs.get(record.jobId);
    assert.equal(job.documentId,"damaged");assert.equal(job.state,"failed");assert.equal(job.errorCode,"MESH_METADATA_CORRUPT");assert.equal(fs.readFileSync(file,"utf8"),"damaged JSON");
    const list=await restored.handle("GET","/api/documents/damaged/mesh/jobs");assert.equal(list.payload.jobs.length,1);
    await restored.handle("DELETE",`/api/mesh/jobs/${job.jobId}`);assert.equal(restored.jobs.size,0);assert.equal(fs.existsSync(file),false);
  } finally {await restored?.closeAndWait();await f.cleanup();}
});

test("result JSON checksum and managed artifact paths are enforced",async()=>{
  const f=fixture();
  try {
    const accepted=await f.service.create("checksum",{background:true});await until(()=>f.workers[0]?.command);f.workers[0].finish();
    const job=f.service.jobs.get(accepted.payload.meshJob.jobId);await job.completion;
    const file=path.join(f.service.store.directory(job),"result.json");fs.appendFileSync(file," ");
    assert.throws(()=>f.service.store.readResult(job),/校验失败/);
    assert.throws(()=>f.service.store.directory({documentId:"../escape",jobId:job.jobId}),/身份不合法/);
    assert.throws(()=>f.service.store.directory({documentId:"checksum",jobId:"../../escape"}),/身份不合法/);
  } finally {await f.cleanup();}
});

test("schema-damaged task metadata cannot break project task lists or render arbitrary objects",async()=>{
  const f=fixture();
  try {
    for(const damage of [{createdAt:{}},{error:{message:"not text"}},{options:{repairMode:"unknown",qualityThreshold:0.2}},{source:{version:1,documentId:"other",revision:2,bodies:[]}}]) {
      const job={version:1,jobId:"mesh-"+crypto.randomUUID(),documentId:"schema",state:"failed",createdAt:new Date().toISOString(),...damage};
      const directory=f.service.store.directory(job);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,"metadata.json"),JSON.stringify(job));
    }
    const restored=new ProjectMeshService(f.options);await restored.ready;const list=await restored.handle("GET","/api/documents/schema/mesh/jobs");
    assert.equal(list.status,200);assert.equal(list.payload.jobs.length,4);
    for(const job of list.payload.jobs){assert.equal(job.state,"failed");assert.equal(job.errorCode,"MESH_METADATA_CORRUPT");assert.equal(typeof job.error,"string");}
    assert.equal(f.workers.length,0);
  } finally {await f.cleanup();}
});
