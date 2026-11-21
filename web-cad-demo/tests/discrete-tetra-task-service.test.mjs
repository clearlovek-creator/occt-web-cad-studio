import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ProjectMeshService} from '../gateway/project-mesh-service.mjs';
import {DiscreteTetraTaskClient} from '../gateway/discrete-tetra-task-client.mjs';
import {capabilitySnapshot} from '../gateway/worker-capabilities.mjs';
import {DISCRETE_SOURCE,DISCRETE_SOURCE_CAPABILITY} from '../shared/discrete-surface-source.mjs';
import {cadDiscreteTetraFixture} from './helpers/cad-discrete-tetra-fixture.mjs';
import {tetraResult} from './helpers/discrete-tetra-fixture.mjs';
import {discreteTetraFailure} from '../gateway/discrete-tetra-protocol.mjs';
import {denyWindowsFileRead} from './helpers/windows-file-sharing.mjs';
const request={kind:'discrete-tetra'},tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,options={}){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-tetra-service-')),f=cadDiscreteTetraFixture(options),events=[];let exports=0,factories=0;
  const config={dataDir:data,serializeDocument:async(_id,action)=>action(),getCapabilities:()=>capabilitySnapshot(f.binding.workerInstance,true,{[DISCRETE_SOURCE_CAPABILITY]:DISCRETE_SOURCE}),command:async(operation)=>{if(operation==='document.summary')return structuredClone(f.view);assert.equal(operation,'mesh.discrete.export');exports++;await options.holdCapture?.();return {ok:true,protocolVersion:1,documentId:'doc',revision:1,discreteSurface:structuredClone(f.bundle)};},workerFactory:()=>{throw Error('Ordinary Gmsh route must not run');},...!options.unconfigured&&{discreteTetraWorkerFactory:()=>{factories++;return new DiscreteTetraTaskClient({partitionClient:{children:new Set(),partition:async(input,{signal})=>{events.push('partition');if(options.partition)return options.partition({f,signal,input});return structuredClone(f.domain);},closeAndWait:async()=>events.push('close-partition')},tetraClient:{children:new Set(),tetrahedralize:async(input,{signal})=>{events.push('tetra');if(options.tetra)return options.tetra({f,signal,input});return structuredClone(f.output);},closeAndWait:async()=>events.push('close-tetra')}});}}};
  const service=new ProjectMeshService(config);await service.ready;t.after(async()=>{options.release?.();await service.closeAndWait();assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-tetra-service-/);fs.rmSync(data,{recursive:true,force:true});});return {f,config,service,data,events,get exports(){return exports;},get factories(){return factories;}};
}

test('durable tetra uses shared task store, preserves stage artifacts and returns a bounded hidden result',async t=>{
  const f=await fixture(t),reply=await f.service.create('doc',request);assert.equal(reply.status,200,JSON.stringify(reply));const job=f.service.jobs.get(reply.payload.meshJob.jobId);assert.equal(job.state,'complete');assert.equal(job.discreteStage,'complete');assert.equal(reply.payload.discreteTetraSummary.tetraCount,6);assert.equal(reply.payload.mesh,undefined);assert.equal(reply.payload.meshJob.visible,false);assert.equal(job.snapshot,undefined);assert.equal(job.client,null);assert.deepEqual(f.events,['partition','tetra','close-partition','close-tetra']);assert.equal(f.exports,1);
  for(const kind of ['discreteSource','partition'])assert.ok(fs.existsSync(f.service.store.tetraFile(job,kind)));assert.ok(fs.existsSync(path.join(f.service.store.directory(job),'completion.json')));
});

test('completed tetra reopens without engines and is revalidated without source export or replay',async t=>{
  const f=await fixture(t),reply=await f.service.create('doc',request);await f.service.closeAndWait();const restored=new ProjectMeshService({...f.config,discreteTetraWorkerFactory:undefined});try{await restored.ready;const r=await restored.handle('GET','/api/mesh/jobs/'+reply.payload.meshJob.jobId);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.payload.discreteTetraSummary.tetraCount,6);assert.equal(r.payload.meshJob.visible,false);assert.equal(f.factories,1);assert.equal(f.exports,1);}finally{await restored.closeAndWait();}
});

test('material conflict becomes a durable failure before tetra starts and survives reopen',async t=>{
  const f=await fixture(t,{materials:['Copper','Steel']}),reply=await f.service.create('doc',request);assert.equal(reply.payload.code,'MESH_MATERIAL_CONFLICT');assert.equal(f.events.includes('tetra'),false);const job=f.service.jobs.get(reply.payload.meshJob.jobId);assert.equal(job.state,'failed');assert.equal(job.discreteFailureSummary.conflictCellCount,1);assert.ok(fs.existsSync(f.service.store.tetraFile(job,'discreteFailure')));assert.equal((await f.service.handle('GET','/api/mesh/jobs/'+job.jobId)).payload.discreteFailureSummary.code,'MESH_MATERIAL_CONFLICT');
});

