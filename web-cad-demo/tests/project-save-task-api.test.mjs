import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';
import {waitChildExit} from '../gateway/child-exit.mjs';
import {decodeProjectPackage} from '../gateway/project-package.mjs';
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cad-project-save-task-'));
function clean(data){assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-project-save-task-/);fs.rmSync(data,{recursive:true,force:true});}
async function state(f){return {model:await f.cad('document.summary'),raw:(await f.cad('property.list')).propertyRecords,typed:(await f.cad('property.instance.list')).instances};}
async function seed(f){const body=await f.cad('primitive.box',{width:10,depth:20,height:30}),type=await f.cad('property.type.create',{key:'SaveTaskData',association:'required',targetScope:'body',fields:[{key:'marker',type:'int'}]});await f.cad('property.instance.create',{typeId:type.type.typeId,value:{marker:82},target:{kind:'body',bodyId:body.bodyId}});await f.cad('property.set',{key:'saveMarker',type:'int',value:82},{kind:'body',bodyId:body.bodyId});return state(f);}
async function same(f,before){const after=await state(f);for(const key of ['revision','stateToken','stateSequence','features','bodyMetadata','entityIdentities','variables','coordinateSystems','materials'])assert.deepEqual(after.model[key],before.model[key],key);assert.deepEqual(after.raw,before.raw);assert.deepEqual(after.typed,before.typed);}
const input=before=>({protocolVersion:1,operation:'project.save',documentId:'default',requestId:randomUUID(),baseRevision:before.model.revision,baseStateToken:before.model.stateToken,baseStateSequence:before.model.stateSequence});
async function reserve(f,command){const response=await f.post('/documents/default/project/save/tasks',{command});assert.equal(response.status,201,JSON.stringify(response));return response.value.modelingTask;}
const generate=(f,command,task)=>f.post('/documents/default/project/save',{command},{'X-Cad-Task-Id':task.taskId,'X-Request-Id':command.requestId});
const status=(f,task)=>f.get('/documents/default/modeling-tasks/'+task.taskId).then(value=>value.modelingTask);
async function download(f,result){const response=await fetch(new URL(result.projectBackup.downloadPath,f.api));assert.equal(response.status,200,await response.clone().text());assert.match(response.headers.get('content-type'),/application\/vnd.webcad.project/);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,result.projectBackup.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),result.projectBackup.sha256);assert.equal(response.headers.get('x-content-sha256'),result.projectBackup.sha256);return bytes;}

test('save registration binds metadata only, rejects unknown input and foreign origins before snapshot generation',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),at=f.events.length;
  for(const value of [{...command,path:'C:/secret'}, {...command,baseRevision:-1}, {...command,operation:'primitive.box'}])assert.equal((await f.post('/documents/default/project/save/tasks',{command:value})).status,400);
  assert.equal((await f.post('/documents/default/project/save/tasks',{command},{Origin:'https://foreign.invalid'})).status,403);const task=await reserve(f,command);assert.equal(task.phase,'reserved');assert.equal((await reserve(f,command)).taskId,task.taskId);assert.equal((await f.post('/documents/default/project/save/tasks',{command:{...command,baseRevision:command.baseRevision+1}})).status,409);assert.equal(f.events.slice(at).some(row=>row.type==='fixture.native-request'),false);assert.deepEqual(fs.readdirSync(path.join(data,'project-backups')),[]);await f.cancel(task);await same(f,before);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});

test('a generated package has an exact durable receipt, contains both native and typed data, and never edits source geometry',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),task=await reserve(f,command),saved=await generate(f,command,task);assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(saved.value.modelingTask.phase,'succeeded');const bytes=await download(f,saved.value),decoded=decodeProjectPackage(bytes);assert.equal(decoded.metadata.document.revision,before.model.revision);assert.equal(decoded.propertySchema.instances[0].value.marker,82);await same(f,before);
  const original={...saved.value};delete original.modelingTask;delete original.projectSave;delete original.projectSaveNotice;assert.deepEqual((await f.get('/documents/default/modeling-tasks/'+task.taskId+'/result')).result,original);
  const opened=await fetch(f.api+'/documents/backup-check/project/open',{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:bytes});assert.equal(opened.status,200);const nativeRecords=(await f.cad('property.list',{}, {},'backup-check')).propertyRecords.filter(record=>record.state==='active'&&record.values.saveMarker);assert.equal(nativeRecords.length,1);assert.equal(nativeRecords[0].values.saveMarker.value,82);assert.equal((await f.cad('property.instance.list',{}, {},'backup-check')).instances[0].value.marker,82);await same(f,before);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});

