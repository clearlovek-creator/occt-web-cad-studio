import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SourceAuditService} from '../gateway/source-audit-service.mjs';
import {readManagedStepSource,STEP_SOURCE_ALGORITHM} from '../gateway/step-source-integrity.mjs';

function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-source-audit-中文-'));
  fs.mkdirSync(path.join(root,'imports'));fs.mkdirSync(path.join(root,'history'));
  const file=path.join(root,'imports','原始.step');fs.writeFileSync(file,'ISO-10303-21; source proof');
  const actual=readManagedStepSource(file,root),reference={featureId:'feature-1',sourcePath:file,sourceFingerprint:actual.fingerprint,sourceFingerprintAlgorithm:STEP_SOURCE_ALGORITHM};
  const snapshots=['current','undo','redo'].map(scope=>{const file=path.join(root,'history',scope+'.xbf');fs.writeFileSync(file,'BINFILE'+scope);return{file,name:scope+'.xbf',scope,sha256:'a'.repeat(64)};});
  const metadata=new Map(snapshots.map(item=>[item.file,{metadataComplete:true,snapshotSha256:'a'.repeat(64),sources:[{...reference}]}]));
  let signature='initial';
  const plan={signature,revision:7,stateToken:'b'.repeat(64),checkpoints:snapshots,currentSources:[reference]};
  const service=new SourceAuditService({dataDir:root,inspector:{inspect:async file=>structuredClone(metadata.get(file))},capture:async()=>structuredClone(plan),signature:()=>signature,...options});
  t.after(async()=>{await service.close();assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  return{root,file,reference,plan,snapshots,metadata,service,changeSignature:()=>signature+='-changed'};
}
async function run(f,id='project'){const started=f.service.start(id);await f.service.jobs.get(started.jobId).promise;return f.service.get(id);}

test('current, Undo and Redo use actual checkpoint references without modifying files or exposing paths',async t=>{
  const f=fixture(t),before=fs.readFileSync(f.file),report=await run(f);
  assert.equal(report.state,'complete');assert.equal(report.integrityOK,true);assert.equal(report.coverageComplete,true);
  assert.equal(report.scope,'current-undo-redo');assert.equal(report.cleanupAvailable,false);
  const row=report.assets[0];assert.equal(row.referenceCount,3);assert.equal(row.currentReferences,1);assert.equal(row.undoReferences,1);assert.equal(row.redoReferences,1);
  assert.equal(row.status,'verified');assert.equal(report.completedCheckpoints,3);assert.equal(report.totalCheckpoints,3);
  assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(JSON.stringify(report).includes(f.root),false);
  row.references.length=0;assert.equal(f.service.get('project').assets[0].references.length,3,'Public reports must not mutate internal evidence');
});

test('a source valid now but changed relative to retained Undo is never reported as healthy',async t=>{
  const f=fixture(t);f.metadata.get(f.snapshots[1].file).sources[0].sourceFingerprint='0'.repeat(64);
  // Fixture records intentionally have independent metadata, as real XBF files do.
  f.metadata.set(f.snapshots[0].file,{metadataComplete:true,sources:[{...f.reference}]});
  f.metadata.set(f.snapshots[2].file,{metadataComplete:true,sources:[{...f.reference}]});
  const report=await run(f);assert.equal(report.integrityOK,false);assert.equal(report.assets[0].status,'changed');
  assert.equal(report.assets[0].references.find(item=>item.scope==='current').status,'verified');
  assert.equal(report.assets[0].references.find(item=>item.scope==='undo').status,'changed');
});

test('sources retained only by Undo remain in scope after all current geometry is deleted',async t=>{
  const f=fixture(t);f.metadata.set(f.snapshots[0].file,{metadataComplete:true,sources:[]});f.metadata.set(f.snapshots[2].file,{metadataComplete:true,sources:[]});f.plan.currentSources=[];
  const report=await run(f);assert.equal(report.assets.length,1);assert.equal(report.assets[0].currentReferences,0);assert.equal(report.assets[0].undoReferences,1);assert.equal(report.integrityOK,true);
});

test('missing, legacy and external source references are differentiated without reading arbitrary paths',async t=>{
  const f=fixture(t);fs.rmSync(f.file);
  const legacy=path.join(f.root,'imports','legacy.step');fs.writeFileSync(legacy,'legacy');
  for(const item of f.metadata.values())item.sources=[{...f.reference},{featureId:'feature-2',sourcePath:legacy},{featureId:'feature-3',sourcePath:path.join(f.root,'outside.step')}];
  const report=await run(f);assert.deepEqual(report.assets.map(item=>item.status),['missing','legacy-unverified','untrusted']);assert.equal(report.integrityOK,false);assert.equal(report.coverageComplete,true);
});

test('a bad or uncertified checkpoint leaves coverage incomplete rather than assuming no dependencies',async t=>{
  const f=fixture(t);f.snapshots[0].sha256=undefined;f.metadata.get(f.snapshots[1].file).metadataComplete=false;
  const original=f.service.inspector.inspect;f.service.inspector.inspect=async file=>{if(file===f.snapshots[2].file)throw Object.assign(new Error('private path '+f.root),{code:'SOURCE_SNAPSHOT_CHECKSUM'});return original(file);};
  const report=await run(f);assert.equal(report.state,'complete');assert.equal(report.coverageComplete,false);assert.equal(report.integrityOK,false);assert.equal(report.issues.length,3);assert.equal(JSON.stringify(report).includes(f.root),false);
  fs.appendFileSync(f.snapshots[2].file,'repaired-or-changed');assert.equal(f.service.get('project').stale,true,'A failed checkpoint must still be watched for later repairs');
});

test('history, STEP bytes and snapshot changes each invalidate an otherwise verified report',async t=>{
  const f=fixture(t);assert.equal((await run(f)).integrityOK,true);f.changeSignature();assert.equal(f.service.get('project').stale,true);assert.equal(f.service.get('project').integrityOK,false);
  f.plan.signature='initial-changed';assert.equal((await run(f)).integrityOK,true);fs.appendFileSync(f.file,'changed');assert.equal(f.service.get('project').stale,true);assert.equal(f.service.get('project').integrityOK,false);
  fs.writeFileSync(f.file,'ISO-10303-21; source proof');assert.equal((await run(f)).integrityOK,true);fs.appendFileSync(f.snapshots[0].file,'changed');assert.equal(f.service.get('project').stale,true);
});

test('explicit budgets fail closed, and empty new projects do not require a synthetic checkpoint',async t=>{
  const f=fixture(t,{maxReadBytes:1});const report=await run(f);assert.equal(report.integrityOK,false);assert.equal(report.assets[0].status,'unreadable');
  f.plan.checkpoints=[];f.plan.currentSources=[];f.plan.hasUnsnapshottedGeometry=false;assert.equal((await run(f)).integrityOK,true);
  f.plan.hasUnsnapshottedGeometry=true;assert.equal((await run(f)).coverageComplete,false);
  f.plan.checkpoints=Array.from({length:129},()=>f.snapshots[0]);const limited=await run(f);assert.equal(limited.state,'failed');assert.equal(limited.code,'SOURCE_AUDIT_LIMIT');
});

test('cancel waits for an unconfirmed native reader to really exit before becoming terminal',async t=>{
  const f=fixture(t);let exit,started;const ready=new Promise(resolve=>started=resolve),observed=new Promise(resolve=>exit=resolve);
  f.service.inspector.inspect=async(_file,{signal})=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('unconfirmed'),{code:'SOURCE_INSPECTOR_STOP_UNCONFIRMED',exitObserved:observed})),{once:true}));};
  const startedJob=f.service.start('project');await ready;assert.equal(f.service.cancel('project').state,'stopping');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.service.get('project').state,'stopping');
  exit();await f.service.jobs.get(startedJob.jobId).promise;assert.equal(f.service.get('project').state,'cancelled');assert.equal(f.service.get('project').integrityOK,false);
});

