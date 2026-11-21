import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {SourceCheckpointCatalog} from '../gateway/source-checkpoint-catalog.mjs';
import {SourceAuditService} from '../gateway/source-audit-service.mjs';
import {readManagedStepSource,STEP_SOURCE_ALGORITHM} from '../gateway/step-source-integrity.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-source-catalog-中文-'));t.after(()=>{assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));return file;};
  const snapshot=(id,n=1)=>{const name=`state-1-1-${n}.xbf`,file=write(`history/${id}/${name}`,'BINFILE snapshot '+id+n);return {file,name,checksum:sha(fs.readFileSync(file))};};
  const manifest=(id,current,undo=[],redo=[])=>write(`history/${id}/manifest.json`,{version:2,documentId:id,current:current.name,undo:undo.map(item=>item.name),redo:redo.map(item=>item.name),checksums:Object.fromEntries([current,...undo,...redo].map(item=>[item.name,item.checksum]))});
  return {root,write,snapshot,manifest,catalog:new SourceCheckpointCatalog({dataDir:root})};
}

test('project discovery reads the durable manifest including missing Undo, never a repaired in-memory list',async t=>{
  const f=fixture(t),current=f.snapshot('A'),old=f.snapshot('A',2);f.manifest('A',current,[old]);fs.rmSync(old.file);
  const before=fs.readFileSync(path.join(f.root,'history/A/manifest.json')),plan=await f.catalog.project('A');assert.equal(plan.checkpoints.length,2);assert.equal(plan.checkpoints[1].file,old.file);assert.equal(plan.checkpoints[1].sha256,old.checksum);assert.equal(plan.issues.length,0);assert.deepEqual(fs.readFileSync(path.join(f.root,'history/A/manifest.json')),before);
});

test('storage discovery includes shared project sources, quarantine, retained snapshots and recovery journals',async t=>{
  const f=fixture(t),a=f.snapshot('A'),b=f.snapshot('B');f.manifest('A',a);f.manifest('B',b);
  const source=f.write('imports/shared.step','ISO-10303-21; original'),actual=readManagedStepSource(source,f.root),reference={featureId:'feature-1',sourcePath:source,sourceFingerprint:actual.fingerprint,sourceFingerprintAlgorithm:STEP_SOURCE_ALGORITHM};
  const quarantineBytes=fs.readFileSync(a.file);f.write(`history-quarantine/A/${a.name}-${sha(quarantineBytes)}.corrupt`,quarantineBytes);
  f.write('project-assets/A-ABC123/model.xbf',quarantineBytes);f.write('imports/unclassified.step','retained source');
  const rollback=f.write('project-transactions/rollback-A-11111111-1111-1111-1111-111111111111.xbf',quarantineBytes);
  f.write('project-transactions/A.pending.json',{version:1,phase:'prepared',documentId:'A',rollbackPath:rollback,beforeHistory:{current:a.file,undo:[],redo:[]}});
  const plan=await f.catalog.storage();assert.ok(plan.checkpoints.some(item=>item.scope==='quarantine'&&item.sha256===sha(quarantineBytes)));assert.ok(plan.checkpoints.some(item=>item.file===rollback&&item.scope==='recovery'));assert.ok(plan.checkpoints.some(item=>item.scope==='retained'));assert.equal(plan.looseSources.length,2);
  const service=new SourceAuditService({dataDir:f.root,scope:'storage',capture:()=>f.catalog.storage(),inspector:{inspect:async()=>({metadataComplete:true,sources:[reference]})}});t.after(()=>service.close());
  const job=service.start('@storage');await service.jobs.get(job.jobId).promise;const report=service.get('@storage'),row=report.assets.find(item=>item.fileName==='shared.step');
  assert.equal(report.scope,'storage');assert.equal(row.currentReferences,2);assert.ok(row.recoveryReferences>=2);assert.equal(row.quarantineReferences,1);assert.equal(row.retainedReferences,1);assert.deepEqual(row.projects,['A','B']);assert.equal(row.projectCount,2);assert.equal(report.assets.find(item=>item.fileName==='unclassified.step').status,'unreferenced');assert.equal(report.cleanupAvailable,false);assert.equal(JSON.stringify(report).includes(f.root),false);
  assert.equal(report.coverageComplete,false,'Uncertified archival artifacts must not be silently certified');
  f.write('imports/new.step','new retained source');assert.equal(service.get('@storage').stale,true);
});

