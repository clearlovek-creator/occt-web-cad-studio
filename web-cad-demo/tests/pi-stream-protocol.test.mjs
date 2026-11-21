import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PiRpcSession,PiRpcRuntime} from '../gateway/pi-rpc-runtime.mjs';
import {parsePiCursor,piReplayDecision,attachPiEventStream} from '../gateway/pi-event-stream.mjs';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function fakeChild(handler){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.stdin=new Writable({write(chunk,_encoding,done){const command=JSON.parse(String(chunk));queueMicrotask(()=>handler(command,child));done();}});child.kill=()=>{child.exitCode=0;child.stdout.end();child.stderr.end();child.emit('exit',0,null);child.emit('close',0,null);return true;};return child;}
const reply=(child,command,data={})=>child.stdout.write(JSON.stringify({type:'response',id:command.id,success:true,data})+'\n');

test('SSE cursors are scoped to the native process stream, not comparable bare integers',()=>{
  assert.deepEqual(parsePiCursor({lastEventId:`${A}:12`,streamId:B,after:'900'}),{streamId:A,after:12});
  assert.deepEqual(parsePiCursor({streamId:A,after:'0'}),{streamId:A,after:0});
  for(const value of ['-1','1.2','NaN','Infinity','9007199254740992','2:3'])assert.equal(parsePiCursor({streamId:A,after:value}),null);
  assert.equal(parsePiCursor({lastEventId:'5000'}),null);assert.equal(parsePiCursor({streamId:'not-a-stream',after:'0'}),null);
  for(const after of ['1','9999'])assert.equal(piReplayDecision({streamId:B,sequence:10,eventHistory:[{id:1}]},{streamId:A,after}).reason,'stream-changed');
  assert.equal(piReplayDecision({streamId:A,sequence:20,eventHistory:[{id:15}]},{streamId:A,after:'13'}).reason,'replay-gap');
  assert.equal(piReplayDecision({streamId:A,sequence:20,eventHistory:[{id:15}]},{streamId:A,after:'14'}).reset,false);
  assert.equal(piReplayDecision({streamId:A,sequence:20,eventHistory:[]},{streamId:A,after:'19'}).reason,'replay-gap');
});

test('RPC snapshots are stamped at their exact stdout line even when later deltas share the chunk',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pi-stream-stamp-'));let child;
  const session=new PiRpcSession({sessionId:'stamp',documentId:'doc',cliPath:'fake.js',extensionPath:path.join(root,'ext.js'),cwd:root,sessionRoot:root,agentConfigDir:root,spawnImpl:()=>child=fakeChild((command,owner)=>{
    if(command.type==='get_messages')owner.stdout.write([JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'before'}}),JSON.stringify({type:'response',id:command.id,success:true,data:{messages:[]}}),JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'after'}}),''].join('\n'));else reply(owner,command);
  })});
  try{await session.start();const old=session.streamId,result=await session.request({type:'get_messages'});assert.equal(result.transport.streamId,old);assert.equal(result.transport.eventCursor,session.sequence-1);await session.stop();await session.start({resume:true});assert.notEqual(session.streamId,old);assert.equal(session.sequence,1);assert.equal(session.eventHistory.length,1);assert.equal(child.listenerCount('exit'),1);}finally{await session.stop();await rm(root,{recursive:true,force:true});}
});