test('strict quality refusal persists original bounded quality and process-exit evidence',async t=>{
  const quality={version:1,mode:'strict',threshold:.9,maxBadFraction:0},f=await fixture(t,{tetra:({f,input})=>{const generated=tetraResult('rejected',quality),error=discreteTetraFailure({ok:false,operation:'mesh.discrete-tetra',code:'MESH_QUALITY_REJECTED',error:'Requested quality failed.',quality:generated.quality,optimization:generated.optimization},input);throw Object.assign(error,{execution:{basis:'single-process-exit-confirmed-v1',exitCode:2,automaticReplay:false},processResources:f.output.processResources,algorithm:f.output.algorithm});}});
  const reply=await f.service.create('doc',{...request,discreteTetra:{quality}});assert.equal(reply.payload.code,'MESH_QUALITY_REJECTED',JSON.stringify(reply));const job=f.service.jobs.get(reply.payload.meshJob.jobId);assert.equal(job.discreteFailureSummary.lowQualityCount,6);const raw=JSON.parse(fs.readFileSync(f.service.store.tetraFile(job,'discreteFailure')));assert.equal(raw.execution.exitCode,2);assert.equal(raw.processResources.enforced,true);assert.equal((await f.service.handle('GET','/api/mesh/jobs/'+job.jobId)).payload.discreteFailureSummary.code,'MESH_QUALITY_REJECTED');
});

test('ordinary render, boundary, quality and download paths cannot admit an unconverted discrete result',async t=>{
  const f=await fixture(t),r=await f.service.create('doc',request),id=r.payload.meshJob.jobId;for(const suffix of ['render','boundary','quality','visibility'])assert.equal((await f.service.handle(suffix==='visibility'?'POST':'GET',`/api/mesh/jobs/${id}/${suffix}`,{visible:true})).payload.code,'MESH_DISCRETE_ADMISSION_REQUIRED');assert.equal((await f.service.outputAccess(id+'.msh')).payload.code,'MESH_DISCRETE_ADMISSION_REQUIRED');
});

test('material-only edits mark the recorded result stale without altering its captured source',async t=>{
  const f=await fixture(t),r=await f.service.create('doc',request),id=r.payload.meshJob.jobId;f.f.view.bodyMetadata[0].material='Steel';const read=await f.service.handle('GET','/api/mesh/jobs/'+id);assert.equal(read.payload.meshJob.freshness.status,'stale');assert.equal(f.service.store.readTetraSource(f.service.jobs.get(id)).materials.bodies[0].material,'Copper');
});

test('queued source corruption prevents either native stage, preserving original artifacts',async t=>{
  const f=await fixture(t);f.service.maxConcurrent=0;const r=await f.service.create('doc',{...request,background:true}),job=f.service.jobs.get(r.payload.meshJob.jobId);await job.preparation;assert.equal(job.state,'queued');assert.equal(job.snapshot,undefined);fs.appendFileSync(f.service.store.tetraFile(job,'discreteSource'),' ');const done=job.completion;f.service.maxConcurrent=1;f.service.pump();await done;assert.equal(job.errorCode,'MESH_ARTIFACT_INVALID');assert.equal(f.events.includes('partition'),false);
});

test('cancel between stages cannot start a replacement tetra process or publish completion',async t=>{
  let entered;const started=new Promise(resolve=>entered=resolve),f=await fixture(t,{partition:({signal})=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{code:'MESH_CANCELLED'})),{once:true}));}}),r=await f.service.create('doc',{...request,background:true});await started;const id=r.payload.meshJob.jobId,cancel=await f.service.handle('POST','/api/mesh/jobs/'+id+'/cancel');assert.equal(cancel.payload.meshJob.state,'cancelled');assert.equal(f.events.includes('tetra'),false);assert.equal(f.factories,1);assert.equal(fs.existsSync(path.join(f.service.store.directory(f.service.jobs.get(id)),'completion.json')),false);
});

test('temporary real file locks preserve completion state and allow an explicit reread without recomputation',async t=>{
  const f=await fixture(t),r=await f.service.create('doc',request),id=r.payload.meshJob.jobId,job=f.service.jobs.get(id),before=fs.readFileSync(path.join(f.service.store.directory(job),'metadata.json'));
  for(const kind of ['discreteSource','partition']){const held=await denyWindowsFileRead(f.service.store.tetraFile(job,kind));try{const read=await f.service.handle('GET','/api/mesh/jobs/'+id);assert.equal(read.payload.code,'MESH_ARTIFACT_IO');assert.equal(job.state,'complete');assert.deepEqual(fs.readFileSync(path.join(f.service.store.directory(job),'metadata.json')),before);}finally{await held.release();}assert.equal((await f.service.handle('GET','/api/mesh/jobs/'+id)).status,200);}assert.equal(f.factories,1);
});

