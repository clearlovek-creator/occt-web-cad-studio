import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {denyWindowsFileReplacement} from './helpers/windows-file-sharing.mjs';
import {ModelingTaskService} from '../gateway/modeling-task-service.mjs';
import {writeTaskRecord} from '../gateway/task-record-file.mjs';
const meta={documentId:'private-task',operation:'feature.update',requestKey:'private-request',digest:'a'.repeat(64),outcomeFingerprint:'b'.repeat(64)};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-task-record-')),warnings=[],service=new ModelingTaskService(root,{onWarning:message=>warnings.push(message)}),fixture={root,service,warnings,retain:false};t.after(()=>{assert.equal(fixture.retain,false,'Owned child exit unconfirmed; data retained: '+root);assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-task-record-/);fs.rmSync(root,{recursive:true,force:true});});return fixture;}
test('a successfully published task record does not fail because of a redundant temporary-file cleanup',t=>{
  const f=fixture(t),remove=fs.rmSync;let unnecessary=0;
  t.mock.method(fs,'rmSync',(file,options)=>{if(typeof file==='string'&&file.startsWith(f.service.root+path.sep)&&file.endsWith('.tmp')&&!fs.existsSync(file)){unnecessary++;throw Object.assign(Error('Simulated scanner cleanup denial'),{code:'EBUSY'});}return remove(file,options);});
  const record=f.service.reserve(meta);assert.equal(record.phase,'reserved');assert.equal(f.service.get(meta.documentId,record.taskId).reportDurable,true);assert.equal(unnecessary,0);assert.equal(JSON.parse(fs.readFileSync(f.service.file(record.taskId))).taskId,record.taskId);
});
test('exclusive-create failure never removes an existing temporary file owned by someone else',t=>{
  const f=fixture(t),open=fs.openSync;let trapped=false,collision;
  t.mock.method(fs,'openSync',(file,flags,...args)=>{if(!trapped&&flags==='wx'&&String(file).startsWith(f.service.root+path.sep)&&String(file).endsWith('.tmp')){trapped=true;collision=String(file);fs.writeFileSync(collision,'retained foreign bytes',{flag:'wx'});throw Object.assign(Error('Existing material'),{code:'EEXIST'});}return open(file,flags,...args);});
  assert.throws(()=>f.service.reserve(meta),{code:'MODELING_TASK_REPORT_UNAVAILABLE'});assert.equal(fs.readFileSync(collision,'utf8'),'retained foreign bytes');assert.equal(f.service.records.size,0);
});
test('a replacement that completed before reporting an error is reconciled from exact staged identity without retry',t=>{
  const f=fixture(t),rename=fs.renameSync;let writes=0;
  t.mock.method(fs,'renameSync',(source,target)=>{if(String(target).startsWith(f.service.root+path.sep)){writes++;rename(source,target);throw Object.assign(Error('Outcome observation lost'),{code:'EIO'});}return rename(source,target);});
  const record=f.service.reserve(meta);assert.equal(record.phase,'reserved');assert.equal(writes,1);assert.equal(f.service.status().persistence.reconciled,1);assert.equal(f.service.get(meta.documentId,record.taskId).reportDurable,true);
});
test('a failed replacement preserves the previous record and exposes bounded path-free stage diagnostics',t=>{
  const f=fixture(t),record=f.service.reserve(meta),file=f.service.file(record.taskId),before=fs.readFileSync(file),rename=fs.renameSync;
  t.mock.method(fs,'renameSync',(source,target)=>{if(target===file)throw Object.assign(Error('SECRET '+file),{code:'EPERM'});return rename(source,target);});
  assert.throws(()=>f.service.cancel(meta.documentId,record.taskId),error=>{assert.equal(error.code,'MODELING_TASK_REPORT_UNAVAILABLE');assert.equal(error.details.taskPersistence.stage,'replace');assert.equal(error.details.taskPersistence.ioCode,'EPERM');assert.equal(error.retryableByModel,false);return true;});
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(f.service.get(meta.documentId,record.taskId).phase,'reserved');assert.doesNotMatch(JSON.stringify(f.service.status()),/SECRET|cad-task-record-|private-request/);
});

test('cleanup failure cannot conceal the original write error and retained evidence blocks a restart',t=>{
  const f=fixture(t),write=fs.writeFileSync,unlink=fs.unlinkSync;
  t.mock.method(fs,'writeFileSync',(file,...args)=>{if(typeof file==='number')throw Object.assign(Error('SECRET failed write'),{code:'ENOSPC'});return write(file,...args);});
  t.mock.method(fs,'unlinkSync',file=>{if(String(file).startsWith(f.service.root+path.sep))throw Object.assign(Error('SECRET cleanup'),{code:'EPERM'});return unlink(file);});
  assert.throws(()=>f.service.reserve(meta),error=>{assert.equal(error.details.taskPersistence.stage,'write');assert.equal(error.details.taskPersistence.ioCode,'ENOSPC');assert.equal(error.details.taskPersistence.cleanup,'failed');return true;});
  assert.equal(fs.readdirSync(f.service.root).length,1);assert.throws(()=>new ModelingTaskService(f.root),{code:'MODELING_TASK_STORE_UNAVAILABLE'});assert.doesNotMatch(JSON.stringify(f.service.status())+f.warnings.join(''),/SECRET|cad-task-record-|private-request/);
});

