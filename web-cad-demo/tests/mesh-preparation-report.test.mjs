import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {validatePreparation,preparationSummary} from '../gateway/mesh-preparation-report.mjs';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
import {diagnosticFixture,diagnosticSource} from './helpers/mesh-preparation-fixture.mjs';

test('preparation schema validates complete geometry evidence, bounded display arrays and severity totals',()=>{
  const valid=diagnosticFixture();assert.equal(validatePreparation(valid.diagnostics,diagnosticSource,valid.preview),valid.diagnostics);
  assert.deepEqual(preparationSummary(valid.diagnostics),{reportAvailable:true,status:'ready',bodyCount:1,errorCount:0,warningCount:0,solidCount:1,faceCount:6});
  const invalid=[
    value=>value.diagnostics.stage='repair',
    value=>value.diagnostics.status='blocked',
    value=>value.diagnostics.bodies[0].kind='unknown',
    value=>value.diagnostics.bodies[0].before.maxTolerance=-1,
    value=>value.diagnostics.bodies[0].before.sliverFaceCount=7,
    value=>value.diagnostics.bodies[0].before.issues=[{code:'X',severity:'warning',kind:'body',index:0}],
    value=>{Object.assign(value.diagnostics.afterPartition,{issueCount:1,errorCount:1,issues:[{code:'NON_POSITIVE_VOLUME',severity:'error',kind:'body',index:0}]});},
    value=>value.preview.edges[0].points=[0,0],
    value=>value.preview.edges[0].points[0]=Infinity,
    value=>value.preview.edges=Array(1001).fill(value.preview.edges[0]),
    value=>value.preview.stats.triangleCount=2,
    value=>value.preview.positions[0]=NaN,
    value=>value.preview.indices=[0,0,2],
    value=>value.preview.normals=[],
  ];
  for(const damage of invalid){const value=diagnosticFixture();damage(value);assert.throws(()=>validatePreparation(value.diagnostics,diagnosticSource,value.preview),/报告无效/,damage.toString());}
});

test('source diagnostic selection requires its original persistent identity and prepared issues cannot pretend to be CAD faces',()=>{
  const value=diagnosticFixture(),body=diagnosticSource.bodies[0];
  const issue={code:'SMALL_EDGE',severity:'warning',kind:'edge',index:1,target:{...body,kind:'edge',topologyId:'edge-2-1'}};
  Object.assign(value.diagnostics.bodies[0].before,{issueCount:1,warningCount:1,smallEdgeCount:1,issues:[issue]});
  validatePreparation(value.diagnostics,diagnosticSource,value.preview);
  for(const damage of [target=>target.bodyIdentity='c'.repeat(32),target=>target.kind='face',target=>target.topologyId='edge-2-13',target=>target.topologyRevision=3]){
    const copy=structuredClone(value);damage(copy.diagnostics.bodies[0].before.issues[0].target);assert.throws(()=>validatePreparation(copy.diagnostics,diagnosticSource,copy.preview),/报告无效/);
  }
  const copied=structuredClone(value);Object.assign(copied.diagnostics.bodies[0].afterRepair,{issueCount:1,warningCount:1,issues:[issue]});assert.throws(()=>validatePreparation(copied.diagnostics,diagnosticSource,copied.preview),/来源身份/);
});

test('saved preparation revalidates report semantics even when file checksums match',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-preparation-schema-'));
  try{
    const store=new MeshJobStore(directory),job={jobId:'mesh-'+crypto.randomUUID(),documentId:diagnosticSource.documentId,kind:'preparation',state:'complete',source:diagnosticSource,options:{repairMode:'conservative',qualityThreshold:.2,deepCheck:false}};
    const write=value=>{const result={ok:true,requestId:job.jobId,preparation:value};job.artifact=store.writeResult(job,result);job.preparationSummary=preparationSummary(value.diagnostics);return result;};
    const good=write(diagnosticFixture());assert.deepEqual(store.readResult(job),good);
    const bad=diagnosticFixture();bad.preview.edges[0].points=null;write(bad);
    assert.throws(()=>store.readResult(job),/预览边线/);assert.equal(JSON.parse(fs.readFileSync(path.join(store.directory(job),'result.json'))).preparation.preview.edges[0].points,null,'Invalid evidence must remain on disk');
    write(diagnosticFixture());job.preparationSummary.warningCount=100;assert.throws(()=>store.readResult(job),/任务概要/);
    write(diagnosticFixture());job.options.repairMode='strict';assert.throws(()=>store.readResult(job),/任务设置/);
  }finally{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});}
});
