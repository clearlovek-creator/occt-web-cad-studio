import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {CadMcpProcessClient} from '../gateway/cad-mcp-process-client.mjs';
import {BoundedJsonLines} from '../gateway/bounded-json-lines.mjs';
class Child extends EventEmitter{
  constructor(){super();this.pid=123456;this.exitCode=null;this.signalCode=null;this.killed=false;this.lines=[];this.stdout=new PassThrough();this.stderr=new PassThrough();this.stdin=new Writable({write:(chunk,_encoding,done)=>{this.lines.push(JSON.parse(String(chunk)));done();}});}
  reply(result={},id=this.lines.at(-1).id){this.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');}
  exit(code=0){this.exitCode=code;this.emit('exit',code,null);this.stdout.end();this.stderr.end();this.emit('close',code,null);}
  kill(){this.killed=true;if(!this.ignoreKill)queueMicrotask(()=>this.exit());return true;}
}
function fixture(limits={}){const child=new Child();let spawns=0;const client=new CadMcpProcessClient({serverPath:'fixture.mjs',spawnImpl:(_exe,_args,options)=>{spawns++;assert.equal(options.windowsHide,true);assert.equal(options.env.API_KEY,undefined);return child;},limits:{stopMs:15,...limits}});return {child,client,spawns:()=>spawns};}
test('byte framing preserves split Chinese UTF-8, CRLF and final records without quadratic whole-buffer concatenation',()=>{
  const f=new BoundedJsonLines(32),received=[],bytes=Buffer.from('中文\r\nnext\nlast');for(const byte of bytes)f.push(Buffer.from([byte]),line=>received.push(line));f.finish(line=>received.push(line));assert.deepEqual(received,['中文','next','last']);assert.equal(f.bytes,0);
  assert.throws(()=>f.push(Buffer.alloc(33),()=>{}),error=>error.code==='MCP_FRAME_LIMIT');const invalid=new BoundedJsonLines(8);assert.throws(()=>invalid.push(Buffer.from([0xff,10]),()=>{}));
  const fragmented=new BoundedJsonLines(200000),one=Buffer.from('x');for(let index=0;index<65537;index++)fragmented.push(one,()=>{});assert.equal(fragmented.parts.length,2,'Tiny fragments must not create one Buffer object per byte');fragmented.finish(()=>{});assert.equal(fragmented.bytes,0);
});
test('only one request is in flight and queue budgets bound both count and bytes',async()=>{
  const {child,client}=fixture({queueCount:2,queueBytes:512,requestBytes:256});const first=client.request('initialize'),second=client.request('ping');assert.equal(child.lines.length,1);await assert.rejects(client.request('ping'),error=>error.code==='MCP_QUEUE_LIMIT'&&error.outcome==='not-started');child.reply({first:true});assert.deepEqual(await first,{first:true});assert.equal(child.lines.length,2);child.reply({second:true});assert.deepEqual(await second,{second:true});await assert.rejects(client.request('ping',{large:'x'.repeat(300)}),error=>error.code==='MCP_REQUEST_LIMIT');child.exit();await client.stop();
});
test('queued abort and timeout remove unsent requests without advancing or transmitting them',async()=>{
  const {child,client}=fixture();const active=client.request('ping'),abort=new AbortController(),queued=client.request('tools/call',{}, {signal:abort.signal});abort.abort();await assert.rejects(queued,error=>error.code==='MCP_CANCELLED_BEFORE_SEND'&&error.outcome==='not-started');const timed=client.request('ping',{}, {timeoutMs:10});await assert.rejects(timed,error=>error.code==='MCP_QUEUE_TIMEOUT');assert.equal(child.lines.length,1);child.reply({ok:true});await active;child.exit();await client.stop();
});
test('aborting a sent call sends one exact MCP cancellation control and waits for its actual outcome rather than claiming rollback',async()=>{
  const {child,client}=fixture(),abort=new AbortController(),progress=[];const result=client.request('tools/call',{}, {signal:abort.signal,onProgress:text=>progress.push(text)});let settled=false;result.then(()=>settled=true);const original=child.lines[0];abort.abort();abort.abort();await Promise.resolve();assert.equal(settled,false);assert.equal(progress.length,1);assert.equal(child.killed,false);assert.deepEqual(child.lines[1],{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:original.id,reason:'User requested cancellation'}});assert.equal(child.lines.length,2);child.reply({content:[{type:'text',text:'actual commit'}]},original.id);assert.equal((await result).content[0].text,'actual commit');child.exit();await client.stop();
});
test('a cancelled read settles promptly as unchanged while its late response still preserves stream ordering',async()=>{
  const {child,client}=fixture(),abort=new AbortController(),read=client.request('tools/call',{}, {readOnly:true,signal:abort.signal});abort.abort();await assert.rejects(read,error=>error.code==='MCP_READ_CANCELLED'&&error.outcome==='unchanged');assert.equal(client.status().inFlight,true);assert.equal(client.status().reconcileRequired,false);const next=client.request('ping',{}, {readOnly:true});assert.equal(child.lines.length,1);child.reply({});child.reply({});await next;child.exit();await client.stop();
});
test('a dispatched mutation deadline is unknown, blocks writes and never replays; an explicit query after the late result permits reconciliation',async()=>{
  const {child,client}=fixture(),active=client.request('tools/call',{}, {timeoutMs:10});await assert.rejects(active,error=>error.code==='MCP_CALL_TIMEOUT'&&error.outcome==='unknown'&&!error.retryableByModel);assert.equal(client.status().inFlight,true);await assert.rejects(client.request('tools/call'),error=>error.code==='MCP_RECONCILE_REQUIRED');const query=client.request('tools/call',{name:'query_model'},{readOnly:true});assert.equal(child.lines.length,1);child.reply({content:[]});assert.equal(child.lines.length,2);child.reply({content:[{type:'text',text:'fresh snapshot'}]});await query;client.confirmReconciled();const next=client.request('ping',{}, {readOnly:true});assert.equal(child.lines.length,3);child.reply({});await next;child.exit();await client.stop();
});
test('invalid, oversized or unrequested output is fatal and never exposes its raw content as a model error',async()=>{
  for(const output of [Buffer.from('not json SECRET\n'),Buffer.alloc(65),Buffer.from('{"jsonrpc":"2.0","id":"forged","result":{}}\n')]){const {child,client}=fixture({responseBytes:64}),pending=client.request('tools/call');child.stdout.write(output);await assert.rejects(pending,error=>error.outcome==='unknown'&&!error.message.includes('SECRET'));assert.equal(client.status().state,'failed');child.exit();await client.stop();}
});
test('write errors, stderr floods and process exits settle every queued request once with correct uncertainty',async()=>{
  for(const fail of [child=>child.stdin.emit('error',Error('secret')),child=>child.stderr.write(Buffer.alloc(65)),child=>child.exit(1)]){const {child,client}=fixture({stderrBytes:64}),active=client.request('tools/call'),queued=client.request('ping');fail(child);await assert.rejects(active,error=>error.outcome==='unknown');await assert.rejects(queued,error=>error.outcome==='not-started');if(child.exitCode===null)child.exit();await client.stop();assert.equal(client.status().queued,0);}
});
test('stop verifies the owned process, retains an unconfirmed stop handle and never spawns a replacement',async()=>{
  const {child,client,spawns}=fixture();child.ignoreKill=true;await assert.rejects(client.stop(),error=>error.code==='MCP_STOP_UNCONFIRMED');assert.equal(child.killed,true);assert.equal(client.status().exited,false);assert.equal(spawns(),1);child.exit();await client.stop();assert.equal(client.status().state,'closed');await assert.rejects(client.request('ping'),error=>error.code==='MCP_NOT_RUNNING');
});
