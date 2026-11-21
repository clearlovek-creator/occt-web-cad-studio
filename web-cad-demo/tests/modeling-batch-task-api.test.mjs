import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';

const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cad-batch-task-api-'));
function clean(data){assert.equal(path.dirname(path.resolve(data)),path.resolve(os.tmpdir()));assert.ok(path.basename(data).startsWith('cad-batch-task-api-'));fs.rmSync(data,{recursive:true,force:true});}
const box=(x=40)=>({operation:'primitive.box',parameters:{width:3,depth:4,height:5,x}});
const batch=(steps=[box(),box(60)],extra={})=>({protocolVersion:1,operation:'project.batch',documentId:'default',requestId:randomUUID(),batchId:randomUUID(),steps,...extra});
const submit=(f,input,task)=>f.post('/command-batches',input,{'x-cad-task-id':task.taskId});
async function snapshot(f){return {model:await f.cad('document.summary'),raw:(await f.cad('property.list')).propertyRecords,typed:(await f.cad('property.instance.list')).instances};}
async function unchanged(f,before,{sameToken=true}={}){const after=await snapshot(f);for(const key of ['revision','features','bodyMetadata','entityIdentities','variables','coordinateSystems',...(sameToken?['stateToken']:[])])assert.deepEqual(after.model[key],before.model[key],key);assert.deepEqual(after.raw,before.raw);assert.deepEqual(after.typed,before.typed);}
async function seed(f){const body=await f.cad('primitive.box',{width:10,depth:20,height:30});const type=await f.cad('property.type.create',{key:'BatchBoundary',targetScope:'body',association:'required',fields:[{key:'enabled',type:'bool'}]});const instance=await f.cad('property.instance.create',{typeId:type.type.typeId,value:{enabled:true},target:{kind:'body',bodyId:body.bodyId}});await f.cad('property.set',{key:'batchMark',type:'int',value:42},{kind:'body',bodyId:body.bodyId});await f.cad('variable.set',{name:'batchSize',type:'length',expression:'10 mm'});return {bodyId:body.bodyId,instanceId:instance.instance.instanceId,before:await snapshot(f)};}

