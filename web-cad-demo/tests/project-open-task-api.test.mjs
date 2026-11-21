import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';
import {waitChildExit} from '../gateway/child-exit.mjs';
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cad-project-open-task-'));
function clean(data){assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-project-open-task-/);fs.rmSync(data,{recursive:true,force:true});}
async function bytesFor(f){await f.cad('primitive.sphere',{radius:5},{},'source');const response=await fetch(f.api+'/documents/source/project/save',{method:'POST'});assert.equal(response.status,200);return Buffer.from(await response.arrayBuffer());}
async function state(f,id='default'){return {model:await f.cad('document.summary',{}, {},id),raw:(await f.cad('property.list',{}, {},id)).propertyRecords,typed:(await f.cad('property.instance.list',{}, {},id)).instances};}
async function seed(f){const body=await f.cad('primitive.box',{width:10,depth:20,height:30}),type=await f.cad('property.type.create',{key:'FileTaskSource',association:'required',targetScope:'body',fields:[{key:'marker',type:'int'}]});await f.cad('property.instance.create',{typeId:type.type.typeId,value:{marker:71},target:{kind:'body',bodyId:body.bodyId}});await f.cad('property.set',{key:'fileTaskMarker',type:'int',value:71},{kind:'body',bodyId:body.bodyId});return state(f);}
async function same(f,before){const after=await state(f);for(const key of ['revision','stateToken','features','bodyMetadata','entityIdentities','variables','coordinateSystems','materials'])assert.deepEqual(after.model[key],before.model[key],key);assert.deepEqual(after.raw,before.raw);assert.deepEqual(after.typed,before.typed);}
const command=(bytes,before,extra={})=>({protocolVersion:1,operation:'project.open',documentId:'incoming-'+randomUUID().slice(0,12),sourceDocumentId:'default',requestId:randomUUID(),fileName:'工程 中文.cadproj',expectedBytes:bytes.length,sourceRevision:before.model.revision,sourceStateToken:before.model.stateToken,sourceStateSequence:before.model.stateSequence,...extra});
async function reserve(f,input){const response=await f.post('/documents/'+input.documentId+'/project/open/tasks',{command:input});assert.equal(response.status,201,JSON.stringify(response));return response.value;}
const headers=(input,task)=>({'Content-Type':'application/vnd.webcad.project','X-Cad-Task-Id':task.taskId,'X-Request-Id':input.requestId,'X-File-Name':encodeURIComponent(input.fileName)});
async function upload(f,input,task,bytes,extra={}){const response=await fetch(f.api+'/documents/'+input.documentId+'/project/open',{method:'POST',headers:{...headers(input,task),...extra},body:bytes});return {status:response.status,value:await response.json()};}
const status=(f,input,task)=>f.get('/documents/'+input.documentId+'/modeling-tasks/'+task.taskId).then(value=>value.modelingTask);
async function notPublished(f,input){const catalog=await f.get('/projects?q='+input.documentId);assert.equal(catalog.projects.some(project=>project.documentId===input.documentId),false);}

