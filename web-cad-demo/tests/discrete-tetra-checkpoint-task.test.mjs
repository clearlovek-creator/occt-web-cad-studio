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
import {assertOptimizationCheckpointInput,assertCheckpointOptimizationResult} from '../gateway/mesh-checkpoint-protocol.mjs';
import {tetraExecutionInput} from '../gateway/discrete-tetra-task-result.mjs';
import {writeDiscreteMeshFiles,expectedDiscreteMeshFiles} from '../gateway/discrete-mesh-files.mjs';
import {discreteMeshSourceToken} from '../gateway/discrete-mesh-registration.mjs';
import {captureProjectMeshArchive,stageProjectMeshArchive} from '../gateway/project-mesh-archive.mjs';
import {validateDiscreteNativePacket} from '../gateway/discrete-native-validation.mjs';
import {discreteValidationBinary} from '../gateway/discrete-validation-envelope.mjs';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t,options={}){
  const f=cadCheckpointFixture(),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-checkpoint-task-')),events=[];let service,exports=0;
  const factory=()=>({children:new Set(),partition:async()=>{events.push('partition');return structuredClone(f.domain);},createCheckpoint:async()=>{events.push('generate');return structuredClone(f.checkpoint);},optimizeCheckpoint:async(input,{signal})=>{
    events.push('optimize');const job=[...service.jobs.values()][0];assert.ok(job.artifact.checkpoint);assert.ok(fs.existsSync(service.store.tetraFile(job,'checkpoint')));assert.deepEqual(input.checkpointResult,f.checkpoint);
    if(options.optimize)return options.optimize({f,job,service,input,signal});return structuredClone(f.optimized);
  },closeAndWait:async()=>events.push('close')});Object.defineProperty(factory,'checkpointSupported',{value:true});
  const config={dataDir:data,serializeDocument:async(_id,action)=>action(),getCapabilities:()=>capabilitySnapshot(f.binding.workerInstance,true,{[DISCRETE_SOURCE_CAPABILITY]:DISCRETE_SOURCE}),command:async operation=>{if(operation==='document.summary')return structuredClone(f.view);assert.equal(operation,'mesh.discrete.export');exports++;return {ok:true,protocolVersion:1,documentId:'doc',revision:1,discreteSurface:structuredClone(f.bundle)};},discreteTetraWorkerFactory:factory};
  service=new ProjectMeshService(config);await service.ready;
  t.after(async()=>{await service.closeAndWait();assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-checkpoint-task-/);fs.rmSync(data,{recursive:true,force:true});});
  return {f,data,service,config,events,get exports(){return exports;},create:()=>service.create('doc',{kind:'discrete-tetra',discreteTetra:f.snapshot.settings}),job:()=>[...service.jobs.values()][0]};
}

test('actual artifact workers publish and reauthenticate the source-bound checkpoint before independent optimization',async t=>{
  const f=await fixture(t),reply=await f.create(),job=f.job();assert.equal(reply.status,200,JSON.stringify(reply));assert.equal(job.options.optimizationProcess,'checkpoint-v1');assert.deepEqual(f.events,['partition','generate','optimize','close']);assert.equal(job.state,'complete');assert.equal(reply.payload.meshJob.checkpoint.recorded,true);assert.equal(reply.payload.meshJob.normalMeshAdmitted,false);
  const checkpoint=f.service.store.readTetraCheckpoint(job),result=JSON.parse(fs.readFileSync(path.join(f.service.store.directory(job),'result.json')));assert.equal(result.discreteTetra.version,2);assert.equal(result.discreteTetra.value.version,2);assert.deepEqual(result.discreteTetra.checkpointProof,job.artifact.checkpoint);assert.equal(result.discreteTetra.value.output.algorithm.basis,'gmsh-checkpoint-optimization-v1');assert.deepEqual(checkpoint.result,f.f.checkpoint);
});

test('a failed checkpoint publication never starts optimization and does not fake a successful result',async t=>{
  const f=await fixture(t),execute=f.service.artifacts.execute.bind(f.service.artifacts);f.service.artifacts.execute=options=>options.operation==='capture-tetra-checkpoint'?Promise.reject(Object.assign(Error('checkpoint disk write denied'),{code:'MESH_ARTIFACT_IO'})):execute(options);
  const reply=await f.create(),job=f.job();assert.equal(reply.payload.code,'MESH_ARTIFACT_IO');assert.equal(job.state,'failed');assert.equal(f.events.includes('optimize'),false);assert.equal(job.artifact.checkpoint,undefined);assert.equal(job.artifact.result,undefined);
});

