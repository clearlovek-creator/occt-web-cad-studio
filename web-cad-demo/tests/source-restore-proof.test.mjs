import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {SourceCheckpointCatalog} from '../gateway/source-checkpoint-catalog.mjs';
import {SourceRestoreProof} from '../gateway/source-restore-proof.mjs';
import {hashRestorationStepSource} from '../gateway/step-source-integrity.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cad-restore-proof-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const write=(name,value)=>{const file=path.join(dataDir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));return file;};
  const candidatePath=write('source-restores/test/candidate.step','original STEP bytes'),candidate=await hashRestorationStepSource(candidatePath,dataDir),target=path.join(dataDir,'imports','missing.step');
  const references=new Map(),calls=[];
  const snapshot=(id,n=1,extra={})=>{const name=`state-1-1-${n}.xbf`,file=write(`history/${id}/${name}`,'BINFILE '+id+n),checksum=sha(fs.readFileSync(file));references.set(file,[{featureId:'feature-1',sourcePath:target,sourceFingerprint:candidate.fingerprint,sourceFingerprintAlgorithm:candidate.algorithm,decompositionVersion:2,...extra}]);return {file,name,checksum};};
  const manifest=(id,current,undo=[])=>write(`history/${id}/manifest.json`,{version:2,documentId:id,current:current.name,undo:undo.map(item=>item.name),redo:[],checksums:Object.fromEntries([current,...undo].map(item=>[item.name,item.checksum]))});
  const inspector={inspect:async(file,{expectedSha256})=>{calls.push(file);assert.ok(fs.existsSync(file),'No loader may hide a missing snapshot');const snapshotSha256=sha(fs.readFileSync(file));if(expectedSha256&&expectedSha256!==snapshotSha256)throw Object.assign(Error('checksum'),{code:'SOURCE_SNAPSHOT_CHECKSUM'});return {metadataComplete:true,snapshotSha256,sources:references.get(file)||[]};}};
  const catalog=new SourceCheckpointCatalog({dataDir}),proof=new SourceRestoreProof({dataDir,catalog,inspector});return {dataDir,write,candidatePath,candidate,target,references,calls,snapshot,manifest,catalog,inspector,proof};
}

test('restoration proves all shared current/Undo/recovery/quarantine references without loading or changing a document',async t=>{
  const f=await fixture(t),a=f.snapshot('A'),old=f.snapshot('A',2),b=f.snapshot('B');f.manifest('A',a,[old]);f.manifest('B',b);
  const retained=f.write('project-assets/A-ABC123/model.xbf','BINFILE archive');f.references.set(retained,f.references.get(a.file));
  const quarantine=f.write(`history-quarantine/A/${a.name}-${a.checksum}.corrupt`,fs.readFileSync(a.file,'utf8'));f.references.set(quarantine,f.references.get(a.file));
  const manifest=fs.readFileSync(path.join(f.dataDir,'history/A/manifest.json'),'utf8'),backupName='A-11111111-1111-1111-1111-111111111111.manifest.json';f.write('document-transactions/'+backupName,manifest);
  f.write('document-transactions/A.pending.json',{version:2,documentId:'A',phase:'prepared',beforeManifest:{file:backupName,bytes:Buffer.byteLength(manifest),sha256:sha(manifest)}});
  const before=fs.readFileSync(path.join(f.dataDir,'history/A/manifest.json')),result=await f.proof.validate(f.target,f.candidate);
  assert.deepEqual(result.projects,['A','B']);assert.equal(result.referenceCount,7);assert.ok(result.references.some(item=>item.scope==='quarantine'));assert.ok(result.references.some(item=>item.scope==='retained'));assert.ok(result.references.some(item=>item.scope==='recovery'));assert.equal(new Set(f.calls).size,f.calls.length,'Inspect each physical checkpoint only once');assert.equal(fs.existsSync(f.target),false);assert.deepEqual(fs.readFileSync(path.join(f.dataDir,'history/A/manifest.json')),before);
  const second=await f.proof.validate(f.target,f.candidate);assert.equal(second.signature,result.signature);
  f.references.get(b.file)[0].featureId='feature-new';assert.notEqual((await f.proof.validate(f.target,f.candidate)).signature,result.signature);
});

test('one disagreeing or legacy Undo reference prevents restoring a matching current source',async t=>{
  const f=await fixture(t),a=f.snapshot('A'),old=f.snapshot('A',2);f.manifest('A',a,[old]);
  f.references.get(old.file)[0].sourceFingerprint='a'.repeat(64);await assert.rejects(f.proof.validate(f.target,f.candidate),{code:'SOURCE_RESTORE_CONFLICT'});
  delete f.references.get(old.file)[0].sourceFingerprint;delete f.references.get(old.file)[0].sourceFingerprintAlgorithm;f.references.get(old.file)[0].decompositionVersion=1;await assert.rejects(f.proof.validate(f.target,f.candidate),{code:'SOURCE_RESTORE_PROOF_MISSING'});
  f.references.get(old.file)[0].decompositionVersion=2;await assert.rejects(f.proof.validate(f.target,f.candidate),{code:'SOURCE_RESTORE_PROOF_MISSING'});
});

test('unreadable materials, unresolved private references and uncertified-only archives cannot authorize replacement',async t=>{
  const f=await fixture(t),a=f.snapshot('A');f.manifest('A',a);
  f.inspector.inspect=async()=>({metadataComplete:false,sources:[]});await assert.rejects(f.proof.validate(f.target,f.candidate),{code:'SOURCE_RESTORE_COVERAGE_INCOMPLETE'});
  f.inspector.inspect=async()=>({metadataComplete:true,snapshotSha256:a.checksum,sources:[{...f.references.get(a.file)[0],sourcePath:f.candidatePath}]});await assert.rejects(f.proof.validate(f.target,f.candidate),{code:'SOURCE_RESTORE_COVERAGE_INCOMPLETE'});
  f.inspector.inspect=async()=>({metadataComplete:true,snapshotSha256:a.checksum,sources:f.references.get(a.file)});fs.rmSync(path.join(f.dataDir,'history/A/manifest.json'));await assert.rejects(f.proof.validate(f.target,f.candidate),{code:'SOURCE_RESTORE_NO_ANCHOR'});
});

test('directory/manifest changes during proof collection invalidate it, while cancellation and limits release shared admission',async t=>{
  const f=await fixture(t),a=f.snapshot('A');f.manifest('A',a);let changed=false;
  await assert.rejects(f.proof.validate(f.target,f.candidate,{onProgress:({checkpoints})=>{if(checkpoints&&!changed){changed=true;f.write('imports/appeared.step','new file');}}}),{code:'SOURCE_RESTORE_STALE'});
  const signal=AbortSignal.abort();await assert.rejects(f.proof.validate(f.target,f.candidate,{signal}),{code:'SOURCE_RESTORE_CANCELLED'});assert.equal(f.proof.activeRegistry.size,0);
  f.proof.maxReferences=0;await assert.rejects(f.proof.validate(f.target,f.candidate),{code:'SOURCE_RESTORE_LIMIT'});assert.equal(f.proof.activeRegistry.size,0);
  f.proof.activeRegistry.add({});f.proof.activeRegistry.add({});await assert.rejects(f.proof.validate(f.target,f.candidate),{code:'SOURCE_AUDIT_BUSY'});
});
