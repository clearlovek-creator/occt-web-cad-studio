import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
import {ProjectMeshService} from '../gateway/project-mesh-service.mjs';
const deferred=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve:()=>resolve()};};
async function fixture(t,{hold=false,readError}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-recovery-')),store=new MeshJobStore(root),gate=deferred(),view={ok:true,documentId:'doc',revision:1,bodyCount:1,bodyMetadata:[{bodyId:'body-1',kind:'solid',bodyIdentity:'a'.repeat(32),topologyIdentity:'b'.repeat(32),topologyRevision:1}]};
  const job={jobId:'mesh-00000000-0000-4000-8000-000000000001',documentId:'doc',kind:'mesh',state:'failed',source:{version:1,documentId:'doc',revision:1,bodies:view.bodyMetadata},createdAt:'2026-11-17T00:00:00.000Z',startedAt:'2026-11-17T00:00:01.000Z',finishedAt:'2026-11-17T00:00:02.000Z',options:{repairMode:'conservative',qualityThreshold:0.2},errorCode:'MESH_COMPLETION_UNCOMMITTED',error:'Completion was not committed',artifact:{result:{bytes:2,sha256:crypto.createHash('sha256').update('{}').digest('hex')}},meshSummary:{dimension:3,nodeCount:4,elementCount:1}};
  store.save(job);fs.writeFileSync(path.join(store.directory(job),'result.json'),'{}');let reads=0,native=0;
  const artifacts={admissionMemo:{dropJob(){}},async execute({operation}){if(operation==='recover-catalog')return store.loadCatalog();assert.equal(operation,'read');reads++;if(hold)await gate.promise;if(readError)throw Object.assign(Error('SECRET private file path'),{code:readError});return {ok:true,requestId:job.jobId,mesh:{dimension:3,nodeCount:4,elementCount:1,admission:{version:1,status:'accepted',usable:true}}};},async close(){gate.resolve();},async cancelJob(){}};
  const options={dataDir:root,artifactPool:artifacts,serializeDocument:async(_id,action)=>action(),command:async operation=>{if(operation!=='document.summary')native++;assert.equal(operation,'document.summary');return view;}},service=new ProjectMeshService(options);await service.ready;
  t.after(async()=>{gate.resolve();await service.closeAndWait();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-mesh-recovery-/);fs.rmSync(root,{recursive:true,force:true});});
  const route='/api/mesh/jobs/'+job.jobId+'/recover-completion',descriptor=()=>service.descriptor(service.jobs.get(job.jobId),view),request=()=>({requestId:crypto.randomUUID(),failedStateToken:descriptor().completionRecovery.failedStateToken});
  return {root,store,job,service,options,gate,descriptor,request,route,get reads(){return reads;},get native(){return native;}};
}
async function settled(f){await Promise.all([...f.service.recoveryTasks]);return f.descriptor();}

