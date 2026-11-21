import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker,markAsUntransferable} from 'node:worker_threads';
import {discreteValidationBinary,discreteValidationPacket,discreteValidationTransferList,decodeDiscreteValidationBinary,assertDiscreteValidationReceipt,DISCRETE_VALIDATION_BYTES} from '../gateway/discrete-validation-envelope.mjs';
import {validateDiscreteNativePacket} from '../gateway/discrete-native-validation.mjs';
import {MeshArtifactPool} from '../gateway/mesh-artifact-pool.mjs';
import {MeshComputeGate} from '../gateway/mesh-compute-gate.mjs';
import {volumeInput,verifiedDomain,tetraResult} from './helpers/discrete-tetra-fixture.mjs';
const requestId='tetra-11111111-1111-4111-8111-111111111111';
const fields=()=>({phase:'result',operation:'mesh.discrete-tetra',requestId,input:{domain:verifiedDomain(),meshSize:1,quality:{version:1,mode:'strict',threshold:.2,maxBadFraction:0}},context:{sourceInput:volumeInput()},candidate:tetraResult(requestId)});
async function fixture(t,options={}){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-validation-binary-')),gate=new MeshComputeGate(),workers=[];
  const pool=new MeshArtifactPool({dataDir:data,computeGate:gate,workerFactory:(url,config)=>{const worker=options.workerFactory?options.workerFactory(url,config):new Worker(url,config);workers.push(worker);return worker;}}),job={jobId:'mesh-'+crypto.randomUUID(),documentId:'doc',kind:'discrete-tetra'};
  t.after(async()=>{await pool.close();gate.close();assert.equal(workers.every(worker=>worker.threadId===-1),true);assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-validation-binary-/);fs.rmSync(data,{recursive:true,force:true});});return {pool,gate,workers,job};
}

test('binary snapshot preserves validated geometry and yields the same semantic receipt as JSON reference',()=>{
  const value=fields(),binary=discreteValidationBinary(value),reference=discreteValidationPacket(value),decoded=decodeDiscreteValidationBinary(binary.packet);assert.deepEqual(decoded.packet,reference.packet);assert.equal(decoded.sha256,binary.sha256);const receipt=validateDiscreteNativePacket(binary.packet);assertDiscreteValidationReceipt(receipt,binary.packet,binary.sha256);assert.deepEqual({...receipt,sha256:'same'},{...validateDiscreteNativePacket(reference.packet),sha256:'same'});assert.ok(binary.packet.bytes>0&&binary.packet.bytes<=DISCRETE_VALIDATION_BYTES);
});
test('binary encoding fixes source and candidate before later caller mutation and preserves signed zero',()=>{
  const value=fields();value.candidate.points[0][0]=-0;const binary=discreteValidationBinary(value);value.candidate.sources[0].faceId='changed';value.context.sourceInput.sources[0].faceId='changed';const decoded=decodeDiscreteValidationBinary(binary.packet).packet;assert.equal(Object.is(decoded.candidate.points[0][0],-0),true);assert.equal(decoded.candidate.sources[0].faceId,'face-0');assert.doesNotThrow(()=>validateDiscreteNativePacket(binary.packet));
});
test('actual artifact dispatch transfers exclusive backing storage and does not return geometry',async t=>{
  const f=await fixture(t),binary=discreteValidationBinary(fields()),view=new Uint8Array(binary.packet.data),result=await f.pool.execute({operation:'validate-discrete-native',job:f.job,result:binary.packet});assert.equal(view.byteLength,0);assert.equal(binary.packet.data.byteLength,0);assertDiscreteValidationReceipt(result,binary.packet,binary.sha256);assert.equal(result.candidate,undefined);assert.ok(f.pool.status().metrics.replyBytes<1024);assert.equal(f.workers[0].threadId,-1);
});
test('waiting computation admission does not transfer early and cancellation leaves caller ownership intact',async t=>{
  const f=await fixture(t),lease=await f.gate.acquire({kind:'quality'}),binary=discreteValidationBinary(fields()),controller=new AbortController(),work=f.pool.execute({operation:'validate-discrete-native',job:f.job,result:binary.packet,signal:controller.signal}),checked=assert.rejects(work,{code:'MESH_ARTIFACT_CANCELLED'});assert.equal(binary.packet.data.byteLength,binary.packet.bytes);controller.abort();await checked;assert.equal(binary.packet.data.byteLength,binary.packet.bytes);assert.equal(f.workers.length,0);lease.release();
});
test('one backing buffer cannot be dispatched twice even when both operations were queued before transfer',async t=>{
  const f=await fixture(t),lease=await f.gate.acquire({kind:'quality'}),binary=discreteValidationBinary(fields()),first=f.pool.execute({operation:'validate-discrete-native',job:f.job,result:binary.packet}),second=f.pool.execute({operation:'validate-discrete-native',job:f.job,result:binary.packet});const checked=assert.rejects(second,{code:'MESH_VALIDATION_PROTOCOL_INVALID'});lease.release();await first;await checked;assert.equal(f.workers.length,1);assert.equal(binary.packet.data.byteLength,0);
});
test('unknown codec, shared/resizable/detached or nontransferable backing and byte mismatch fail closed',()=>{
  for(const mutate of [p=>p.format='other',p=>p.codec='other',p=>p.bytes++,p=>p.bytes=DISCRETE_VALIDATION_BYTES+1,p=>p.data=new SharedArrayBuffer(p.bytes),p=>p.data=new ArrayBuffer(p.bytes,{maxByteLength:p.bytes+8}),p=>markAsUntransferable(p.data),p=>structuredClone(p.data,{transfer:[p.data]})]){const p=discreteValidationBinary(fields()).packet;mutate(p);assert.throws(()=>discreteValidationTransferList(p),{code:'MESH_VALIDATION_PROTOCOL_INVALID'});}
});
test('malformed binary cannot be deserialized or accepted as a native success',()=>{
  const b=discreteValidationBinary(fields());new Uint8Array(b.packet.data).fill(0);assert.throws(()=>validateDiscreteNativePacket(b.packet),{code:'MESH_VALIDATION_PROTOCOL_INVALID'});
});
test('content mutation cannot retain the original receipt identity even if the decoded operation remains valid',()=>{
  const value=fields();value.phase='input';delete value.candidate;const b=discreteValidationBinary(value),bytes=Buffer.from(b.packet.data),where=bytes.indexOf(Buffer.from(requestId));assert.ok(where>=0);bytes[where+6]='2'.charCodeAt(0);b.packet.requestId='tetra-21111111-1111-4111-8111-111111111111';const receipt=validateDiscreteNativePacket(b.packet);assert.throws(()=>assertDiscreteValidationReceipt(receipt,b.packet,b.sha256),{code:'MESH_VALIDATION_PROTOCOL_INVALID'});
});
test('failed worker construction cannot detach a snapshot that was never dispatched',async t=>{
  const f=await fixture(t,{workerFactory:()=>{throw Error('constructor failed');}}),binary=discreteValidationBinary(fields());await assert.rejects(f.pool.execute({operation:'validate-discrete-native',job:f.job,result:binary.packet}),/constructor failed/);assert.equal(binary.packet.data.byteLength,binary.packet.bytes);assert.equal(f.workers.length,0);
});
