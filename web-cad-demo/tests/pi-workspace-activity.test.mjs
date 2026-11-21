import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {PiRpcRuntime,PI_DOCUMENT_ACTIVITY_LIMITS} from '../gateway/pi-rpc-runtime.mjs';
import {gatewayErrorStatus} from '../gateway/gateway-error-status.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
async function until(predicate){const end=Date.now()+2000;while(!predicate()){assert.ok(Date.now()<end,'Fixture did not reach the requested state');await tick();}}
function close(child){if(child.exitCode!==null)return;child.exitCode=0;child.signalCode=null;child.emit('exit',0,null);child.stdout.end();child.stderr.end();child.emit('close',0,null);}
function fixture(options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-pi-activity-')),entries=[];
  const runtime=new PiRpcRuntime({cliPath:'fake.js',extensionPath:path.join(root,'extension.mjs'),cwd:root,sessionRoot:path.join(root,'sessions'),agentConfigDir:path.join(root,'config'),activityTimeoutMs:options.timeoutMs??1000,spawnImpl:(_binary,args,config)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.signalCode=null;child.pid=12000+entries.length;
    const entry={child,documentId:config.env.CAD_DOCUMENT_ID,commands:[],state:{isStreaming:false,isCompacting:false,pendingMessageCount:0,model:{apiKey:'DO_NOT_EXPOSE'},sessionFile:'C:/private-history.jsonl'},holdState:Boolean(options.holdState),heldStates:[],holdPrompt:false,heldPrompts:[],holdExit:false};
    const respond=(command,data)=>child.stdout.write(JSON.stringify({type:'response',id:command.id,command:command.type,success:true,data})+'\n');
    child.stdin=new Writable({write(bytes,_encoding,done){const command=JSON.parse(String(bytes));entry.commands.push(command);if(command.type==='get_state'){const snapshot=structuredClone(entry.state),reply=()=>respond(command,snapshot);if(entry.holdState)entry.heldStates.push(reply);else queueMicrotask(reply);}else if(command.type==='prompt'){entry.state.isStreaming=true;if(entry.holdPrompt)entry.heldPrompts.push(()=>respond(command,{}));else queueMicrotask(()=>respond(command,{}));}else{if(command.type==='abort')entry.state.isStreaming=false;queueMicrotask(()=>respond(command,{}));}done();}});
    child.kill=()=>{if(!entry.holdExit)close(child);return true;};entries.push(entry);return child;
  }});
  return {root,runtime,entries,async create(sessionId='source',documentId='default'){return runtime.create({sessionId,documentId});},async dispose(){for(const entry of entries){entry.holdExit=false;close(entry.child);}await runtime.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-pi-activity-/);fs.rmSync(root,{recursive:true,force:true});}};
}

test('an absent Pi workspace is observed without creating a session, owner, config or history',async()=>{
  const f=fixture();try{const value=await f.runtime.documentActivity('default');assert.equal(value.status,'idle');assert.equal(value.guarded,false);assert.deepEqual(value.sessions,[]);assert.equal(f.entries.length,0);assert.deepEqual(fs.readdirSync(f.root),[]);let ran=0;await f.runtime.withDocumentQuiescent('default',()=>ran++);assert.equal(ran,1);assert.deepEqual(fs.readdirSync(f.root),[]);}finally{await f.dispose();}
});

test('live native state is projected to bounded identity and activity fields without model, path or history content',async()=>{
  const f=fixture();try{const session=await f.create(),value=await f.runtime.documentActivity('default');assert.equal(value.status,'idle');assert.equal(value.sessions.length,1);assert.equal(value.sessions[0].sessionId,'source');assert.equal(value.sessions[0].streamId,session.streamId);assert.equal(value.sessions[0].pendingMessageCount,0);assert.doesNotMatch(JSON.stringify(value),/DO_NOT_EXPOSE|private-history|model|apiKey/);assert.deepEqual(f.entries[0].commands.map(value=>value.type),['get_state','get_state']);}finally{await f.dispose();}
});

test('streaming, compaction and queued native messages all prevent workspace admission without an abort or model call',async()=>{
  const f=fixture();try{await f.create();const entry=f.entries[0];for(const patch of [{isStreaming:true},{isCompacting:true},{pendingMessageCount:2}]){entry.state={isStreaming:false,isCompacting:false,pendingMessageCount:0,...patch};const value=await f.runtime.documentActivity('default');assert.equal(value.status,'busy');let ran=false;await assert.rejects(f.runtime.withDocumentQuiescent('default',()=>ran=true),{code:'PI_DOCUMENT_ACTIVE'});assert.equal(ran,false);assert.equal(f.runtime.documentGuards.size,0);}assert.ok(entry.commands.every(command=>command.type==='get_state'));}finally{await f.dispose();}
});