test('the replay ring is limited by both event count and serialized bytes, without retaining oversized payloads',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pi-stream-ring-'));let child;const session=new PiRpcSession({sessionId:'ring',cliPath:'fake.js',extensionPath:path.join(root,'ext.js'),cwd:root,sessionRoot:root,agentConfigDir:root,spawnImpl:()=>child=fakeChild((command,owner)=>reply(owner,command))});
  try{await session.start();for(let i=0;i<1100;i++)child.stdout.write(JSON.stringify({type:'text',index:i})+'\n');assert.equal(session.eventHistory.length,1000);assert.ok(session.eventHistoryBytes<=4*1024*1024);
    for(let i=0;i<6;i++)child.stdout.write(JSON.stringify({type:'text',text:'x'.repeat(900*1024)})+'\n');assert.ok(session.eventHistoryBytes<=4*1024*1024);assert.ok(session.eventHistory.length<1000);assert.equal(piReplayDecision(session,{streamId:session.streamId,after:'0'}).reason,'replay-gap');
    child.stdout.write(JSON.stringify({type:'huge',text:'x'.repeat(5*1024*1024)})+'\n');assert.equal(session.eventHistory.at(-1).event.type,'runtime_snapshot_required');assert.equal(session.eventHistory.at(-1).event.nativeEventType,'huge');assert.ok(session.eventHistoryBytes<=4*1024*1024);assert.ok(!session.eventHistory.some(row=>row.event.type==='huge'));assert.equal(piReplayDecision(session,{streamId:session.streamId,after:String(session.sequence-1)}).reset,false);
  }finally{await session.stop();await rm(root,{recursive:true,force:true});}
});

test('concurrent session creation reserves the ID before filesystem awaits and cannot rebind a project',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pi-runtime-create-')),children=[],runtime=new PiRpcRuntime({sessionRoot:root,agentConfigDir:root,cliPath:'fake.js',extensionPath:path.join(root,'ext.js'),cwd:root,spawnImpl:()=>{const child=fakeChild((command,owner)=>reply(owner,command));children.push(child);return child;}});
  try{const [first,second]=await Promise.all([runtime.create({sessionId:'shared',documentId:'doc'}),runtime.create({sessionId:'shared',documentId:'doc'})]);assert.equal(first,second);assert.equal(children.length,1);await assert.rejects(runtime.create({sessionId:'shared',documentId:'other'}),error=>error.code==='PI_SESSION_DOCUMENT_MISMATCH');assert.equal(children.length,1);}finally{await runtime.close();await assert.rejects(runtime.create({sessionId:'new'}),/shutting down/);await rm(root,{recursive:true,force:true});}
});

function sessionFixture(){const session=new EventEmitter();Object.assign(session,{streamId:B,sequence:3,sessionId:'test',documentId:'doc',eventHistory:[{streamId:B,id:3,event:{type:'old-tool'}}]});return session;}
class Response extends EventEmitter{constructor(blocked=false){super();this.frames=[];this.blocked=blocked;this.destroyed=false;}writeHead(status,headers){this.status=status;this.headers=headers;}flushHeaders(){}write(frame){this.frames.push(frame);return !this.blocked;}destroy(){this.destroyed=true;this.emit('close');}}
test('a stale stream sends a reset rather than filtering all new events, and event IDs include generation',()=>{
  const session=sessionFixture(),response=new Response(),cleanup=attachPiEventStream(session,{headers:{}},response,new URL(`http://local/events?streamId=${A}&after=999`));
  try{assert.match(response.frames.join(''),/stream_reset/);assert.doesNotMatch(response.frames.join(''),/old-tool/);session.emit('event',{streamId:B,id:4,event:{type:'tool_execution_end',toolCallId:'new-call'}});assert.match(response.frames.join(''),new RegExp(`id: ${B}:4`));assert.match(response.frames.join(''),/new-call/);}finally{cleanup();}
});
test('slow SSE subscribers have bounded queues and release their listeners on overflow',()=>{
  const session=sessionFixture(),response=new Response(true),cleanup=attachPiEventStream(session,{headers:{}},response,new URL(`http://local/events?streamId=${B}&after=3`),{maxQueuedBytes:1024});
  try{for(let i=4;i<50&&!response.destroyed;i++)session.emit('event',{streamId:B,id:i,event:{type:'text',text:'x'.repeat(200)}});assert.equal(response.destroyed,true);assert.equal(session.listenerCount('event'),0);assert.equal(response.listenerCount('drain'),0);}finally{cleanup();}
});
