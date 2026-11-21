import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
import {executeCadDiscreteTetra} from '../gateway/cad-discrete-tetra.mjs';
import {tetraTaskResult,tetraTaskFailure,validateTetraTaskResult,validateTetraSummary,validateTetraFailureSummary} from '../gateway/discrete-tetra-task-result.mjs';
import {cadDiscreteTetraFixture} from './helpers/cad-discrete-tetra-fixture.mjs';
async function fixture(t,options={}){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-tetra-store-')),store=new MeshJobStore(data),f=cadDiscreteTetraFixture(options),job={version:1,jobId:'mesh-'+crypto.randomUUID(),documentId:'doc',kind:'discrete-tetra',state:'running',discreteStage:'partition',source:f.source,materialSourceSha256:f.snapshot.materials.sha256,options:{discreteTetra:f.snapshot.settings,nativeSurfaceMemoryLimitBytes:2*1024**3,nativeMemoryLimitBytes:2*1024**3},createdAt:new Date().toISOString(),processResources:{partition:f.domain.processResources},artifact:{}};
  t.after(()=>{assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-tetra-store-/);fs.rmSync(data,{recursive:true,force:true});});
  store.save(job);Object.assign(job.artifact,store.writeTetraArtifact(job,'discreteSource',f.snapshot).artifact);Object.assign(job.artifact,store.writeTetraArtifact(job,'partition',f.domain).artifact);return {...f,job,store,data};
}
async function completed(f){f.job.processResources.tetra=f.output.processResources;const value=await executeCadDiscreteTetra({snapshot:f.snapshot,...f.clients}),result=tetraTaskResult(f.job,value);Object.assign(f.job.artifact,f.store.writeResult(f.job,result));f.job.discreteTetraSummary=validateTetraTaskResult(result,f.job,f.snapshot,f.domain);return result;}

test('durable tetra source and partition are immutable, content-certified and source-bound',async t=>{
  const f=await fixture(t);assert.deepEqual(f.store.readTetraSource(f.job),f.snapshot);assert.deepEqual(f.store.readTetraPartition(f.job),f.domain);
  for(const [kind,value]of [['discreteSource',f.snapshot],['partition',f.domain]])assert.throws(()=>f.store.writeTetraArtifact(f.job,kind,value));
  const before=fs.readFileSync(f.store.tetraFile(f.job,'discreteSource'));f.job.materialSourceSha256='f'.repeat(64);assert.throws(()=>f.store.readTetraSource(f.job));assert.deepEqual(fs.readFileSync(f.store.tetraFile(f.job,'discreteSource')),before);
});

test('tetra result stores full cells but default artifact read returns only a revalidated summary',async t=>{
  const f=await fixture(t);await completed(f);const read=f.store.readResult(f.job);assert.equal(read.discreteTetraSummary.tetraCount,6);assert.equal(read.mesh,undefined);assert.equal(read.discreteTetra,undefined);assert.ok(JSON.stringify(read).length<8192);assert.ok(JSON.parse(fs.readFileSync(path.join(f.store.directory(f.job),'result.json'))).discreteTetra.value.output.cells[0].tetrahedra.length);
});

test('source, partition, settings and process proof corruption prevents result admission without overwriting files',async t=>{
  const f=await fixture(t),r=await completed(f),before=fs.readFileSync(path.join(f.store.directory(f.job),'result.json'));
  for(const mutate of [v=>v.discreteTetra.sourceProof.sha256='a'.repeat(64),v=>v.discreteTetra.partitionProof.sha256='a'.repeat(64),v=>v.discreteTetra.value.output.execution.exitCode=2,v=>v.discreteTetra.value.partition.sourceSolids[0].bodyId='foreign']){const value=structuredClone(r);mutate(value);assert.throws(()=>f.store.writeResult(f.job,value));}
  assert.deepEqual(fs.readFileSync(path.join(f.store.directory(f.job),'result.json')),before);fs.appendFileSync(f.store.tetraFile(f.job,'partition'),' ');assert.throws(()=>f.store.readResult(f.job),{code:'MESH_ARTIFACT_INVALID'});
});