test('version-two recovery backups retain their own checkpoint proof and cannot point outside storage',async t=>{
  const f=fixture(t),a=f.snapshot('A');f.manifest('A',a);const backupName='A-11111111-1111-1111-1111-111111111111.manifest.json',bytes=fs.readFileSync(path.join(f.root,'history/A/manifest.json'));f.write('document-transactions/'+backupName,bytes);
  f.write('document-transactions/A.pending.json',{version:2,phase:'prepared',documentId:'A',beforeManifest:{file:backupName,bytes:bytes.length,sha256:sha(bytes)}});
  let plan=await f.catalog.storage();assert.equal(plan.checkpoints.find(item=>item.scope==='recovery').sha256,a.checksum);assert.equal(plan.issues.length,0);
  f.write('document-transactions/A.pending.json',{version:2,phase:'prepared',documentId:'A',beforeManifest:{file:'../private.json',bytes:1,sha256:'a'.repeat(64)}});plan=await f.catalog.storage();assert.ok(plan.issues.some(issue=>issue.code==='SOURCE_RECOVERY_INVALID'));
});

test('v2 package-open recovery carries the exact rollback checksum and terminal cleanup does not invent missing recovery roots',async t=>{
  const f=fixture(t),old=f.snapshot('A'),current=f.snapshot('A',2),content=Buffer.alloc(64,65),rollback=f.write('project-transactions/rollback-A-11111111-1111-1111-1111-111111111111.xbf',content);
  f.manifest('A',current);const journal={version:2,documentId:'A',phase:'prepared',rollbackPath:rollback,rollbackProof:{bytes:content.length,sha256:sha(content)},beforeHistory:{current:old.file,undo:[],redo:[]}};
  f.write('project-transactions/A.pending.json',journal);let plan=await f.catalog.storage();assert.equal(plan.issues.length,0);assert.equal(plan.checkpoints.find(item=>item.file===rollback).sha256,sha(content));assert.ok(plan.checkpoints.some(item=>item.file===old.file&&item.scope==='recovery'));
  fs.rmSync(old.file);fs.rmSync(rollback);
  for(const phase of ['committed','rolled-back']){f.write('project-transactions/A.pending.json',{...journal,phase});plan=await f.catalog.storage();assert.equal(plan.issues.length,0);assert.equal(plan.checkpoints.some(item=>item.file===old.file||item.file===rollback),false);assert.ok(plan.checkpoints.some(item=>item.file===current.file));}
});

test('package-open v2 checksum declarations and unexpected generic transaction phases are not silently trusted',async t=>{
  const f=fixture(t),a=f.snapshot('A');f.manifest('A',a);const rollback=f.write('project-transactions/rollback-A-11111111-1111-1111-1111-111111111111.xbf',Buffer.alloc(64));
  f.write('project-transactions/A.pending.json',{version:2,documentId:'A',phase:'prepared',rollbackPath:rollback,rollbackProof:{bytes:64,sha256:'invalid'},beforeHistory:{current:a.file,undo:[],redo:[]}});
  let plan=await f.catalog.storage();assert.ok(plan.issues.some(issue=>issue.code==='SOURCE_RECOVERY_INVALID'));
  f.write('document-transactions/A.pending.json',{version:1,documentId:'A',phase:'rolled-back',beforeHistory:{current:a.file,undo:[],redo:[]}});plan=await f.catalog.storage();assert.ok(plan.issues.filter(issue=>issue.code==='SOURCE_RECOVERY_INVALID').length>=2);
});

test('malformed manifests, journal path escapes and directory links are reported without outside reads',async t=>{
  const f=fixture(t),a=f.snapshot('A');f.write('history/A/manifest.json','{malformed');
  f.write('project-transactions/A.pending.json',{version:1,phase:'prepared',documentId:'A',beforeHistory:{current:path.join(f.root,'outside.xbf'),undo:[],redo:[]}});
  const target=f.write('outside/secret.step','private'),link=path.join(f.root,'imports');fs.symlinkSync(path.dirname(target),link,'junction');
  try{const plan=await f.catalog.storage();assert.equal(plan.looseSources.length,0);assert.ok(plan.issues.length>=3);assert.ok(plan.checkpoints.some(item=>item.file===a.file&&item.scope==='retained'));assert.equal(plan.checkpoints.some(item=>item.file.endsWith('outside.xbf')),false);}finally{fs.unlinkSync(link);}
});

test('discovery budgets and pre-cancelled scans are explicit, with no hidden partial success',async t=>{
  const f=fixture(t),a=f.snapshot('A');f.manifest('A',a);
  for(const limits of [{maxEntries:1},{maxSnapshotBytes:1},{maxCheckpoints:0},{maxMetadataBytes:1}])await assert.rejects(new SourceCheckpointCatalog({dataDir:f.root,...limits}).storage(),error=>error.code==='SOURCE_AUDIT_LIMIT');
  const controller=new AbortController();controller.abort();await assert.rejects(f.catalog.storage({signal:controller.signal}),error=>error.code==='SOURCE_AUDIT_CANCELLED');
  for(let index=0;index<120;index++)f.write(`imports/retained-${index}.step`,'retained');
  const midScan=new AbortController();await assert.rejects(f.catalog.storage({signal:midScan.signal,onProgress:({entries})=>{if(entries>=100)midScan.abort();}}),error=>error.code==='SOURCE_AUDIT_CANCELLED');
});