test('active requests deduplicate per project, are globally bounded and are not replayed on restart',async t=>{
  const f=fixture(t,{maxActive:1,maxRecords:2});let release;f.service.capture=()=>new Promise(resolve=>release=()=>resolve(structuredClone(f.plan)));
  const first=f.service.start('project');assert.equal(f.service.start('project').jobId,first.jobId);assert.throws(()=>f.service.start('other'),error=>error.code==='SOURCE_AUDIT_BUSY');
  await new Promise(resolve=>setImmediate(resolve));f.service.cancel('project');release();await f.service.jobs.get(first.jobId).promise;
  f.service.capture=async()=>structuredClone(f.plan);await run(f,'other');await run(f,'third');assert.ok(f.service.jobs.size<=2);
  await f.service.close();assert.throws(()=>f.service.start('project'),error=>error.code==='SERVICE_STOPPING');
  const fresh=new SourceAuditService();assert.equal(fresh.get('project'),null);await fresh.close();
});

test('project and storage inspectors share the same global admission limit',async t=>{
  const registry=new Set(),f=fixture(t,{activeRegistry:registry,maxActive:1});let release;f.service.capture=()=>new Promise(resolve=>release=()=>resolve(structuredClone(f.plan)));
  const storage=new SourceAuditService({scope:'storage',activeRegistry:registry,maxActive:1});t.after(()=>storage.close());
  const first=f.service.start('project');assert.throws(()=>storage.start('@storage'),error=>error.code==='SOURCE_AUDIT_BUSY');await new Promise(resolve=>setImmediate(resolve));release();await f.service.jobs.get(first.jobId).promise;assert.equal(registry.size,0);
});

test('one physical checkpoint is read once for multiple roles, and conflicting proofs are never picked by order',async t=>{
  const f=fixture(t);f.plan.checkpoints=[f.snapshots[0],{...f.snapshots[0],scope:'undo',name:'recovery copy'}];let reads=0;const original=f.service.inspector.inspect;f.service.inspector.inspect=async(...args)=>{reads++;return original(...args);};
  const report=await run(f);assert.equal(reads,1);assert.equal(report.completedCheckpoints,2);assert.equal(report.assets[0].currentReferences,1);assert.equal(report.assets[0].undoReferences,1);
  f.plan.checkpoints[1].sha256='b'.repeat(64);const conflict=await run(f);assert.equal(reads,1);assert.equal(conflict.coverageComplete,false);assert.equal(conflict.integrityOK,false);assert.equal(conflict.issues[0].code,'SOURCE_CHECKPOINT_PROOF_CONFLICT');
});

test('reference data and cached reports have byte budgets, not only row-count limits',async t=>{
  const references=fixture(t,{maxReferenceBytes:1}),overflow=await run(references);assert.equal(overflow.state,'failed');assert.equal(overflow.code,'SOURCE_AUDIT_LIMIT');assert.equal(overflow.integrityOK,false);
  const retained=fixture(t,{maxRetainedBytes:100}),report=await run(retained);assert.equal(report.state,'failed');assert.equal(report.code,'SOURCE_AUDIT_LIMIT');assert.deepEqual(report.assets,[]);assert.equal(retained.service.jobs.get(report.jobId).watches.size,0);
});
