import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {MeshArtifactPool} from '../gateway/mesh-artifact-pool.mjs';import {MeshAdmissionMemo} from '../gateway/mesh-admission-memo.mjs';
const job={
  jobId:'mesh-00000000-0000-0000-0000-000000000001',documentId:'test',
  source:{documentId:'test',revision:1,bodies:[]},state:'complete',options:{qualityThreshold:.2},
  artifact:{result:{bytes:1,sha256:'a'.repeat(64)},quality:{bytes:2,sha256:'b'.repeat(64)}}
};
const result=()=>({ok:true,mesh:{admission:{version:1,policy:'test',status:'accepted',usable:true}}});
async function fixture(action){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-memo-pool-')),workers=[],memo=new MeshAdmissionMemo({runtimeKey:'test-runtime'}),pool=new MeshArtifactPool({dataDir:root,admissionMemo:memo,workerFactory:(_url,settings)=>{const worker=new EventEmitter();worker.settings=settings;worker.terminate=async()=>1;worker.reply=(mode='full')=>worker.emit('message',{id:settings.workerData.id,ok:true,value:result(),admissionVerification:mode});workers.push(worker);return worker;}});try{await action({pool,memo,workers,read:extra=>pool.execute({operation:'read',job,...extra})});}finally{for(const worker of workers)worker.emit('exit',1);await pool.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-memo-pool-/);fs.rmSync(root,{recursive:true,force:true});}}
test('a successful full-verifier message cannot seed admission until the original worker exits successfully',()=>fixture(async f=>{
  const work=f.read();f.workers[0].reply();assert.equal(f.memo.status().entries,0);assert.equal(f.pool.metrics.fullAdmissions,0);f.workers[0].emit('exit',0);const received=await work;assert.equal(f.memo.status().entries,1);received.mesh.admission.usable=false;
  const next=f.read();assert.ok(f.workers[1].settings.workerData.admissionMemo.receipt);assert.equal(f.workers[1].settings.workerData.admissionMemo.receipt.admission.usable,true);f.workers[1].reply('receipt');f.workers[1].emit('exit',0);assert.equal((await next).mesh.admission.usable,true);assert.equal(f.pool.metrics.reusedAdmissions,1);
}));
test('cancelled or failed verifiers never seed memo and close/deletion discard earlier authority',()=>fixture(async f=>{
  const controller=new AbortController(),cancelled=f.read({signal:controller.signal}),failed=assert.rejects(cancelled,{code:'MESH_ARTIFACT_CANCELLED'});f.workers[0].reply();controller.abort();f.workers[0].emit('exit',0);await failed;assert.equal(f.memo.status().entries,0);
  const errored=f.read(),rejected=assert.rejects(errored,{code:'MESH_ARTIFACT_WORKER_FAILED'});f.workers[1].reply();f.workers[1].emit('exit',1);await rejected;assert.equal(f.memo.status().entries,0);
  const good=f.read();f.workers[2].reply();f.workers[2].emit('exit',0);await good;assert.equal(f.memo.status().entries,1);await f.pool.cancelJob(job.jobId);assert.equal(f.memo.status().entries,0);f.memo.put(job,result().mesh.admission);await f.pool.close();assert.equal(f.memo.status().entries,0);
}));
test('a worker cannot claim receipt reuse when none was issued for this read',()=>fixture(async f=>{
  const work=f.read(),failed=assert.rejects(work,{code:'MESH_ARTIFACT_INVALID'});f.workers[0].reply('receipt');f.workers[0].emit('exit',0);await failed;assert.equal(f.memo.status().entries,0);assert.equal(f.pool.metrics.reusedAdmissions,0);
}));
