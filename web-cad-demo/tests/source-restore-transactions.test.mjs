import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {stopTestChild} from './helpers/stop-test-child.mjs';
import {SourceFileSwap} from '../gateway/source-file-swap.mjs';
import {SourceRestoreTransactions} from '../gateway/source-restore-transactions.mjs';
const executablePath=path.resolve('geometry-worker/build/cad_source_file_swap.exe');
async function fixture(t,{missing=false}={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cad-restore-transaction-中文-')),operationId='restore-'+randomUUID(),directory=path.join(dataDir,'source-restores',operationId),target=path.join(dataDir,'imports','original.step');
  fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(path.dirname(target));fs.writeFileSync(path.join(directory,'candidate.step'),'verified original');if(!missing)fs.writeFileSync(target,'damaged source');
  const calls=[],proof={signature:'a'.repeat(64),async validate(file,candidate){calls.push({file,candidate});return {signature:this.signature,referenceCount:2,projects:['A','B']};}},swap=new SourceFileSwap({dataDir,executablePath}),transactions=new SourceRestoreTransactions({dataDir,proof,swap});
  t.after(async()=>{await transactions.close();await swap.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  return {dataDir,operationId,directory,target,calls,proof,swap,transactions,record:()=>JSON.parse(fs.readFileSync(path.join(directory,'record.json'),'utf8'))};
}
const native={skip:process.platform!=='win32'};

test('a real source replacement commits once, survives reload and rolls back without losing either version',native,async t=>{
  const f=await fixture(t);const prepared=await f.transactions.prepare(f);assert.equal(prepared.canCommit,true);assert.equal(fs.readFileSync(f.target,'utf8'),'damaged source');assert.equal(JSON.stringify(prepared).includes(f.dataDir),false);
  const old=f.record().beforeArtifact;assert.equal(fs.readFileSync(path.join(f.directory,old),'utf8'),'damaged source');
  const committed=await f.transactions.commit(f.operationId);assert.equal(committed.state,'committed');assert.equal(committed.canRollback,true);assert.equal(fs.readFileSync(f.target,'utf8'),'verified original');const attempts=f.record().attempts.length;
  assert.equal((await f.transactions.commit(f.operationId)).state,'committed');assert.equal(f.record().attempts.length,attempts,'Lost replies must not cause a second file replacement');
  const restarted=new SourceRestoreTransactions({dataDir:f.dataDir,proof:f.proof,swap:f.swap});await restarted.recover();assert.equal(restarted.get(f.operationId).state,'committed');
  const rolled=await restarted.rollback(f.operationId);assert.equal(rolled.state,'rolled-back');assert.equal(fs.readFileSync(f.target,'utf8'),'damaged source');assert.equal(fs.readFileSync(path.join(f.directory,old),'utf8'),'damaged source');assert.equal(fs.readFileSync(path.join(f.directory,'candidate.step'),'utf8'),'verified original');
  const retained=f.record().attempts.map(item=>fs.readFileSync(path.join(f.directory,item.backup),'utf8'));assert.deepEqual(retained,['damaged source','verified original']);
  assert.equal((await restarted.rollback(f.operationId)).state,'rolled-back');await restarted.close();
});

test('a missing nested STEP can be restored and rollback retires it without deleting the restored bytes',native,async t=>{
  const f=await fixture(t,{missing:true});f.target=path.join(f.dataDir,'project-assets','lost','original.step');
  await f.transactions.prepare(f);assert.equal(fs.existsSync(path.dirname(f.target)),false);assert.equal((await f.transactions.commit(f.operationId)).state,'committed');assert.equal(fs.readFileSync(f.target,'utf8'),'verified original');
  assert.equal((await f.transactions.rollback(f.operationId)).state,'rolled-back');assert.equal(fs.existsSync(f.target),false);const attempt=f.record().attempts.at(-1);assert.equal(fs.readFileSync(path.join(f.directory,attempt.backup),'utf8'),'verified original');
});

test('reference changes, changed candidate and external source edits cannot reuse a prepared file plan',native,async t=>{
  const f=await fixture(t);await f.transactions.prepare(f);f.proof.signature='b'.repeat(64);await assert.rejects(f.transactions.commit(f.operationId),{code:'SOURCE_RESTORE_STALE'});assert.equal(f.record().attempts.length,0);
  f.proof.signature='a'.repeat(64);fs.writeFileSync(path.join(f.directory,'candidate.step'),'different file');await assert.rejects(f.transactions.commit(f.operationId),{code:'SOURCE_RESTORE_CANDIDATE_CHANGED'});assert.equal(fs.readFileSync(f.target,'utf8'),'damaged source');
  fs.writeFileSync(path.join(f.directory,'candidate.step'),'verified original');fs.writeFileSync(f.target,'external edit');await assert.rejects(f.transactions.commit(f.operationId),{code:'SOURCE_RESTORE_STALE'});assert.equal(fs.readFileSync(f.target,'utf8'),'external edit');
});

test('a lost native reply after actual replacement is reconciled to the original version, never blindly retried',native,async t=>{
  const f=await fixture(t);await f.transactions.prepare(f);const original=f.swap.swap.bind(f.swap);let count=0;
  f.swap.swap=async args=>{const result=await original(args);if(++count===1)throw Object.assign(Error('reply lost'),{code:'SOURCE_SWAP_OUTCOME_UNKNOWN'});return result;};
  const result=await f.transactions.commit(f.operationId);assert.equal(result.state,'prepared');assert.equal(result.errorCode,'SOURCE_SWAP_OUTCOME_UNKNOWN');assert.match(result.recovery,/未自动继续/);assert.equal(count,2);assert.equal(fs.readFileSync(f.target,'utf8'),'damaged source');
  const attempt=f.record().attempts[0];assert.equal(fs.readFileSync(path.join(f.directory,attempt.backup),'utf8'),'damaged source');assert.equal(fs.readFileSync(path.join(f.directory,attempt.recoveryBackup),'utf8'),'verified original');
});

test('startup reconciles an interrupted partial Windows rename without requiring a readable target',native,async t=>{
  const f=await fixture(t);await f.transactions.prepare(f);const save=f.transactions.save.bind(f.transactions);let intercepted=false;
  f.transactions.save=record=>{
    save(record);if(record.state==='activating'&&!intercepted){intercepted=true;const attempt=record.attempts.at(-1);fs.renameSync(f.target,path.join(f.directory,attempt.backup));throw Error('simulated process loss after old-file rename');}
  };
  await assert.rejects(f.transactions.commit(f.operationId),/simulated process loss/);assert.equal(fs.existsSync(f.target),false);assert.equal(f.record().state,'activating');
  const restarted=new SourceRestoreTransactions({dataDir:f.dataDir,proof:f.proof,swap:f.swap});const results=await restarted.recover();assert.equal(results[0].state,'prepared');assert.equal(fs.readFileSync(f.target,'utf8'),'damaged source');assert.equal(f.record().attempts.length,1);await restarted.close();
});

test('a changed actual native backup or unexpected target is held for review instead of guessed rollback',native,async t=>{
  const f=await fixture(t);await f.transactions.prepare(f);const original=f.swap.swap.bind(f.swap);
  f.swap.swap=async args=>{fs.writeFileSync(args.target,'external version just before native replacement');return original(args);};
  const result=await f.transactions.commit(f.operationId);assert.equal(result.state,'attention');assert.equal(result.canCommit,false);assert.equal(result.canRollback,false);assert.equal(result.errorCode,'SOURCE_RESTORE_BACKUP_MISMATCH');assert.equal(fs.readFileSync(f.target,'utf8'),'verified original');
  const attempt=f.record().attempts[0];assert.equal(fs.readFileSync(path.join(f.directory,attempt.backup),'utf8'),'external version just before native replacement');assert.equal(fs.readFileSync(path.join(f.directory,f.record().beforeArtifact),'utf8'),'damaged source');await assert.rejects(f.transactions.commit(f.operationId),{code:'SOURCE_RESTORE_NOT_READY'});
});

test('committed restores cannot roll back across new references; record corruption and retention limits do not trigger cleanup',native,async t=>{
  const f=await fixture(t);await f.transactions.prepare(f);await f.transactions.commit(f.operationId);f.proof.signature='c'.repeat(64);await assert.rejects(f.transactions.rollback(f.operationId),{code:'SOURCE_RESTORE_STALE'});assert.equal(fs.readFileSync(f.target,'utf8'),'verified original');
  const saved=fs.readFileSync(path.join(f.directory,'record.json'));fs.writeFileSync(path.join(f.directory,'record.json'),JSON.stringify({...f.record(),targetRelative:'../outside.step'}));assert.throws(()=>f.transactions.get(f.operationId),{code:'SOURCE_RESTORE_RECORD_INVALID'});fs.writeFileSync(path.join(f.directory,'record.json'),saved);
  f.transactions.maxRetainedBytes=1;await assert.rejects(f.transactions.recover(),{code:'SOURCE_RESTORE_LIMIT'});assert.deepEqual(fs.readFileSync(path.join(f.directory,'record.json')),saved);assert.equal(fs.readFileSync(f.target,'utf8'),'verified original');
});

test('explicit revalidation can accept a new reference set, but cannot adopt changed existing bytes',native,async t=>{
  const f=await fixture(t);await f.transactions.prepare(f);f.proof.signature='d'.repeat(64);await assert.rejects(f.transactions.commit(f.operationId),{code:'SOURCE_RESTORE_STALE'});
  assert.equal((await f.transactions.revalidate(f.operationId)).state,'prepared');assert.equal((await f.transactions.commit(f.operationId)).state,'committed');
  await assert.rejects(f.transactions.revalidate(f.operationId),{code:'SOURCE_RESTORE_NOT_READY'});
  await f.transactions.rollback(f.operationId);
});

test('a failed durable commit record restores before bytes and a prior attention state remains blocking after restart',native,async t=>{
  const f=await fixture(t);await f.transactions.prepare(f);const save=f.transactions.save.bind(f.transactions);let failed=false;
  f.transactions.save=record=>{if(record.state==='committed'&&!failed){failed=true;throw Object.assign(Error('disk commit refused'),{code:'EACCES'});}return save(record);};
  const result=await f.transactions.commit(f.operationId);assert.equal(result.state,'prepared');assert.equal(result.errorCode,'EACCES');assert.equal(fs.readFileSync(f.target,'utf8'),'damaged source');
  const record=f.record();record.state='attention';record.errorCode='SOURCE_RESTORE_EXTERNAL_CHANGE';save(record);
  const restarted=new SourceRestoreTransactions({dataDir:f.dataDir,proof:f.proof,swap:f.swap});const records=await restarted.recover();assert.equal(records.length,1);assert.equal(records[0].state,'attention');assert.equal(records[0].blocking,true,'A prior attention state cannot disappear from startup admission');await restarted.close();
});

test('a later repair supersedes old file ownership; restart cannot misclassify the earlier version as an external edit',native,async t=>{
  const f=await fixture(t);await f.transactions.prepare(f);await f.transactions.commit(f.operationId);
  const second='restore-'+randomUUID(),directory=path.join(f.dataDir,'source-restores',second);fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'candidate.step'),'verified original');
  // The same source may be damaged again months after its first recovery.
  fs.writeFileSync(f.target,'new damage');await f.transactions.prepare({operationId:second,target:f.target});
  assert.equal(f.transactions.get(f.operationId).canRollback,false);assert.equal(f.transactions.get(f.operationId).supersededBy,second);await assert.rejects(f.transactions.rollback(f.operationId),{code:'SOURCE_RESTORE_SUPERSEDED'});
  await f.transactions.commit(second);const records=await f.transactions.recover();assert.deepEqual(records.map(item=>item.state),['committed','committed']);assert.equal(records.some(item=>item.blocking),false);
  await f.transactions.rollback(second);assert.equal(fs.readFileSync(f.target,'utf8'),'new damage');assert.equal((await f.transactions.recover()).some(item=>item.blocking),false);assert.equal(f.transactions.get(f.operationId).canRollback,false);
});

test('real process termination after native swap reconciles commit and rollback without publishing a false success',native,async t=>{
  for(const missing of [false,true]){
    const f=await fixture(t,{missing});await f.transactions.prepare(f);
    const crash=async action=>{
      const child=spawn(process.execPath,[path.resolve('tests/fixtures/source-restore-crash-fixture.mjs'),f.dataDir,f.operationId,action],{windowsHide:true,stdio:['ignore','pipe','pipe']});let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);child.stdout.resume();
      try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Crash fixture did not exit')),10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);try{assert.equal(code,88,diagnostic);resolve();}catch(error){reject(error);}});});}finally{await stopTestChild(child);}
    };
    await crash('commit');assert.equal(f.record().state,'activating');assert.equal(fs.readFileSync(f.target,'utf8'),'verified original');
    let records=await f.transactions.recover();assert.equal(records[0].state,'prepared');assert.equal(fs.existsSync(f.target),!missing);if(!missing)assert.equal(fs.readFileSync(f.target,'utf8'),'damaged source');
    await f.transactions.commit(f.operationId);await crash('rollback');assert.equal(f.record().state,'reverting');assert.equal(fs.existsSync(f.target),!missing);if(!missing)assert.equal(fs.readFileSync(f.target,'utf8'),'damaged source');
    records=await f.transactions.recover();assert.equal(records[0].state,'committed');assert.equal(fs.readFileSync(f.target,'utf8'),'verified original');
    assert.equal(records[0].canRollback,true);assert.ok(f.record().attempts.every(attempt=>attempt.start.status==='missing'||fs.existsSync(path.join(f.directory,attempt.backup))));
  }
});
