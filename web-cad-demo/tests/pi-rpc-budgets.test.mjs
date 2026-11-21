import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PiRpcSession,validatePiCommand} from '../gateway/pi-rpc-runtime.mjs';
import {PI_RPC_TIMEOUTS,piRpcTimeoutMs,piRpcBrowserTimeoutMs} from '../shared/pi-rpc-timeouts.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const reply=(child,command,data={})=>child.stdout.write(JSON.stringify({type:'response',id:command.id,command:command.type,success:true,data})+'\n');
function close(child){if(child.outputClosed)return;child.outputClosed=true;child.exitCode=0;child.emit('exit',0,null);child.stdout.end();child.stderr.end();child.emit('close',0,null);}
async function fixture(t,{limits={},onCommand,blockWrites=false,holdExit=false}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'pi-rpc-bounds-')),children=[],commands=[],events=[],diagnostics=[];
  const session=new PiRpcSession({cliPath:'fake.js',extensionPath:path.join(root,'extension.mjs'),cwd:root,sessionRoot:root,agentConfigDir:root,limits,spawnImpl:()=>{
    const child=new EventEmitter();child.pid=23000+children.length;child.exitCode=null;child.signalCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();let first=true;
    child.stdin=new Writable({write(chunk,_encoding,done){const command=JSON.parse(String(chunk));commands.push(command);if(first){first=false;queueMicrotask(()=>reply(child,command));done();}else{if(blockWrites)child.releaseWrite=done;else done();onCommand?.(command,child);}}});
    child.kill=()=>{child.killed=true;if(!holdExit)close(child);return true;};children.push(child);return child;
  }});
  session.on('event',value=>events.push(value));session.on('diagnostic',value=>diagnostics.push(value));
  t.after(async()=>{for(const child of children)close(child);await session.stop();await rm(root,{recursive:true,force:true});});
  await session.start();return {session,children,commands,events,diagnostics,get child(){return children.at(-1);}};
}

test('native compaction and startup share explicit Gateway/browser deadlines while normal queries stay short',async t=>{
  assert.equal(piRpcTimeoutMs('get_messages'),30000);assert.equal(piRpcTimeoutMs('compact'),180000);assert.equal(piRpcBrowserTimeoutMs('compact'),190000);assert.equal(piRpcBrowserTimeoutMs('startup'),60000);
  const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});const compact=f.session.request({type:'compact'}),rejected=assert.rejects(compact,error=>error.code==='PI_RPC_TIMEOUT'&&error.outcome==='unknown');t.mock.timers.tick(PI_RPC_TIMEOUTS.requestMs+1);assert.equal(f.session.pending.size,1);t.mock.timers.tick(PI_RPC_TIMEOUTS.compactMs-PI_RPC_TIMEOUTS.requestMs);await rejected;assert.equal(f.session.pendingBytes,0);t.mock.timers.reset();
});

test('Pi transport limits and image envelopes are explicit and reject malformed native requests before sending',async t=>{
  const image={type:'image',mimeType:'image/png',data:'eA=='};
  assert.deepEqual(validatePiCommand({type:'prompt',message:'Inspect',images:[image]}).images,[image]);
  for(const images of [{},[...Array(9)].map(()=>image),[{...image,filePath:'C:/private'}],[{...image,data:'http://private'}],[{...image,data:'a=a='}],[{...image,mimeType:'text/html'}]])assert.throws(()=>validatePiCommand({type:'prompt',message:'x',images}),error=>error.code==='PI_INVALID_IMAGES');
  assert.throws(()=>new PiRpcSession({limits:{responseBytes:0}}),error=>error.code==='PI_INVALID_LIMIT');
  assert.throws(()=>new PiRpcSession({limits:{toString:1}}),error=>error.code==='PI_INVALID_LIMIT');
  const f=await fixture(t,{limits:{requestBytes:512}});
  await assert.rejects(f.session.request({type:'prompt',message:'x'.repeat(600)}),error=>error.code==='PI_RPC_REQUEST_LIMIT'&&error.outcome==='not-started');
  for(const timeout of [0,-1,NaN,Infinity,1.5,600001])await assert.rejects(f.session.request({type:'get_state'},timeout),error=>error.code==='PI_RPC_INVALID_TIMEOUT');
  assert.equal(f.commands.length,1);assert.equal(f.session.pendingBytes,0);
});

