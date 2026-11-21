import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ModelingTaskClient} from '../app/modeling/modeling-task-client.ts';
import {ModelingController} from '../app/modeling/modeling-controller.ts';
import {normalizeProjectOpenTask} from '../shared/project-open-input.mjs';
import {idleWorkspaceResponse,activatedWorkspaceResponse} from './helpers/workspace-activation-fixture.mjs';
const stamp=new Date().toISOString(),options={pollMs:60000,recoveryMs:0};
const command=()=>({protocolVersion:1,operation:'project.open',documentId:'target',sourceDocumentId:'default',requestId:'open-1',fileName:'中文 工程.cadproj',expectedBytes:4,sourceRevision:40,sourceStateSequence:4,sourceStateToken:'4'.repeat(64)});
const task=(input,phase='reserved',extra={})=>({version:1,taskId:randomUUID(),documentId:input.documentId,operation:'project.open',requestKey:input.requestId,phase,sequence:phase==='reserved'?1:8,createdAt:stamp,updatedAt:stamp,cancelRequested:false,cancellable:['reserved','receiving','queued','executing'].includes(phase),reportDurable:true,...extra});
const row=(input,status,canUpload=status.phase==='reserved')=>({modelingTask:status,projectOpen:{version:1,taskId:status.taskId,...input,canUpload}});
const json=(value,status=200)=>new Response(JSON.stringify({ok:true,...value}),{status,headers:{'Content-Type':'application/json'}});
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const snapshot=(documentId='default',revision=40,stateSequence=4)=>({ok:true,documentId,revision,stateSequence,stateToken:String(stateSequence).repeat(64),positions:[],features:[]});
const list=(sourceDocumentId,items,extra={})=>({sourceDocumentId,total:items.length,items,active:items.filter(row=>!['succeeded','failed','cancelled','unknown'].includes(row.modelingTask.phase)),attention:[],nextCursor:null,...extra});

test('public file bindings reject a foreign source, swapped target/request/attachment, unknown fields and impossible reupload flags',()=>{
  const input=command(),status=task(input),valid=row(input,status).projectOpen;
  assert.deepEqual(normalizeProjectOpenTask(valid,status,'default',input),valid);
  for(const bad of [{...valid,sourceDocumentId:'other'},{...valid,documentId:'other'},{...valid,requestId:'other'},{...valid,fileName:'other.cadproj'},{...valid,expectedBytes:8},{...valid,apiKey:'secret'},{...valid,taskId:randomUUID()}])assert.throws(()=>normalizeProjectOpenTask(bad,status,'default',input));
  assert.throws(()=>normalizeProjectOpenTask(valid,{...status,phase:'succeeded'},'default',input));
});

