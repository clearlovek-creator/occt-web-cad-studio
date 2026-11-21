import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ProjectMeshService} from '../gateway/project-mesh-service.mjs';
import {capabilitySnapshot} from '../gateway/worker-capabilities.mjs';
import {DISCRETE_SOURCE,DISCRETE_SOURCE_CAPABILITY} from '../shared/discrete-surface-source.mjs';
import {cadCheckpointFixture} from './helpers/cad-checkpoint-fixture.mjs';
import {parseOptimizationRecoveryRequest} from '../gateway/mesh-optimization-recovery.mjs';
import {captureProjectMeshArchive,stageProjectMeshArchive,materializeProjectMeshArchive,openMaterializedMeshAsset} from '../gateway/project-mesh-archive.mjs';
import {expectedDiscreteMeshFiles} from '../gateway/discrete-mesh-files.mjs';
import {denyWindowsFileRead} from './helpers/windows-file-sharing.mjs';
import {createCadMcpHandler} from '../gateway/cad-mcp-server.mjs';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function fixture(t,{optimize}={}){
  const f=cadCheckpointFixture(),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-optimization-recovery-')),counts={partition:0,generation:0,optimization:0,exports:0};let service;
  const factory=()=>({children:new Set(),partition:async()=>{counts.partition++;return structuredClone(f.domain);},createCheckpoint:async()=>{counts.generation++;return structuredClone(f.checkpoint);},optimizeCheckpoint:async(input,{signal})=>{
    counts.optimization++;if(optimize)return optimize({f,input,signal,count:counts.optimization,service});if(counts.optimization===1)throw Object.assign(Error('Mesh worker exited with code 3221225477'),{code:'MESH_WORKER_EXITED'});return structuredClone(f.optimized);
  },closeAndWait:async()=>{}});Object.defineProperty(factory,'checkpointSupported',{value:true});
  const config={dataDir:data,serializeDocument:async(_id,action)=>action(),getCapabilities:()=>capabilitySnapshot(f.binding.workerInstance,true,{[DISCRETE_SOURCE_CAPABILITY]:DISCRETE_SOURCE}),command:async operation=>{if(operation==='document.summary')return structuredClone(f.view);assert.equal(operation,'mesh.discrete.export');counts.exports++;return {ok:true,protocolVersion:1,documentId:'doc',revision:1,discreteSurface:structuredClone(f.bundle)};},discreteTetraWorkerFactory:factory};
  service=new ProjectMeshService(config);await service.ready;t.after(async()=>{await service.closeAndWait();assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-optimization-recovery-/);fs.rmSync(data,{recursive:true,force:true});});
  const initial=await service.create('doc',{kind:'discrete-tetra',discreteTetra:f.snapshot.settings});assert.equal(initial.payload.meshJob.state,'failed',JSON.stringify(initial));const origin=service.jobs.get(initial.payload.meshJob.jobId),route='/api/mesh/jobs/'+origin.jobId+'/resume-optimization';
  const request=()=>{const info=service.descriptor(origin,f.view).optimizationRecovery;return {requestId:crypto.randomUUID(),failedStateToken:info.failedStateToken,checkpointToken:info.checkpointToken};};
  const done=async job=>{const deadline=Date.now()+10000;while(['preparing','queued','running','cancelling'].includes(job.state)){assert.ok(Date.now()<deadline,JSON.stringify(service.descriptor(job,f.view)));await tick();}await job.task;return job;};
  const files=job=>{const directory=service.store.directory(job),walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);return Object.fromEntries(walk(directory).map(file=>[path.relative(directory,file),hash(fs.readFileSync(file))]));};
  return {f,data,counts,config,service,origin,route,request,done,files};
}

test('recovery request accepts only a fresh operation identity and exact failure/checkpoint tokens',()=>{
  const good={requestId:crypto.randomUUID(),failedStateToken:'a'.repeat(64),checkpointToken:'b'.repeat(64)};assert.deepEqual(parseOptimizationRecoveryRequest(good),good);
  for(const value of [null,[],{}, {...good,path:'elsewhere'},{...good,optimization:{method:'gmsh'}},{...good,requestId:'x'},{...good,failedStateToken:'x'},{...good,checkpointToken:'x'}])assert.throws(()=>parseOptimizationRecoveryRequest(value),{code:'MESH_OPTIMIZATION_RECOVERY_REQUEST_INVALID'});
});

