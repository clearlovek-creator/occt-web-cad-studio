import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
const digest=bytes=>({bytes:Buffer.byteLength(bytes),sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
function fixture(t){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-completion-')),store=new MeshJobStore(root);
    t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-mesh-completion-/);fs.rmSync(root,{recursive:true,force:true});});
    const job={jobId:'mesh-00000000-0000-4000-8000-000000000001',documentId:'doc',state:'running',createdAt:'2026-11-17T00:00:00.000Z',startedAt:'2026-11-17T00:00:01.000Z',source:{version:1,documentId:'doc',revision:1,bodies:[{bodyId:'body-1',kind:'solid',bodyIdentity:'a'.repeat(32),topologyIdentity:'b'.repeat(32),topologyRevision:1}]},options:{repairMode:'conservative',qualityThreshold:0.2}};
    store.save(job);const file=path.join(store.directory(job),'metadata.json'),before=fs.readFileSync(file);
    Object.assign(job,{state:'complete',finishedAt:'2026-11-17T00:00:02.000Z',artifact:{result:digest('{}')},meshSummary:{dimension:3,nodeCount:4,elementCount:1}});
    return {root,store,job,file,before,receipt:path.join(store.directory(job),'completion.json')};
}
function denyMetadata(t,f){const rename=fs.renameSync;t.mock.method(fs,'renameSync',(source,target)=>{if(target===f.file)throw Object.assign(Error('SECRET '+target),{code:'EPERM'});return rename(source,target);});}

test('a durable completion receipt survives a locked mutable metadata file without reporting computation failure',t=>{
    const f=fixture(t);denyMetadata(t,f);const completion=f.store.commitCompletion(f.job);
    assert.equal(completion.metadataSynchronized,false);assert.deepEqual(fs.readFileSync(f.file),f.before);assert.equal(JSON.parse(fs.readFileSync(f.receipt)).record.state,'complete');assert.doesNotMatch(JSON.stringify(completion),/SECRET|cad-mesh-completion-/);
});
test('restart recovers the exact committed completion without replay or rewriting the old metadata',t=>{
    const f=fixture(t);denyMetadata(t,f);f.store.commitCompletion(f.job);const before=fs.readFileSync(f.receipt),loaded=new MeshJobStore(f.root).loadCatalog();
    assert.equal(loaded.jobs[0].state,'complete');assert.equal(loaded.jobs[0].visible,false);assert.equal(loaded.jobs[0].completionReceipt,true);assert.deepEqual(loaded.jobs[0].artifact,f.job.artifact);assert.deepEqual(fs.readFileSync(f.file),f.before);assert.deepEqual(fs.readFileSync(f.receipt),before);assert.equal(loaded.stats.completionRecovered,1);
});
test('a receipt cannot override changed metadata from another task state or source',t=>{
    const f=fixture(t);denyMetadata(t,f);f.store.commitCompletion(f.job);fs.writeFileSync(f.file,JSON.stringify({...JSON.parse(f.before),state:'cancelled'}));const before=fs.readFileSync(f.file),loaded=f.store.loadCatalog();
    assert.equal(loaded.jobs[0].state,'failed');assert.equal(loaded.jobs[0].errorCode,'MESH_METADATA_COMPLETION_CONFLICT');assert.deepEqual(fs.readFileSync(f.file),before);assert.ok(fs.existsSync(f.receipt));
});
test('completion bytes and metadata bytes share the catalog budget before parsing or adoption',t=>{
    const f=fixture(t);denyMetadata(t,f);f.store.commitCompletion(f.job);const receipt=fs.readFileSync(f.receipt),bytes=f.before.length+receipt.length;
    assert.throws(()=>f.store.loadCatalog({limits:{maxMetadataBytes:bytes-1}}),{code:'MESH_CATALOG_LIMIT'});assert.deepEqual(fs.readFileSync(f.file),f.before);assert.deepEqual(fs.readFileSync(f.receipt),receipt);
});
test('a corrupt or future completion receipt blocks adoption and preserves the original running material',t=>{
    const f=fixture(t);denyMetadata(t,f);f.store.commitCompletion(f.job);const receipt=JSON.parse(fs.readFileSync(f.receipt));receipt.version=99;fs.writeFileSync(f.receipt,JSON.stringify(receipt));const before=fs.readFileSync(f.receipt),loaded=f.store.loadCatalog();
    assert.equal(loaded.jobs[0].errorCode,'MESH_METADATA_COMPLETION_INVALID');assert.equal(loaded.jobs[0].state,'failed');assert.deepEqual(fs.readFileSync(f.file),f.before);assert.deepEqual(fs.readFileSync(f.receipt),before);
});
test('an explicit deleted tombstone wins over the old receipt after incomplete directory cleanup',t=>{
    const f=fixture(t);f.store.commitCompletion(f.job);const remove=fs.rmSync;t.mock.method(fs,'rmSync',(file,options)=>{if(file===f.store.directory(f.job)&&options?.recursive)throw Object.assign(Error('Retained cleanup'),{code:'EBUSY'});return remove(file,options);});
    assert.throws(()=>f.store.remove(f.job),{code:'EBUSY'});assert.ok(fs.existsSync(f.receipt));const loaded=f.store.loadCatalog();assert.deepEqual(loaded.jobs,[]);assert.equal(loaded.stats.deleted,1);
});
test('an existing different receipt is never overwritten by a later completion attempt',t=>{
    const f=fixture(t);f.store.commitCompletion(f.job);const before=fs.readFileSync(f.receipt);assert.throws(()=>f.store.commitCompletion({...f.job,artifact:{result:digest('changed')}}),{code:'MESH_METADATA_COMPLETION_CONFLICT'});assert.deepEqual(fs.readFileSync(f.receipt),before);
});

test('a hard-linked receipt remains untrusted and is never adopted or rewritten',t=>{
    const f=fixture(t);denyMetadata(t,f);f.store.commitCompletion(f.job);const bytes=fs.readFileSync(f.receipt),alias=path.join(f.root,'receipt-alias');fs.linkSync(f.receipt,alias);const loaded=f.store.loadCatalog();assert.equal(loaded.jobs[0].errorCode,'MESH_METADATA_COMPLETION_INVALID');assert.deepEqual(fs.readFileSync(alias),bytes);assert.deepEqual(fs.readFileSync(f.file),f.before);
});
test('an existing receipt with an unknown publication basis cannot certify a repeated commit',t=>{
    const f=fixture(t);f.store.commitCompletion(f.job);const completion=JSON.parse(fs.readFileSync(f.receipt));completion.basis='unknown';fs.writeFileSync(f.receipt,JSON.stringify(completion));const bytes=fs.readFileSync(f.receipt);assert.throws(()=>f.store.commitCompletion(f.job),{code:'MESH_METADATA_COMPLETION_INVALID'});assert.deepEqual(fs.readFileSync(f.receipt),bytes);
});
test('reading a valid receipt cannot override metadata changed during the same catalog observation',t=>{
    const f=fixture(t);denyMetadata(t,f);f.store.commitCompletion(f.job);const read=fs.readSync;let changed=false;
    t.mock.method(fs,'readSync',(...args)=>{const count=read(...args);if(!changed&&count>0){changed=true;fs.writeFileSync(f.file,JSON.stringify({...JSON.parse(f.before),state:'cancelled'}));}return count;});
    const loaded=f.store.loadCatalog();assert.equal(loaded.jobs[0].state,'failed');assert.ok(['MESH_METADATA_CORRUPT','MESH_METADATA_COMPLETION_CONFLICT'].includes(loaded.jobs[0].errorCode));assert.ok(fs.existsSync(f.receipt));
});
