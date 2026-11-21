import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ModelingController} from '../app/modeling/modeling-controller.ts';
import {assertPiWorkspaceIdle} from '../app/modeling/pi-workspace-activity.ts';
import {idleWorkspaceResponse,activatedWorkspaceResponse} from './helpers/workspace-activation-fixture.mjs';
const json=(value,status=200)=>new Response(JSON.stringify({ok:true,...value}),{status,headers:{'Content-Type':'application/json'}});
const snapshot=(documentId='default',revision=40,stateSequence=4)=>({ok:true,documentId,revision,stateSequence,stateToken:String(stateSequence).repeat(64),features:[],bodyMetadata:[],bodyId:'body-'+documentId});
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const idle=(patch={})=>({ok:true,protocolVersion:1,documentId:'default',activity:{version:1,documentId:'default',status:'idle',guarded:false,checkedAt:new Date().toISOString(),sessions:[],...patch}});
const task=(input,phase='reserved')=>({version:1,taskId:randomUUID(),documentId:input.documentId,operation:'project.create',requestKey:input.requestId,phase,sequence:phase==='reserved'?1:8,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),cancelRequested:false,cancellable:phase==='reserved',reportDurable:true});
const row=(input,status,canCreate=status.phase==='reserved')=>({modelingTask:status,projectCreate:{version:1,taskId:status.taskId,...input,canCreate}});
const receipt=(input,status)=>({ok:true,documentId:input.documentId,requestId:input.requestId,revision:1,stateSequence:1,stateToken:'a'.repeat(64),bodyCount:0,featureCount:0,features:[],bodies:[],bodyMetadata:[],variables:[],propertyRecords:[],coordinateSystems:[],materials:[],stats:{faceCount:0,edgeCount:0,triangleCount:0},propertySchema:{types:[],instances:[]},...row(input,status,false)});
async function fixture(options={}){
  const calls=[];let input,status;
  const controller=new ModelingController({taskControl:options.taskControl!==false,fetchImpl:async(url,init)=>{
    url=String(url);calls.push({url,init});
    if(url.endsWith('/commands'))return json(snapshot());
    if(url.endsWith('/activity'))return options.activity?options.activity():idleWorkspaceResponse(url);
    if(url.endsWith('/project/create/tasks')){input=JSON.parse(init.body).command;status=task(input);return options.register?options.register(input,status):json(row(input,status),201);}
    if(url.endsWith('/project/create')){assert.deepEqual(JSON.parse(init.body).command,input);assert.equal(init.headers['X-Cad-Task-Id'],status.taskId);return options.submit?options.submit(input,status):json(receipt(input,{...status,phase:'succeeded',sequence:8,cancellable:false}));}
    if(url.endsWith('/activate')){const response=options.activate?await options.activate(input):json(snapshot(input.documentId,3,3));return activatedWorkspaceResponse(await response.json(),init);}
    throw Error('Unexpected '+url);
  }});
  await controller.execute({operation:'document.view'});controller.setSelection({kind:'body',bodyId:'body-default'});controller.setActiveOperation('primitive.box');
  return {controller,calls,get input(){return input;},get status(){return status;}};
}
test('one-click creation preserves source model and selection through registration, commit and separate current-view read',async()=>{
  const registration=deferred(),view=deferred(),f=await fixture({register:()=>registration.promise,activate:()=>view.promise}),before=f.controller.getSnapshot();
  try{
    const pending=f.controller.createNewProject();await tick();assert.equal(f.controller.hasWorkspaceTransfer(),true);assert.equal(f.controller.getSnapshot().model,before.model);assert.deepEqual(f.controller.getSnapshot().selection,before.selection);
    for(const action of [()=>f.controller.createNewProject(),()=>f.controller.restoreWorkspace('other'),()=>f.controller.execute({operation:'body.delete'}),()=>f.controller.streamAgentRun('create box')])await assert.rejects(action(),{code:'WORKSPACE_TRANSFER_BUSY'});
    registration.resolve(json(row(f.input,f.status),201));await tick();assert.equal(f.controller.getSnapshot().documentId,'default');assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.hasWorkspaceTransfer(),true);
    view.resolve(json(snapshot(f.input.documentId,7,7)));const result=await pending;assert.equal(result.revision,7);assert.equal(f.controller.getSnapshot().revision,7);assert.equal(f.controller.getSnapshot().selection,null);assert.equal(f.controller.hasWorkspaceTransfer(),false);assert.equal(f.controller.getSnapshot().busy,false);assert.equal(f.calls.filter(call=>call.url.endsWith('/project/create')).length,1);assert.equal(f.calls.filter(call=>call.url.endsWith('/commands')).length,1);assert.equal(f.input.sourceRevision,40);
  }finally{f.controller.disposeTaskTracking();}
});
test('missing task capability fails closed without legacy document reset or changing source identity',async()=>{
  const f=await fixture({taskControl:false}),before=f.controller.getSnapshot();try{await assert.rejects(f.controller.createNewProject(),{code:'PROJECT_CREATE_TASK_REQUIRED'});assert.equal(f.calls.length,1);assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.getSnapshot().documentId,'default');assert.equal(f.controller.getSnapshot().busy,false);}finally{f.controller.disposeTaskTracking();}
});
test('busy, unknown, guarded and malformed Pi activity never register or create a target',async()=>{
  for(const value of [idle({status:'busy'}),idle({status:'unknown'}),idle({guarded:true}),idle({sessions:[{sessionId:'x',status:'idle',streamId:'s',isStreaming:true,isCompacting:false,pendingMessageCount:0}]}),{ok:true}]){
    const f=await fixture({activity:()=>json(value)}),before=f.controller.getSnapshot();try{await assert.rejects(f.controller.createNewProject(),{code:'PI_DOCUMENT_NOT_IDLE'});assert.equal(f.calls.length,2);assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.getSnapshot().documentId,'default');assert.equal(f.controller.hasWorkspaceTransfer(),false);}finally{f.controller.disposeTaskTracking();}
  }
});
test('source changes during native preflight prevent any registration and preserve the newer source',async()=>{
  const hold=deferred(),f=await fixture({activity:()=>hold.promise});try{const pending=f.controller.createNewProject(),checked=assert.rejects(pending,{code:'WORKSPACE_TRANSFER_SUPERSEDED'});await tick();const newer=snapshot('default',41,5);f.controller.adoptModel(newer);hold.resolve(json(idle()));await checked;assert.equal(f.controller.getSnapshot().model,newer);assert.equal(f.calls.length,2);}finally{f.controller.disposeTaskTracking();}
});
test('source changes during target read reject a late empty view without reverting the newer model',async()=>{
  const hold=deferred(),f=await fixture({activate:()=>hold.promise});try{const pending=f.controller.createNewProject(),checked=assert.rejects(pending,{code:'WORKSPACE_TRANSFER_SUPERSEDED'});await tick();const newer=snapshot('default',41,5);f.controller.adoptModel(newer);hold.resolve(json(snapshot(f.input.documentId,1,1)));await checked;assert.equal(f.controller.getSnapshot().model,newer);assert.equal(f.controller.getSnapshot().documentId,'default');assert.equal(f.calls.filter(call=>call.url.endsWith('/project/create')).length,1);}finally{f.controller.disposeTaskTracking();}
});
test('committed target with unavailable current view retains source and offers recovery rather than claiming not created',async()=>{
  const f=await fixture({activate:()=>{throw Error('lost view');}}),before=f.controller.getSnapshot();try{await assert.rejects(f.controller.createNewProject(),error=>error.code==='PROJECT_CREATE_VIEW_UNAVAILABLE'&&error.details.targetDocumentId===f.input.documentId);assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.getSnapshot().modelingTasks[0].task.phase,'succeeded');assert.equal(f.controller.getSnapshot().modelingTasks[0].projectCreate.sourceDocumentId,'default');assert.equal(f.controller.hasPendingMutation(),false);assert.equal(f.calls.filter(call=>call.url.endsWith('/project/create')).length,1);}finally{f.controller.disposeTaskTracking();}
});
test('manual discovery restores a source-owned creation and cancellation addresses its target without creating again',async()=>{
  const input={protocolVersion:1,operation:'project.create',sourceDocumentId:'default',documentId:'target',requestId:'create-restored',name:'未命名工程',sourceRevision:40,sourceStateToken:'4'.repeat(64),sourceStateSequence:4},status=task(input),calls=[];
  const controller=new ModelingController({taskControl:true,fetchImpl:async(url,init)=>{url=String(url);calls.push({url,init});if(url.endsWith('/modeling-tasks'))return json({ok:true,tasks:[]});if(url.includes('/project/create-tasks?'))return json({ok:true,sourceDocumentId:'default',total:1,items:[row(input,status,false)],active:[row(input,status,false)],attention:[],nextCursor:null});if(url.endsWith('/cancel'))return json({ok:true,modelingTask:{...status,phase:'cancelled',sequence:8,cancellable:false,cancelRequested:true,execution:'not-started'}});throw Error('Unexpected '+url);}});
  try{await controller.discoverModelingTasks();assert.equal(controller.hasPendingMutation(),true);await assert.rejects(controller.createNewProject(),{code:'WORKSPACE_TRANSFER_BUSY'});await controller.cancelModelingTask(status.taskId);assert.match(calls.at(-1).url,/\/documents\/target\/modeling-tasks\/.*\/cancel$/);assert.equal(controller.hasPendingMutation(),false);assert.equal(calls.filter(call=>call.init?.method==='POST').length,1);}finally{controller.disposeTaskTracking();}
});
test('Pi idle proof requires bounded, unique, complete native session rows and matching document identities',async()=>{
  const valid={sessionId:'one',streamId:'stream',status:'idle',isStreaming:false,isCompacting:false,pendingMessageCount:0};
  await assertPiWorkspaceIdle('/api',async()=>json(idle({sessions:[valid]})),'default');
  for(const value of [idle({sessions:[valid,valid]}),idle({sessions:Array(33).fill(valid)}),idle({sessions:[{...valid,isCompacting:true}]}),{...idle(),documentId:'foreign'},idle({documentId:'foreign'}),idle({sessions:[{...valid,pendingMessageCount:1}]}),idle({checkedAt:'invalid'})])await assert.rejects(assertPiWorkspaceIdle('/api',async()=>json(value),'default'));
  await assert.rejects(assertPiWorkspaceIdle('/api',async()=>new Response('x'.repeat(65537)),'default'));
});
