import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {importTestTypeScript} from './helpers/import-typescript.mjs';
const {MeshWireLayer}=await importTestTypeScript('../app/model/mesh-wire-layer.ts',import.meta.url);
const never=()=>new Promise(()=>{});
const flush=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));};
const bytes=Buffer.alloc(48);[0,0,0,1,1,1].forEach((value,i)=>bytes.writeDoubleLE(value,i*8));
const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
const wire=key=>({key,scalars:6,chunks:[{offset:0,bytes:48,sha256}]});
const context={jobId:'mesh-private',documentId:'doc',visibleKeys:['wire-3-1'],render:{dimension:3,kind:'wire',positions:[],groups:[],storage:{version:1,format:'float64-le',bytes:96,sha256:'a'.repeat(64)},wires:[wire('wire-3-1'),wire('wire-3-2')]}};
function response(key,{body,status=200,wrongHeader=false,length=48}={}){return {ok:status>=200&&status<300,status,headers:new Headers({'X-CAD-Mesh-Format':'float64-le','X-CAD-Mesh-Wire':wrongHeader?'wire-3-99':key,'X-CAD-Mesh-Chunk':'0','Content-Length':String(length)}),body:body||new Response(bytes).body};}
function readerBody(read,{throwRelease=false}={}){const calls={cancel:0,release:0,read:0};return {calls,body:{getReader:()=>({read:()=>{calls.read++;return read();},cancel:()=>{calls.cancel++;return never();},releaseLock:()=>{calls.release++;if(throwRelease)throw Error('Test-owned pending read');}})}};}
function setup(t,fetchImpl,{concurrency=1,digest}={}){
  // Deadlines are tested independently of the host crypto thread scheduling.
  // The existing integrity suite continues to exercise real SHA-256.
  t.mock.method(globalThis.crypto.subtle,'digest',digest||(async(_algorithm,data)=>Uint8Array.from(crypto.createHash('sha256').update(Buffer.from(data)).digest()).buffer));
  const requests=[],errors=[],updates=[];
  const layer=new MeshWireLayer({apiRoot:'/api',concurrency,fetchImpl:(url,init)=>{const key=new URL(url,'http://test').searchParams.get('wireKey');requests.push({key,signal:init.signal});return fetchImpl(key,init,requests.length);},onError:value=>errors.push(value),onUpdate:value=>updates.push(value)});
  t.after(()=>layer.dispose());return {layer,requests,errors,updates};
}

test('the hard wire deadline settles a fetch that ignores AbortSignal and cancels a late response without retrying',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let deliver,cancelled=0;
  const f=setup(t,()=>new Promise(resolve=>deliver=resolve));f.layer.update(context);t.mock.timers.tick(15000);await flush();
  assert.equal(f.requests[0].signal.aborted,true);assert.equal(f.layer.status().pending,0);assert.equal(f.errors.length,1);assert.match(f.errors[0],/超时/);
  f.layer.update(context);await flush();assert.equal(f.requests.length,1);
  deliver(response('wire-3-1',{body:{cancel:()=>{cancelled++;return never();},getReader:()=>assert.fail('A late body must not be read')}}));await flush();assert.equal(cancelled,1);assert.equal(f.layer.group.children.length,0);
});

test('hiding an uncooperative fetch immediately frees its observation slot for the newly requested Body',async t=>{
  let deliver,cancelled=0;const f=setup(t,(key)=>key==='wire-3-1'?new Promise(resolve=>deliver=resolve):Promise.resolve(response(key)));
  f.layer.update(context);f.layer.update({...context,visibleKeys:['wire-3-2']});assert.equal(f.requests[0].signal.aborted,true);assert.equal(f.requests.length,2);await flush();assert.equal(f.layer.status().pending,0);assert.equal(f.layer.status().loadedChunks,1);
  deliver(response('wire-3-1',{body:{cancel:()=>{cancelled++;return never();}}}));await flush();assert.equal(cancelled,1);assert.equal(f.layer.group.children[0].userData.meshWireKey,'wire-3-2');assert.deepEqual(f.errors,[]);
});

test('wrong wire headers or byte lengths fail without awaiting an unending response cancellation',async t=>{
  for(const options of [{wrongHeader:true},{length:49}]){let cancelled=0;const f=setup(t,key=>Promise.resolve(response(key,{...options,body:{cancel:()=>{cancelled++;return never();}}})));f.layer.update(context);await flush();assert.equal(f.layer.status().pending,0);assert.equal(f.errors.length,1);assert.equal(cancelled,1);assert.equal(f.layer.status().residentBytes,0);f.layer.dispose();}
});

test('oversized binary reads report the bounded failure and release their reader even if cancel never finishes',async t=>{
  const stream=readerBody(async()=>({done:false,value:new Uint8Array(49)})),f=setup(t,key=>Promise.resolve(response(key,{body:stream.body})));f.layer.update(context);await flush();assert.equal(f.layer.status().pending,0);assert.match(f.errors[0],/数据块预算/);assert.equal(stream.calls.cancel,1);assert.equal(stream.calls.release,1);assert.equal(stream.calls.read,1);
});