test('explicit recovery creates an independent task, copies exact inputs, and runs only optimization',async t=>{
  const f=await fixture(t),before=f.files(f.origin),request=f.request(),reply=await f.service.handle('POST',f.route,request);assert.equal(reply.status,202,JSON.stringify(reply));assert.notEqual(reply.payload.meshJob.jobId,f.origin.jobId);const job=await f.done(f.service.jobs.get(reply.payload.meshJob.jobId));assert.equal(job.state,'complete',JSON.stringify(f.service.descriptor(job,f.f.view)));assert.deepEqual(f.counts,{partition:1,generation:1,optimization:2,exports:1});assert.deepEqual(f.files(f.origin),before);assert.equal(f.origin.state,'failed');
  for(const kind of ['discreteSource','partition','checkpoint'])assert.deepEqual(fs.readFileSync(f.service.store.tetraFile(job,kind)),fs.readFileSync(f.service.store.tetraFile(f.origin,kind)));
  assert.equal(f.service.store.readOptimizationOrigin(job).record.errorCode,'MESH_WORKER_EXITED');assert.equal(f.service.store.readResult(job).discreteTetraSummary.tetraCount,6);const materials=f.service.store.readTetraMaterials(job);assert.equal(expectedDiscreteMeshFiles({...materials,jobId:job.jobId}).projection.normalMeshAdmitted,true);
});

test('same request after success returns the same attempt; changed tokens cannot reuse its identity',async t=>{
  const f=await fixture(t),request=f.request(),first=await f.service.handle('POST',f.route,request),job=await f.done(f.service.jobs.get(first.payload.meshJob.jobId)),again=await f.service.handle('POST',f.route,request);assert.equal(again.status,200);assert.equal(again.payload.meshJob.jobId,job.jobId);assert.equal(f.counts.optimization,2);assert.equal((await f.service.handle('POST',f.route,{...request,checkpointToken:'a'.repeat(64)})).payload.code,'MESH_OPTIMIZATION_RECOVERY_CONFLICT');assert.equal(f.service.jobs.size,2);
});

test('stale geometry/material and stale failure tokens refuse before creating an attempt or running native work',async t=>{
  const f=await fixture(t),request=f.request();assert.equal((await f.service.handle('POST',f.route,{...request,failedStateToken:'a'.repeat(64)})).payload.code,'MESH_OPTIMIZATION_RECOVERY_CONFLICT');f.f.view.bodyMetadata[0].material='Steel';assert.equal((await f.service.handle('POST',f.route,request)).payload.code,'MESH_SOURCE_STALE');assert.equal(f.service.jobs.size,1);assert.equal(f.counts.optimization,1);
});

test('a second failure is retained independently and can itself be explicitly resumed without regeneration',async t=>{
  const f=await fixture(t,{optimize:({f,count})=>{if(count<3)throw Object.assign(Error('optimizer failed '+count),{code:'MESH_WORKER_EXITED'});return structuredClone(f.optimized);}}),original=f.files(f.origin),first=await f.service.handle('POST',f.route,f.request()),failed=await f.done(f.service.jobs.get(first.payload.meshJob.jobId));assert.equal(failed.state,'failed');const before=f.files(failed),info=f.service.descriptor(failed,f.f.view).optimizationRecovery,next=await f.service.handle('POST','/api/mesh/jobs/'+failed.jobId+'/resume-optimization',{requestId:crypto.randomUUID(),failedStateToken:info.failedStateToken,checkpointToken:info.checkpointToken}),completed=await f.done(f.service.jobs.get(next.payload.meshJob.jobId));assert.equal(completed.state,'complete',JSON.stringify(f.service.descriptor(completed,f.f.view)));assert.equal(completed.optimizationRecovery.checkpointJobId,f.origin.jobId);assert.deepEqual(f.files(f.origin),original);assert.deepEqual(f.files(failed),before);assert.deepEqual(f.counts,{partition:1,generation:1,optimization:3,exports:1});
});