test('registered package routes reject malformed bindings, foreign origins and Host headers before admission or geometry access',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),route='/documents/'+input.documentId+'/project/open/tasks',at=f.events.length;
    for(const patch of [{documentId:'wrong-target'},{sourceDocumentId:input.documentId},{sourceRevision:-1},{sourceStateSequence:'3'},{sourceStateToken:'bad'},{expectedBytes:2**31},{path:'C:/arbitrary'},{fileName:'../wrong'}])assert.equal((await f.post(route,{command:{...input,...patch}})).status,400);
    assert.equal((await f.post(route,{command:input,extra:true})).status,400);assert.equal((await f.post(route+'?extra=1',{command:input})).status,400);assert.equal((await f.post(route,{command:input},{Origin:'https://untrusted.invalid'})).status,403);
    const foreign=await new Promise((resolve,reject)=>{const body=JSON.stringify({command:input}),request=httpRequest(f.api+route,{method:'POST',headers:{Host:'untrusted.invalid:'+f.port,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});request.once('error',reject);request.end(body);});assert.equal(foreign,403);
    assert.equal((await f.get('/documents/default/project/open-tasks?limit=1&limit=2')).code,'PROJECT_OPEN_TASK_ARGUMENTS');assert.equal((await f.get('/documents/default/project/open-tasks?limit=101')).code,'PROJECT_OPEN_TASK_ARGUMENTS');assert.equal((await f.get('/documents/default/project/open-tasks')).total,0);
    const {modelingTask:task}=await reserve(f,input);assert.equal((await upload(f,input,task,bytes,{Origin:'https://untrusted.invalid'})).status,403);assert.equal((await status(f,input,task)).phase,'reserved');assert.equal(f.events.slice(at).some(item=>item.type==='fixture.native-request'&&item.documentId===input.documentId),false);await f.cancel(task);await same(f,before);await notPublished(f,input);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('project-open registration atomically binds file and source identity without creating or overwriting a workspace',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),first=await reserve(f,input),task=first.modelingTask;
    assert.equal(task.phase,'reserved');assert.equal(first.projectOpen.sourceDocumentId,'default');assert.equal((await reserve(f,input)).modelingTask.taskId,task.taskId);await notPublished(f,input);await same(f,before);
    const persisted=JSON.parse(fs.readFileSync(path.join(data,'modeling-tasks',task.taskId+'.json'),'utf8'));assert.equal(persisted.projectOpenInput.fileName,input.fileName);assert.equal(persisted.projectOpenInput.expectedBytes,bytes.length);assert.equal(JSON.stringify(task).includes('projectOpenInput'),false);
    assert.equal((await f.post('/documents/'+input.documentId+'/project/open/tasks',{command:{...input,fileName:'another.cadproj'}})).status,409);
    assert.equal((await f.post('/documents/default/project/open/tasks',{command:{...input,documentId:'default',sourceDocumentId:'source'}})).value.code,'PROJECT_OPEN_TARGET_EXISTS');
    const wrong=await upload(f,input,task,bytes,{'X-File-Name':'wrong.cadproj'});assert.equal(wrong.status,409);assert.equal((await status(f,input,task)).phase,'reserved');
    await f.cancel(task);assert.equal((await status(f,input,task)).execution,'not-started');assert.equal((await upload(f,input,task,bytes)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');await notPublished(f,input);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
test('registered project opens once and its exact committed receipt survives later edits and restart without uploading again',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),{modelingTask:task}=await reserve(f,input),first=await upload(f,input,task,bytes);
    assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.value.modelingTask.phase,'succeeded');assert.equal(first.value.features[0].type,'primitive.sphere');assert.equal(first.value.documentId,input.documentId);await same(f,before);
    const original={...first.value};delete original.modelingTask;delete original.projectOpen;delete original.projectOpenNotice;
    assert.deepEqual((await f.get('/documents/'+input.documentId+'/modeling-tasks/'+task.taskId+'/result')).result,original);
    await f.cad('primitive.box',{width:2,depth:3,height:4},{},input.documentId);const later=await state(f,input.documentId);assert.equal(later.model.bodyCount,2);
    await f.stop();f=null;f=await gatedGeometryGateway(data);const recovered=await f.get('/documents/'+input.documentId+'/modeling-tasks/'+task.taskId+'/result');assert.deepEqual(recovered.result,original);assert.equal((await state(f,input.documentId)).model.bodyCount,2);assert.equal((await reserve(f,input)).modelingTask.taskId,task.taskId);assert.equal((await upload(f,input,task,bytes)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');
    const list=await f.get('/documents/default/project/open-tasks');assert.equal(list.items[0].projectOpen.taskId,task.taskId);assert.equal(list.active.length,0);assert.equal(list.items[0].modelingTask.phase,'succeeded');
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('a malformed registered package fails before native restoration without changing or publishing either workspace',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const before=await seed(f),bytes=Buffer.from('not a valid engineering package'),input=command(bytes,before),{modelingTask:task}=await reserve(f,input),at=f.events.length,result=await upload(f,input,task,bytes);
    assert.equal(result.status,400,JSON.stringify(result));assert.equal(result.value.modelingTask.phase,'failed');assert.equal(result.value.modelingTask.execution,'not-started');assert.equal(result.value.modelingTask.restored,undefined);
    assert.equal(f.events.slice(at).some(event=>event.type==='fixture.native-request'&&event.documentId===input.documentId),false);assert.deepEqual(fs.readdirSync(path.join(data,'pending-project-inputs')),[]);await same(f,before);await notPublished(f,input);assert.equal((await upload(f,input,task,bytes)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
test('cancel of a real partial project upload waits for file cleanup and never enters the geometry worker',async()=>{
  const data=scratch();let f,request;
  try{
    f=await gatedGeometryGateway(data);const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),{modelingTask:task}=await reserve(f,input),at=f.events.length;
    request=httpRequest(f.api+'/documents/'+input.documentId+'/project/open',{method:'POST',headers:{...headers(input,task),'Content-Length':String(bytes.length)}},response=>response.resume());request.on('error',()=>{});request.write(bytes.subarray(0,80));
    await f.until(async()=>(await status(f,input,task)).phase==='receiving','Upload did not enter receiving');await f.cancel(task);await f.until(async()=>(await status(f,input,task)).phase==='cancelled','Upload cancellation not settled');
    assert.equal((await status(f,input,task)).execution,'not-started');assert.deepEqual(fs.readdirSync(path.join(data,'pending-project-inputs')),[]);assert.equal(f.events.slice(at).some(item=>item.type==='fixture.native-request'&&item.documentId===input.documentId),false);await same(f,before);await notPublished(f,input);
  }finally{request?.destroy();if(f){assert.equal(await f.stop(),0);clean(data);}}
});
test('queued project-open cancellation releases its input and does not create a target checkpoint',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),{modelingTask:task}=await reserve(f,input),at=f.events.length;
    f.tell('arm-geometry');await f.event('geometry-armed',at);const busy=f.post('/commands',{documentId:'busy',operation:'primitive.box',parameters:{width:2,depth:3,height:4}});await f.event('geometry-held',at);
    const pending=upload(f,input,task,bytes);await f.until(async()=>(await status(f,input,task)).phase==='queued','Package did not queue');await f.cancel(task);const result=await pending;assert.equal(result.value.modelingTask.phase,'cancelled');assert.equal(result.value.modelingTask.execution,'not-started');assert.deepEqual(fs.readdirSync(path.join(data,'pending-project-inputs')),[]);assert.equal(f.events.slice(at).some(item=>item.type==='fixture.native-request'&&item.documentId===input.documentId),false);
    f.tell('release-geometry');await busy;await same(f,before);await notPublished(f,input);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
test('a target created after reservation is never overwritten by the queued file task',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),{modelingTask:task}=await reserve(f,input);await f.cad('primitive.box',{width:6,depth:7,height:8},{},input.documentId);const targetBefore=await state(f,input.documentId),result=await upload(f,input,task,bytes);assert.equal(result.value.code,'PROJECT_OPEN_TARGET_EXISTS');assert.equal(result.value.modelingTask.execution,'not-started');const targetAfter=await state(f,input.documentId);delete targetBefore.model.requestId;delete targetAfter.model.requestId;assert.deepEqual(targetAfter,targetBefore);await same(f,before);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('a restart before attachment proves a bound reserved file was not submitted and permits explicit abandonment, never automatic reupload',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),first=await reserve(f,input),task=first.modelingTask;assert.equal(first.projectOpen.canUpload,true);
    await f.stop();f=null;f=await gatedGeometryGateway(data);const restored=await f.get('/documents/'+input.documentId+'/project/open/tasks/'+task.taskId);assert.equal(restored.projectOpen.canUpload,false);assert.equal(restored.modelingTask.phase,'reserved');assert.equal(restored.modelingTask.execution,'not-started');assert.equal(restored.modelingTask.cancellable,true);assert.equal((await upload(f,input,task,bytes)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');
    const list=await f.get('/documents/default/project/open-tasks');assert.ok(list.attention.some(item=>item.taskId===task.taskId));assert.equal((await f.cancel(task)).value.modelingTask.phase,'cancelled');await same(f,before);await notPublished(f,input);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('cancelling an already restored package waits for real process exit and leaves the source and unpublished target intact',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),{modelingTask:task}=await reserve(f,input),at=f.events.length;
    f.tell('arm-project-open');await f.event('project-open-armed',at);f.tell('arm-geometry-exit');await f.event('geometry-exit-armed',at);const pending=upload(f,input,task,bytes);await f.event('project-open-held',at);assert.equal((await status(f,input,task)).phase,'executing');
    await f.cancel(task);await f.event('geometry-exit-held',at);assert.equal((await status(f,input,task)).phase,'stopping');assert.equal((await f.get('/health')).lifecycle.documentActions.active,1);f.tell('release-geometry-exit');
    const result=await pending;assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.value.modelingTask.phase,'cancelled');assert.equal(result.value.modelingTask.restored,true);await same(f,before);await notPublished(f,input);assert.deepEqual(fs.readdirSync(path.join(data,'pending-project-inputs')),[]);assert.deepEqual(fs.readdirSync(path.join(data,'project-assets')),[]);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('package commit is protected before its final checkpoint and returns the exact original engineering receipt',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),{modelingTask:task}=await reserve(f,input),at=f.events.length;
    f.tell('arm-project-open');await f.event('project-open-armed',at);const pending=upload(f,input,task,bytes);await f.event('project-open-held',at);f.tell('arm-task-commit');await f.event('task-commit-armed',at);f.tell('release-geometry');await f.event('task-commit-held',at);
    assert.equal((await status(f,input,task)).phase,'committing');assert.equal((await f.cancel(task)).value.code,'MODELING_TASK_NOT_CANCELLABLE');f.tell('release-geometry');const result=await pending;assert.equal(result.value.modelingTask.phase,'succeeded');await same(f,before);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('unconfirmed exit retains the original package and recovery evidence rather than reporting successful cancellation',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data,{GEOMETRY_WORKER_STOP_TIMEOUT_MS:'100'});const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),{modelingTask:task}=await reserve(f,input),at=f.events.length;
    f.tell('arm-project-open');await f.event('project-open-armed',at);f.tell('arm-geometry-exit');await f.event('geometry-exit-armed',at);const pending=upload(f,input,task,bytes);await f.event('project-open-held',at);await f.cancel(task);await f.event('geometry-exit-held',at);const result=await pending;assert.equal(result.value.code,'PROJECT_ROLLBACK_FAILED');assert.equal(result.value.modelingTask.phase,'unknown');assert.equal(result.value.modelingTask.restored,undefined);
    const files=fs.readdirSync(path.join(data,'pending-project-inputs'));assert.equal(files.length,1);assert.deepEqual(fs.readFileSync(path.join(data,'pending-project-inputs',files[0])),bytes);assert.ok(fs.existsSync(path.join(data,'project-transactions',input.documentId+'.pending.json')));assert.equal((await f.get('/health')).lifecycle.projectInputs.retainedSlots,1);
    await f.stop();f=null;f=await gatedGeometryGateway(data);await same(f,before);await notPublished(f,input);assert.equal((await status(f,input,task)).phase,'unknown');assert.equal((await upload(f,input,task,bytes)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');assert.deepEqual(fs.readFileSync(path.join(data,'pending-project-inputs',files[0])),bytes);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

for(const phase of ['published','terminal'])test(`process exit after package ${phase} does not invent success or replay the original attachment`,async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await bytesFor(f),before=await seed(f),input=command(bytes,before),{modelingTask:task}=await reserve(f,input),at=f.events.length;
    f.tell('exit-project-open-'+phase);await f.event('project-open-'+phase+'-exit-armed',at);await assert.rejects(upload(f,input,task,bytes));await waitChildExit(f.child,{timeoutMs:5000});assert.equal(f.child.exitCode,88);f=null;
    f=await gatedGeometryGateway(data);const restored=await status(f,input,task);
    if(phase==='published'){assert.equal(restored.phase,'unknown');await notPublished(f,input);assert.equal((await f.get('/documents/'+input.documentId+'/modeling-tasks/'+task.taskId+'/result')).ok,false);}
    else{assert.equal(restored.phase,'succeeded');assert.equal(restored.recovered,true);const receipt=(await f.get('/documents/'+input.documentId+'/modeling-tasks/'+task.taskId+'/result')).result;assert.equal(receipt.features[0].type,'primitive.sphere');assert.equal(receipt.documentId,input.documentId);}
    await same(f,before);assert.equal((await upload(f,input,task,bytes)).value.code,'MODELING_TASK_ALREADY_SUBMITTED');
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