test('a named copy preserves the source workspace identity and unsaved changes', async () => {
 const data = scratch();
 let f;
 try {
  f = await gatedGeometryGateway(data);
  const before = await seed(f);
  await f.post('/projects/default', {name: '源工程'});
  const source = (await f.get('/projects/default')).project;
  assert.equal(source.hasChangesSinceExport, true);
  const command = {...input(before), copyName: '独立副本'};
  const task = await reserve(f, command);
  assert.equal((await f.post('/documents/default/project/save/tasks', {command: {...command, copyName: '其他名称'}})).status, 409);
  const saved = await generate(f, command, task);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  const bytes = await download(f, saved.value);
  assert.equal(decodeProjectPackage(bytes).metadata.document.name, '独立副本');
  const reopened = await fetch(f.api + '/documents/copy-check/project/open', {
   method: 'POST', headers: {'Content-Type': 'application/vnd.webcad.project'}, body: bytes,
  });
  assert.equal(reopened.status, 200, await reopened.clone().text());
  assert.equal((await f.get('/projects/copy-check')).project.name, '独立副本');
  const after = (await f.get('/projects/default')).project;
  for (const key of ['documentId', 'name', 'token', 'hasChangesSinceExport', 'lastGeneratedToken', 'lastGeneratedAt', 'updatedAt']) {
   assert.equal(after[key], source[key], key);
  }
  await same(f, before);
 } finally {
  if (f) { assert.equal(await f.stop(), 0); clean(data); }
 }
});

test('later source edits and a gateway restart cannot change or regenerate the original backup bytes or receipt',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),task=await reserve(f,command),saved=await generate(f,command,task),bytes=await download(f,saved.value);await f.cad('primitive.sphere',{radius:4});const later=await state(f);assert.equal(later.model.bodyCount,2);assert.equal((await f.get('/projects/default')).project.hasChangesSinceExport,true);await f.stop();f=null;f=await gatedGeometryGateway(data);const receipt=(await f.get('/documents/default/modeling-tasks/'+task.taskId+'/result')).result;assert.deepEqual(await download(f,receipt),bytes);assert.equal(receipt.revision,before.model.revision);assert.equal((await generate(f,command,task)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');await same(f,later);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});

test('a stale queued save never substitutes the newest geometry for the requested checkpoint',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),task=await reserve(f,command);await f.cad('primitive.sphere',{radius:4});const latest=await state(f),result=await generate(f,command,task);assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.value.code,'PROJECT_STATE_CONFLICT');assert.equal(result.value.modelingTask.execution,'not-started');assert.equal(result.value.modelingTask.phase,'failed');assert.deepEqual(fs.readdirSync(path.join(data,'project-backups')),[]);await same(f,latest);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});

test('reserved saves interrupted before submission stay explicitly abandonable after restart and never auto-generate',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),task=await reserve(f,command);await f.stop();f=null;f=await gatedGeometryGateway(data);const restored=await status(f,task);assert.equal(restored.phase,'reserved');assert.equal(restored.execution,'not-started');assert.equal(restored.cancellable,true);assert.equal((await generate(f,command,task)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');await f.cancel(task);assert.equal((await status(f,task)).phase,'cancelled');assert.deepEqual(fs.readdirSync(path.join(data,'project-backups')),[]);await same(f,before);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});

test('queued backup cancellation never reaches native snapshot or creates a backup reservation',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),task=await reserve(f,command),at=f.events.length;f.tell('arm-geometry');await f.event('geometry-armed',at);const busy=f.post('/commands',{documentId:'busy',operation:'primitive.box',parameters:{width:2,depth:3,height:4}});await f.event('geometry-held',at);const pending=generate(f,command,task);await f.until(async()=>(await status(f,task)).phase==='queued','Save did not queue');await f.cancel(task);const result=await pending;assert.equal(result.value.modelingTask.phase,'cancelled');assert.equal(result.value.modelingTask.execution,'not-started');assert.deepEqual(fs.readdirSync(path.join(data,'project-backups')),[]);f.tell('release-geometry');await busy;await same(f,before);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});

test('cancelling a real save snapshot waits for OS exit and reports unchanged rather than claiming a geometry rollback',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),task=await reserve(f,command),at=f.events.length;f.tell('arm-project-save');await f.event('project-save-armed',at);f.tell('arm-geometry-exit');await f.event('geometry-exit-armed',at);const pending=generate(f,command,task);await f.event('project-save-held',at);assert.equal((await status(f,task)).phase,'executing');await f.cancel(task);await f.event('geometry-exit-held',at);assert.equal((await status(f,task)).phase,'stopping');f.tell('release-geometry-exit');const result=await pending;assert.equal(result.value.modelingTask.phase,'cancelled',JSON.stringify(result));assert.equal(result.value.modelingTask.unchanged,true);assert.equal(result.value.modelingTask.restored,undefined);assert.deepEqual(fs.readdirSync(path.join(data,'project-backups')),[]);await same(f,before);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});

