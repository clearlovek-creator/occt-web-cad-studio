import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MeshWorkerClient } from "../gateway/mesh-worker-client.mjs";
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn} from 'node:child_process';

function harness(timeoutMs=1000,limits={}){const children=[];const client=new MeshWorkerClient({workerPath:'fake-worker',timeoutMs,...limits,spawnImpl:()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.commands=[];child.stdin=new Writable({write(bytes,_encoding,done){child.commands.push(JSON.parse(String(bytes)));done();}});child.kill=()=>{child.killed=true;return true;};child.reply=(id,value={})=>child.stdout.write(JSON.stringify({ok:true,requestId:id,...value})+'\n');children.push(child);return child;}});return {client,children};}

test('mesh framing bounds partial and complete UTF-8 replies, rejects invalid bytes and preserves fresh generations',async()=>{
  for(const bytes of [Buffer.from('x'.repeat(129)),Buffer.from('x'.repeat(129)+'\n'),Buffer.from([0xff,10])]){
    const {client,children}=harness(1000,{maxFrameBytes:128});try{const pending=client.request({requestId:'bounded'});children[0].stdout.write(bytes);await assert.rejects(pending,error=>error.code===(bytes[0]===255?'MESH_WORKER_INVALID_RESPONSE':'MESH_WORKER_RESPONSE_LIMIT'));assert.equal(client.frames.bytes,0);assert.equal(client.pending.size,0);assert.equal(children[0].killed,true);const next=client.request({requestId:'next'});children[1].reply('next',{value:'中文'});assert.equal((await next).value,'中文');}finally{client.close();}
  }
});
test('mesh framing accepts a multibyte character split across native output chunks',async()=>{
  const {client,children}=harness();try{const pending=client.request({requestId:'unicode'}),bytes=Buffer.from(JSON.stringify({ok:true,requestId:'unicode',value:'中文'})+'\n'),offset=bytes.indexOf(Buffer.from('中'));children[0].stdout.write(bytes.subarray(0,offset+1));children[0].stdout.write(bytes.subarray(offset+1));assert.equal((await pending).value,'中文');}finally{client.close();}
});
test('oversized mesh requests are rejected before any worker starts and forks retain budgets',async()=>{
  const {client,children}=harness(1000,{maxRequestBytes:128,maxFrameBytes:256});try{await assert.rejects(client.request({requestId:'large',value:'中'.repeat(60)}),{code:'MESH_REQUEST_LIMIT'});assert.equal(children.length,0);const fork=client.fork();assert.equal(fork.maxRequestBytes,128);assert.equal(fork.maxFrameBytes,256);fork.close();}finally{client.close();}
});

test('mesh responses are matched by request ID, not FIFO order',async()=>{const {client,children}=harness();try{const first=client.request({requestId:'one'}),second=client.request({requestId:'two'});children[0].reply('two',{value:2});children[0].reply('one',{value:1});assert.equal((await first).value,1);assert.equal((await second).value,2);assert.equal(client.pending.size,0);}finally{client.close();}});
test('old mesh worker exits cannot reject a restarted generation',async()=>{const {client,children}=harness(20);try{await assert.rejects(client.request({requestId:'old'}),error=>error.code==='MESH_WORKER_TIMEOUT');const next=client.request({requestId:'new'});children[0].emit('exit',1);children[0].reply('new',{value:'wrong'});children[1].reply('new',{value:'right'});assert.equal((await next).value,'right');assert.equal(client.pending.size,0);}finally{client.close();}});
test('duplicate IDs and mismatched worker responses fail explicitly without leaking timers',async()=>{const {client,children}=harness();try{const first=client.request({requestId:'same'});await assert.rejects(client.request({requestId:'same'}),error=>error.code==='MESH_DUPLICATE_REQUEST');children[0].reply('not-same');await assert.rejects(first,error=>error.code==='MESH_WORKER_PROTOCOL_ERROR');assert.equal(client.pending.size,0);const next=client.request({requestId:'after'});client.close();await assert.rejects(next,error=>error.code==='MESH_WORKER_CLOSED');}finally{client.close();}});

test('permanent disposal waits for every old owned generation and cannot create or fork new workers',async()=>{
  const {client,children}=harness();let disposed;
  try{const first=client.request({requestId:'old'});children[0].reply('wrong');await assert.rejects(first);const second=client.request({requestId:'new'}),rejected=assert.rejects(second);let finished=false;disposed=client.dispose().then(()=>finished=true);await rejected;children[0].emit('exit',1);await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);children[1].emit('exit',1);await disposed;assert.equal(finished,true);await assert.rejects(client.request({requestId:'never'}),error=>error.code==='MESH_WORKER_CLOSED');assert.throws(()=>client.fork(),error=>error.code==='MESH_WORKER_CLOSED');assert.equal(children.length,2);}
  finally{for(const child of children)child.emit('exit',0);await disposed;}
});

test("mesh worker reports a stable startup error when the binary is unavailable", async () => {
  const client = new MeshWorkerClient({
    workerPath: path.join(process.cwd(), "mesh-worker", "build", "does-not-exist.exe"),
    timeoutMs: 100,
  });
  await assert.rejects(
    client.request({ protocolVersion: 1, requestId: "test-startup", operation: "health.ping" }),
    (error) => error.code === "MESH_WORKER_START_FAILED" || error.code === "MESH_WORKER_EXITED",
  );
  client.close();
});

test("dedicated worker termination waits for a real process exit and leaves a sibling usable",async()=>{
  const children=[];
  const program=`process.stdin.setEncoding('utf8');let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){const command=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(command.operation==='health.ping')process.stdout.write(JSON.stringify({ok:true,requestId:command.requestId,pid:process.pid})+'\\n');}});`;
  const shared=new MeshWorkerClient({workerPath:'dedicated-test',timeoutMs:5000,spawnImpl:(_file,_args,options)=>{const child=spawn(process.execPath,['-e',program],options);children.push(child);return child;}});
  const dedicated=shared.fork();
  try {
    const held=dedicated.request({requestId:'held',operation:'hold'});const rejected=assert.rejects(held,error=>error.code==='MESH_WORKER_CLOSED');
    const sibling=await shared.request({requestId:'sibling',operation:'health.ping'});assert.equal(children.length,2);
    await dedicated.closeAndWait();await rejected;
    assert.ok(children[0].exitCode!==null||children[0].signalCode!==null,'Cancellation must await the OS exit event');
    assert.equal((await shared.request({requestId:'after-cancel',operation:'health.ping'})).pid,sibling.pid);
  } finally {await Promise.all([dedicated.closeAndWait(),shared.closeAndWait()]);}
});
