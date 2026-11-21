import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {validatePreparation} from '../gateway/mesh-preparation-report.mjs';

test('native dirty-geometry corpus records real defects, bounded issues and verified ShapeFix repair in Unicode paths',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-diagnostics-中文-'));
  const worker=process.env.GEOMETRY_WORKER_PATH||path.resolve('geometry-worker/build/occt_geometry_worker.exe');
  const env={...process.env},inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;env.PATH=[path.resolve('../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  try{
    const run=spawnSync(path.join(path.dirname(worker),'mesh_diagnostics_tests.exe'),[],{env,windowsHide:true,encoding:'utf8',input:JSON.stringify({directory})+'\n',timeout:30000});
    assert.equal(run.status,0,`${run.error?.message||''}\n${run.stderr}\n${run.stdout}`);
    const cases=JSON.parse(fs.readFileSync(path.join(directory,'corpus.json'))),byId=new Map(cases.map(item=>[item.id,item]));
    assert.equal(cases.length,8);for(const item of cases.filter(item=>item.file))assert.ok(fs.statSync(path.join(directory,item.file)).size>0);
    const repaired=byId.get('same-parameter-repaired').report;assert.equal(repaired.status,'ready');assert.ok(repaired.bodies[0].before.errorCount>0);assert.equal(repaired.bodies[0].afterRepair.errorCount,0);
    const source={bodies:[{bodyId:'body-1',bodyIdentity:'a'.repeat(32),topologyIdentity:'b'.repeat(32),topologyRevision:1}]};assert.equal(validatePreparation(repaired,source).status,'ready');
    for(const corrupt of [report=>report.bodies[0].before.valid='true',report=>report.stage='unknown',report=>report.bodies[0].before.issues[0].target.bodyIdentity='0'.repeat(32)]){const damaged=structuredClone(repaired);corrupt(damaged);assert.throws(()=>validatePreparation(damaged,source),/报告无效/);}
    for(const item of cases.filter(item=>item.diagnostics)){assert.ok(item.diagnostics.issues.length<=128);assert.equal(item.diagnostics.selfIntersectionCheck,'complete');for(const issue of item.diagnostics.issues)if(issue.target)assert.equal(issue.target.bodyIdentity,'a'.repeat(32));}
    assert.ok(byId.get('small-edges-sliver-faces').diagnostics.warningCount>0);assert.equal(byId.get('healthy-box').diagnostics.errorCount,0);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