test('batch reservation validates the entire batch without mutation and binds the dedicated transport and complete input',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);await f.cad('primitive.box',{width:10,depth:20,height:30});const before=await snapshot(f),input=batch(),task=await f.reserve(input);
    assert.equal(task.operation,'project.batch');assert.equal(task.requestKey,input.batchId);await unchanged(f,before);
    assert.equal((await submit(f,{...input,steps:[box(99)]},task)).value.code,'MODELING_TASK_CONFLICT');
    assert.equal((await f.post('/commands',input,{'x-cad-task-id':task.taskId})).value.ok,false);
    assert.equal((await f.get('/documents/default/modeling-tasks/'+task.taskId)).modelingTask.phase,'reserved');
    for(const command of [batch([]),batch([box(),{...box(),options:{preview:true}}]),batch([box(),{operation:'document.undo'}]),batch([box()],{batchId:'',requestId:''}),batch([box()],{protocolVersion:9})]){const result=await f.post('/documents/default/modeling-tasks',{command});assert.equal(result.value.ok,false);}
    const foreign=await f.post('/command-batches',input,{'x-cad-task-id':task.taskId,origin:'https://untrusted.invalid'});assert.equal(foreign.status,403);await unchanged(f,before);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('queued batch cancellation executes no step, restores no fake geometry, and reports every step as not executed',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);await f.cad('primitive.box',{width:10,depth:20,height:30});const before=await snapshot(f);await f.cad('primitive.box',{width:2,depth:2,height:2},{},'busy');
    const offset=f.events.length;f.tell('arm-geometry');await f.event('geometry-armed',offset);const active=f.post('/commands',{documentId:'busy',...box()});await f.event('geometry-held',offset);
    const input=batch(),task=await f.reserve(input),pending=submit(f,input,task);await f.until(async()=>(await f.get('/health')).lifecycle.documentActions.queued===1,'Batch did not queue');const at=f.events.length;await f.cancel(task);const result=await pending;
    assert.equal(result.value.code,'DOCUMENT_ACTION_CANCELLED');assert.equal(result.value.modelingTask.phase,'cancelled');assert.deepEqual(result.value.results.map(item=>item.status),['not-executed','not-executed']);assert.ok(result.value.results.every(item=>!item.ok&&!item.bodyId&&!item.positions));
    assert.equal(f.events.slice(at).some(item=>item.type==='fixture.native-request'&&item.documentId==='default'),false);f.tell('release-geometry');await active;await unchanged(f,before);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('cancelling after mixed provisional steps waits for real exit then restores variables, native/typed properties, geometry and history as one batch',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const {bodyId,instanceId,before}=await seed(f),input=batch([
      {operation:'variable.set',parameters:{name:'batchSize',type:'length',expression:'25 mm'}},
      {operation:'property.instance.update',inputs:{instanceId},parameters:{value:{enabled:false}}},
      {operation:'property.set',inputs:{kind:'body',bodyId},parameters:{key:'batchMark',type:'int',value:99}},box(),{operation:'primitive.sphere',parameters:{radius:2,x:80}},
    ],{baseStateToken:before.model.stateToken}),task=await f.reserve(input),at=f.events.length;
    f.tell('arm-geometry');await f.event('geometry-armed',at);f.tell('arm-geometry-exit');await f.event('geometry-exit-armed',at);const pending=submit(f,input,task);assert.equal((await f.event('geometry-held',at)).bodyCount,2);
    const stopped=await f.cancel(task);assert.equal(stopped.value.modelingTask.phase,'stopping');await f.event('geometry-exit-held',at);assert.equal((await f.get('/health')).lifecycle.documentActions.active,1);assert.equal((await f.get('/documents/default/modeling-tasks/'+task.taskId)).modelingTask.phase,'stopping');
    f.tell('release-geometry-exit');const result=await pending;assert.equal(result.value.code,'WORKER_CANCELLED');assert.equal(result.value.modelingTask.phase,'cancelled');assert.equal(result.value.projectRollback.confirmed,true);assert.deepEqual(result.value.results.map(item=>item.status),['rolled-back','rolled-back','rolled-back','failed','not-executed']);assert.ok(result.value.results.every(item=>!item.ok&&!item.bodyId&&!item.positions));
    assert.equal(f.events.slice(at).some(item=>item.type==='fixture.native-request'&&item.operation==='primitive.sphere'),false);await unchanged(f,before);assert.equal((await f.cad('primitive.box',{width:1,depth:1,height:1})).bodyCount,2);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('batch publication is protected before its checkpoint and returns one exact aggregate receipt after later edits, Undo and restart',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);await f.cad('primitive.box',{width:10,depth:20,height:30});const input=batch([box()]),task=await f.reserve(input),at=f.events.length;
    f.tell('arm-geometry');await f.event('geometry-armed',at);const pending=submit(f,input,task);await f.event('geometry-held',at);f.tell('arm-task-commit');await f.event('task-commit-armed',at);f.tell('release-geometry');await f.event('task-commit-held',at);
    assert.equal((await f.get('/documents/default/modeling-tasks/'+task.taskId)).modelingTask.phase,'committing');assert.equal((await f.cancel(task)).value.code,'MODELING_TASK_NOT_CANCELLABLE');f.tell('release-geometry');const first=await pending;assert.equal(first.value.ok,true,JSON.stringify(first));const expected={...first.value};delete expected.modelingTask;
    assert.deepEqual((await f.get('/documents/default/modeling-tasks/'+task.taskId+'/result')).result,expected);
    await f.cad('primitive.box',{width:2,depth:2,height:2,x:90});await f.cad('document.undo');await f.cad('document.redo');const later=await f.cad('document.summary');assert.equal(later.bodyCount,3);assert.notEqual(later.stateToken,expected.stateToken);
    assert.equal(await f.stop(),0);f=await gatedGeometryGateway(data);assert.deepEqual((await f.get('/documents/default/modeling-tasks/'+task.taskId+'/result')).result,expected);assert.equal((await f.cancel(task)).value.modelingTask.phase,'succeeded');
    const deleted=await fetch(f.api+'/documents/default/modeling-tasks/'+task.taskId,{method:'DELETE'});assert.equal(deleted.status,200);const replacement=await f.reserve(input),replayed=await submit(f,input,replacement);const payload={...replayed.value};delete payload.modelingTask;assert.deepEqual(payload,expected);assert.equal((await f.cad('document.summary')).stateToken,later.stateToken);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('legacy step-only replay cannot fabricate an exact aggregate receipt or execute again through task control',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const input=batch(),first=await f.post('/command-batches',input);assert.equal(first.value.ok,true);const before=await snapshot(f),task=await f.reserve(input),replayed=await submit(f,input,task);assert.equal(replayed.value.code,'MODELING_TASK_BATCH_RECEIPT_MISSING');assert.equal(replayed.value.modelingTask.phase,'failed');await unchanged(f,before);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('aggregate receipt storage fits the same atomic retention budget or the entire tracked batch rolls back',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data,{GEOMETRY_IDEMPOTENCY_BYTES:'4096'});assert.equal((await f.post('/commands',{documentId:'default',operation:'primitive.box',parameters:{width:10,depth:20,height:30}})).value.ok,true);const before=await snapshot(f),input=batch(),task=await f.reserve(input),result=await submit(f,input,task);assert.equal(result.value.ok,false);assert.equal(result.value.causeCode,'BATCH_RESULT_TOO_LARGE');assert.equal(result.value.modelingTask.phase,'failed');assert.ok(result.value.results.every(item=>!item.ok));await unchanged(f,before);assert.equal((await f.get('/documents/default/modeling-tasks/'+task.taskId+'/result')).ok,false);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('unconfirmed native exit never claims batch rollback or cancellation, preserves the journal, and recovers without replay after restart',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data,{GEOMETRY_WORKER_STOP_TIMEOUT_MS:'40'});await f.cad('primitive.box',{width:10,depth:20,height:30});const before=await snapshot(f),input=batch(),task=await f.reserve(input),at=f.events.length;
    f.tell('arm-geometry');await f.event('geometry-armed',at);f.tell('arm-geometry-exit');await f.event('geometry-exit-armed',at);const pending=submit(f,input,task);await f.event('geometry-held',at);await f.cancel(task);await f.event('geometry-exit-held',at);const result=await pending;assert.equal(result.value.code,'PROJECT_ROLLBACK_FAILED');assert.equal(result.value.modelingTask.phase,'unknown');assert.equal(result.value.results,undefined);assert.ok(fs.readdirSync(path.join(data,'document-transactions')).some(name=>name.endsWith('.pending.json')));
    f.tell('release-geometry-exit');await f.event('geometry-exit',at);await f.stop();f=await gatedGeometryGateway(data);await unchanged(f,before,{sameToken:false});assert.equal((await f.get('/documents/default/modeling-tasks/'+task.taskId)).modelingTask.phase,'unknown');
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('a real Gateway crash after durable batch commit but before terminal reporting recovers only the original aggregate receipt',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);await f.cad('primitive.box',{width:10,depth:20,height:30});const input=batch(),task=await f.reserve(input),at=f.events.length;
    f.tell('exit-task-terminal');await f.event('task-terminal-exit-armed',at);const lost=submit(f,input,task);await assert.rejects(lost);await new Promise(resolve=>{if(f.child.exitCode!==null)return resolve();f.child.once('close',resolve);});assert.equal(f.child.exitCode,88);
    const record=JSON.parse(fs.readFileSync(path.join(data,'modeling-tasks',task.taskId+'.json'),'utf8'));assert.equal(record.phase,'committing');assert.equal(fs.readdirSync(path.join(data,'document-transactions')).some(name=>name.endsWith('.pending.json')),false);
    f=await gatedGeometryGateway(data);const recovered=await f.get('/documents/default/modeling-tasks/'+task.taskId);assert.equal(recovered.modelingTask.phase,'succeeded');assert.equal(recovered.modelingTask.recovered,true);
    const result=await f.get('/documents/default/modeling-tasks/'+task.taskId+'/result');assert.equal(result.result.ok,true);assert.equal(result.result.batchId,input.batchId);assert.equal(result.result.bodyCount,3);assert.equal(result.result.results.length,2);assert.equal(result.result.batch.state,'committed');
    const current=await f.cad('document.summary');assert.equal(current.stateToken,result.result.stateToken);assert.equal(current.bodyCount,3);assert.equal(f.events.some(item=>item.type==='fixture.native-request'&&item.operation==='primitive.box'),false,'Restart status/result reads must never recreate the batch');
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('the 64-step boundary commits with a retained aggregate and one Undo, while 65 steps are rejected before execution',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const before=await snapshot(f),steps=Array.from({length:64},(_,index)=>({operation:'variable.set',parameters:{name:'batchLimit'+index,type:'dimensionless',expression:String(index+1)}})),input=batch(steps);
    const rejected=await f.post('/documents/default/modeling-tasks',{command:batch([...steps,steps[0]])});assert.equal(rejected.value.code,'INVALID_BATCH');await unchanged(f,before);
    const task=await f.reserve(input),result=await submit(f,input,task);assert.equal(result.value.ok,true,JSON.stringify(result));assert.equal(result.value.results.length,64);assert.equal(result.value.variables.length,64);assert.equal(result.value.modelingTask.phase,'succeeded');const exact=(await f.get('/documents/default/modeling-tasks/'+task.taskId+'/result')).result;assert.equal(exact.results.length,64);assert.equal(exact.variables.length,64);
    const undone=await f.cad('document.undo');assert.deepEqual(undone.variables,before.model.variables);assert.equal(undone.canUndo,false);assert.deepEqual((await f.get('/documents/default/modeling-tasks/'+task.taskId+'/result')).result,exact);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