test('an unacknowledged mutative RPC is busy even when its last native streaming state is false',async()=>{
  const f=fixture();try{const session=await f.create(),entry=f.entries[0];entry.holdPrompt=true;const pending=session.request({type:'prompt',message:'do not lose ownership'});pending.catch(()=>{});entry.state.isStreaming=false;const before=entry.commands.length,value=await f.runtime.documentActivity('default');assert.equal(value.status,'busy');assert.equal(value.sessions[0].reason,'pending-command');assert.equal(entry.commands.length,before);entry.heldPrompts.shift()();await pending;}finally{await f.dispose();}
});

test('the workspace barrier blocks source mutations and new source sessions but keeps observations, stop and other projects available',async()=>{
  const f=fixture();try{const source=await f.create(),other=await f.create('other','other'),hold=deferred();let entered=false;
    const pending=f.runtime.withDocumentQuiescent('default',async()=>{entered=true;await hold.promise;});await until(()=>entered);assert.equal((await f.runtime.documentActivity('default')).guarded,true);
    const entry=f.entries[0],before=entry.commands.length;
    for(const command of [{type:'prompt',message:'blocked'},{type:'steer',message:'blocked'},{type:'follow_up',message:'blocked'},{type:'compact'},{type:'new_session'},{type:'set_model',provider:'x',modelId:'x'}])await assert.rejects(source.request(command),{code:'PI_DOCUMENT_TRANSFER_BUSY'});
    assert.equal(entry.commands.length,before);await assert.rejects(f.create('new-source','default'),{code:'PI_DOCUMENT_TRANSFER_BUSY'});assert.equal(fs.existsSync(path.join(f.root,'sessions/new-source')),false);
    for(const type of ['get_state','get_messages','abort','abort_retry'])assert.equal((await source.request({type})).success,true);
    await other.request({type:'prompt',message:'independent project'});assert.equal((await f.runtime.documentActivity('other')).status,'busy');
    await assert.rejects(f.runtime.ownership('legacy','default','a'.repeat(64)),{code:'PI_DOCUMENT_TRANSFER_BUSY'});assert.equal(fs.existsSync(path.join(f.root,'sessions/legacy')),false);
    hold.resolve();await pending;assert.equal(f.runtime.documentGuards.size,0);await source.request({type:'prompt',message:'allowed after completion'});
  }finally{await f.dispose();}
});

test('a barrier is released on an operation failure and a nested same-project action cannot release the original owner',async()=>{
  const f=fixture();try{await f.create();await assert.rejects(f.runtime.withDocumentQuiescent('default',async()=>{await assert.rejects(f.runtime.withDocumentQuiescent('default',()=>{}),{code:'PI_DOCUMENT_TRANSFER_BUSY'});assert.equal(f.runtime.documentGuards.has('default'),true);throw Error('operation failed');}),/operation failed/);assert.equal(f.runtime.documentGuards.size,0);assert.equal(await f.runtime.withDocumentQuiescent('default',()=>42),42);}finally{await f.dispose();}
});

test('startup is busy, never guessed idle, and a status check never starts a replacement process',async()=>{
  const f=fixture({holdState:true});try{const launch=f.create();await until(()=>f.entries.length===1);const value=await f.runtime.documentActivity('default');assert.equal(value.status,'busy');assert.equal(value.sessions[0].reason,'starting');await assert.rejects(f.runtime.withDocumentQuiescent('default',()=>{}),{code:'PI_DOCUMENT_ACTIVE'});assert.equal(f.entries.length,1);f.entries[0].heldStates.shift()();await launch;f.entries[0].holdState=false;assert.equal((await f.runtime.documentActivity('default')).status,'idle');}finally{await f.dispose();}
});

test('removing a session keeps unknown until its exact child and streams close, rather than inferring idle from map removal',async()=>{
  const f=fixture();try{await f.create();const entry=f.entries[0];entry.holdExit=true;const removing=f.runtime.remove('source');await until(()=>f.runtime.retiring.size===1);assert.equal((await f.runtime.documentActivity('default')).status,'unknown');await assert.rejects(f.runtime.withDocumentQuiescent('default',()=>{}),{code:'PI_DOCUMENT_ACTIVITY_UNCONFIRMED'});assert.equal(f.entries.length,1);close(entry.child);await removing;assert.equal((await f.runtime.documentActivity('default')).status,'idle');}finally{await f.dispose();}
});

