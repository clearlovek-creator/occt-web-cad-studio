import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {normalizeMeshQualityPolicy,meshAcceptanceSettings,validateMeshAcceptanceSettings} from '../shared/mesh-quality-policy.mjs';
import {assessMeshAdmission} from '../gateway/mesh-admission.mjs';import {admissionFixture} from './helpers/mesh-admission-fixture.mjs';
import {normalizeMeshStrategyOptions,meshStrategyOptionsEqual} from '../shared/mesh-strategy.mjs';import {meshStrategyHash,validateMeshStrategyExecution} from '../gateway/mesh-strategy-proof.mjs';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';import {ProjectMeshTaskStore} from '../app/model/project-mesh-task-store.ts';

test('quality policy is explicit, strictly typed, and omission preserves legacy warning semantics',()=>{
  assert.equal(normalizeMeshQualityPolicy(undefined),'warning');for(const value of ['warning','strict'])assert.equal(normalizeMeshQualityPolicy(value),value);
  for(const value of [null,false,true,1,'','Strict',{},[]])assert.throws(()=>normalizeMeshQualityPolicy(value),{code:'MESH_QUALITY_POLICY_INVALID'});
  for(const qualityThreshold of [undefined,null,'0.2',NaN,Infinity,-.1,1.1])assert.throws(()=>meshAcceptanceSettings({qualityPolicy:'strict',qualityThreshold}));
});
test('strict quality blocks otherwise healthy low-quality cells, not cells equal to the threshold',()=>{
  const f=admissionFixture({threshold:.9});f.mesh.quality.badCount=1;
  const assess=options=>assessMeshAdmission(f.mesh,f.index,f.source,options);
  assert.equal(assess().status,'warning');const blocked=assess({qualityPolicy:'strict',qualityThreshold:.9});assert.equal(blocked.usable,false);assert.equal(blocked.status,'blocked');assert.equal(blocked.counts.lowQualityCount,1);assert.equal(blocked.reasons.find(row=>row.code==='LOW_QUALITY_ELEMENTS').severity,'error');
  f.index.threshold=.8;f.mesh.quality.threshold=.8;f.mesh.quality.badCount=0;assert.equal(assess({qualityPolicy:'strict',qualityThreshold:.8}).status,'accepted');
});
test('quality thresholds cannot be silently taken from contradictory output evidence',()=>{
  const f=admissionFixture();const report=assessMeshAdmission(f.mesh,f.index,f.source,{qualityPolicy:'strict',qualityThreshold:1});assert.equal(report.usable,false);assert.ok(report.reasons.some(row=>row.code==='QUALITY_THRESHOLD_INCONSISTENT'));
});
test('strict mode never changes hard-error enforcement or grants missing-evidence results normal use',()=>{
  for(const qualityPolicy of ['warning','strict']){const f=admissionFixture();f.index.cells[0].minJacobian=-1;assert.equal(assessMeshAdmission(f.mesh,f.index,f.source,{qualityPolicy}).usable,false);assert.equal(assessMeshAdmission(f.mesh,null,f.source,{qualityPolicy}).usable,false);}
});
test('captured acceptance proof cannot be omitted, downgraded or extended; true legacy remains readable',()=>{
  const options={qualityPolicy:'strict',qualityThreshold:.2},proof=meshAcceptanceSettings(options);validateMeshAcceptanceSettings(proof,options);
  validateMeshAcceptanceSettings(undefined,{qualityThreshold:.2});
  for(const value of [undefined,null,{...proof,qualityPolicy:'warning'},{...proof,qualityThreshold:0},{...proof,extra:true}])assert.throws(()=>validateMeshAcceptanceSettings(value,options),{code:'MESH_ARTIFACT_INVALID'});
  assert.throws(()=>validateMeshAcceptanceSettings(proof,{qualityThreshold:.2}),{code:'MESH_ARTIFACT_INVALID'});
});
test('strategy warning defaults retain old definition hashes while strict policy participates in exact execution proof',()=>{
  const options={repairMode:'strict',qualityThreshold:.2};assert.deepEqual(normalizeMeshStrategyOptions({...options,qualityPolicy:'warning'}),options);assert.ok(meshStrategyOptionsEqual(options,{...options,qualityPolicy:'warning'}));assert.equal(meshStrategyHash(normalizeMeshStrategyOptions(options)),meshStrategyHash(options));
  const snapshot={strategyId:'mesh-strategy-'+randomUUID(),name:'Strict film',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),options:{...options,qualityPolicy:'strict'}},ref={strategyId:snapshot.strategyId,revision:1,definitionHash:meshStrategyHash(snapshot)},execution={...snapshot.options,strategySnapshot:snapshot,strategyRef:ref};
  validateMeshStrategyExecution(execution);assert.throws(()=>validateMeshStrategyExecution({...execution,qualityPolicy:'warning'}),{code:'MESH_STRATEGY_PROOF_INVALID'});assert.equal(meshStrategyOptionsEqual(options,snapshot.options),false);
});
test('sealed result reads apply the captured quality policy in both streaming and in-memory paths',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-quality-policy-unit-'));try{
    const f=admissionFixture({threshold:.9}),store=new MeshJobStore(root),job={jobId:'mesh-'+randomUUID(),documentId:f.source.documentId,source:f.source,state:'complete',createdAt:new Date().toISOString(),options:{repairMode:'strict',qualityThreshold:.9,qualityPolicy:'strict'}};
    f.index.requestId=job.jobId;f.mesh.quality.badCount=1;fs.mkdirSync(store.directory(job),{recursive:true});fs.writeFileSync(store.qualityOutput(job),JSON.stringify(f.index));
    job.artifact=store.writeResult(job,{ok:true,requestId:job.jobId,mesh:f.mesh});store.save(job);
    for(const streamQuality of [true,false]){assert.equal(store.readResult(job,{streamQuality}).mesh.admission.status,'blocked');const forged=structuredClone(job);forged.options.qualityPolicy='warning';assert.throws(()=>store.readResult(forged,{streamQuality}),{code:'MESH_ARTIFACT_INVALID'});delete forged.options.qualityPolicy;assert.throws(()=>store.readResult(forged,{streamQuality}),{code:'MESH_ARTIFACT_INVALID'});}
    assert.equal(new MeshJobStore(root).load()[0].options.qualityPolicy,'strict');
  }finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-quality-policy-unit-/);fs.rmSync(root,{recursive:true,force:true});}
});
test('workspace quality drafts survive tool subscriptions and strategy loading resets the exact selected rule',async t=>{
  let posts=0;const store=new ProjectMeshTaskStore({documentId:'one',apiRoot:'/api',fetchImpl:async(_url,init)=>{if(init?.method==='POST')posts++;return new Response(JSON.stringify({ok:true,jobs:[]}));}});store.start();t.after(store.stop);await store.refresh();store.setSetupStrictQuality(true);const off=store.subscribe(()=>{});off();await store.refresh();assert.equal(store.getSnapshot().setupStrictQuality,true);
  const row={strategyId:'mesh-strategy-'+randomUUID(),name:'Legacy',options:{repairMode:'strict',qualityThreshold:.2}};store.loadStrategy(row,{});assert.equal(store.getSnapshot().setupStrictQuality,false);store.loadStrategy({...row,options:{...row.options,qualityPolicy:'strict'}},{});assert.equal(store.getSnapshot().setupStrictQuality,true);assert.equal(posts,0);
});
