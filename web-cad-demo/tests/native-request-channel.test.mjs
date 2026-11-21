import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {NativeRequestChannel} from '../gateway/native-request-channel.mjs';

const command=(requestId,documentId='doc')=>({protocolVersion:1,requestId,documentId,operation:'document.summary'});
const reply=(requestId,documentId='doc',extra={})=>JSON.stringify({ok:true,protocolVersion:1,requestId,documentId,...extra})+'\n';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){
  const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new EventEmitter(),pid:999999,exitCode:null,signalCode:null,killed:false});
  const writes=[],events=[];child.stdin.writable=true;child.stdin.write=(wire,callback)=>{writes.push(wire);callback?.();return true;};child.kill=()=>{child.killed=true;events.push('kill');return true;};
  const channel=new NativeRequestChannel(child,{timeoutMs:10000,stopTimeoutMs:1000,onUnavailable:()=>events.push('unavailable'),onStopped:()=>events.push('stopped'),...options});
  const exit=()=>{if(child.exitCode!=null)return;child.exitCode=0;child.emit('exit',0);child.emit('close',0);};
  t.after(async()=>{exit();await channel.waitUntilStopped();});return {child,channel,writes,events,exit};
}
test('replies correlate by exact request and project, never by the next FIFO slot',async t=>{
  const f=fixture(t),a=f.channel.request(command('a','one')),b=f.channel.request(command('b','two'));
  f.child.stdout.write(reply('b','two')+reply('a','one'));assert.equal((await a).documentId,'one');assert.equal((await b).documentId,'two');assert.equal(f.channel.status().pendingBytes,0);assert.deepEqual(f.events,[]);
});
test('timeout retains all owned calls until the exact process exits and ignores a late valid reply',async t=>{
  let unavailable;const triggered=new Promise(resolve=>unavailable=resolve);const f=fixture(t,{timeoutMs:10,onUnavailable:()=>{f.events.push('unavailable');unavailable();}});let settled=0;
  const a=f.channel.request(command('a')).finally(()=>settled++),b=f.channel.request(command('b'),{timeoutMs:10000}).finally(()=>settled++);const checked=Promise.allSettled([a,b]);
  await triggered;assert.equal(f.channel.state,'retiring');assert.equal(f.channel.pending.size,2);assert.equal(settled,0);f.child.stdout.write(reply('b'));await tick();assert.equal(settled,0);assert.deepEqual(f.events,['unavailable','kill']);
  f.exit();const result=await checked;assert.ok(result.every(item=>item.status==='rejected'&&item.reason.code==='WORKER_TIMEOUT'));assert.equal(f.events.at(-1),'stopped');assert.equal(f.channel.state,'closed');
});
test('a stop deadline blocks replacement rather than treating kill as confirmed exit',async t=>{
  const f=fixture(t,{timeoutMs:5,stopTimeoutMs:10});const request=f.channel.request(command('a'));
  await assert.rejects(request,error=>error.code==='WORKER_STOP_UNCONFIRMED');assert.equal(f.channel.state,'blocked');assert.equal(f.events.includes('stopped'),false);await assert.rejects(f.channel.waitUntilStopped(),error=>error.code==='WORKER_STOP_UNCONFIRMED');
  f.exit();await tick();assert.equal(f.channel.state,'closed');assert.equal(f.events.filter(value=>value==='stopped').length,1);await f.channel.waitUntilStopped();
});
test('AbortSignal cancellation is no-op before send, but a sent call waits for exit; resolved calls detach abort handlers',async t=>{
  const f=fixture(t),early=new AbortController();early.abort();await assert.rejects(f.channel.request(command('early'),{signal:early.signal}),error=>error.code==='WORKER_CANCELLED');assert.equal(f.writes.length,0);assert.equal(f.child.killed,false);
  const done=new AbortController(),successful=f.channel.request(command('done'),{signal:done.signal});f.child.stdout.write(reply('done'));await successful;done.abort();assert.equal(f.child.killed,false);
  const active=new AbortController(),pending=f.channel.request(command('active'),{signal:active.signal});const rejected=assert.rejects(pending,error=>error.code==='WORKER_CANCELLED');active.abort();await tick();assert.equal(f.channel.state,'retiring');f.exit();await rejected;
});
test('request count, UTF8 byte and individual payload budgets reject before write without disturbing accepted work',async t=>{
  const f=fixture(t,{maxPendingRequests:1,maxPendingBytes:1024,maxRequestBytes:512}),a=f.channel.request(command('a'));
  await assert.rejects(f.channel.request(command('b')),error=>error.code==='WORKER_QUEUE_LIMIT');await assert.rejects(f.channel.request({...command('large'),data:'界'.repeat(300)}),error=>error.code==='WORKER_REQUEST_TOO_LARGE');assert.equal(f.writes.length,1);assert.equal(f.channel.status().pendingBytes,Buffer.byteLength(f.writes[0]));f.child.stdout.write(reply('a'));await a;assert.equal(f.channel.status().pendingBytes,0);
  const constrained=fixture(t,{maxPendingBytes:Buffer.byteLength(JSON.stringify(command('a'))+'\n')+1}),accepted=constrained.channel.request(command('a'));await assert.rejects(constrained.channel.request(command('b')),error=>error.code==='WORKER_QUEUE_LIMIT');constrained.child.stdout.write(reply('a'));await accepted;
});
test('malformed, unknown, duplicate or wrong-document JSON cannot shift a subsequent response to another call',async t=>{
  for(const bad of ['{broken}\n',reply('unknown'),reply('a','wrong'),reply('a','doc',{protocolVersion:2})]){
    const f=fixture(t),a=f.channel.request(command('a')),b=f.channel.request(command('b')),checked=Promise.allSettled([a,b]);f.child.stdout.write(bad+reply('b'));assert.equal(f.channel.state,'retiring');f.exit();assert.ok((await checked).every(item=>item.status==='rejected'&&item.reason.code==='WORKER_PROTOCOL_ERROR'));
  }
  const f=fixture(t),a=f.channel.request(command('a'));f.child.stdout.write(reply('a'));await a;const b=f.channel.request(command('b')),checked=assert.rejects(b,error=>error.code==='WORKER_PROTOCOL_ERROR');f.child.stdout.write(reply('a')+reply('b'));f.exit();await checked;
});
test('response limits apply to each UTF8 line, not a chunk containing multiple small correlated replies',async t=>{
  const f=fixture(t,{maxResponseBytes:110}),a=f.channel.request(command('a')),b=f.channel.request(command('b'));f.child.stdout.write(reply('a')+reply('b'));await Promise.all([a,b]);assert.equal(f.child.killed,false);
  const payload=reply('u','doc',{text:'中文字符'}),g=fixture(t,{maxResponseBytes:Buffer.byteLength(payload)-2}),pending=g.channel.request(command('u')),checked=assert.rejects(pending,error=>error.code==='WORKER_RESPONSE_TOO_LARGE');g.child.stdout.write(payload);g.exit();await checked;
});
test('partial writes and output/diagnostic stream errors retire only their own generation and wait for its exit',async t=>{
  for(const stream of ['stdin','stdout','stderr']){
    const f=fixture(t),pending=f.channel.request(command('a')),checked=assert.rejects(pending,error=>error.code==='WORKER_UNAVAILABLE');f.child[stream].emit('error',Error('broken '+stream));assert.equal(f.channel.state,'retiring');f.exit();await checked;
  }
  const f=fixture(t);f.child.stdin.write=(wire,callback)=>{f.writes.push(wire);callback(Error('partial line'));return false;};const pending=f.channel.request(command('a')),checked=assert.rejects(pending,error=>error.code==='WORKER_UNAVAILABLE');f.exit();await checked;
});
test('an old stream, timer or exit cannot settle a replacement generation',async t=>{
  const old=fixture(t),original=old.channel.request(command('same')),checked=assert.rejects(original,error=>error.code==='WORKER_UNAVAILABLE');old.exit();await checked;const next=fixture(t),replacement=next.channel.request(command('same'));old.child.stdout.write(reply('same','wrong'));old.child.emit('exit',1);await tick();assert.equal(next.channel.pending.size,1);assert.equal(next.child.killed,false);next.child.stdout.write(reply('same'));assert.equal((await replacement).ok,true);
});
test('serialization and identity admission failures are not written or confused with native failure',async t=>{
  const f=fixture(t),value=command('cycle');value.self=value;await assert.rejects(f.channel.request(value),error=>error.code==='WORKER_REQUEST_INVALID');await assert.rejects(f.channel.request({...command(''),requestId:''}),error=>error.code==='WORKER_REQUEST_INVALID');assert.equal(f.writes.length,0);assert.equal(f.channel.state,'active');
});
test('split valid UTF8 is preserved while invalid encoded bytes cannot silently rewrite geometry names',async t=>{
  const f=fixture(t),a=f.channel.request(command('a')),bytes=Buffer.from(reply('a','doc',{name:'几何中文'})),split=bytes.indexOf(Buffer.from('几'))+1;f.child.stdout.write(bytes.subarray(0,split));assert.equal(f.channel.pending.size,1);f.child.stdout.write(bytes.subarray(split));assert.equal((await a).name,'几何中文');
  const g=fixture(t),b=g.channel.request(command('b')),checked=assert.rejects(b,error=>error.code==='WORKER_PROTOCOL_ERROR');g.child.stdout.write(Buffer.concat([Buffer.from('{"ok":true,"protocolVersion":1,"requestId":"b","documentId":"doc","name":"'),Buffer.from([0xc3,0x28]),Buffer.from('"}\n')]));g.exit();await checked;
});
test('stdout EOF before the OS exit cannot hide an authoritative native memory exit reason',async t=>{
  const f=fixture(t,{exitError:code=>Object.assign(Error('native exited'),{code:code===86?'WORKER_MEMORY_LIMIT':'WORKER_UNAVAILABLE'})}),pending=f.channel.request(command('memory')),checked=assert.rejects(pending,error=>error.code==='WORKER_MEMORY_LIMIT');f.child.stdout.emit('end');assert.equal(f.channel.state,'retiring');assert.equal(f.child.killed,false,'Do not overwrite a native self-exit code');f.child.exitCode=86;f.child.emit('exit',86);f.child.emit('close',86);await checked;
});

