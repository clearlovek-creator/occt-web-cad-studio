import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelingController} from '../app/modeling/modeling-controller.ts';
import {randomUUID} from 'node:crypto';
import {idleWorkspaceResponse,activatedWorkspaceResponse} from './helpers/workspace-activation-fixture.mjs';
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const snapshot=(documentId='default',revision=40,stateSequence=4)=>({ok:true,documentId,revision,stateSequence,stateToken:String(stateSequence).repeat(64),positions:[],features:[],bodyId:'body-'+documentId});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const target=url=>decodeURIComponent(new URL(url,'http://localhost').pathname.split('/')[3]);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(handler,{tracked=true}={}){
  const calls=[];let input,task,opened;
  const binding=()=>({version:1,taskId:task.taskId,...input,canUpload:task.phase==='reserved'});
  const controller=new ModelingController({taskControl:tracked,fetchImpl:async(url,options)=>{
    url=String(url);calls.push({url,options});
    if(url.endsWith('/commands'))return json(snapshot());
    if(url.endsWith('/activity'))return idleWorkspaceResponse(url);
    if(url.endsWith('/project/open/tasks')){input=JSON.parse(options.body).command;task={version:1,taskId:randomUUID(),documentId:input.documentId,operation:'project.open',requestKey:input.requestId,phase:'reserved',sequence:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),cancelRequested:false,cancellable:true,reportDurable:true};return json({ok:true,modelingTask:task,projectOpen:binding()});}
    if(task&&url.endsWith('/modeling-tasks/'+task.taskId))return json({ok:true,modelingTask:task});
    if(url.endsWith('/project/open')){try{const response=await handler(url,options);opened=await response.clone().json();task={...task,phase:response.ok&&opened.ok?'succeeded':'failed',sequence:8,cancellable:false};return new Response(JSON.stringify({...opened,modelingTask:task,projectOpen:binding()}),{status:response.status});}catch(error){task={...task,phase:'unknown',sequence:8,cancellable:false};throw error;}}
    if(url.endsWith('/activate')){const response=opened?json(opened):await handler(url,options);return activatedWorkspaceResponse(await response.json(),options);}
    return handler(url,options);
  }});
  await controller.execute({operation:'document.view'});controller.setSelection({kind:'body',bodyId:'body-default'});controller.setActiveOperation('primitive.box');return {controller,calls};
}
test('one open owns its file and source workspace until acceptance and blocks competing transfer, mutation, STEP and Agent submissions',async()=>{
  const hold=deferred(),f=await fixture(()=>hold.promise),file=new Blob(['original file']),before=f.controller.getSnapshot(),pending=f.controller.openProject(file);await tick();const request=f.calls.at(-1),beforeBlocked=f.calls.length;
  assert.equal(request.options.body,file);assert.ok(request.options.headers['X-Request-Id']);assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.getSnapshot().documentId,'default');assert.equal(f.controller.getSnapshot().busy,true);
  for(const action of [()=>f.controller.openProject(new Blob(['other'])),()=>f.controller.restoreWorkspace('other'),()=>f.controller.createNewProject(),()=>f.controller.saveProject(),()=>f.controller.importStep(new Blob(['step'])),()=>f.controller.execute({operation:'primitive.box'}),()=>f.controller.executeBatch([{operation:'primitive.box'}]),()=>f.controller.exportStep(),()=>f.controller.renameWorkspace('other'),()=>f.controller.streamAgentRun('create a box')])await assert.rejects(action(),{code:'WORKSPACE_TRANSFER_BUSY'});
  assert.equal(f.calls.length,beforeBlocked);await f.controller.execute({operation:'document.summary'});assert.equal(f.controller.getSnapshot().busy,true);
  const id=target(request.url);hold.resolve(json(snapshot(id,1,1)));await pending;const after=f.controller.getSnapshot();assert.equal(after.documentId,id);assert.equal(after.revision,1,'A fresh target may legitimately have a lower native revision');assert.equal(after.model.bodyId,'body-'+id);assert.equal(after.selection,null);assert.equal(after.operationWindow,null);assert.equal(after.busy,false);assert.equal(f.calls.filter(call=>call.url.endsWith('/project/open')).length,1);
});
test('an advanced source state never adopts an old opened result or automatically uploads again',async()=>{
  const hold=deferred(),f=await fixture(()=>hold.promise),pending=f.controller.openProject(new Blob(['file'])),checked=assert.rejects(pending,{code:'WORKSPACE_TRANSFER_SUPERSEDED'});await tick();const id=target(f.calls.at(-1).url);
  const newer=snapshot('default',40,5);assert.equal(f.controller.adoptModel(newer),true);hold.resolve(json(snapshot(id,1,1)));await checked;
  assert.equal(f.controller.getSnapshot().model,newer);assert.equal(f.controller.getSnapshot().documentId,'default');assert.equal(f.controller.getSnapshot().stateSequence,5);assert.equal(f.controller.getSnapshot().error,null);assert.equal(f.controller.getSnapshot().busy,false);assert.equal(f.controller.getSnapshot().commandLog.at(-1).status,'success');assert.equal(f.controller.getSnapshot().commandLog.at(-1).warningCount,1);assert.equal(f.calls.filter(call=>call.url.endsWith('/project/open')).length,1);
});
test('malformed successful opens never replace the current model, selection or operation window',async()=>{
  for(const malformed of [value=>({...value,documentId:'wrong'}),value=>({...value,documentId:undefined}),value=>({...value,revision:-1}),value=>({...value,stateSequence:-1}),value=>({...value,stateToken:'invalid'}),value=>({...value,positions:null}),value=>({...value,positions:undefined,features:undefined})]){
    const f=await fixture(url=>json(malformed(snapshot(target(url),1,1)))),before=f.controller.getSnapshot();try{await assert.rejects(f.controller.openProject(new Blob(['file'])),error=>['INVALID_RESPONSE','MODELING_TASK_PROTOCOL','MODELING_TASK_RESULT_UNCONFIRMED','MODELING_TASK_RECEIPT_UNAVAILABLE'].includes(error.code));const after=f.controller.getSnapshot();assert.equal(after.model,before.model);assert.deepEqual(after.selection,before.selection);assert.equal(after.operationWindow,before.operationWindow);assert.equal(after.busy,false);assert.equal(after.commandLog.at(-1).status,'error');}finally{f.controller.disposeTaskTracking();}
  }
});
test('network loss and non-JSON errors keep the previous workspace and describe the open outcome as unconfirmed',async()=>{
  for(const reply of [()=>{throw TypeError('fetch failed');},()=>new Response('Not Found',{status:404})]){
    const f=await fixture(reply),before=f.controller.getSnapshot();try{await assert.rejects(f.controller.openProject(new Blob(['file'])),error=>['NETWORK_ERROR','INVALID_RESPONSE','MODELING_TASK_RESULT_UNCONFIRMED'].includes(error.code)&&/未确认|核对/.test(error.message));assert.equal(f.controller.getSnapshot().documentId,before.documentId);assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.getSnapshot().busy,false);assert.equal(f.calls.filter(call=>call.url.endsWith('/project/open')).length,1);}finally{f.controller.disposeTaskTracking();}
  }
});
test('restore activation is serialized and its accepted result is bound to the exact target document',async()=>{
  const hold=deferred(),f=await fixture(()=>hold.promise),pending=f.controller.restoreWorkspace('restored');await tick();const before=f.calls.length;await assert.rejects(f.controller.restoreWorkspace('other'),{code:'WORKSPACE_TRANSFER_BUSY'});assert.equal(f.calls.length,before);hold.resolve(json(snapshot('restored',2,1)));await pending;assert.equal(f.controller.getSnapshot().documentId,'restored');assert.equal(f.controller.getSnapshot().revision,2);assert.equal(f.controller.getSnapshot().operationWindow,null);assert.equal(f.controller.getSnapshot().busy,false);
});
test('saving remains owned through the entire file body, blocks conflicting edits, and records generation rather than a claimed local save',async()=>{
  let stream;const response=new Response(new ReadableStream({start(controller){stream=controller;}}),{headers:{'Content-Type':'application/vnd.webcad.project'}}),f=await fixture(()=>response,{tracked:false}),before=f.controller.getSnapshot(),pending=f.controller.saveProject();await Promise.resolve();await Promise.resolve();
  assert.equal(f.controller.getSnapshot().busy,true);await assert.rejects(f.controller.openProject(new Blob(['file'])),{code:'WORKSPACE_TRANSFER_BUSY'});await assert.rejects(f.controller.execute({operation:'body.delete'}),{code:'WORKSPACE_TRANSFER_BUSY'});stream.enqueue(new Uint8Array([1,2,3]));stream.close();const file=await pending;assert.deepEqual([...new Uint8Array(await file.arrayBuffer())],[1,2,3]);assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.getSnapshot().busy,false);assert.match(f.controller.getSnapshot().commandLog.at(-1).message,/不代表本地保存已完成/);
});
test('saving rejects HTML masquerading as a successful file without changing the current workspace',async()=>{
  const f=await fixture(()=>new Response('<html>gateway error</html>',{headers:{'Content-Type':'text/html'}}),{tracked:false}),before=f.controller.getSnapshot();await assert.rejects(f.controller.saveProject(),{code:'INVALID_RESPONSE'});assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.getSnapshot().busy,false);
});