test('equal bytes published from a different file are not accepted as our rename outcome',t=>{
  const f=fixture(t),rename=fs.renameSync;let foreign;
  t.mock.method(fs,'renameSync',(source,target)=>{if(String(target).startsWith(f.service.root+path.sep)){foreign=target;fs.writeFileSync(target,fs.readFileSync(source),{flag:'wx'});fs.unlinkSync(source);throw Object.assign(Error('Ambiguous replacement'),{code:'EIO'});}return rename(source,target);});
  assert.throws(()=>f.service.reserve(meta),error=>{assert.equal(error.details.taskPersistence.publication,'unconfirmed');return true;});assert.ok(fs.existsSync(foreign));assert.equal(f.service.records.size,0);assert.equal(f.service.status().persistence.reconciled,0);
});

test('a temporary path replaced by someone else is retained instead of deleted during cleanup',t=>{
  const f=fixture(t);let temporary,retained;
  t.mock.method(fs,'fsyncSync',()=>{temporary=path.join(f.service.root,fs.readdirSync(f.service.root).find(name=>name.endsWith('.tmp')));retained=temporary+'.retained';fs.renameSync(temporary,retained);fs.writeFileSync(temporary,'foreign replacement',{flag:'wx'});throw Object.assign(Error('Sync denied'),{code:'EIO'});});
  assert.throws(()=>f.service.reserve(meta),error=>{assert.equal(error.details.taskPersistence.stage,'sync');assert.equal(error.details.taskPersistence.cleanup,'retained');return true;});assert.equal(fs.readFileSync(temporary,'utf8'),'foreign replacement');assert.ok(fs.existsSync(retained));
});

test('oversized records are rejected before opening a temporary file, matching the bounded reader',t=>{
  const f=fixture(t);assert.throws(()=>writeTaskRecord(path.join(f.service.root,'bounded.json'),{payload:'x'.repeat(32768)}),{stage:'encode',ioCode:'EFBIG',publication:'not-started'});assert.deepEqual(fs.readdirSync(f.service.root),[]);
});

test('throwing warning callbacks cannot change strict errors or interrupt geometry recovery',async t=>{
  const f=fixture(t),record=f.service.reserve(meta),task=f.service.claim(record.taskId,meta),rename=fs.renameSync;f.service.onWarning=()=>{throw Error('SECRET auxiliary logger');};
  await f.service.runAction(task,async()=>{f.service.enterExecuting();t.mock.method(fs,'renameSync',(source,target)=>{if(String(target).startsWith(f.service.root+path.sep))throw Object.assign(Error('SECRET rename'),{code:'EBUSY'});return rename(source,target);});f.service.beginRecovery();assert.equal(f.service.commandOptions().signal,undefined);assert.equal(f.service.get(meta.documentId,task.taskId).reportDurable,false);});
  assert.equal(f.service.status().persistence.lastFailure.ioCode,'EBUSY');assert.doesNotMatch(JSON.stringify(f.service.status()),/SECRET/);
});

test('Windows sharing denial preserves the old phase and requires an explicit new action after release',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const f=fixture(t),record=f.service.reserve(meta),file=f.service.file(record.taskId),before=fs.readFileSync(file);
  let lock;
  try{
    lock=await denyWindowsFileReplacement(file);
    assert.throws(()=>f.service.cancel(meta.documentId,record.taskId),error=>{assert.equal(error.code,'MODELING_TASK_REPORT_UNAVAILABLE');assert.equal(error.details.taskPersistence.stage,'replace');assert.ok(['EPERM','EACCES','EBUSY'].includes(error.details.taskPersistence.ioCode));return true;});
    assert.deepEqual(fs.readFileSync(file),before);assert.equal(f.service.get(meta.documentId,record.taskId).phase,'reserved');assert.equal(f.service.status().persistence.attempts,2);
  }catch(error){if(error.retainData)f.retain=true;throw error;}finally{if(lock)try{await lock.release();}catch(error){if(error.retainData)f.retain=true;throw error;}}
  assert.equal(f.service.cancel(meta.documentId,record.taskId).phase,'cancelled');assert.equal(f.service.status().persistence.attempts,3);assert.equal(fs.readdirSync(f.service.root).length,1);
});
