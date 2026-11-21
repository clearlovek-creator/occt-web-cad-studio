import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {SourceCheckpointCatalog} from '../gateway/source-checkpoint-catalog.mjs';
import {SourceAuditService} from '../gateway/source-audit-service.mjs';
import {SourceFileSwap} from '../gateway/source-file-swap.mjs';
import {SourceRestoreTransactions} from '../gateway/source-restore-transactions.mjs';
import {SourceRestoreService} from '../gateway/source-restore-service.mjs';

function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cad-restoration-catalog-')),target=path.join(dataDir,'imports','source.step');fs.mkdirSync(path.dirname(target));fs.writeFileSync(target,'damaged');
  const proof={validate:async()=>({signature:'a'.repeat(64),referenceCount:1,projects:['A','B']})},swap=new SourceFileSwap({dataDir,executablePath:path.resolve('geometry-worker/build/cad_source_file_swap.exe')}),transactions=new SourceRestoreTransactions({dataDir,proof,swap}),restores=new SourceRestoreService({dataDir,transactions,resolveAsset:()=>({target})}),catalog=new SourceCheckpointCatalog({dataDir});catalog.restorationCapture=options=>restores.catalogEvidence(options);
  const audit=new SourceAuditService({dataDir,scope:'storage',capture:(_id,options)=>catalog.storage(options),inspector:{inspect:()=>assert.fail('A private STEP catalog must never load geometry')}});
  t.after(async()=>{await restores.close();await audit.close();await swap.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const prepare=async()=>{const id='restore-'+randomUUID();await restores.upload(id,{scope:'current-undo-redo',documentId:'A',auditJobId:'test',assetId:'test',fileName:'source.step'},Readable.from(['original']));await restores.active?.promise;return id;};
  const run=async()=>{const job=audit.start('@storage');await audit.jobs.get(job.jobId).promise;return audit.get('@storage');};return {dataDir,target,transactions,restores,catalog,audit,prepare,run};
}

test('storage audits distinguish retained repair materials, verify their recorded bytes and never mark them as deletable inputs',async t=>{
  const f=fixture(t),id=await f.prepare(),record=f.transactions.read(id),report=await f.run();assert.equal(report.state,'complete');assert.equal(report.stale,false);assert.equal(report.coverageComplete,true);
  const rows=report.assets.filter(row=>row.retainedOnly);assert.equal(rows.length,2);assert.ok(rows.every(row=>row.status==='verified'&&row.referenceCount===0&&row.operationId===id));assert.deepEqual(rows[0].projects,['A','B']);assert.equal(report.cleanupAvailable,false);assert.equal(JSON.stringify(report).includes(f.dataDir),false);
  const privatePlan=await f.catalog.storage({includeRestorations:false});assert.equal(privatePlan.retainedSources.length,0);assert.equal([...privatePlan.metadataWatches.keys()].some(file=>file.includes('source-restores')),false,'The restoration dependency proof must not watch its own candidates or journals');
  fs.appendFileSync(path.join(f.dataDir,'source-restores',id,record.beforeArtifact),' changed backup');assert.equal(f.audit.get('@storage').stale,true);const changed=await f.run();assert.equal(changed.assets.find(row=>row.materialRole==='before').status,'changed');assert.equal(changed.integrityOK,false);
});

test('corrupt request metadata lowers coverage, remains preserved and becomes stale when repaired',async t=>{
  const f=fixture(t),id=await f.prepare(),file=f.restores.requestPath(id),bytes=fs.readFileSync(file);fs.writeFileSync(file,'{broken');const report=await f.run();assert.equal(report.coverageComplete,false);assert.ok(report.assets.some(row=>row.retainedOnly));assert.equal(fs.readFileSync(file,'utf8'),'{broken');
  fs.writeFileSync(file,bytes);assert.equal(f.audit.get('@storage').stale,true);assert.equal((await f.run()).coverageComplete,true);
});

test('partial and orphaned upload material remains visible without being certified as an original source',async t=>{
  const f=fixture(t),id='restore-'+randomUUID(),directory=f.transactions.directory(id);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'candidate.step'),'partial candidate');
  const report=await f.run();assert.equal(report.coverageComplete,false);assert.ok(report.issues.some(issue=>issue.code==='SOURCE_RESTORE_ORPHANED_MATERIAL'));const row=report.assets.find(item=>item.retainedOnly);assert.equal(row.status,'unreferenced');assert.equal(row.referenceCount,0);assert.equal(report.cleanupAvailable,false);assert.equal(fs.existsSync(path.join(directory,'candidate.step')),true);
});

test('actual displaced versions retain separate roles after real Windows commit and rollback',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t),id=await f.prepare();f.restores.action(id,'commit');await f.restores.active.promise;let report=await f.run();assert.equal(report.coverageComplete,true);assert.equal(report.stale,false);assert.equal(report.assets.filter(row=>row.retainedOnly).length,3);
  f.restores.action(id,'rollback');await f.restores.active.promise;report=await f.run();assert.equal(report.assets.filter(row=>row.retainedOnly).length,4);assert.ok(report.assets.filter(row=>row.retainedOnly).every(row=>row.status==='verified'));assert.equal(report.cleanupAvailable,false);
});