test('unconfigured, expanded and under-reserved requests never export or start native stages',async t=>{
  const missing=await fixture(t,{unconfigured:true});assert.equal((await missing.service.create('doc',request)).payload.code,'MESH_DISCRETE_WORKER_UNAVAILABLE');const f=await fixture(t);for(const value of [{...request,selection:{kind:'all'}},{...request,inputPath:'private'},{...request,discreteTetra:{materialPolicy:'first'}}])assert.equal((await f.service.create('doc',value)).status,400);
  let released=false;f.service.storageBudget={reserve:async()=>({bytes:1024,release(){released=true;}})};assert.equal((await f.service.create('doc',request)).payload.code,'MESH_STORAGE_TASK_RESERVATION');assert.equal(released,true);assert.equal(f.exports,0);assert.equal(f.factories,0);assert.equal(f.service.jobs.size,0);
});

test('explicit deletion removes only the owned source, partition, result and task metadata',async t=>{
  const f=await fixture(t),r=await f.service.create('doc',request),job=f.service.jobs.get(r.payload.meshJob.jobId),directory=f.service.store.directory(job);assert.equal((await f.service.handle('DELETE','/api/mesh/jobs/'+job.jobId)).status,200);assert.equal(fs.existsSync(directory),false);await tick();
});

test('explicit completion recovery reuses the exact result after a receipt write refusal',async t=>{
  const f=await fixture(t),commit=f.service.store.commitCompletion.bind(f.service.store);f.service.store.commitCompletion=()=>{throw Object.assign(Error('denied'),{code:'EPERM'});};
  const r=await f.service.create('doc',request),job=f.service.jobs.get(r.payload.meshJob.jobId);assert.equal(job.errorCode,'MESH_COMPLETION_UNCOMMITTED');assert.equal(r.payload.meshJob.completionRecovery.state,'available');const result=fs.readFileSync(path.join(f.service.store.directory(job),'result.json'));f.service.store.commitCompletion=commit;
  const reply=await f.service.handle('POST','/api/mesh/jobs/'+job.jobId+'/recover-completion',{requestId:crypto.randomUUID(),failedStateToken:job.metadataProof.sha256});assert.equal(reply.status,202);await Promise.all([...f.service.recoveryTasks]);assert.equal(job.state,'complete',JSON.stringify(f.service.descriptor(job,f.f.view)));assert.equal(job.discreteStage,'complete');assert.deepEqual(fs.readFileSync(path.join(f.service.store.directory(job),'result.json')),result);assert.equal(f.factories,1);assert.equal(f.exports,1);
});

test('storage publication refusal keeps exact computed artifacts eligible for explicit completion recovery',async t=>{
  const f=await fixture(t);let released=0;f.service.storageBudget={reserve:async()=>({bytes:256*1024**2,release(){released++;},verify:async()=>{throw Object.assign(Error('disk full'),{code:'MESH_STORAGE_CAPACITY'});}})};
  const r=await f.service.create('doc',request),job=f.service.jobs.get(r.payload.meshJob.jobId);assert.equal(job.errorCode,'MESH_COMPLETION_UNCOMMITTED');assert.equal(r.payload.meshJob.completionRecovery.state,'available');assert.ok(fs.existsSync(path.join(f.service.store.directory(job),'result.json')));assert.equal(released,1);
});

test('controlled shutdown preserves interrupted source and never restarts a native stage after reopen',async t=>{
  let entered;const started=new Promise(resolve=>entered=resolve),f=await fixture(t,{partition:({signal})=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{code:'MESH_CANCELLED'})),{once:true}));}}),r=await f.service.create('doc',{...request,background:true});await started;await f.service.closeAndWait();
  const restored=new ProjectMeshService({...f.config,discreteTetraWorkerFactory:undefined});try{await restored.ready;const job=restored.jobs.get(r.payload.meshJob.jobId);assert.equal(job.state,'interrupted');assert.ok(fs.existsSync(restored.store.tetraFile(job,'discreteSource')));assert.equal(f.events.includes('tetra'),false);assert.equal(f.factories,1);assert.equal(f.exports,1);}finally{await restored.closeAndWait();}
});

test('one composite owner closes both clients and fences every later stage',async()=>{
  const events=[],client=new DiscreteTetraTaskClient({partitionClient:{children:new Set(),partition(){events.push('partition');},closeAndWait:async()=>{events.push('close-partition');throw Object.assign(Error('exit unconfirmed'),{code:'SURFACE_STOP_UNCONFIRMED'});}},tetraClient:{children:new Set(),tetrahedralize(){events.push('tetra');},closeAndWait:async()=>events.push('close-tetra')}});
  await assert.rejects(client.closeAndWait(),{code:'SURFACE_STOP_UNCONFIRMED'});assert.deepEqual(events,['close-partition','close-tetra']);assert.throws(()=>client.partition({}),{code:'MESH_SERVICE_CLOSED'});assert.throws(()=>client.tetrahedralize({}),{code:'MESH_SERVICE_CLOSED'});
});