test('bounded in-flight Pi RPC work reserves room for stop and status instead of serializing controls behind model work',async t=>{
  const f=await fixture(t,{limits:{pendingCount:8},onCommand:(command,child)=>{if(command.type==='abort')reply(child,command);}}),pending=[];
  for(let i=0;i<4;i++){const promise=f.session.request({type:'prompt',message:String(i)});promise.catch(()=>{});pending.push(promise);}
  await assert.rejects(f.session.request({type:'get_messages'}),error=>error.code==='PI_RPC_QUEUE_LIMIT'&&error.outcome==='not-started');
  assert.equal(f.commands.length,5);assert.equal(f.session.pending.size,4);assert.ok(f.session.pendingBytes>0);
  await f.session.request({type:'abort'});assert.equal(f.commands.at(-1).type,'abort');
  for(const command of f.commands.filter(command=>command.type==='prompt'))reply(f.child,command);
  await Promise.all(pending);assert.equal(f.session.pending.size,0);assert.equal(f.session.pendingBytes,0);
});

test('stdin backpressure remains byte-bounded after deadlines release their in-flight bookkeeping',async t=>{
  const f=await fixture(t,{limits:{stdinBytes:1024},blockWrites:true});
  const sent=f.session.request({type:'prompt',message:'x'.repeat(800)},10);await assert.rejects(sent,error=>error.code==='PI_RPC_TIMEOUT'&&error.outcome==='unknown');
  assert.equal(f.session.pendingBytes,0);assert.ok(f.child.stdin.writableLength>800);
  await assert.rejects(f.session.request({type:'prompt',message:'next'}),error=>error.code==='PI_RPC_QUEUE_LIMIT');
  const abort=f.session.request({type:'abort'},10);await assert.rejects(abort,error=>error.code==='PI_RPC_TIMEOUT');assert.ok(f.child.stdin.writableLength<=1024);
  assert.equal(f.commands.filter(command=>command.type==='prompt').length,1,'No timed-out request was replayed');
});

test('Pi reply deadlines distinguish an unconfirmed accepted task from an unchanged observation, and late replies never replay work',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.session.request({type:'prompt',message:'one'},10),error=>error.code==='PI_RPC_TIMEOUT'&&error.outcome==='unknown'&&!error.retryableByModel);
  await assert.rejects(f.session.request({type:'get_messages'},10),error=>error.code==='PI_RPC_TIMEOUT'&&error.outcome==='unchanged');
  for(const command of f.commands.slice(1))reply(f.child,command);
  assert.equal(f.session.pending.size,0);assert.equal(f.session.pendingBytes,0);assert.equal(f.children.length,1);assert.equal(f.commands.length,3);
});

test('malformed, oversized and invalid UTF-8 Pi output settles pending tasks without reflecting raw payloads or spawning replacements',async t=>{
  for(const kind of ['json','utf8','overflow','wrong-command','invalid-response'])await t.test(kind,async t=>{
    const f=await fixture(t,{limits:{responseBytes:1024}}),pending=f.session.request({type:'prompt',message:'pending'}),rejected=assert.rejects(pending,error=>error.outcome==='unknown'&&['PI_RPC_PROTOCOL_ERROR','PI_RPC_OUTPUT_LIMIT'].includes(error.code));
    const command=f.commands.at(-1);
    const bytes=kind==='json'?Buffer.from('not-json-PRIVATE_KEY\n'):kind==='utf8'?Buffer.from([0xc3,0x28,10]):kind==='overflow'?Buffer.alloc(1025,65):Buffer.from(JSON.stringify({type:'response',id:command.id,command:kind==='wrong-command'?'abort':'prompt',success:kind==='invalid-response'?'yes':true,data:{secret:'PRIVATE_KEY'}})+'\n');
    f.child.stdout.write(bytes);await rejected;await f.session.stop();assert.equal(f.session.frames.bytes,0);assert.equal(f.session.pendingBytes,0);assert.equal(f.children.length,1);assert.doesNotMatch(JSON.stringify([f.events,f.diagnostics]),/PRIVATE_KEY/);
  });
});