test('optimizer crash preserves immutable checkpoint and a restart reads it without exporting or replaying',async t=>{
  const f=await fixture(t,{optimize:()=>{throw Object.assign(Error('Mesh worker exited with code 3221225477'),{code:'MESH_WORKER_EXITED'});}}),reply=await f.create(),job=f.job();assert.equal(reply.payload.code,'MESH_WORKER_EXITED');assert.equal(job.state,'failed');const target=f.service.store.tetraFile(job,'checkpoint'),before=hash(fs.readFileSync(target));assert.equal(job.artifact.result,undefined);
  await f.service.closeAndWait();const restored=new ProjectMeshService({...f.config,discreteTetraWorkerFactory:undefined});try{await restored.ready;const read=await restored.handle('GET','/api/mesh/jobs/'+job.jobId);assert.equal(read.status,200,JSON.stringify(read));assert.equal(read.payload.checkpoint.available,true);assert.equal(read.payload.checkpoint.normalMeshAdmitted,false);assert.equal(read.payload.meshJob.state,'failed');assert.equal(read.payload.meshJob.visible,false);assert.equal(hash(fs.readFileSync(target)),before);assert.equal(f.exports,1);assert.equal(f.events.filter(value=>value==='generate').length,1);assert.equal(f.events.filter(value=>value==='optimize').length,1);}finally{await restored.closeAndWait();}
});

test('geometry/material change after checkpoint publication prevents optimizer success from being published',async t=>{
  const f=await fixture(t,{optimize:({f})=>{f.view.bodyMetadata[0].material='Steel';return structuredClone(f.optimized);}}),reply=await f.create(),job=f.job();assert.equal(reply.payload.code,'MESH_SOURCE_STALE',JSON.stringify(reply));assert.equal(job.state,'failed');assert.ok(job.artifact.checkpoint);assert.equal(job.artifact.result,undefined);assert.equal(fs.existsSync(path.join(f.service.store.directory(job),'result.json')),false);assert.ok(f.service.store.readTetraCheckpoint(job));
});

test('isolated-result derivation retains strict admission and exact original checkpoint identity',async t=>{
  const f=await fixture(t),reply=await f.create();assert.equal(reply.status,200,JSON.stringify(reply));const job=f.job(),materials=f.service.store.readTetraMaterials(job),directory=path.join(f.data,'derived');fs.mkdirSync(directory);const before=hash(fs.readFileSync(f.service.store.tetraFile(job,'checkpoint'))),input={...materials,jobId:job.jobId},written=writeDiscreteMeshFiles({directory,...input}),expected=expectedDiscreteMeshFiles(input);assert.deepEqual(written.manifest,expected.manifest);assert.equal(expected.projection.normalMeshAdmitted,true);assert.equal(hash(fs.readFileSync(f.service.store.tetraFile(job,'checkpoint'))),before);
  const token=discreteMeshSourceToken(job);job.artifact.checkpoint={...job.artifact.checkpoint,sha256:'a'.repeat(64)};assert.notEqual(discreteMeshSourceToken(job),token);assert.throws(()=>f.service.store.readTetraMaterials(job),{code:'MESH_ARTIFACT_INVALID'});
});

test('completed and failed checkpoint tasks round-trip with exact bytes in existing portable archive format',async t=>{
  for(const crash of [false,true]){
    const f=await fixture(t,crash?{optimize:()=>{throw Object.assign(Error('crash'),{code:'MESH_WORKER_EXITED'});}}:{}),reply=await f.create(),job=f.job();assert.equal(reply.status===200,!crash);
    const archive=captureProjectMeshArchive({store:f.service.store,documentId:'doc',source:f.f.source,jobs:[job]});assert.ok(archive.assets[0].files.checkpoint);const directory=path.join(f.data,'open');fs.mkdirSync(directory);const staged=stageProjectMeshArchive(archive,directory);try{const copy=staged.jobs[0];assert.deepEqual(fs.readFileSync(staged.store.tetraFile(copy,'checkpoint')),fs.readFileSync(f.service.store.tetraFile(job,'checkpoint')));assert.equal(copy.state,job.state);assert.equal(staged.store.readResult(copy).ok,true);}finally{staged.cleanup();}
  }
});

