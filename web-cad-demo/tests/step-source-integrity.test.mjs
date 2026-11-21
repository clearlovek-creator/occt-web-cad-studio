import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {hashManagedStepSource,readManagedStepSource,verifyStepSource,managedStepPath,STEP_SOURCE_ALGORITHM} from '../gateway/step-source-integrity.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function proof(bytes){let state='webcad-step-sha256-chain-1m-v1',index=0;for(let offset=0;offset<bytes.length;offset+=1024*1024)state=hash(state+':'+index+++':'+hash(bytes.subarray(offset,offset+1024*1024)));return hash(state+':'+bytes.length);}
function fixture(t,bytes=Buffer.from('ISO-10303-21;')){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-step-proof-'));fs.mkdirSync(path.join(root,'imports'));const file=path.join(root,'imports','来源.step');fs.writeFileSync(file,bytes);t.after(()=>{assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});return{root,file};}
test('source fingerprint matches fixed native 1 MiB blocks and ordinary file SHA256',t=>{
  for(const size of [0,1,1024*1024-1,1024*1024,1024*1024+1,2*1024*1024+7]){const bytes=Buffer.alloc(size,87),f=fixture(t,bytes),read=readManagedStepSource(f.file,f.root);assert.equal(read.fingerprint,proof(bytes));assert.equal(read.sha256,hash(bytes));assert.deepEqual(read.bytes,bytes);assert.equal(readManagedStepSource(f.file,f.root,{retainBytes:false}).bytes,undefined);}
});
test('short OS reads cannot change block boundaries or create a false mismatch',t=>{
  const bytes=Buffer.alloc(1024*1024+9,9),f=fixture(t,bytes),read=fs.readSync;fs.readSync=(fd,buffer,offset,length,position)=>read(fd,buffer,offset,Math.min(length,8191),position);
  try{assert.equal(readManagedStepSource(f.file,f.root).fingerprint,proof(bytes));}finally{fs.readSync=read;}
});

test('asynchronous audit hashing matches native blocks, yields to the event loop and does not retain source bytes',async t=>{
  for(const size of [0,1,1024*1024-1,1024*1024,1024*1024+1,2*1024*1024+7]){
    const bytes=Buffer.alloc(size,87),f=fixture(t,bytes);let yielded=false;setImmediate(()=>yielded=true);
    const result=await hashManagedStepSource(f.file,f.root);assert.equal(result.fingerprint,proof(bytes));assert.equal(result.sha256,hash(bytes));assert.equal(result.bytes,undefined);assert.equal(yielded,true);assert.equal(typeof result.stamp,'string');
  }
});

test('a source audit can cancel within a large file and still closes its file handle',async t=>{
  const f=fixture(t,Buffer.alloc(3*1024*1024,9)),controller=new AbortController(),open=fs.promises.open;let reads=0,closed=false;
  fs.promises.open=async(...args)=>{const handle=await open(...args),read=handle.read.bind(handle),close=handle.close.bind(handle);handle.read=async(...args)=>{const result=await read(...args);reads++;controller.abort();return result;};handle.close=async()=>{closed=true;return close();};return handle;};
  try{await assert.rejects(hashManagedStepSource(f.file,f.root,{signal:controller.signal}),error=>error.code==='SOURCE_INSPECTION_INTERRUPTED');assert.equal(reads,1);assert.equal(closed,true);}finally{fs.promises.open=open;}
  await assert.rejects(hashManagedStepSource(f.file,f.root,{maxBytes:1}),error=>error.code==='PROJECT_TOO_LARGE');
});
test('changed and unsupported source proofs fail; legacy sources remain explicitly unverified',t=>{
  const f=fixture(t),actual=readManagedStepSource(f.file,f.root),reference={sourceFingerprint:actual.fingerprint,sourceFingerprintAlgorithm:STEP_SOURCE_ALGORITHM};assert.equal(verifyStepSource(reference,actual),'verified');assert.equal(verifyStepSource({},actual),'legacy-unverified');
  for(const changed of [{...reference,sourceFingerprint:'0'.repeat(64)},{...reference,sourceFingerprintAlgorithm:'unknown'},{sourceFingerprint:actual.fingerprint}])assert.throws(()=>verifyStepSource(changed,actual),error=>['PROJECT_SOURCE_CHANGED','PROJECT_SOURCE_PROOF_INVALID'].includes(error.code));
  assert.throws(()=>verifyStepSource({decompositionVersion:2},actual),error=>error.code==='PROJECT_SOURCE_PROOF_INVALID');assert.equal(verifyStepSource({decompositionVersion:1},actual),'legacy-unverified');
});
test('external files, symbolic paths and hard links are never read as managed STEP assets',t=>{
  const f=fixture(t),outside=path.join(f.root,'private.step');fs.writeFileSync(outside,'private');assert.throws(()=>managedStepPath(outside,f.root),error=>error.code==='PROJECT_SOURCE_UNTRUSTED');
  const linked=path.join(f.root,'imports','linked.step');fs.linkSync(outside,linked);assert.throws(()=>readManagedStepSource(linked,f.root),error=>error.code==='PROJECT_SOURCE_UNTRUSTED');fs.rmSync(linked);
  const directory=path.join(f.root,'project-assets');fs.symlinkSync(path.dirname(outside),directory,process.platform==='win32'?'junction':'dir');assert.throws(()=>readManagedStepSource(path.join(directory,'private.step'),f.root),error=>error.code==='PROJECT_SOURCE_UNTRUSTED');fs.unlinkSync(directory);
});
test('budget checks happen before opening content and missing files have an actionable code',t=>{
  const f=fixture(t);assert.throws(()=>readManagedStepSource(f.file,f.root,{maxBytes:1}),error=>error.code==='PROJECT_TOO_LARGE');fs.rmSync(f.file);assert.throws(()=>readManagedStepSource(f.file,f.root),error=>error.code==='PROJECT_SOURCE_MISSING');
});
test('source bytes changed during reading cannot be returned or silently certified',t=>{
  const f=fixture(t),read=fs.readSync;let changed=false;fs.readSync=(...args)=>{const count=read(...args);if(!changed){changed=true;fs.appendFileSync(f.file,'changed');}return count;};
  try{assert.throws(()=>readManagedStepSource(f.file,f.root),error=>error.code==='PROJECT_SOURCE_CHANGED');}finally{fs.readSync=read;}
});