test('an unexpectedly exited mapped session is unknown until an explicit reconnect verifies the restored native process',async()=>{
  const f=fixture();try{await f.create();close(f.entries[0].child);assert.equal((await f.runtime.documentActivity('default')).status,'unknown');await assert.rejects(f.runtime.withDocumentQuiescent('default',()=>{}),{code:'PI_DOCUMENT_ACTIVITY_UNCONFIRMED'});assert.equal(f.entries.length,1);await f.create();assert.equal(f.entries.length,2);assert.equal((await f.runtime.documentActivity('default')).status,'idle');}finally{await f.dispose();}
});

test('malformed states and read timeouts remain unknown, release admission and do not restart or issue prompts',async()=>{
  const f=fixture({timeoutMs:20});try{await f.create();const entry=f.entries[0];for(const state of [{},{isStreaming:false,isCompacting:false,pendingMessageCount:-1},{isStreaming:'false',isCompacting:false,pendingMessageCount:0}]){entry.state=state;assert.equal((await f.runtime.documentActivity('default')).status,'unknown');await assert.rejects(f.runtime.withDocumentQuiescent('default',()=>{}),{code:'PI_DOCUMENT_ACTIVITY_UNCONFIRMED'});assert.equal(f.runtime.documentGuards.size,0);}entry.state={isStreaming:false,isCompacting:false,pendingMessageCount:0};entry.holdState=true;assert.equal((await f.runtime.documentActivity('default')).status,'unknown');assert.equal(f.entries.length,1);assert.ok(entry.commands.every(command=>command.type==='get_state'));entry.holdState=false;for(const reply of entry.heldStates.splice(0))reply();assert.equal((await f.runtime.documentActivity('default')).status,'idle');}finally{await f.dispose();}
});

test('a native command admitted during a public state read invalidates even a captured idle reply',async()=>{
  const f=fixture();try{const session=await f.create(),entry=f.entries[0];entry.holdState=true;const pending=f.runtime.documentActivity('default');await until(()=>entry.heldStates.length===1);await session.request({type:'prompt',message:'racing prompt'});entry.state.isStreaming=false;entry.heldStates.shift()();const value=await pending;assert.equal(value.status,'unknown');assert.equal(value.sessions[0].reason,'changed');}finally{await f.dispose();}
});

test('stream changes during a state lookup cannot authorize a workspace action',async()=>{
  const f=fixture();try{const session=await f.create(),entry=f.entries[0];entry.holdState=true;let ran=false;const pending=f.runtime.withDocumentQuiescent('default',()=>ran=true),rejected=assert.rejects(pending,{code:'PI_DOCUMENT_ACTIVITY_UNCONFIRMED'});await until(()=>entry.heldStates.length===1);session.streamId=randomUUID();entry.heldStates.shift()();await rejected;assert.equal(ran,false);assert.equal(f.runtime.documentGuards.size,0);}finally{await f.dispose();}
});

test('concurrent status reads coalesce but admission obtains a fresh native read after any earlier observation',async()=>{
  const f=fixture();try{const session=await f.create(),entry=f.entries[0];entry.holdState=true;const first=f.runtime.documentActivity('default'),second=f.runtime.documentActivity('default');assert.equal(first,second);await until(()=>entry.heldStates.length===1);let ran=false;const action=f.runtime.withDocumentQuiescent('default',()=>ran=true);await assert.rejects(session.request({type:'prompt',message:'blocked while waiting for prior state'}),{code:'PI_DOCUMENT_TRANSFER_BUSY'});entry.heldStates.shift()();await first;await until(()=>entry.heldStates.length===1);assert.equal(ran,false);entry.heldStates.shift()();await action;assert.equal(ran,true);assert.equal(entry.commands.filter(command=>command.type==='get_state').length,3);}finally{await f.dispose();}
});