test('completion receipt reopens tetra completion after metadata denial without recomputation',async t=>{
  const f=await fixture(t);await completed(f);const metadata=path.join(f.store.directory(f.job),'metadata.json'),before=fs.readFileSync(metadata),rename=fs.renameSync;t.mock.method(fs,'renameSync',(a,b)=>{if(b===metadata)throw Object.assign(Error('denied'),{code:'EPERM'});return rename(a,b);});
  f.job.state='complete';f.job.discreteStage='complete';f.job.finishedAt=new Date().toISOString();assert.equal(f.store.commitCompletion(f.job).metadataSynchronized,false);const restored=f.store.loadCatalog().jobs[0];assert.equal(restored.state,'complete');assert.equal(restored.kind,'discrete-tetra');assert.equal(f.store.readResult(restored).discreteTetraSummary.normalMeshAdmitted,false);assert.deepEqual(fs.readFileSync(metadata),before);
});

test('material-conflict diagnosis is retained with exact source and partition evidence',async t=>{
  const f=await fixture(t,{materials:['Copper','Steel']});let error;try{await executeCadDiscreteTetra({snapshot:f.snapshot,...f.clients});}catch(cause){error=cause;}
  assert.equal(error.code,'MESH_MATERIAL_CONFLICT');const saved=f.store.writeTetraArtifact(f.job,'discreteFailure',tetraTaskFailure(f.job,f.snapshot,error));Object.assign(f.job.artifact,saved.artifact);f.job.discreteFailureSummary=saved.summary;f.job.state='failed';f.job.errorCode=error.code;f.store.save(f.job);
  const read=f.store.readResult(f.job);assert.equal(read.discreteFailureSummary.conflictCellCount,1);assert.equal(read.mesh,undefined);const restored=f.store.loadCatalog().jobs[0];assert.equal(restored.state,'failed');assert.equal(f.store.readResult(restored).discreteFailureSummary.code,error.code);
});

test('interrupted tasks preserve exact source and partition and never auto-create completion',async t=>{
  const f=await fixture(t);f.store.save(f.job);const restored=f.store.loadCatalog().jobs[0];assert.equal(restored.state,'interrupted');assert.equal(fs.existsSync(f.store.tetraFile(restored,'discreteSource')),true);assert.equal(fs.existsSync(f.store.tetraFile(restored,'partition')),true);assert.equal(fs.existsSync(path.join(f.store.directory(restored),'completion.json')),false);
});

test('published tetra results cannot be overwritten even by a repeated valid result',async t=>{const f=await fixture(t),result=await completed(f),before=fs.readFileSync(path.join(f.store.directory(f.job),'result.json'));assert.throws(()=>f.store.writeResult(f.job,result));assert.deepEqual(fs.readFileSync(path.join(f.store.directory(f.job),'result.json')),before);});

test('catalog summaries reject forged quality, unbounded diagnostics and false normal admission',async t=>{
  const f=await fixture(t);await completed(f);for(const mutate of [v=>v.quality.lowQualityCount=-1,v=>v.quality.threshold=.99,v=>v.quality.perCell=[],v=>v.normalMeshAdmitted=true,v=>v.points=[]]){const value=structuredClone(f.job.discreteTetraSummary);mutate(value);assert.throws(()=>validateTetraSummary(value,f.job.options));}
  for(const value of [{version:1,code:'MESH_MATERIAL_CONFLICT',conflictCellCount:129,normalMeshAdmitted:false},{version:1,code:'MESH_QUALITY_REJECTED',tetraCount:1,lowQualityCount:2,minimumSICN:.1,threshold:.2,normalMeshAdmitted:false}])assert.throws(()=>validateTetraFailureSummary(value));
});
