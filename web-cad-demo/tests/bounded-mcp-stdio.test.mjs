import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import {serveBoundedMcp} from '../gateway/bounded-mcp-stdio.mjs';
const deferred=()=>{let resolve;const promise=new Promise(value=>resolve=value);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(handle,limits={},output){const stdin=new PassThrough(),lines=[],stdout=new Writable({write(chunk,_encoding,done){lines.push(...String(chunk).trim().split('\n').filter(Boolean).map(JSON.parse));if(output)output(done);else done();}}),transport=serveBoundedMcp({stdin,stdout,handle,limits:{workMs:1000,...limits}});return {stdin,stdout,lines,transport,send:(id,method='tools/call',params={})=>stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')};}
test('a second command cannot execute before the first response has passed output backpressure',async()=>{
  const writes=[],executed=[],f=fixture(async message=>{executed.push(message.id);return {jsonrpc:'2.0',id:message.id,result:{ok:true}};},{},done=>writes.push(done));f.send(1);f.send(2);await turn();assert.deepEqual(executed,[1]);writes.shift()();await turn();assert.deepEqual(executed,[1,2]);writes.shift()();await turn();f.stdin.end();await f.transport.done;assert.deepEqual(f.lines.map(line=>line.id),[1,2]);
});
test('EOF drains the real active call but queued commands are explicitly not executed',async()=>{
  const actual=deferred(),entered=deferred(),executed=[],f=fixture(async message=>{executed.push(message.id);entered.resolve();await actual.promise;return {jsonrpc:'2.0',id:message.id,result:{committed:true}};});f.send(1);f.send(2);await entered.promise;f.stdin.end();let ended=false;f.transport.done.then(()=>ended=true);await turn();assert.equal(ended,false);actual.resolve();await f.transport.done;assert.deepEqual(executed,[1]);assert.equal(f.lines[0].result.committed,true);assert.equal(f.lines[1].error.data.outcome,'not-started');
});
test('input overflow is bounded while the already-dispatched operation retains its real outcome',async()=>{
  const actual=deferred(),entered=deferred(),f=fixture(async message=>{entered.resolve();await actual.promise;return {jsonrpc:'2.0',id:message.id,result:{ok:true}};},{queueCount:1});f.send(1);await entered.promise;f.send(2);assert.equal(f.transport.status().queued,0);assert.equal(f.transport.status().closing,true);actual.resolve();await f.transport.done;assert.equal(f.lines[0].result.ok,true);assert.equal(f.lines[1].error.data.outcome,'not-started');
});
test('duplicate IDs are rejected rather than executing the same request twice',async()=>{
  const actual=deferred(),entered=deferred(),seen=[],f=fixture(async message=>{seen.push(message.id);entered.resolve();await actual.promise;return {jsonrpc:'2.0',id:message.id,result:{}};});f.send('one');await entered.promise;f.send('one');actual.resolve();await f.transport.done;assert.deepEqual(seen,['one']);assert.match(f.lines[1].error.message,/Duplicate/);
});
test('invalid UTF-8, malformed JSON and oversized partial lines terminate intake without running a command',async()=>{
  for(const bytes of [Buffer.from([255,10]),Buffer.from('not json\n'),Buffer.alloc(129,65)]){let executed=0;const f=fixture(async()=>{executed++;},{requestBytes:128});f.stdin.write(bytes);await f.transport.done;assert.equal(executed,0);assert.equal(f.lines[0].error.data.outcome,'not-started');assert.ok(f.transport.status().frameBytes===0);}
});
test('a timeout reports unknown but transport completion still waits for the actual work handle',async()=>{
  const actual=deferred(),entered=deferred(),f=fixture(async message=>{entered.resolve();await actual.promise;return {jsonrpc:'2.0',id:message.id,result:{committed:true}};},{workMs:10});f.send(1);await entered.promise;while(!f.lines.length)await turn();assert.equal(f.lines[0].error.data.outcome,'unknown');assert.equal(f.transport.status().inFlight,true);let ended=false;f.transport.done.then(()=>ended=true);await turn();assert.equal(ended,false);actual.resolve();await f.transport.done;assert.equal(f.lines.length,1,'Never produce a second tool result for the same ID');
});
test('large output is replaced with a bounded uncertainty receipt, not partial or falsely successful geometry',async()=>{
  const f=fixture(async message=>({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'x'.repeat(4000)}]}}),{responseBytes:512});f.send(1);await turn();f.stdin.end();await f.transport.done;assert.equal(f.lines.length,1);assert.equal(f.lines[0].error.code,-32004);assert.equal(f.lines[0].error.data.outcome,'unknown');assert.ok(Buffer.byteLength(JSON.stringify(f.lines[0]))<512);
});

test('exact-ID cancellation notifications reach active work while ordinary commands stay serialized',async()=>{
  const entered=deferred(),actual=deferred(),seen=[];
  const f=fixture(async(message,{signal})=>{seen.push(message.id);entered.resolve(signal);await actual.promise;return {jsonrpc:'2.0',id:message.id,result:{cancelled:signal.aborted}};});
  f.send('active');const signal=await entered.promise;f.send('later');
  const notify=requestId=>f.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId}})+'\n');
  notify('foreign');notify(1);assert.equal(signal.aborted,false);notify('active');notify('active');assert.equal(signal.aborted,true);assert.deepEqual(seen,['active']);
  actual.resolve();await turn();f.stdin.end();await f.transport.done;assert.equal(f.lines[0].result.cancelled,true);
});
test('a cancelled queued request is never executed and cannot cancel a differently typed active ID',async()=>{
  const entered=deferred(),actual=deferred(),seen=[];const f=fixture(async(message,{signal})=>{seen.push(message.id);entered.resolve(signal);await actual.promise;return {jsonrpc:'2.0',id:message.id,result:{}};});
  f.send(1);const signal=await entered.promise;f.send('1');f.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'1'}})+'\n');assert.equal(signal.aborted,false);actual.resolve();await turn();await turn();f.stdin.end();await f.transport.done;assert.deepEqual(seen,[1]);assert.equal(f.lines[1].error.data.outcome,'not-started');
});