test('the session, concurrent document and barrier budgets fail closed without partial admission',async()=>{
  const runtime=new PiRpcRuntime(),holds=[];try{
    for(let i=0;i<33;i++)runtime.sessions.set('s'+i,{sessionId:'s'+i,documentId:'default'});await assert.rejects(runtime.documentActivity('default'),{code:'PI_DOCUMENT_ACTIVITY_LIMIT'});runtime.sessions.clear();await tick();
    for(let i=0;i<64;i++){const hold=deferred(),documentId='d'+i,streamId=randomUUID();holds.push(hold);runtime.sessions.set(documentId,{sessionId:documentId,documentId,streamId,child:{},commandSequence:0,pending:new Map(),request:()=>hold.promise});}
    const reads=[...runtime.sessions.keys()].map(id=>runtime.documentActivity(id));assert.throws(()=>runtime.documentActivity('overflow'),{code:'PI_DOCUMENT_ACTIVITY_LIMIT'});for(let i=0;i<64;i++){const session=runtime.sessions.get('d'+i);holds[i].resolve({transport:{streamId:session.streamId},data:{isStreaming:false,isCompacting:false,pendingMessageCount:0}});}await Promise.all(reads);runtime.sessions.clear();
    for(let i=0;i<64;i++)runtime.documentGuards.set('d'+i,Symbol());let ran=false;await assert.rejects(runtime.withDocumentQuiescent('overflow',()=>ran=true),{code:'PI_DOCUMENT_ACTIVITY_LIMIT'});assert.equal(ran,false);assert.equal(PI_DOCUMENT_ACTIVITY_LIMITS.sessions,32);
  }finally{runtime.sessions.clear();runtime.documentGuards.clear();await runtime.close();}
});

test('invalid identities, timeout settings and shutdown cannot produce an idle/admitted result and public error status is actionable',async()=>{
  const runtime=new PiRpcRuntime();for(const id of ['',null,'../escape','x'.repeat(65)])assert.throws(()=>runtime.documentActivity(id),{code:'PI_DOCUMENT_ACTIVITY_ARGUMENTS'});for(const activityTimeoutMs of [0,5001,1.5])assert.throws(()=>new PiRpcRuntime({activityTimeoutMs}),{code:'PI_DOCUMENT_ACTIVITY_ARGUMENTS'});await runtime.close();await assert.rejects(runtime.documentActivity('default'),{code:'PI_SESSION_OWNER_STOPPING'});await assert.rejects(runtime.withDocumentQuiescent('default',()=>{}),{code:'PI_SESSION_OWNER_STOPPING'});assert.equal(gatewayErrorStatus('PI_DOCUMENT_ACTIVE'),409);assert.equal(gatewayErrorStatus('PI_DOCUMENT_TRANSFER_BUSY'),409);assert.equal(gatewayErrorStatus('PI_DOCUMENT_ACTIVITY_UNCONFIRMED'),503);assert.equal(gatewayErrorStatus('PI_DOCUMENT_ACTIVITY_LIMIT'),429);
});

test('paired workspace admission holds both documents and deduplicates self-activation without nested-barrier failure',async()=>{
  const f=fixture();try{const source=await f.create('source','alpha'),target=await f.create('target','beta');await f.runtime.withDocumentsQuiescent(['beta','alpha'],async()=>{assert.deepEqual([...f.runtime.documentGuards.keys()],['alpha','beta']);for(const session of [source,target])await assert.rejects(session.request({type:'prompt',message:'blocked'}),{code:'PI_DOCUMENT_TRANSFER_BUSY'});});assert.equal(f.runtime.documentGuards.size,0);assert.equal(await f.runtime.withDocumentsQuiescent(['alpha','alpha'],()=>42),42);}finally{await f.dispose();}
});
test('a busy second workspace, concurrent inverse switch or failed action releases only the paired barriers it owns',async()=>{
  const f=fixture();try{await f.create('source','alpha');await f.create('target','beta');f.entries[1].state.isStreaming=true;await assert.rejects(f.runtime.withDocumentsQuiescent(['alpha','beta'],()=>assert.fail('busy target admitted')),{code:'PI_DOCUMENT_ACTIVE'});assert.equal(f.runtime.documentGuards.size,0);f.entries[1].state.isStreaming=false;
    await assert.rejects(f.runtime.withDocumentsQuiescent(['alpha','beta'],async()=>{await assert.rejects(f.runtime.withDocumentsQuiescent(['beta','alpha'],()=>{}),{code:'PI_DOCUMENT_TRANSFER_BUSY'});assert.equal(f.runtime.documentGuards.size,2);throw Error('view failed');}),/view failed/);assert.equal(f.runtime.documentGuards.size,0);
    for(const ids of [[],['a','b','c'],['../a'],null])await assert.rejects(f.runtime.withDocumentsQuiescent(ids,()=>{}),{code:'PI_DOCUMENT_ACTIVITY_ARGUMENTS'});
  }finally{await f.dispose();}
});
