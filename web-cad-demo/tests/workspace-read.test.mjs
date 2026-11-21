import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWorkspaceRead,normalizeWorkspaceReadProof} from '../shared/workspace-read.mjs';
import {ModelingController} from '../app/modeling/modeling-controller.ts';
import {initialWorkspaceId} from '../app/modeling/initial-workspace.ts';
import {idleWorkspaceResponse,activatedWorkspaceResponse} from './helpers/workspace-activation-fixture.mjs';
const input=patch=>({protocolVersion:1,operation:'project.read',documentId:'default',requestId:'read-1',...patch});
const snapshot=(documentId='default',patch={})=>({ok:true,documentId,revision:4,stateSequence:5,stateToken:'a'.repeat(64),features:[],positions:[],bodyId:'first-body',...patch});
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {resolve,reject,promise};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function proof(init,documentId='default',patch={}){return {...snapshot(documentId),workspaceRead:input({documentId,requestId:init.headers['X-Request-Id']}),...patch};}
test('read protocol is exact and cannot contain hidden activation/source fields',()=>{
  assert.deepEqual(normalizeWorkspaceRead(Object.fromEntries(Object.entries(input()).reverse())),input());
  for(const patch of [{documentId:'../a'},{requestId:''},{requestId:'a'.repeat(161)},{protocolVersion:2},{operation:'project.activate'},{sourceDocumentId:'other'}])assert.throws(()=>normalizeWorkspaceRead(input(patch)));
  assert.deepEqual(normalizeWorkspaceReadProof(input(),input()),input());for(const patch of [{documentId:'other'},{requestId:'other'}])assert.throws(()=>normalizeWorkspaceReadProof(input(patch),input()));assert.throws(()=>normalizeWorkspaceReadProof(undefined,input()));
});
test('boot identity prefers valid tab storage, then shared storage; no malformed identity or denied storage escapes',()=>{
  const storage=(session,local)=>({sessionStorage:{getItem:()=>session},localStorage:{getItem:()=>local}});
  assert.equal(initialWorkspaceId(storage('tab','shared')),'tab');assert.equal(initialWorkspaceId(storage('../invalid','shared')),'shared');assert.equal(initialWorkspaceId(storage(null,'shared')),'shared');assert.equal(initialWorkspaceId(storage('','x'.repeat(65))),'default');assert.equal(initialWorkspaceId(),'default');
  assert.equal(initialWorkspaceId({get sessionStorage(){throw Error('denied');},localStorage:{getItem:()=> 'shared'}}),'shared');assert.equal(initialWorkspaceId({get sessionStorage(){throw Error('denied');},get localStorage(){throw Error('denied');}}),'default');
});
test('server snapshot remains stable and empty while client starts from remembered identity',()=>{
  const c=new ModelingController({documentId:'remembered',serverDocumentId:'default'}),server=c.getServerSnapshot();assert.equal(server.documentId,'default');assert.equal(c.getSnapshot().documentId,'remembered');c.setSelection({kind:'body',bodyId:'chosen'});c.adoptModel(snapshot('remembered'));assert.equal(c.getServerSnapshot(),server);assert.equal(server.model,null);assert.equal(server.selection,null);
});
test('same-workspace reads coalesce and preserve selection, operation and conversation without Pi requests',async()=>{
  const hold=deferred(),calls=[],c=new ModelingController({fetchImpl:(url,init)=>{calls.push({url,init});return hold.promise;}});c.adoptModel(snapshot());c.setSelection({kind:'body',bodyId:'chosen'});c.setActiveOperation('primitive.box');const before=c.getSnapshot(),a=c.readCurrentWorkspace(),b=c.readCurrentWorkspace();assert.equal(a,b);assert.equal(c.hasWorkspaceTransfer(),false);assert.equal(c.hasPendingMutation(),false);await tick();assert.equal(calls.length,1);assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.cache,'no-store');hold.resolve(json(proof(calls[0].init)));await a;const after=c.getSnapshot();for(const key of ['selection','currentBodyId','activeOperation','operationWindow','agentConversation','agentPlan','agentRun'])assert.equal(after[key],before[key],key);assert.equal(after.busy,false);
});
test('an unloaded self-read accepts a concurrent matching query without resetting its context',async()=>{
  const hold=deferred();let init;const c=new ModelingController({fetchImpl:(_url,value)=>{init=value;return hold.promise;}}),pending=c.readCurrentWorkspace();await tick();c.adoptModel(snapshot());c.setSelection({kind:'body',bodyId:'chosen'});hold.resolve(json(proof(init)));await pending;assert.equal(c.getSnapshot().selection.bodyId,'chosen');
});
test('newer model sequence and contradictory same-sequence tokens or revisions cannot be replaced by a read',async()=>{
  for(const patch of [{stateSequence:6,revision:5,stateToken:'b'.repeat(64)},{stateToken:'b'.repeat(64)},{revision:9}]){const hold=deferred();let init;const c=new ModelingController({fetchImpl:(_url,value)=>{init=value;return hold.promise;}}),pending=c.readCurrentWorkspace(),checked=assert.rejects(pending,{code:'WORKSPACE_READ_SUPERSEDED'});await tick();const newer=snapshot('default',patch);c.adoptModel(newer);hold.resolve(json(proof(init)));await checked;assert.equal(c.getSnapshot().model,newer);assert.equal(c.getSnapshot().error,null);}
});
test('missing, foreign, malformed or incomplete read proof never adopts a superficially successful model',async()=>{
  for(const patch of [{workspaceRead:undefined},{workspaceRead:input({documentId:'foreign'})},{workspaceRead:input({requestId:'other'})},{documentId:'foreign'},{stateToken:undefined},{stateSequence:undefined},{revision:-1},{positions:'bad'}]){const c=new ModelingController({fetchImpl:async(_url,init)=>json(proof(init,'default',patch))}),before=snapshot();c.adoptModel(before);await assert.rejects(c.readCurrentWorkspace(),{code:'WORKSPACE_READ_UNCONFIRMED'});assert.equal(c.getSnapshot().model,before);assert.equal(c.getSnapshot().busy,false);}
});
test('a read finishing after A-to-B-to-A is rejected even when A still has identical geometry stamps',async()=>{
  const hold=deferred();let readInit;const c=new ModelingController({fetchImpl:async(url,init)=>{url=String(url);if(url.endsWith('/view')){readInit=init;return hold.promise;}if(url.endsWith('/activity'))return idleWorkspaceResponse(url);if(url.endsWith('/activate')){const command=JSON.parse(init.body).command;return activatedWorkspaceResponse(snapshot(command.documentId),init);}throw Error(url);}});c.adoptModel(snapshot());const pending=c.readCurrentWorkspace(),checked=assert.rejects(pending,{code:'WORKSPACE_READ_SUPERSEDED'});await tick();await c.restoreWorkspace('other');await c.restoreWorkspace('default');const latest=c.getSnapshot().model;hold.resolve(json(proof(readInit)));await checked;assert.equal(c.getSnapshot().model,latest);assert.equal(c.getSnapshot().error,null);
});
test('late read failure cannot put its error on a different workspace',async()=>{
  const hold=deferred(),c=new ModelingController({fetchImpl:async(url,init)=>{url=String(url);if(url.endsWith('/view'))return hold.promise;if(url.endsWith('/activity'))return idleWorkspaceResponse(url);return activatedWorkspaceResponse(snapshot('other'),init);}});c.adoptModel(snapshot());const pending=c.readCurrentWorkspace(),checked=assert.rejects(pending,{code:'NETWORK_ERROR'});await tick();await c.restoreWorkspace('other');hold.reject(Error('offline'));await checked;assert.equal(c.getSnapshot().documentId,'other');assert.equal(c.getSnapshot().error,null);
});
test('disposal invalidates a late read but does not suppress subsequent explicit loading',async()=>{
  const hold=deferred();let init,count=0;const c=new ModelingController({fetchImpl:async(_url,value)=>{init=value;return ++count===1?hold.promise:json(proof(value));}}),pending=c.readCurrentWorkspace(),checked=assert.rejects(pending,{code:'WORKSPACE_READ_SUPERSEDED'});await tick();c.disposeTaskTracking();hold.resolve(json(proof(init)));await checked;assert.equal(c.getSnapshot().model,null);await c.readCurrentWorkspace();assert.equal(c.getSnapshot().revision,4);
});
test('synchronous transport errors settle coalescing and allow a later manual retry',async()=>{
  let count=0;const c=new ModelingController({fetchImpl:(_url,init)=>{if(++count===1)throw Error('offline');return Promise.resolve(json(proof(init)));}});await assert.rejects(c.readCurrentWorkspace(),{code:'NETWORK_ERROR'});assert.equal(c.getSnapshot().busy,false);await c.readCurrentWorkspace();assert.equal(count,2);assert.equal(c.getSnapshot().error,null);
});
test('subscriber reentry observes the same read instead of starting another transport',async()=>{
  let count=0,reentered;const c=new ModelingController({fetchImpl:async(_url,init)=>{count++;return json(proof(init));}});const unsubscribe=c.subscribe(()=>{if(c.getSnapshot().pendingOperation==='document.view'&&!reentered)reentered=c.readCurrentWorkspace();});const pending=c.readCurrentWorkspace();unsubscribe();assert.equal(reentered,pending);await pending;assert.equal(count,1);
});
test('a queued read abandoned before dispatch never contacts the former workspace',async()=>{
  let calls=0;const c=new ModelingController({fetchImpl:async()=>{calls++;throw Error('not called');}}),pending=c.readCurrentWorkspace(),checked=assert.rejects(pending,{code:'WORKSPACE_READ_SUPERSEDED'});c.disposeTaskTracking();await checked;assert.equal(calls,0);assert.equal(c.getSnapshot().busy,false);
});
test('non-JSON, invalid HTTP and typed backend failures retain the current model',async()=>{
  for(const response of [new Response('Not Found',{status:404}),json({}),new Response(JSON.stringify({ok:true}),{status:500}),new Response(JSON.stringify({ok:false,code:'WORKSPACE_UNAVAILABLE',error:'checkpoint unavailable'}),{status:409})]){const c=new ModelingController({fetchImpl:async()=>response}),before=snapshot();c.adoptModel(before);await assert.rejects(c.readCurrentWorkspace());assert.equal(c.getSnapshot().model,before);assert.equal(c.getSnapshot().busy,false);}
});