test('requests arriving after EOF wait for the same authoritative exit reason without writing or replacing the process',async t=>{
  const f=fixture(t,{exitError:code=>Object.assign(Error('native exited'),{code:code===86?'WORKER_MEMORY_LIMIT':'WORKER_UNAVAILABLE'})});
  const original=f.channel.request(command('memory')),first=assert.rejects(original,{code:'WORKER_MEMORY_LIMIT'});
  f.child.stdout.emit('end');let settled=false;
  const late=f.channel.request(command('late')),second=assert.rejects(late,{code:'WORKER_MEMORY_LIMIT'}).then(()=>{settled=true;});
  await tick();assert.equal(settled,false);assert.equal(f.writes.length,1);assert.equal(f.child.killed,false);
  f.child.exitCode=86;f.child.emit('exit',86);f.child.emit('close',86);await first;await second;
  assert.equal(f.channel.state,'closed');assert.equal(f.writes.length,1);
});

test('non-writable admission waits for actual process exit and returns its verified resource failure',async t=>{
  const f=fixture(t,{exitError:code=>Object.assign(Error('native exited'),{code:code===87?'WORKER_MEMORY_EXHAUSTED':'WORKER_UNAVAILABLE'})});
  f.child.stdin.writable=false;let settled=false;
  const pending=f.channel.request(command('not-sent')),checked=assert.rejects(pending,{code:'WORKER_MEMORY_EXHAUSTED'}).then(()=>{settled=true;});
  await tick();assert.equal(settled,false);assert.equal(f.writes.length,0);assert.equal(f.child.killed,true);
  f.child.exitCode=87;f.child.emit('exit',87);f.child.emit('close',87);await checked;
});
test('EOF without actual exit stays blocked at the deadline and only then requests forced stop',async t=>{
  const f=fixture(t,{stopTimeoutMs:10}),pending=f.channel.request(command('eof')),checked=assert.rejects(pending,error=>error.code==='WORKER_STOP_UNCONFIRMED');f.child.stdout.emit('end');assert.equal(f.child.killed,false);await checked;assert.equal(f.channel.state,'blocked');assert.equal(f.child.killed,true);assert.equal(f.events.includes('stopped'),false);f.exit();await tick();assert.equal(f.channel.state,'closed');
});