test('independent recovered task is self-contained across archive and source-task deletion',async t=>{
  const f=await fixture(t),reply=await f.service.handle('POST',f.route,f.request()),job=await f.done(f.service.jobs.get(reply.payload.meshJob.jobId));assert.equal(job.state,'complete');const archive=captureProjectMeshArchive({store:f.service.store,documentId:'doc',source:f.f.source,jobs:[job]});assert.ok(archive.assets[0].files.optimizationOrigin);const staged=stageProjectMeshArchive(archive,f.data);try{assert.equal(staged.store.readResult(staged.jobs[0]).discreteTetraSummary.tetraCount,6);assert.equal(staged.store.readOptimizationOrigin(staged.jobs[0]).record.jobId,f.origin.jobId);}finally{staged.cleanup();}
  const materialized=materializeProjectMeshArchive(archive,f.data);try{const restored=openMaterializedMeshAsset(materialized.directory,materialized.manifestProof,materialized.manifest.assets[0].assetId);assert.equal(restored.store.readResult(restored.job).discreteTetraSummary.tetraCount,6);assert.equal(restored.store.readOptimizationOrigin(restored.job).record.jobId,f.origin.jobId);}finally{materialized.cleanup();}
  assert.equal((await f.service.handle('DELETE','/api/mesh/jobs/'+f.origin.jobId)).status,200);assert.equal(f.service.store.readResult(job).discreteTetraSummary.tetraCount,6);assert.equal(f.counts.optimization,2);
});

test('duplicate active request does not start another optimizer; cancellation retains both task histories',async t=>{
  let entered;const started=new Promise(resolve=>entered=resolve),f=await fixture(t,{optimize:({f,count,signal})=>{if(count===1)throw Object.assign(Error('initial crash'),{code:'MESH_WORKER_EXITED'});if(count===2){entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{code:'MESH_CANCELLED'})),{once:true}));}return structuredClone(f.optimized);}}),before=f.files(f.origin),request=f.request(),reply=await f.service.handle('POST',f.route,request),job=f.service.jobs.get(reply.payload.meshJob.jobId);await started;
  const duplicate=await f.service.handle('POST',f.route,request);assert.equal(duplicate.status,202);assert.equal(duplicate.payload.meshJob.jobId,job.jobId);assert.equal((await f.service.handle('POST',f.route,f.request())).payload.code,'MESH_JOB_ALREADY_RUNNING');assert.equal(f.counts.optimization,2);
  const cancelled=await f.service.handle('POST','/api/mesh/jobs/'+job.jobId+'/cancel',{});assert.equal(cancelled.payload.meshJob.state,'cancelled');await f.done(job);assert.deepEqual(f.files(f.origin),before);assert.ok(f.service.store.readTetraCheckpoint(job));assert.equal((await f.service.handle('POST',f.route,request)).payload.meshJob.jobId,job.jobId);assert.equal(f.counts.optimization,2);
});

test('temporary checkpoint file lock fails only the new attempt and requires a new explicit request',async t=>{
  const f=await fixture(t),before=f.files(f.origin),lock=await denyWindowsFileRead(f.service.store.tetraFile(f.origin,'checkpoint')),request=f.request();let job;
  try{const reply=await f.service.handle('POST',f.route,request);assert.equal(reply.status,202,JSON.stringify(reply));job=await f.done(f.service.jobs.get(reply.payload.meshJob.jobId));assert.equal(job.state,'failed');assert.equal(job.errorCode,'MESH_ARTIFACT_IO');assert.equal(f.counts.optimization,1);}finally{await lock.release();}
  assert.deepEqual(f.files(f.origin),before);const duplicate=await f.service.handle('POST',f.route,request);assert.equal(duplicate.payload.meshJob.jobId,job.jobId);assert.equal(f.counts.optimization,1);const next=await f.service.handle('POST',f.route,f.request()),completed=await f.done(f.service.jobs.get(next.payload.meshJob.jobId));assert.equal(completed.state,'complete');assert.equal(f.counts.generation,1);
});

