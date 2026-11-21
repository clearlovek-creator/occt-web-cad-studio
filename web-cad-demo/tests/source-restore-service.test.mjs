import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable,PassThrough} from 'node:stream';
import {SourceAccessGate} from '../gateway/source-access-gate.mjs';
import {SourceFileSwap} from '../gateway/source-file-swap.mjs';
import {SourceRestoreTransactions} from '../gateway/source-restore-transactions.mjs';
import {SourceRestoreService,sourceRestoreFailure} from '../gateway/source-restore-service.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cad-source-service-')),target=path.join(dataDir,'imports','source.step');fs.mkdirSync(path.dirname(target));fs.writeFileSync(target,'damaged');
  const gate=new SourceAccessGate(),proof={async validate(){return {signature:'a'.repeat(64),referenceCount:1,projects:['A']};}},swap=new SourceFileSwap({dataDir,executablePath:path.resolve('geometry-worker/build/cad_source_file_swap.exe')}),transactions=new SourceRestoreTransactions({dataDir,proof,swap,gate});
  const service=new SourceRestoreService({dataDir,transactions,resolveAsset:()=>({target,fileName:'source.step'})});
  t.after(async()=>{await service.close();await swap.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const metadata={scope:'current-undo-redo',documentId:'A',auditJobId:'test',assetId:'test',fileName:'source.step'},id=()=> 'restore-'+randomUUID();
  return {dataDir,target,gate,proof,swap,transactions,service,metadata,id};
}

test('shutdown waits for the complete upload-to-validation handoff, not only the last uploaded byte',async t=>{
  const f=fixture(t),entered=deferred(),release=deferred(),id=f.id();f.proof.validate=async()=>{entered.resolve();await release.promise;return {signature:'a'.repeat(64),referenceCount:1,projects:['A']};};
  await f.service.upload(id,f.metadata,Readable.from([Buffer.from('original')]));await entered.promise;
  let stopped=false;const closing=f.service.close().then(()=>{stopped=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);assert.equal(f.service.health().active.action,'prepare');
  release.resolve();await closing;assert.equal(f.service.get(id).state,'prepared');assert.equal(fs.readFileSync(f.target,'utf8'),'damaged');assert.equal(f.service.active,null);await assert.rejects(f.service.upload(f.id(),f.metadata,Readable.from(['other'])),{code:'SERVICE_STOPPING'});
});

test('an interrupted upload remains queryable and cannot be revalidated as if its partial file were complete',async t=>{
  const f=fixture(t),id=f.id(),input=new PassThrough(),uploading=f.service.upload(id,f.metadata,input);input.write('partial');
  const rejected=assert.rejects(uploading,{code:'SERVICE_STOPPING'});
  while(!fs.existsSync(path.join(f.dataDir,'source-restores',id,'candidate.step')))await new Promise(resolve=>setImmediate(resolve));
  await f.service.close();await rejected;const result=f.service.get(id);assert.equal(result.uploadComplete,false);assert.equal(result.canRevalidate,false);assert.equal(result.canCommit,false);assert.equal(fs.readFileSync(f.target,'utf8'),'damaged');
});

test('the shared gate drains modeling before activation and holds later model access until the actual file replacement completes',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t),id=f.id();await f.service.upload(id,f.metadata,Readable.from(['original']));await f.service.active?.promise;
  const first=deferred(),proofEntered=deferred(),proofRelease=deferred(),events=[];
  const reading=f.gate.read(async()=>{events.push('model-before');await first.promise;});
  f.proof.validate=async()=>{events.push('restore-proof');proofEntered.resolve();await proofRelease.promise;return {signature:'a'.repeat(64),referenceCount:1,projects:['A']};};
  f.service.action(id,'commit');const committing=f.service.active.promise;
  // Let the service dispatch its real transaction before queuing a later reader.
  await Promise.resolve();await Promise.resolve();
  const later=f.gate.read(()=>{events.push('model-after');assert.equal(fs.readFileSync(f.target,'utf8'),'original');});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['model-before']);first.resolve();await reading;await proofEntered.promise;assert.deepEqual(events,['model-before','restore-proof']);assert.equal(f.service.get(id).serviceBusy,true);
  proofRelease.resolve();await Promise.all([committing,later]);assert.deepEqual(events,['model-before','restore-proof','model-after']);assert.equal(f.service.get(id).state,'committed');
});

test('unknown filesystem errors are sanitized and candidate paths never enter ordinary error messages',()=>{
  const failure=sourceRestoreFailure(Object.assign(Error('EPERM C:\\private\\secret.step sk-secret'),{code:'EPERM'}));assert.equal(failure.code,'EPERM');assert.equal(failure.error.includes('private'),false);assert.equal(failure.error.includes('sk-secret'),false);
});

test('record queries never scan ephemeral native stage files or convert their rename into a missing operation',async t=>{
  const f=fixture(t),id=f.id();await f.service.upload(id,f.metadata,Readable.from(['original']));await f.service.active?.promise;
  const stage=path.join(f.dataDir,'source-restores',id,'stage-'+randomUUID()+'.step');fs.writeFileSync(stage,'native stage');
  const original=fs.lstatSync;let observed=false;
  fs.lstatSync=(file,...options)=>{if(path.resolve(String(file))===stage){observed=true;fs.renameSync(stage,stage+'.moved');throw Object.assign(Error('native rename raced a material scan'),{code:'ENOENT'});}return original(file,...options);};
  try{assert.equal(f.service.get(id).state,'prepared');assert.equal(f.service.list().items[0].operationId,id);assert.equal(observed,false,'Read-only status must not enumerate or certify mutable stage material');}
  finally{fs.lstatSync=original;}
  f.transactions.maxRetainedBytes=1;assert.throws(()=>f.transactions.budget(),{code:'SOURCE_RESTORE_LIMIT'},'Writes still enforce retained-material quotas');
});

test('upload quotas count incoming bytes without rescanning the complete retained archive for each network chunk',async t=>{
  const f=fixture(t),id=f.id(),budget=f.transactions.budget.bind(f.transactions);let scans=0;f.transactions.budget=(...args)=>{scans++;return budget(...args);};
  await f.service.upload(id,f.metadata,Readable.from(Array.from({length:200},()=>Buffer.alloc(512,1))));await f.service.active?.promise;
  assert.equal(f.service.get(id).state,'prepared');assert.ok(scans<20,`Unexpected per-chunk retained-directory scans: ${scans}`);assert.equal(fs.statSync(path.join(f.dataDir,'source-restores',id,'candidate.step')).size,200*512);
});