test('explicit recovery revalidates retained results, publishes once and never executes a modeling or meshing command',async t=>{
  const f=await fixture(t);assert.equal(f.descriptor().completionRecovery.state,'available');const input=f.request(),accepted=await f.service.handle('POST',f.route,input);assert.equal(accepted.status,202);const done=await settled(f);assert.equal(done.state,'complete');assert.equal(done.visible,false);assert.equal(done.completionRecovery.state,'complete');assert.equal(f.reads,1);assert.equal(f.native,0);assert.equal(JSON.parse(fs.readFileSync(path.join(f.store.directory(f.job),'completion.json'))).basis,'revalidated-retained-artifacts-v1');assert.equal((await f.service.handle('POST',f.route,input)).status,200);assert.equal(f.reads,1);
});
test('duplicate accepted requests share the exact check and a pending recovery blocks deletion',async t=>{
  const f=await fixture(t,{hold:true}),input=f.request();assert.equal((await f.service.handle('POST',f.route,input)).status,202);assert.equal((await f.service.handle('POST',f.route,input)).status,202);assert.equal((await f.service.handle('POST',f.route,{...input,requestId:crypto.randomUUID()})).status,409);assert.equal((await f.service.handle('DELETE',f.route.replace('/recover-completion',''))).status,409);assert.equal(f.reads,1);f.gate.resolve();assert.equal((await settled(f)).state,'complete');
});
test('invalid, stale and expanded recovery requests perform no artifact read or mutation',async t=>{
  const f=await fixture(t),file=path.join(f.store.directory(f.job),'metadata.json'),before=fs.readFileSync(file),input=f.request();for(const body of [{},{...input,failedStateToken:'0'.repeat(64)},{...input,options:{}},{...input,requestId:'bad'}])assert.ok([400,409].includes((await f.service.handle('POST',f.route,body)).status));assert.equal(f.reads,0);assert.deepEqual(fs.readFileSync(file),before);
});
test('changed metadata during validation cannot be overwritten by an old recovery result',async t=>{
  const f=await fixture(t,{hold:true}),input=f.request(),file=path.join(f.store.directory(f.job),'metadata.json');await f.service.handle('POST',f.route,input);const changed=JSON.stringify({...JSON.parse(fs.readFileSync(file)),error:'Changed independently'});fs.writeFileSync(file,changed);f.gate.resolve();const done=await settled(f);assert.equal(done.state,'failed');assert.equal(done.completionRecovery.state,'failed');assert.equal(fs.readFileSync(file,'utf8'),changed);assert.equal(fs.existsSync(path.join(f.store.directory(f.job),'completion.json')),false);
});
test('artifact validation failure preserves the original failed record and does not leak private paths',async t=>{
  const f=await fixture(t,{readError:'MESH_ARTIFACT_INVALID'}),input=f.request(),file=path.join(f.store.directory(f.job),'metadata.json'),before=fs.readFileSync(file);await f.service.handle('POST',f.route,input);const done=await settled(f);assert.equal(done.state,'failed');assert.equal(done.completionRecovery.state,'failed');assert.doesNotMatch(JSON.stringify(done.completionRecovery),/SECRET|cad-mesh-recovery-/);assert.deepEqual(fs.readFileSync(file),before);assert.equal((await f.service.handle('POST',f.route,input)).status,409);assert.equal(f.reads,1);
});
test('shutdown fences a late successful validation instead of publishing a completion receipt',async t=>{
  const f=await fixture(t,{hold:true});await f.service.handle('POST',f.route,f.request());await f.service.closeAndWait();assert.equal(fs.existsSync(path.join(f.store.directory(f.job),'completion.json')),false);assert.equal(f.service.jobs.get(f.job.jobId).state,'failed');
});
test('recovery publication observes current disk capacity without reserving a new meshing job',async t=>{
  const f=await fixture(t),file=path.join(f.store.directory(f.job),'metadata.json'),before=fs.readFileSync(file);let checked=0;f.service.storageBudget={async verifyPublication(bytes){checked++;assert.ok(bytes>0);throw Object.assign(Error('Capacity'),{code:'MESH_STORAGE_CAPACITY'});}};await f.service.handle('POST',f.route,f.request());const done=await settled(f);assert.equal(checked,1);assert.equal(done.state,'failed');assert.equal(done.completionRecovery.code,'MESH_STORAGE_CAPACITY');assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(path.join(f.store.directory(f.job),'completion.json')),false);
});
test('a revalidated recovery receipt survives restart even when the old failed metadata cannot be replaced',async t=>{
  const f=await fixture(t),file=path.join(f.store.directory(f.job),'metadata.json'),before=fs.readFileSync(file),rename=fs.renameSync,input=f.request();t.mock.method(fs,'renameSync',(source,target)=>{if(target===file)throw Object.assign(Error('Private denied metadata'),{code:'EPERM'});return rename(source,target);});await f.service.handle('POST',f.route,input);const done=await settled(f);assert.equal(done.state,'complete');assert.deepEqual(fs.readFileSync(file),before);await f.service.closeAndWait();const restored=new ProjectMeshService(f.options);try{await restored.ready;const job=restored.jobs.get(f.job.jobId);assert.equal(job.state,'complete');assert.equal(restored.descriptor(job,null).completionRecovery.requestId,input.requestId);assert.equal((await restored.handle('POST',f.route,input)).status,200);assert.equal(f.reads,1);}finally{await restored.closeAndWait();}
});
