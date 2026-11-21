import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {Worker} from 'node:worker_threads';
import {DiscreteTetraClient} from '../gateway/discrete-tetra-client.mjs';
import {MeshArtifactPool} from '../gateway/mesh-artifact-pool.mjs';
import {MeshComputeGate} from '../gateway/mesh-compute-gate.mjs';
import {validateDiscreteNativePacket} from '../gateway/discrete-native-validation.mjs';
import {discreteValidationPacket,assertDiscreteValidationReceipt} from '../gateway/discrete-validation-envelope.mjs';
import {volumeInput,verifiedDomain,tetraHealth,tetraResult} from './helpers/discrete-tetra-fixture.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const command=()=>({domain:verifiedDomain(),meshSize:1,quality:{version:1,mode:'strict',threshold:.2,maxBadFraction:0}});
const id='tetra-11111111-1111-4111-8111-111111111111';
function packet(phase='input',candidate){return discreteValidationPacket({phase,operation:'mesh.discrete-tetra',requestId:id,input:command(),context:{sourceInput:volumeInput()},...candidate&&{candidate}});}
function signalPromise(){let resolve,reject;return {promise:new Promise((r,j)=>{resolve=r;reject=j;}),resolve:value=>resolve(value),reject:error=>reject(error)};}
async function fixture(t,{holdPhase,timeoutMs=5000,validate,onJob}={}){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-threaded-validation-')),job={jobId:'mesh-'+crypto.randomUUID(),documentId:'doc',kind:'discrete-tetra'},gate=new MeshComputeGate(),control=new Int32Array(new SharedArrayBuffer(8)),held=signalPromise(),workers=[],children=[],writes=[];
  const pool=new MeshArtifactPool({dataDir:data,computeGate:gate,timeoutMs,workerFactory:(url,options)=>{
    const holding=options.workerData.operation==='validate-discrete-native'&&options.workerData.result.phase===holdPhase;
    const worker=new Worker(holding?new URL('./fixtures/held-discrete-validation-thread.mjs',import.meta.url):url,holding?{...options,workerData:{...options.workerData,validationFixtureTarget:url.href,validationFixtureControl:control.buffer}}:options);workers.push(worker);
    if(holding){let replied=false;worker.once('message',()=>{replied=true;held.resolve(worker);});worker.once('exit',code=>{if(!replied)held.reject(Error('Held validation worker exited before its reply: '+code));});worker.once('error',held.reject);}return worker;
  }});
  const send=(child,value)=>child.stdout.write(JSON.stringify(value)+'\n'),exit=(child,code=0)=>{if(child.exitCode!==null)return;child.exitCode=code;child.emit('exit',code);child.stdout.end();child.stderr.end();child.emit('close',code);};
  const spawnImpl=()=>{
    const child=new EventEmitter();Object.assign(child,{pid:987654,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new EventEmitter(),exitCode:null,signalCode:null,killed:false});child.stdin.writable=true;
    child.stdin.write=(wire,callback)=>{const c=JSON.parse(wire);writes.push(c);queueMicrotask(()=>{if(c.operation==='health.ping')send(child,tetraHealth(c.requestId));else if(onJob)onJob({child,command:c,send,exit});else{send(child,tetraResult(c.requestId,c.input.quality));exit(child);}});callback?.();return true;};child.kill=()=>{child.killed=true;exit(child);return true;};children.push(child);return child;
  };
  const actualValidate=(value,{signal})=>pool.execute({operation:'validate-discrete-native',job,result:value,signal});
  const client=new DiscreteTetraClient({workerPath:'C:/sealed/gmsh_mesh_worker.exe',spawnImpl,validate:validate?((p,o)=>validate(p,o,actualValidate)):actualValidate,stopTimeoutMs:1000});
  const release=()=>{Atomics.store(control,0,1);Atomics.notify(control,0);};
  t.after(async()=>{release();await client.closeAndWait();await pool.close();gate.close();assert.equal(workers.every(worker=>worker.threadId===-1),true);assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-threaded-validation-/);fs.rmSync(data,{recursive:true,force:true});});
  return {client,pool,gate,held,children,writes,workers,job,send,exit,release};
}