test('registered file upload binds the target task while its pending ownership also blocks the source workspace',async()=>{
  const input=command(),status=task(input),hold=deferred(),calls=[],observations=[];
  const client=new ModelingTaskClient('/api',async(url,init)=>{calls.push({url,init});return json(row(input,status),201);},value=>observations.push(value),options);
  try{
    const pending=client.run(input,async(headers,frozen)=>{assert.equal(headers['X-Cad-Task-Id'],status.taskId);assert.equal(frozen.sourceDocumentId,'default');return hold.promise;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(client.hasPending('default'),true);assert.equal(client.hasPending('target'),true);assert.equal(calls[0].url,'/api/documents/target/project/open/tasks');assert.equal(observations.at(-1)[0].projectOpen.fileName,input.fileName);
    hold.resolve({ok:true,status:200,payload:{...snapshot('target',1,1),...row(input,{...status,phase:'succeeded',sequence:8,cancellable:false},false)}});await pending;assert.equal(client.hasPending('default'),false);
  }finally{client.dispose();}
});

test('lost registration discovers the reserved task by source using GET only and never sends file bytes',async()=>{
  const input=command(),status=task(input),calls=[];let submitted=0;
  const client=new ModelingTaskClient('/api',async(url,init)=>{calls.push({url,method:init?.method||'GET'});if(init?.method==='POST')throw Error('reply lost');return json(list('default',[row(input,status)]));},()=>{},options);
  try{await assert.rejects(client.run(input,async()=>{submitted++;}),error=>error.payload.execution==='not-started');assert.equal(submitted,0);assert.deepEqual(calls.map(call=>call.method),['POST','GET']);assert.match(calls[1].url,/documents\/default\/project\/open-tasks/);assert.equal(client.hasPending('default'),true);}finally{client.dispose();}
});

test('discovery validates all source bindings before publishing and only reads additional attention identities',async()=>{
  const input=command(),status=task(input),foreign=command();foreign.documentId='foreign-target';foreign.sourceDocumentId='foreign';const other=task(foreign),observed=[];
  let bad=true;const calls=[],client=new ModelingTaskClient('/api',async url=>{calls.push(url);if(url.includes('/project/open/tasks/'))return json(row(input,status,false));return json(list('default',bad?[row(input,status),row(foreign,other)]:[],{attention:bad?[]:[{taskId:status.taskId,documentId:input.documentId,needsRead:true}]}));},value=>observed.push(value),options);
  try{await assert.rejects(client.restoreProjectOpens('default'));assert.deepEqual(observed,[]);bad=false;await client.restoreProjectOpens('default');assert.equal(observed.at(-1)[0].projectOpen.canUpload,false);assert.ok(calls.every(url=>typeof url==='string'));}finally{client.dispose();}
});

test('an old reserved attachment never uploads again even when registration returns the same task after restart',async()=>{
  const input=command(),status=task(input,'reserved',{execution:'not-started',interrupted:true});let submitted=0;
  const client=new ModelingTaskClient('/api',async(url,init)=>json(init?.method==='POST'?row(input,status,false):{modelingTask:status}),()=>{},options);
  try{await assert.rejects(client.run(input,async()=>{submitted++;}),error=>error.payload.code==='MODELING_TASK_RESULT_UNCONFIRMED');assert.equal(submitted,0);}finally{client.dispose();}
});

test('controller tracked open preserves the source until the original receipt and a separate current target read are both validated',async()=>{
  const calls=[];let binding,status,controller;
  controller=new ModelingController({taskControl:true,fetchImpl:async(url,init)=>{
    calls.push({url:String(url),init});
    if(String(url).endsWith('/activity'))return idleWorkspaceResponse(url);
    if(String(url).endsWith('/commands'))return json(snapshot());
    if(String(url).endsWith('/project/open/tasks')){binding=JSON.parse(init.body).command;status=task(binding);return json(row(binding,status),201);}
    if(String(url).endsWith('/project/open')){assert.equal(controller.getSnapshot().documentId,'default');assert.equal(init.body.size,4);return json({...snapshot(binding.documentId,1,1),...row(binding,{...status,phase:'succeeded',sequence:8,cancellable:false},false)});}
    if(String(url).endsWith('/activate')){assert.equal(controller.getSnapshot().documentId,'default');return activatedWorkspaceResponse(snapshot(binding.documentId,3,3),init);}
    throw Error('Unexpected '+url);
  }});
  try{await controller.execute({operation:'document.view'});const result=await controller.openProject(new File(['file'],'模型.cadproj'));assert.equal(result.revision,3);assert.equal(controller.getSnapshot().revision,3);assert.equal(binding.sourceRevision,40);assert.equal(binding.fileName,'模型.cadproj');assert.equal(calls.filter(call=>call.url.endsWith('/project/open')).length,1);assert.equal(controller.getSnapshot().busy,false);}finally{controller.disposeTaskTracking();}
});

test('controller discovers an incoming task after reload, cancels its target rather than the source, and never uploads',async()=>{
  const input=command(),status=task(input),calls=[];
  const controller=new ModelingController({apiRoot:'http://localhost:8788/api',taskControl:true,fetchImpl:async(url,init)=>{
    calls.push({url:String(url),init});
    if(String(url).endsWith('/modeling-tasks'))return json({tasks:[]});
    if(String(url).includes('/project/open-tasks?'))return json(list('default',[row(input,status,false)]));
    if(String(url).includes('/project/create-tasks?'))return json({sourceDocumentId:'default',total:0,items:[],active:[],attention:[],nextCursor:null});
    if(String(url).endsWith('/cancel'))return json({modelingTask:{...status,phase:'cancelled',sequence:8,cancellable:false,cancelRequested:true,execution:'not-started'}});
    throw Error('Unexpected '+url);
  }});
  try{await controller.refreshModelingTasks();assert.equal(controller.hasPendingMutation(),true);await assert.rejects(controller.execute({operation:'primitive.box'}),{code:'WORKSPACE_TRANSFER_BUSY'});await controller.cancelModelingTask(status.taskId);assert.equal(calls.at(-1).url,`http://localhost:8788/api/documents/target/modeling-tasks/${status.taskId}/cancel`);assert.equal(controller.hasPendingMutation(),false);assert.equal(calls.some(call=>call.url.endsWith('/project/open')),false);}finally{controller.disposeTaskTracking();}
});

test('source state changes during the separate target read never overwrite the newer visible engineering state',async()=>{
  const held=deferred();let binding,status;const controller=new ModelingController({taskControl:true,fetchImpl:async(url,init)=>{
    if(String(url).endsWith('/activity'))return idleWorkspaceResponse(url);
    if(String(url).endsWith('/commands'))return json(snapshot());
    if(String(url).endsWith('/project/open/tasks')){binding=JSON.parse(init.body).command;status=task(binding);return json(row(binding,status),201);}
    if(String(url).endsWith('/project/open'))return json({...snapshot(binding.documentId,1,1),...row(binding,{...status,phase:'succeeded',sequence:8,cancellable:false},false)});
    if(String(url).endsWith('/activate'))return held.promise.then(async response=>activatedWorkspaceResponse(await response.json(),init));throw Error('Unexpected '+url);
  }});
  try{await controller.execute({operation:'document.view'});const pending=controller.openProject(new Blob(['file']));const checked=assert.rejects(pending,{code:'WORKSPACE_TRANSFER_SUPERSEDED'});await new Promise(resolve=>setImmediate(resolve));const current=snapshot('default',41,5);controller.adoptModel(current);held.resolve(json(snapshot(binding.documentId,3,3)));await checked;assert.equal(controller.getSnapshot().model,current);assert.equal(controller.getSnapshot().documentId,'default');}finally{controller.disposeTaskTracking();}
});

test('successful creation with an unavailable current view is reported as committed, keeps the source and never uploads again',async()=>{
  let binding,status,uploads=0;const controller=new ModelingController({taskControl:true,fetchImpl:async(url,init)=>{
    if(String(url).endsWith('/activity'))return idleWorkspaceResponse(url);
    if(String(url).endsWith('/commands'))return json(snapshot());
    if(String(url).endsWith('/project/open/tasks')){binding=JSON.parse(init.body).command;status=task(binding);return json(row(binding,status),201);}
    if(String(url).endsWith('/project/open')){uploads++;return json({...snapshot(binding.documentId,1,1),...row(binding,{...status,phase:'succeeded',sequence:8,cancellable:false},false)});}
    if(String(url).endsWith('/activate'))throw Error('view reply lost');throw Error('Unexpected '+url);
  }});
  try{await controller.execute({operation:'document.view'});await assert.rejects(controller.openProject(new Blob(['file'])),error=>error.code==='PROJECT_OPEN_VIEW_UNAVAILABLE'&&error.modelingTask.phase==='succeeded');assert.equal(controller.getSnapshot().documentId,'default');assert.equal(controller.getSnapshot().busy,false);assert.equal(uploads,1);}finally{controller.disposeTaskTracking();}
});

test('opening a recovered completed task rechecks source state after status lookup and refuses a late cross-workspace switch',async()=>{
  const input=command(),status=task(input,'succeeded',{cancellable:false}),held=deferred();let activations=0;
  const controller=new ModelingController({taskControl:true,fetchImpl:async(url)=>{
    if(String(url).endsWith('/commands'))return json(snapshot());
    if(String(url).endsWith('/modeling-tasks'))return json({tasks:[]});
    if(String(url).includes('/project/open-tasks?'))return json(list('default',[row(input,status,false)]));
    if(String(url).includes('/project/create-tasks?'))return json({sourceDocumentId:'default',total:0,items:[],active:[],attention:[],nextCursor:null});
    if(String(url).endsWith('/'+status.taskId))return held.promise;
    if(String(url).endsWith('/activate')){activations++;return json(snapshot('target',2,2));}
    throw Error('Unexpected '+url);
  }});
  try{await controller.execute({operation:'document.view'});await controller.refreshModelingTasks();const pending=controller.openCompletedProjectTask(status.taskId),checked=assert.rejects(pending,{code:'WORKSPACE_TRANSFER_SUPERSEDED'});controller.adoptModel(snapshot('default',41,5));held.resolve(json({modelingTask:status}));await checked;assert.equal(activations,0);assert.equal(controller.getSnapshot().documentId,'default');}finally{controller.disposeTaskTracking();}
});