test('checkpoint native validation stays in the existing closed worker registry with phase/input binding',()=>{
  const f=cadCheckpointFixture(),requestId='mesh-checkpoint-'+crypto.randomUUID(),context={sourceInput:tetraExecutionInput(f.snapshot)},input=f.checkpoint.generationInput;
  for(const [operation,command,candidate]of [['mesh.discrete-checkpoint',input,{...f.checkpoint,requestId}],['mesh.discrete-optimize',{generationInput:input,checkpointResult:f.checkpoint},{...f.optimized,requestId}]]){
    const packet=discreteValidationBinary({phase:'result',operation,requestId,input:command,context,candidate}).packet;assert.equal(validateDiscreteNativePacket(packet).operation,operation);
  }
  const command={generationInput:input,checkpointResult:f.checkpoint};assertOptimizationCheckpointInput(command,context);assertCheckpointOptimizationResult(f.optimized,command,f.optimized.requestId);const bad=structuredClone(command);bad.checkpointResult.execution.exitCode=2;assert.throws(()=>assertOptimizationCheckpointInput(bad,context));
});

test('checkpoint tasks reject insufficient whole-task reservation before any source export or registration',async t=>{
  const f=await fixture(t);let released=0;f.service.storageBudget={reserve:async()=>({bytes:256*1024**2,release(){released++;}})};
  const reply=await f.create();assert.equal(reply.payload.code,'MESH_STORAGE_TASK_RESERVATION');assert.equal(released,1);assert.equal(f.exports,0);assert.equal(f.service.jobs.size,0);assert.deepEqual(f.events,[]);
});

test('cancelling independent optimization retains the authenticated checkpoint without publishing completion',async t=>{
  let entered;const started=new Promise(resolve=>entered=resolve),f=await fixture(t,{optimize:({signal})=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{code:'MESH_CANCELLED'})),{once:true}));}}),pending=f.create();await started;const job=f.job(),before=hash(fs.readFileSync(f.service.store.tetraFile(job,'checkpoint'))),reply=await f.service.handle('POST','/api/mesh/jobs/'+job.jobId+'/cancel',{});await pending;assert.equal(reply.payload.meshJob.state,'cancelled');assert.equal(hash(fs.readFileSync(f.service.store.tetraFile(job,'checkpoint'))),before);assert.equal(job.artifact.result,undefined);assert.equal(fs.existsSync(path.join(f.service.store.directory(job),'completion.json')),false);assert.equal(f.events.filter(value=>value==='generate').length,1);
});

test('controlled shutdown records interrupted optimization and retains checkpoint for non-replaying restart',async t=>{
  let entered;const started=new Promise(resolve=>entered=resolve),f=await fixture(t,{optimize:({signal})=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{code:'MESH_CANCELLED'})),{once:true}));}}),pending=f.create();await started;const job=f.job(),before=hash(fs.readFileSync(f.service.store.tetraFile(job,'checkpoint')));await f.service.closeAndWait();await pending;assert.equal(job.state,'interrupted');assert.equal(hash(fs.readFileSync(f.service.store.tetraFile(job,'checkpoint'))),before);const restarted=new ProjectMeshService({...f.config,discreteTetraWorkerFactory:undefined});try{await restarted.ready;const read=await restarted.handle('GET','/api/mesh/jobs/'+job.jobId);assert.equal(read.payload.meshJob.state,'interrupted');assert.equal(read.payload.checkpoint.available,true);assert.equal(f.events.filter(value=>value==='optimize').length,1);}finally{await restarted.closeAndWait();}
});

test('even a mutually rewritten checkpoint file and digest cannot substitute source, policy or generation exit evidence',async t=>{
  for(const mutate of [value=>value.sourceSnapshotSha256='a'.repeat(64),value=>value.result.execution.exitCode=2,value=>value.result.generationInput.optimization.iterations=5,value=>value.result.checkpoint.entities[0].coordinates[0]+=.01]){
    const f=await fixture(t),reply=await f.create();assert.equal(reply.status,200,JSON.stringify(reply));const job=f.job(),target=f.service.store.tetraFile(job,'checkpoint'),value=JSON.parse(fs.readFileSync(target));mutate(value);const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(target,bytes);job.artifact.checkpoint={bytes:bytes.length,sha256:hash(bytes)};assert.throws(()=>f.service.store.readTetraCheckpoint(job));assert.throws(()=>f.service.store.readTetraMaterials(job));
  }
});