test('HTTP diagnostics remain byte-bounded and cannot hang inside reader cancellation',async t=>{
  const stream=readerBody(async()=>({done:false,value:new Uint8Array(8193)})),f=setup(t,key=>Promise.resolve(response(key,{body:stream.body,status:503})));f.layer.update(context);await flush();assert.equal(f.layer.status().pending,0);assert.deepEqual(f.errors,['网格显示读取失败（HTTP 503）。']);assert.equal(stream.calls.cancel,1);assert.equal(stream.calls.release,1);
});

test('a body read that ignores abort settles at the original deadline and never consumes its late chunk',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let deliver;const stream=readerBody(()=>new Promise(resolve=>deliver=resolve),{throwRelease:true}),f=setup(t,key=>Promise.resolve(response(key,{body:stream.body})));f.layer.update(context);await flush();t.mock.timers.tick(15000);await flush();assert.equal(f.layer.status().pending,0);assert.match(f.errors[0],/超时/);assert.equal(stream.calls.cancel,1);assert.equal(stream.calls.release,1);deliver({done:false,value:bytes});await flush();assert.equal(stream.calls.read,1);assert.equal(f.layer.group.children.length,0);
});

test('disposal releases owned readers without waiting for cancel and late completions never notify or allocate geometry',async t=>{
  let deliver;const stream=readerBody(()=>new Promise(resolve=>deliver=resolve)),f=setup(t,key=>Promise.resolve(response(key,{body:stream.body})));f.layer.update(context);await flush();const notifications=f.updates.length;f.layer.dispose();await flush();assert.equal(stream.calls.cancel,1);assert.equal(stream.calls.release,1);assert.equal(f.layer.status().pending,0);deliver({done:false,value:bytes});await flush();assert.equal(f.updates.length,notifications);assert.equal(f.layer.group.children.length,0);assert.deepEqual(f.errors,[]);
});

test('one failed chunk aborts and retires its siblings; their late replies cannot replace an explicit retry',async t=>{
  let failFirst,deliverOld;const f=setup(t,(key,_init,count)=>count===1?new Promise(resolve=>failFirst=resolve):count===2?new Promise(resolve=>deliverOld=resolve):Promise.resolve(response(key)),{concurrency:2});const both={...context,visibleKeys:['wire-3-1','wire-3-2']};f.layer.update(both);failFirst(response('wire-3-1',{wrongHeader:true}));await flush();assert.equal(f.layer.status().pending,0);assert.equal(f.requests[1].signal.aborted,true);assert.equal(f.errors.length,1);
  f.layer.update({...context,visibleKeys:[]});f.layer.update(both);await flush();assert.equal(f.layer.status().loadedChunks,2);deliverOld(response('wire-3-2'));await flush();assert.equal(f.layer.group.children.length,2);assert.equal(f.requests.length,4);assert.equal(f.errors.length,1);
});

test('same-turn hide/show keeps the replacement request owned while the retired request runs its finally handler',async t=>{
  const replies=[];let discarded=0;const f=setup(t,()=>new Promise(resolve=>replies.push(resolve)));
  f.layer.update(context);f.layer.update({...context,visibleKeys:[]});f.layer.update(context);
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].signal.aborted,true);assert.equal(f.requests[1].signal.aborted,false);
  await flush();assert.equal(f.layer.status().pending,1);assert.equal(f.requests.length,2,'Old finally must not remove the new pending entry and start a third read');
  replies[0](response('wire-3-1',{body:{cancel:()=>{discarded++;return never();}}}));await flush();assert.equal(discarded,1);assert.equal(f.layer.status().pending,1);
  replies[1](response('wire-3-1'));await flush();assert.equal(f.layer.status().pending,0);assert.equal(f.layer.status().loadedChunks,1);assert.equal(f.requests.length,2);assert.deepEqual(f.errors,[]);
});

test('the same fifteen-second budget covers headers and body instead of resetting between phases',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let deliver;const stream=readerBody(never),f=setup(t,()=>new Promise(resolve=>deliver=resolve));f.layer.update(context);t.mock.timers.tick(10000);deliver(response('wire-3-1',{body:stream.body}));await flush();t.mock.timers.tick(4999);await flush();assert.equal(f.errors.length,0);assert.equal(f.layer.status().pending,1);t.mock.timers.tick(1);await flush();assert.equal(f.layer.status().pending,0);assert.match(f.errors[0],/超时/);assert.equal(stream.calls.cancel,1);
});

test('the observation deadline also covers a stalled SHA-256 phase and late digests never publish geometry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let deliver;const f=setup(t,key=>Promise.resolve(response(key)),{digest:()=>new Promise(resolve=>deliver=resolve)});f.layer.update(context);await flush();assert.equal(typeof deliver,'function');t.mock.timers.tick(15000);await flush();assert.equal(f.layer.status().pending,0);assert.match(f.errors[0],/超时/);deliver(Uint8Array.from(Buffer.from(sha256,'hex')).buffer);await flush();assert.equal(f.layer.group.children.length,0);assert.equal(f.layer.status().residentBytes,0);
});