test('unconfirmed snapshot exit retains native export evidence and cannot report unchanged or successful cancellation',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data,{GEOMETRY_WORKER_STOP_TIMEOUT_MS:'100'});const before=await seed(f),command=input(before),task=await reserve(f,command),at=f.events.length;f.tell('arm-project-save');await f.event('project-save-armed',at);f.tell('arm-geometry-exit');await f.event('geometry-exit-armed',at);const pending=generate(f,command,task);await f.event('project-save-held',at);await f.cancel(task);await f.event('geometry-exit-held',at);const result=await pending;assert.equal(result.value.code,'WORKER_STOP_UNCONFIRMED');assert.equal(result.value.modelingTask.phase,'unknown');assert.equal(result.value.modelingTask.unchanged,undefined);assert.equal(result.value.modelingTask.restored,undefined);const evidence=fs.readdirSync(path.join(data,'project-transactions')).filter(name=>/^export-default-[A-Za-z0-9]{6}$/.test(name));assert.equal(evidence.length,1);assert.ok(fs.statSync(path.join(data,'project-transactions',evidence[0],'model.xbf')).size>=32);await f.stop();f=null;f=await gatedGeometryGateway(data);await same(f,before);assert.equal((await status(f,task)).phase,'unknown');
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});

test('backup publication is protected from cancellation and produces one exact downloadable file',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),task=await reserve(f,command),at=f.events.length;f.tell('arm-save-publish');await f.event('save-publish-armed',at);const pending=generate(f,command,task);await f.event('save-publish-held',at);assert.equal((await status(f,task)).phase,'committing');assert.equal((await f.cancel(task)).value.code,'MODELING_TASK_NOT_CANCELLABLE');f.tell('release-save-publish');const saved=await pending;assert.equal(saved.value.modelingTask.phase,'succeeded');await download(f,saved.value);assert.equal(fs.readdirSync(path.join(data,'project-backups')).length,1);await same(f,before);
 }finally{if(f){f.tell('release-save-publish');assert.equal(await f.stop(),0);clean(data);}}});

test('process exit after file publication recovers its original receipt and bytes without generating again',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),task=await reserve(f,command),at=f.events.length;f.tell('exit-save-published');await f.event('save-published-exit-armed',at);await assert.rejects(generate(f,command,task));await waitChildExit(f.child,{timeoutMs:5000});assert.equal(f.child.exitCode,88);f=null;f=await gatedGeometryGateway(data);const restored=await status(f,task);assert.equal(restored.phase,'succeeded');assert.equal(restored.recovered,true);const result=(await f.get('/documents/default/modeling-tasks/'+task.taskId+'/result')).result;await download(f,result);assert.equal((await generate(f,command,task)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');assert.equal(fs.readdirSync(path.join(data,'project-backups')).length,1);await same(f,before);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});

test('corrupt stored bytes are refused on download and explicit removal instead of being regenerated or silently deleted',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),task=await reserve(f,command),saved=await generate(f,command,task),file=path.join(data,'project-backups',task.taskId,'backup.cadproj'),bytes=fs.readFileSync(file);bytes[bytes.length-1]^=1;fs.writeFileSync(file,bytes);const response=await fetch(new URL(saved.value.projectBackup.downloadPath,f.api));assert.equal(response.status,503);assert.equal((await response.json()).code,'PROJECT_BACKUP_CHANGED');const removal=await fetch(f.api+'/documents/default/project/backups/'+task.taskId,{method:'DELETE'});assert.equal(removal.status,503);assert.ok(fs.existsSync(file));await same(f,before);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});

test('explicit backup removal does not delete geometry, history or the task and never regenerates an expired result',async()=>{
 const data=scratch();let f;try{f=await gatedGeometryGateway(data);const before=await seed(f),command=input(before),task=await reserve(f,command),saved=await generate(f,command,task);await download(f,saved.value);const url=f.api+'/documents/default/project/backups/'+task.taskId,foreign=await fetch(url,{method:'DELETE',headers:{Origin:'https://foreign.invalid'}});assert.equal(foreign.status,403);const removed=await fetch(url,{method:'DELETE'});assert.equal(removed.status,200);assert.equal((await removed.json()).deleted,true);assert.equal((await status(f,task)).phase,'succeeded');assert.equal((await f.get('/documents/default/modeling-tasks/'+task.taskId+'/result')).code,'MODELING_TASK_RESULT_EXPIRED');assert.equal((await generate(f,command,task)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');await same(f,before);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}});