test('closed validator registry checks input, result and receipt identity without returning geometry',()=>{
  for(const phase of ['input','result']){const value=packet(phase,phase==='result'?tetraResult(id):undefined),receipt=validateDiscreteNativePacket(value.packet);assert.equal(assertDiscreteValidationReceipt(receipt,value.packet,value.sha256),receipt);assert.equal(receipt.candidate,undefined);assert.ok(JSON.stringify(receipt).length<512);}
  for(const mutate of [p=>p.operation='surface.refine',p=>p.phase='eval',p=>p.script='run',p=>p.requestId='other',p=>p.input.meshSize=0,p=>p.context.sourceInput.sources[0].faceId='foreign']){const p=packet().packet;mutate(p);assert.throws(()=>validateDiscreteNativePacket(p));}
});
test('receipt cannot cross input hash, phase, request or native operation',()=>{
  const value=packet(),receipt=validateDiscreteNativePacket(value.packet);
  for(const mutate of [r=>r.sha256='f'.repeat(64),r=>r.phase='result',r=>r.requestId='foreign',r=>r.operation='volume.partition',r=>r.points=[]]){const r=structuredClone(receipt);mutate(r);assert.throws(()=>assertDiscreteValidationReceipt(r,value.packet,value.sha256),{code:'MESH_VALIDATION_PROTOCOL_INVALID'});}
});
test('actual artifact workers validate native input and result, then return only bound receipts',async t=>{
  const f=await fixture(t),r=await f.client.tetrahedralize(command(),{sourceInput:volumeInput()});assert.equal(r.execution.exitCode,0);assert.equal(f.workers.length,2);assert.equal(f.pool.status().metrics.replyBytes<4096,true);assert.equal(f.client.children.size,0);
});
test('validation owns client admission before a native process exists',async t=>{
  const f=await fixture(t,{holdPhase:'input'}),work=f.client.tetrahedralize(command(),{sourceInput:volumeInput()});await f.held.promise;assert.equal(f.client.status().state,'validating-input');assert.equal(f.children.length,0);await assert.rejects(f.client.tetrahedralize(command(),{sourceInput:volumeInput()}),{code:'MESH_BUSY'});f.release();assert.equal((await work).ok,true);
});
test('a valid worker reply is not completion until that exact input-validation worker exits',async t=>{
  const f=await fixture(t,{holdPhase:'input'});let settled=false;const work=f.client.tetrahedralize(command(),{sourceInput:volumeInput()}).then(r=>{settled=true;return r;});const worker=await f.held.promise;await tick();assert.equal(settled,false);assert.ok(worker.threadId>0);assert.equal(f.children.length,0);f.release();await work;assert.equal(worker.threadId,-1);
});
test('cancelling an actual held input-validation worker cannot start native work',async t=>{
  const f=await fixture(t,{holdPhase:'input'}),controller=new AbortController(),work=f.client.tetrahedralize(command(),{sourceInput:volumeInput(),signal:controller.signal}),checked=assert.rejects(work,{code:'MESH_CANCELLED'});const worker=await f.held.promise;controller.abort();await checked;assert.equal(worker.threadId,-1);assert.equal(f.children.length,0);assert.equal(f.pool.status().active,false);
});
test('closing during actual input validation waits for retirement and permanently fences spawn',async t=>{
  const f=await fixture(t,{holdPhase:'input'}),work=f.client.tetrahedralize(command(),{sourceInput:volumeInput()}),checked=assert.rejects(work,{code:'MESH_SERVICE_CLOSED'});const worker=await f.held.promise;await f.client.closeAndWait();await checked;assert.equal(worker.threadId,-1);assert.equal(f.children.length,0);await assert.rejects(f.client.tetrahedralize(command(),{sourceInput:volumeInput()}),{code:'MESH_SERVICE_CLOSED'});
});
test('compute admission wait can be cancelled without spawning a validator or native child',async t=>{
  const f=await fixture(t),lease=await f.gate.acquire({kind:'quality'}),controller=new AbortController(),work=f.client.tetrahedralize(command(),{sourceInput:volumeInput(),signal:controller.signal}),checked=assert.rejects(work,{code:'MESH_CANCELLED'});await tick();controller.abort();await checked;assert.equal(f.workers.length,0);assert.equal(f.children.length,0);lease.release();
});
test('native exit and valid result do not bypass a still-live result-validation worker',async t=>{
  const f=await fixture(t,{holdPhase:'result'}),controller=new AbortController();let settled=false;const checked=f.client.tetrahedralize(command(),{sourceInput:volumeInput(),signal:controller.signal}).catch(error=>{settled=true;return error;});const worker=await f.held.promise;assert.equal(f.children[0].exitCode,0);assert.equal(settled,false);controller.abort();assert.equal((await checked).code,'MESH_CANCELLED');assert.equal(worker.threadId,-1);assert.equal(f.client.children.size,0);
});
test('artifact validation timeout retires the exact worker and does not accept its prior receipt',async t=>{
  const f=await fixture(t,{holdPhase:'result',timeoutMs:1000}),work=f.client.tetrahedralize(command(),{sourceInput:volumeInput()}),checked=assert.rejects(work,{code:'MESH_ARTIFACT_TIMEOUT'});const worker=await f.held.promise;await checked;assert.equal(worker.threadId,-1);assert.equal(f.children.length,1);assert.equal(f.children[0].exitCode,0);
});
test('strict failure validation preserves bounded diagnostics and exact native exit 2',async t=>{
  const quality={version:1,mode:'strict',threshold:.9,maxBadFraction:0},f=await fixture(t,{onJob:({child,command,send,exit})=>{const r=tetraResult(command.requestId,quality);send(child,{ok:false,protocolVersion:1,requestId:command.requestId,service:'gmsh-mesh-worker',operation:'mesh.discrete-tetra',code:'MESH_QUALITY_REJECTED',error:'Strict quality rejected.',quality:r.quality,optimization:r.optimization});exit(child,2);}});
  await assert.rejects(f.client.tetrahedralize({...command(),quality},{sourceInput:volumeInput()}),error=>{assert.equal(error.code,'MESH_QUALITY_REJECTED');assert.equal(error.details.quality.lowQualityCount,6);assert.equal(error.execution.exitCode,2);return true;});assert.equal(f.workers.length,2);
});
test('forged asynchronous receipt rejects before spawn instead of silently falling back to synchronous validation',async t=>{
  const f=await fixture(t,{validate:async p=>({...validateDiscreteNativePacket(p),sha256:'f'.repeat(64)})});await assert.rejects(f.client.tetrahedralize(command(),{sourceInput:volumeInput()}),{code:'MESH_VALIDATION_PROTOCOL_INVALID'});assert.equal(f.children.length,0);assert.equal(f.workers.length,0);
});
test('external domain and source edits during input validation cannot alter the fixed native command',async t=>{
  const f=await fixture(t,{holdPhase:'input'}),input=command(),source=volumeInput(),work=f.client.tetrahedralize(input,{sourceInput:source});await f.held.promise;input.domain.sources[0].faceId='changed';source.sources[0].faceId='changed';f.release();await work;assert.equal(f.writes[1].input.domain.sources[0].faceId,'face-0');
});
test('actual held validator cannot block parent event-loop heartbeats',async t=>{
  const f=await fixture(t,{holdPhase:'input'}),work=f.client.tetrahedralize(command(),{sourceInput:volumeInput()});await f.held.promise;let ticks=0;const timer=setInterval(()=>ticks++,1);await new Promise(resolve=>setTimeout(resolve,25));clearInterval(timer);assert.ok(ticks>0);f.release();await work;
});

