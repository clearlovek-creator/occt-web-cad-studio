import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {transactionFixture} from './helpers/project-transaction-fixture.mjs';
import {ProjectFileService} from '../gateway/project-file-service.mjs';
import {ModelingTaskService} from '../gateway/modeling-task-service.mjs';
import {encodeProjectPackage} from '../gateway/project-package.mjs';
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const bytes=()=>encodeProjectPackage({geometry:Buffer.from('BINFILE'+JSON.stringify({revision:9,name:'Opened project'})),propertySchema:{schemaVersion:1,types:[],instances:[]},sources:[],documentId:'source',revision:9});
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-project-open-life-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-project-open-life-/);fs.rmSync(root,{recursive:true,force:true});});
  const base=transactionFixture(root),id='target';
  await base.transactions.run(id,async()=>{base.schemas.createType(id,{key:'Original',fields:[]});await base.commit(id,'original');return {ok:true};});
  const before={history:base.history.get(id),schema:base.schemas.list(id),model:structuredClone(base.model())},warnings=[];
  const create=(options={})=>new ProjectFileService({dataDir:root,historyStore:base.history,propertySchemaStore:base.schemas,command:base.command,inspectSources:async()=>({metadataComplete:true,sources:[]}),onWarning:message=>warnings.push(message),...options});
  return {...base,id,before,warnings,create};
}
function restored(f){const after=f.history.get(f.id);assert.equal(after.current,f.before.history.current);assert.deepEqual(after.events,f.before.history.events);assert.deepEqual(f.schemas.list(f.id),f.before.schema);assert.deepEqual(f.model(),f.before.model);}
test('project open commits its exact original receipt with the same history and freezes caller receipt identity',async t=>{
  const f=await fixture(t),hold=deferred(),entered=deferred(),phases=[];
  const service=f.create({inspectSources:async()=>{entered.resolve();await hold.promise;return {metadataComplete:true,sources:[]};},onExecutionStart:()=>phases.push('executing'),onCommitStart:()=>phases.push('committing')});
  const receipt={key:'target:project.open:request',fingerprint:'a'.repeat(64)};
  const pending=service.open(f.id,bytes(),{receipt,decorateResult:(view,id,history)=>({...view,documentId:id,stateSequence:history.stateSequence,history:{eventId:history.events.at(-1).eventId}})});
  await entered.promise;assert.equal(service.hasUnconfirmed(f.id),true);assert.throws(()=>service.assertAvailable(f.id),{code:'PROJECT_RECOVERY_REQUIRED'});receipt.key='foreign';receipt.fingerprint='b'.repeat(64);hold.resolve();
  const result=await pending,history=f.history.get(f.id),entry=history.idempotency[0];
  assert.deepEqual(phases,['executing','committing']);assert.equal(result.name,'Opened project');assert.equal(result.stateSequence,history.stateSequence);
  assert.equal(entry.key,'target:project.open:request');assert.equal(entry.fingerprint,'a'.repeat(64));assert.deepEqual(f.history.readIdempotency(f.id,entry),result);
  f.setModel({revision:20,name:'Later model'});assert.equal(f.history.readIdempotency(f.id,entry).name,'Opened project');
  assert.equal(service.hasUnconfirmed(f.id),false);assert.equal(fs.existsSync(service.journalPath(f.id)),false);
});
test('invalid project-open receipt identity is rejected before any input assets or execution',async t=>{
  const f=await fixture(t),service=f.create();
  for(const receipt of [null,false,{}, {key:'other:project.open:r',fingerprint:'a'.repeat(64)},{key:'target:project.open:',fingerprint:'a'.repeat(64)},{key:'target:project.open:r',fingerprint:'x'}, {key:'target:project.open:r',fingerprint:'a'.repeat(64),response:{ok:true}}])await assert.rejects(service.open(f.id,bytes(),{receipt}),{code:'PROJECT_OPEN_RECEIPT_INVALID'});
  assert.deepEqual(fs.readdirSync(service.assets),[]);restored(f);
});
test('an interrupted opened model enters recovery without its cancelled signal and publishes proof only after full restoration',async t=>{
  const f=await fixture(t),tasks=new ModelingTaskService(f.root),meta={documentId:f.id,operation:'project.open',requestKey:'request',digest:'a'.repeat(64),outcomeFingerprint:'b'.repeat(64)},record=tasks.reserve(meta),task=tasks.claim(record.taskId,meta),hold=deferred(),entered=deferred();
  const service=f.create({onExecutionStart:()=>tasks.enterExecuting(),onCommitStart:()=>tasks.beginCommit(),onRecoveryStart:()=>tasks.beginRecovery(),command:async(operation,fields)=>{
    if(operation==='document.restore'&&path.basename(fields.parameters.path)==='model.xbf'){const value=await f.command(operation,fields);entered.resolve();await hold.promise;assert.equal(tasks.commandOptions().signal.aborted,true);throw Object.assign(Error('interrupted'),{code:'WORKER_CANCELLED',unused:value});}
    if(operation==='document.restore')assert.equal(tasks.commandOptions().signal,undefined,'Recovery must not inherit cancelled execution');return f.command(operation,fields);
  }});
  const pending=tasks.finish(task,tasks.runAction(task,()=>service.open(f.id,bytes()))),checked=assert.rejects(pending,error=>error.code==='WORKER_CANCELLED'&&error.projectRollback?.confirmed===true);
  await entered.promise;assert.equal(f.model().name,'Opened project');assert.equal(tasks.cancel(f.id,task.taskId).phase,'stopping');hold.resolve();await checked;
  restored(f);assert.equal(tasks.get(f.id,task.taskId).phase,'cancelled');assert.equal(tasks.get(f.id,task.taskId).restored,true);assert.equal(service.hasUnconfirmed(f.id),false);
});
test('same-size rollback snapshot replacement preserves recovery evidence and blocks another open, save or model access',async t=>{
  const f=await fixture(t),service=f.create({onCommitStart:()=>{const journal=JSON.parse(fs.readFileSync(service.journalPath(f.id),'utf8'));const original=fs.readFileSync(journal.rollbackPath),changed=Buffer.from(original);changed[changed.length-1]^=1;fs.writeFileSync(journal.rollbackPath,changed);throw Error('must roll back');}});
  await assert.rejects(service.open(f.id,bytes()),{code:'PROJECT_ROLLBACK_FAILED'});const journalBytes=fs.readFileSync(service.journalPath(f.id));
  assert.equal(service.hasUnconfirmed(f.id),true);assert.throws(()=>service.assertModelAccess(f.id),{code:'PROJECT_RECOVERY_REQUIRED'});
  await assert.rejects(service.open(f.id,bytes()),{code:'PROJECT_RECOVERY_REQUIRED'});await assert.rejects(service.save(f.id),{code:'PROJECT_RECOVERY_REQUIRED'});
  assert.deepEqual(fs.readFileSync(service.journalPath(f.id)),journalBytes);assert.equal(fs.readdirSync(service.assets).length,1);
  const restarted=f.create();restarted.recover();assert.equal(restarted.hasUnconfirmed(f.id),true);assert.deepEqual(fs.readFileSync(restarted.journalPath(f.id)),journalBytes);
});
test('recovery report failure cannot prevent rollback and native generation changes never commit an opened project',async t=>{
  const f=await fixture(t);let generation=1;
  const service=f.create({captureExecutionState:()=>generation,assertExecutionState:(_id,original)=>{if(original!==generation)throw Object.assign(Error('generation changed'),{code:'WORKER_INSTANCE_CHANGED'});},onRecoveryStart:()=>{throw Error('report unavailable');},command:async(operation,fields)=>{const result=await f.command(operation,fields);if(operation==='document.view')generation++;return result;}});
  await assert.rejects(service.open(f.id,bytes()),error=>error.code==='WORKER_INSTANCE_CHANGED'&&error.projectRollback?.confirmed===true);restored(f);assert.ok(f.warnings.some(value=>value.includes('phase report deferred')));
});
for(const outcome of ['committed','rolled-back'])test(`terminal ${outcome} cleanup survives missing rollback material and never reverts later project edits on restart`,async t=>{
  const f=await fixture(t),failure=Error('operation refused'),service=f.create({...(outcome==='rolled-back'?{onCommitStart:()=>{throw failure;}}:{})});
  service.finishFiles=(_id,journal)=>{fs.rmSync(journal.rollbackPath,{force:true});throw Error('cleanup deferred');};
  if(outcome==='committed')assert.equal((await service.open(f.id,bytes())).ok,true);else await assert.rejects(service.open(f.id,bytes()),error=>error===failure&&error.projectRollback.confirmed);
  const journal=JSON.parse(fs.readFileSync(service.journalPath(f.id),'utf8'));assert.equal(journal.phase,outcome);assert.equal(fs.existsSync(journal.rollbackPath),false);assert.equal(service.hasUnconfirmed(f.id),false);service.assertModelAccess(f.id);
  await f.transactions.run(f.id,async()=>{f.setModel({revision:30,name:'Later accepted edit'});await f.commit(f.id,'later');return {ok:true};});f.history.commit(f.id,{...f.history.get(f.id),undo:[],redo:[]});assert.equal(fs.existsSync(journal.beforeHistory.current),false);const later=f.history.get(f.id),schema=f.schemas.list(f.id);
  const restarted=f.create();restarted.recover();assert.equal(restarted.hasUnconfirmed(f.id),false);assert.equal(fs.existsSync(restarted.journalPath(f.id)),false);assert.deepEqual(f.history.get(f.id),later);assert.deepEqual(f.schemas.list(f.id),schema);assert.equal(f.model().name,'Later accepted edit');
});
