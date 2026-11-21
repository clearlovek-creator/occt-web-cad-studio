import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {NativeRequestChannel,NativeChannelError} from '../gateway/native-request-channel.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){
  const child=new EventEmitter();Object.assign(child,{pid:454545,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new EventEmitter(),exitCode:null,signalCode:null,killed:false});
  child.stdin.writable=true;child.stdin.write=(_wire,callback)=>{callback?.();return true;};child.kill=()=>{child.killed=true;return true;};
  const channel=new NativeRequestChannel(child,{timeoutMs:1000,stopTimeoutMs:25,drainSuccessfulExit:true,exitError:code=>new NativeChannelError(code===0?'WORKER_UNAVAILABLE':'TEST_PROCESS_FAILED','Observed exit '+code),...options});
  const exit=code=>{child.exitCode=code;child.emit('exit',code);};
  t.after(async()=>{if(child.exitCode===null)exit(1);child.stdout.end();child.stderr.end();child.emit('close',child.exitCode);await channel.retire(new NativeChannelError('WORKER_UNAVAILABLE','Test finished'));});
  return {child,channel,exit,request:()=>channel.request({protocolVersion:1,requestId:'job',operation:'work'}),reply:()=>JSON.stringify({ok:true,protocolVersion:1,requestId:'job',value:42})+'\n'};
}
test('single-job success can drain reply bytes after the OS exit event',async t=>{
  const f=fixture(t),work=f.request(),checked=work.then(value=>({value}),error=>({error})),wire=f.reply();f.child.stdout.write(wire.slice(0,17));f.exit(0);await tick();f.child.stdout.write(wire.slice(17));f.child.stdout.end();const result=await checked;assert.equal(result.error,undefined);assert.equal(result.value.value,42);await f.channel.waitUntilStopped();assert.equal(f.channel.outputEndedNormally,true);
});
test('a returned frame is not full output completion until EOF is observed',async t=>{
  const f=fixture(t),work=f.request();f.child.stdout.write(f.reply());assert.equal((await work).value,42);f.exit(0);let stopped=false;const wait=f.channel.waitUntilStopped().then(()=>stopped=true);await tick();assert.equal(stopped,false);f.child.stdout.end();await wait;assert.equal(f.channel.outputFramingComplete,true);
});
test('late extra frames after a zero exit still invalidate the single-job output',async t=>{
  const f=fixture(t),work=f.request();f.child.stdout.write(f.reply());await work;f.exit(0);f.child.stdout.write(JSON.stringify({ok:true,protocolVersion:1,requestId:'foreign'})+'\n');f.child.stdout.end();await f.channel.waitUntilStopped();assert.equal(f.channel.failure.code,'WORKER_PROTOCOL_ERROR');
});
test('an unterminated tail cannot be hidden behind a valid frame and zero exit',async t=>{
  const f=fixture(t),work=f.request();f.child.stdout.write(f.reply());await work;f.exit(0);f.child.stdout.write('{incomplete');f.child.stdout.end();await f.channel.waitUntilStopped();assert.equal(f.channel.outputFramingComplete,false);assert.equal(f.channel.failure.code,'WORKER_PROTOCOL_ERROR');
});
test('an exited process with no output EOF has a bounded drain failure',async t=>{
  const f=fixture(t),work=f.request(),checked=assert.rejects(work,{code:'WORKER_PROTOCOL_ERROR'});f.exit(0);await checked;await f.channel.waitUntilStopped();assert.equal(f.child.killed,false);assert.equal(f.channel.outputEndedNormally,false);
});
test('nonzero exit does not drain or accept a late success frame',async t=>{
  const f=fixture(t),work=f.request(),checked=assert.rejects(work,{code:'TEST_PROCESS_FAILED'});f.exit(3);f.child.stdout.write(f.reply());f.child.stdout.end();await checked;assert.equal(f.channel.outputDrain,null);
});

test('explicit domain-failure exit drains bounded late diagnostic bytes without becoming success',async t=>{
  const f=fixture(t,{drainFailureExitCodes:[2]}),work=f.request();
  const wire=JSON.stringify({ok:false,protocolVersion:1,requestId:'job',code:'QUALITY_REJECTED'})+'\n';
  f.child.stdout.write(wire.slice(0,15));f.exit(2);await tick();f.child.stdout.write(wire.slice(15));f.child.stdout.end();
  assert.equal((await work).ok,false);await f.channel.waitUntilStopped();assert.equal(f.channel.failure.code,'TEST_PROCESS_FAILED');assert.equal(f.channel.outputEndedNormally,true);assert.equal(f.child.killed,false);
});

test('resource exits cannot be opted into delayed failure-output draining',()=>{
  for(const codes of [[86],[87],[88],[89],[2,2],[-1],[0],['2'],null])assert.throws(()=>new NativeRequestChannel({}, {drainFailureExitCodes:codes}),TypeError);
});

test('failure-output draining does not conceal malformed tails',async t=>{
  const f=fixture(t,{drainFailureExitCodes:[2]}),work=f.request();f.child.stdout.write(f.reply());await work;f.exit(2);f.child.stdout.write('{broken');f.child.stdout.end();await f.channel.waitUntilStopped();assert.equal(f.channel.failure.code,'WORKER_PROTOCOL_ERROR');assert.equal(f.channel.outputEndedNormally,false);
});
