import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {importTestTypeScript} from './helpers/import-typescript.mjs';
const {readMeshWireChunk}=await importTestTypeScript('../app/model/mesh-wire-read.ts',import.meta.url);
const {MeshWireLayer}=await importTestTypeScript('../app/model/mesh-wire-layer.ts',import.meta.url);
function fixture({bytes=48,partBytes=1,empties=0,interleave=false,onRead,status=200}={}){
  const payload=Buffer.alloc(bytes);for(let i=0;i<bytes/8;i++)payload.writeDoubleLE(i%6<3?0:1,i*8);
  const sha256=crypto.createHash('sha256').update(payload).digest('hex'),state={reads:0,positive:0,cancel:0,release:0};let offset=0,empty=0;
  const body={getReader:()=>({read:async()=>{state.reads++;onRead?.(state);if(empty<empties&&!(interleave&&state.reads%128===0&&offset<payload.length)){empty++;return {done:false,value:new Uint8Array(0)};}if(offset===payload.length)return {done:true};const value=payload.subarray(offset,Math.min(payload.length,offset+partBytes));offset+=value.length;state.positive++;return {done:false,value};},cancel:async()=>{state.cancel++;},releaseLock:()=>{state.release++;}})};
  const controller=new AbortController(),chunk={offset:0,bytes:payload.length,sha256},response={ok:status===200,status,headers:new Headers({'X-CAD-Mesh-Format':'float64-le','X-CAD-Mesh-Wire':'wire-3-1','X-CAD-Mesh-Chunk':'0','Content-Length':String(payload.length)}),body};
  return {payload,controller,chunk,response,state,read:(extra={})=>readMeshWireChunk({apiRoot:'/api',jobId:'test',wireKey:'wire-3-1',index:0,chunk,signal:controller.signal,fetcher:async()=>response,...extra})};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('a finite empty-fragment flood is rejected before valid trailing bytes can hide its CPU cost',async()=>{
  for(const interleave of [false,true]){const f=fixture({empties:5000,interleave});await assert.rejects(f.read(),{code:'MESH_WIRE_STREAM_LIMIT'});assert.ok(f.state.reads<=4097+(interleave?48:0));if(!interleave)assert.equal(f.state.positive,0);else assert.ok(f.state.positive>0);assert.equal(f.state.cancel,1);assert.equal(f.state.release,1);}
});
test('the empty-fragment boundary still accepts valid data and preserves its source bytes',async()=>{
  for(const interleave of [false,true]){const f=fixture({empties:4096,interleave}),before=Buffer.from(f.payload),result=await f.read();assert.equal(result.positions.length,6);assert.deepEqual([...result.positions],[0,0,0,1,1,1]);assert.deepEqual(f.payload,before);assert.equal(f.state.cancel,0);assert.equal(f.state.release,1);}
});
test('valid one-byte fragmentation yields to a foreground timer before all bytes are consumed',async()=>{
  const f=fixture({bytes:48*1024});let heartbeat=null;const tick=new Promise(resolve=>setTimeout(()=>{heartbeat=f.state.positive;resolve();},0));const result=await f.read();await tick;assert.ok(heartbeat>0&&heartbeat<f.payload.length,`Timer ran only after ${heartbeat}/${f.payload.length} fragments`);assert.equal(result.positions.length,f.payload.length/8);assert.equal(f.state.positive,f.payload.length);assert.equal(f.state.cancel,0);assert.equal(f.state.release,1);
});
test('cancel from a task interrupts a ready one-byte stream before it drains, and leaves no owned yield timer',async()=>{
  const before=process.getActiveResourcesInfo().filter(name=>name==='Timeout').length,f=fixture({bytes:48*1024});const cancel=setTimeout(()=>f.controller.abort(),0);
  try{await assert.rejects(f.read(),{name:'AbortError'});assert.ok(f.state.positive>0&&f.state.positive<f.payload.length,`Cancelled after ${f.state.positive}/${f.payload.length} fragments`);assert.equal(f.state.cancel,1);assert.equal(f.state.release,1);}finally{clearTimeout(cancel);}
  await turn();await turn();assert.equal(process.getActiveResourcesInfo().filter(name=>name==='Timeout').length,before);
});
test('monotonic expiry stops ready fragments even before the fifteen-second timer callback is scheduled',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let now=0;t.mock.method(performance,'now',()=>now);const f=fixture({partBytes:8,onRead:()=>{now+=5000;}}),errors=[];
  const layer=new MeshWireLayer({apiRoot:'/api',fetchImpl:async()=>f.response,onError:value=>errors.push(value)});t.after(()=>layer.dispose());
  layer.update({jobId:'test',documentId:'doc',visibleKeys:['wire-3-1'],render:{dimension:3,kind:'wire',positions:[],groups:[],storage:{version:1,format:'float64-le',bytes:48,sha256:'a'.repeat(64)},wires:[{key:'wire-3-1',scalars:6,chunks:[f.chunk]}]}});
  for(let i=0;i<30&&layer.status().pending;i++)await turn();assert.equal(layer.status().pending,0);assert.match(errors[0]||'',/超时/);assert.ok(f.state.reads<=3);assert.equal(f.state.cancel,1);assert.equal(f.state.release,1);assert.equal(layer.group.children.length,0);
});
test('error response empty fragments obey the CPU bound without reflecting arbitrary diagnostic bytes',async()=>{
  const f=fixture({empties:5000,status:503});await assert.rejects(f.read(),{message:'网格显示读取失败（HTTP 503）。'});assert.ok(f.state.reads<=4097);assert.equal(f.state.cancel,1);assert.equal(f.state.release,1);
});