test('Pi consumes split Unicode and a final unterminated reply after OS exit before closing the stream or starting a replacement',async t=>{
  const f=await fixture(t),pending=f.session.request({type:'get_messages'}),command=f.commands.at(-1),wire=Buffer.from(JSON.stringify({type:'response',id:command.id,command:command.type,success:true,data:{text:'几何🙂'}}));
  const split=wire.indexOf(Buffer.from('几'))+1;f.child.stdout.write(wire.subarray(0,split));assert.ok(f.session.frames.bytes>0);
  const old=f.child;old.exitCode=0;old.emit('exit',0,null);
  const restarting=f.session.start({resume:true});await tick();assert.equal(f.children.length,1);
  old.stdout.end(wire.subarray(split));await tick();old.stderr.end();old.outputClosed=true;old.emit('close',0,null);
  const result=await pending;assert.equal(result.data.text,'几何🙂');await restarting;assert.equal(f.children.length,2);assert.equal(f.events.some(row=>row.event.type==='runtime_error'),false);assert.equal(f.commands.filter(command=>command.type==='get_messages').length,1);
});

test('Pi stderr floods do not retain or log provider content, and stdout stream errors are contained',async t=>{
  const f=await fixture(t,{limits:{stderrBytes:64}});for(let i=0;i<10;i++)f.child.stderr.write('PRIVATE_KEY'.repeat(100));
  assert.equal(f.session.stderrBytes,65);assert.equal(f.diagnostics.length,2);assert.doesNotMatch(f.diagnostics.join(''),/PRIVATE_KEY/);assert.equal(f.session.closed,false);
  const pending=f.session.request({type:'prompt',message:'x'}),rejected=assert.rejects(pending,error=>error.code==='PI_STDOUT_ERROR'&&error.outcome==='unknown');f.child.stdout.emit('error',Error('PRIVATE_KEY'));await rejected;await f.session.stop();assert.doesNotMatch(JSON.stringify(f.events),/PRIVATE_KEY/);
});

test('unconfirmed process exit and unconfirmed stdio closure both block replacement, then permit an explicit verified restart',async t=>{
  const f=await fixture(t,{limits:{stopMs:10},holdExit:true});
  await assert.rejects(f.session.stop(),error=>error.code==='PI_STOP_UNCONFIRMED');await assert.rejects(f.session.start(),error=>error.code==='PI_STOP_UNCONFIRMED');assert.equal(f.children.length,1);
  f.child.exitCode=0;f.child.emit('exit',0,null);await assert.rejects(f.session.start(),error=>error.code==='PI_STDIO_CLOSE_UNCONFIRMED');assert.equal(f.children.length,1);
  close(f.child);await f.session.start({resume:true});assert.equal(f.children.length,2);
});

test('oversized native tool events become replayable snapshot hints while full native history remains readable',async t=>{
  const full={role:'toolResult',toolCallId:'large-call',toolName:'primitive__box',content:[{type:'text',text:'x'.repeat(12000)}]},f=await fixture(t,{limits:{eventBytes:1024},onCommand:(command,child)=>reply(child,command,{messages:[full]})});
  f.child.stdout.write(JSON.stringify({type:'message_end',message:full})+'\n');const event=f.events.at(-1).event;
  assert.deepEqual(event,{type:'runtime_snapshot_required',nativeEventType:'message_end',nativeRole:'toolResult',toolCallId:'large-call',toolName:'primitive__box'});assert.ok(f.session.eventHistoryBytes<1024);
  const native=await f.session.request({type:'get_messages'});assert.equal(native.data.messages[0].content[0].text.length,12000);assert.equal(f.children.length,1);
});