test('native memory or abnormal exit during validation retires the worker and overrides its valid receipt',async t=>{
  for(const [code,expected]of [[86,'MESH_WORKER_MEMORY_LIMIT'],[3,'MESH_PROCESS_FAILED']]){
    const f=await fixture(t,{holdPhase:'result',onJob:({child,command,send})=>send(child,tetraResult(command.requestId))}),work=f.client.tetrahedralize(command(),{sourceInput:volumeInput()}),checked=assert.rejects(work,{code:expected});const worker=await f.held.promise;f.exit(f.children[0],code);await checked;assert.equal(worker.threadId,-1);assert.equal(f.children.length,1);
  }
});

test('late protocol corruption while validation is live cannot become an accepted result',async t=>{
  const f=await fixture(t,{holdPhase:'result',onJob:({child,command,send})=>send(child,tetraResult(command.requestId))}),work=f.client.tetrahedralize(command(),{sourceInput:volumeInput()}),checked=assert.rejects(work,{code:'MESH_PROTOCOL_INVALID'});const worker=await f.held.promise;
  f.children[0].kill=()=>{const child=f.children[0];child.killed=true;child.signalCode='SIGTERM';child.emit('exit',null,'SIGTERM');child.stdout.end();child.stderr.end();child.emit('close',null);return true;};
  f.send(f.children[0],{ok:true,protocolVersion:1,requestId:'foreign'});await checked;assert.equal(worker.threadId,-1);assert.equal(f.children[0].killed,true);
});

test('known protocol failure does not enqueue an unnecessary result validator',async t=>{
  const f=await fixture(t,{onJob:({child,command,send})=>{send(child,tetraResult(command.requestId));send(child,{ok:true,protocolVersion:1,requestId:'foreign'});}});await assert.rejects(f.client.tetrahedralize(command(),{sourceInput:volumeInput()}),{code:'MESH_PROTOCOL_INVALID'});assert.equal(f.workers.length,1,'Only the already completed input validation may exist.');
});