test('resource policy changes and under-reservation do not register or execute a recovery',async t=>{
  const f=await fixture(t);f.service.discreteTetraMemoryLimitBytes=3*1024**3;assert.equal((await f.service.handle('POST',f.route,f.request())).payload.code,'MESH_OPTIMIZATION_RECOVERY_RESOURCE_CHANGED');f.service.discreteTetraMemoryLimitBytes=2*1024**3;let released=0;f.service.storageBudget={reserve:async()=>({bytes:256*1024**2,release(){released++;}})};assert.equal((await f.service.handle('POST',f.route,f.request())).payload.code,'MESH_STORAGE_TASK_RESERVATION');assert.equal(released,1);assert.equal(f.service.jobs.size,1);assert.equal(f.counts.optimization,1);
});

test('restart resolves the same recovery operation identity without replaying completed native work',async t=>{
  const f=await fixture(t),request=f.request(),reply=await f.service.handle('POST',f.route,request),job=await f.done(f.service.jobs.get(reply.payload.meshJob.jobId)),before=f.files(job);await f.service.closeAndWait();const restarted=new ProjectMeshService(f.config);try{await restarted.ready;const duplicate=await restarted.handle('POST',f.route,request);assert.equal(duplicate.status,200,JSON.stringify(duplicate));assert.equal(duplicate.payload.meshJob.jobId,job.jobId);assert.equal(duplicate.payload.meshJob.state,'complete');assert.equal(f.counts.optimization,2);assert.deepEqual(f.files(job),before);}finally{await restarted.closeAndWait();}
});

test('MCP lost acceptance reconciles the persisted attempt by exact request identity without regeneration, including after restart',async t=>{
  const f=await fixture(t),before=f.files(f.origin),request=f.request(),posts=[];let lose=true;
  const api=service=>async(url,init={})=>{
    const route=new URL(url),input=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(route.searchParams);
    const reply=await service.handle(init.method||'GET',route.pathname,input,{signal:init.signal});
    if(init.method==='POST'){posts.push({path:route.pathname,input});if(lose){lose=false;throw Error('accepted response lost');}}
    return new Response(JSON.stringify(reply.payload),{status:reply.status});
  };
  const handler=createCadMcpHandler({apiRoot:'http://cad.test/api',documentId:'doc',fetchImpl:api(f.service)}),call=(name,args)=>handler({id:1,method:'tools/call',params:{name:'mesh_jobs__'+name,arguments:args}});
  const args={jobId:f.origin.jobId,...request},lost=await call('resume_optimization',args),error=JSON.parse(lost.result.content[0].text);
  assert.equal(lost.result.isError,true);assert.equal(error.outcome,'unknown');assert.equal(error.meshRequest.requestId,request.requestId);assert.equal(posts.length,1);
  const job=[...f.service.jobs.values()].find(job=>job.optimizationRecovery?.requestId===request.requestId);assert.ok(job);await f.done(job);
  const found=await call('list',{requestId:request.requestId}),observed=JSON.parse(found.result.content[0].text);assert.equal(found.result.isError,false,JSON.stringify(observed));assert.equal(observed.jobs.length,1);assert.equal(observed.jobs[0].jobId,job.jobId);assert.equal(observed.jobs[0].state,'complete');assert.equal(observed.jobs[0].visible,false);assert.equal(posts.length,1);assert.deepEqual(f.files(f.origin),before);
  const denied=createCadMcpHandler({apiRoot:'http://cad.test/api',documentId:'foreign',fetchImpl:api(f.service)});const rejected=await denied({id:2,method:'tools/call',params:{name:'mesh_jobs__cancel',arguments:{jobId:job.jobId}}});assert.equal(rejected.result.isError,true);assert.equal(JSON.parse(rejected.result.content[0].text).code,'MESH_JOB_NOT_FOUND');assert.equal(job.state,'complete');
  await f.service.closeAndWait();const restarted=new ProjectMeshService(f.config);try{
    await restarted.ready;const restored=createCadMcpHandler({apiRoot:'http://cad.test/api',documentId:'doc',fetchImpl:api(restarted)});
    const reply=await restored({id:3,method:'tools/call',params:{name:'mesh_jobs__list',arguments:{requestId:request.requestId}}});assert.equal(reply.result.isError,false);assert.equal(JSON.parse(reply.result.content[0].text).jobs[0].jobId,job.jobId);assert.equal(f.counts.optimization,2);assert.equal(f.counts.generation,1);assert.equal(f.counts.partition,1);assert.equal(f.counts.exports,1);
  }finally{await restarted.closeAndWait();}
});
