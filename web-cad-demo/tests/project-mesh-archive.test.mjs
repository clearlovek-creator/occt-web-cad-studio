import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {captureProjectMeshArchive,validateProjectMeshArchive,stageProjectMeshArchive} from '../gateway/project-mesh-archive.mjs';
import {archiveFixture,copyArchive,replaceArchiveRole} from './helpers/project-mesh-archive-fixture.mjs';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const files=directory=>Object.fromEntries(fs.readdirSync(directory).filter(name=>fs.statSync(path.join(directory,name)).isFile()).map(name=>[name,sha(fs.readFileSync(path.join(directory,name)))]));

test('portable raw mesh archive preserves exact original records and source/material/partition/result bytes',t=>{
  const f=archiveFixture(t),before=files(f.store.directory(f.job)),archive=f.capture(),checked=validateProjectMeshArchive(archive);assert.equal(checked.jobs[0].state,'complete');assert.deepEqual(Object.keys(archive.assets[0].files).sort(),['completion','discreteSource','metadata','partition','result']);assert.ok(checked.bytes>0);assert.equal(checked.expandedBytes,checked.bytes);assert.equal(JSON.stringify(checked.manifest).includes(f.root),false);assert.deepEqual(files(f.store.directory(f.job)),before);
});
test('staging independently revalidates a raw tetra mesh without inventing normal admission or rewriting source identities',t=>{
  const f=archiveFixture(t),archive=f.capture(),stage=stageProjectMeshArchive(archive,f.root);try{assert.equal(stage.jobs[0].jobId,f.job.jobId);assert.equal(stage.jobs[0].source.documentId,'doc');assert.equal(stage.summaries[0].normalMeshAdmitted,false);assert.equal(stage.summaries[0].defaultVisible,false);assert.deepEqual(files(stage.store.directory(stage.jobs[0])),files(f.store.directory(f.job)));}finally{stage.cleanup();stage.cleanup();}assert.equal(fs.existsSync(stage.directory),false);
});
test('complete derived set reauthenticates all exact bytes and multi-owner material membership without remeshing',t=>{
  const f=archiveFixture(t,{derived:true,materials:['Copper','Copper']}),archive=f.capture(),before=files(f.store.directory(f.job)),stage=stageProjectMeshArchive(archive,f.root);try{assert.equal(stage.summaries[0].normalMeshAdmitted,true);assert.equal(stage.summaries[0].hasDerived,true);const result=stage.store.readResult(stage.jobs[0]);assert.equal(result.mesh.render.groups.length,2);assert.equal(result.derivedMaterialSource.materials[0].name,'Copper');assert.equal(result.mesh.render.groups[0].wireKey,result.mesh.render.groups[1].wireKey);assert.deepEqual(files(stage.store.derivedDirectory(stage.jobs[0])),files(f.store.derivedDirectory(f.job)));}finally{stage.cleanup();}assert.deepEqual(files(f.store.directory(f.job)),before);
});
test('interrupted source and partition remain diagnostic assets and are not automatically completed',t=>{
  const f=archiveFixture(t,{state:'interrupted'}),stage=stageProjectMeshArchive(f.capture(),f.root);try{assert.equal(stage.jobs[0].state,'interrupted');assert.equal(stage.summaries[0].hasResult,false);assert.equal(fs.existsSync(path.join(stage.store.directory(stage.jobs[0]),'completion.json')),false);}finally{stage.cleanup();}
});
test('active, deleting, discarding and in-flight derivation states refuse a mixed engineering backup',t=>{
  const f=archiveFixture(t);for(const patch of [{state:'running'},{state:'queued'},{state:'cancelling'},{deleting:true},{discardingDerived:true},{derivationAttempt:{state:'working'}}])assert.throws(()=>captureProjectMeshArchive({store:f.store,documentId:'doc',source:f.f.source,jobs:[{...f.job,...patch}]}),{code:'PROJECT_MESH_ARCHIVE_BUSY'});assert.equal(f.job.state,'complete');
});
test('capture is fenced at both ends and changed files or newly published roles invalidate the snapshot',t=>{
  const f=archiveFixture(t);let calls=0;assert.throws(()=>captureProjectMeshArchive({store:f.store,documentId:'doc',source:f.f.source,jobs:[f.job],assertIdle:()=>{if(++calls===2)fs.appendFileSync(f.store.tetraFile(f.job,'partition'),' ');}}),{code:'PROJECT_MESH_ARCHIVE_CHANGED'});assert.equal(calls,2);
});
test('small budgets refuse without truncation; duplicate references count their expanded physical size',t=>{
  const f=archiveFixture(t),archive=f.capture(),checked=validateProjectMeshArchive(archive);
  assert.throws(()=>captureProjectMeshArchive({store:f.store,documentId:'doc',source:f.f.source,jobs:[f.job]},{policy:{maxBytes:1}}),{code:'PROJECT_MESH_ARCHIVE_LIMIT'});
  assert.throws(()=>validateProjectMeshArchive(archive,{policy:{maxBytes:checked.bytes-1}}),{code:'PROJECT_MESH_ARCHIVE_LIMIT'});
  const duplicate=copyArchive(archive);duplicate.assets.push(structuredClone(duplicate.assets[0]));assert.throws(()=>validateProjectMeshArchive(duplicate),/任务身份/);
  duplicate.assets[1].jobId='mesh-'+crypto.randomUUID();assert.throws(()=>validateProjectMeshArchive(duplicate,{policy:{maxBytes:checked.bytes}}),{code:'PROJECT_MESH_ARCHIVE_LIMIT'});
});
test('unknown roles, traversal names, duplicate jobs, foreign records and unreferenced blobs never grant file access',t=>{
  const f=archiveFixture(t),original=f.capture();for(const change of [a=>a.assets[0].files['../outside']=a.assets[0].files.metadata,a=>a.assets[0].jobId='../../outside',a=>a.assets[0].files={metadata:a.assets[0].files.metadata},a=>a.assets.push(structuredClone(a.assets[0])),a=>a.source.documentId='other',a=>a.blobs.push({...a.blobs[0]})]){const archive=copyArchive(original);change(archive);assert.throws(()=>validateProjectMeshArchive(archive));}
  const archive=copyArchive(original),data=Buffer.from('unreferenced');archive.blobs.push({sha256:sha(data),bytes:data.length,data});assert.throws(()=>validateProjectMeshArchive(archive),/未引用/);
});
test('missing, changed, shared and resizable data blobs fail before a staging directory is created',t=>{
  const f=archiveFixture(t),original=f.capture();for(const change of [a=>a.blobs.pop(),a=>a.blobs[0].data[0]^=1,a=>a.blobs[0].bytes++,a=>a.blobs[0].data=Buffer.from(new SharedArrayBuffer(a.blobs[0].bytes))]){const archive=copyArchive(original);change(archive);const before=fs.readdirSync(f.root);assert.throws(()=>stageProjectMeshArchive(archive,f.root));assert.deepEqual(fs.readdirSync(f.root),before);}
});
test('a repaired outer hash cannot turn tampered tetra coordinates into a certified portable asset',t=>{
  const f=archiveFixture(t),archive=copyArchive(f.capture()),proof=replaceArchiveRole(archive,'result',value=>{value.discreteTetra.value.output.points[0][0]+=100;return value;});
  const completion=archive.assets[0].files.completion;delete archive.assets[0].files.completion;archive.blobs=archive.blobs.filter(blob=>blob.sha256!==completion);replaceArchiveRole(archive,'metadata',value=>{value.artifact.result=proof;return value;});validateProjectMeshArchive(archive);const before=fs.readdirSync(f.root);assert.throws(()=>stageProjectMeshArchive(archive,f.root));assert.deepEqual(fs.readdirSync(f.root),before);
});
test('derived files and their own manifest may not mutually certify a fabricated result',t=>{
  const f=archiveFixture(t,{derived:true}),archive=copyArchive(f.capture()),proof=replaceArchiveRole(archive,'derivedResult',value=>{value.mesh.nodeCount++;return value;});replaceArchiveRole(archive,'derivedManifest',value=>{value.files.result=proof;return value;});validateProjectMeshArchive(archive);assert.throws(()=>stageProjectMeshArchive(archive,f.root),{code:'MESH_DERIVED_ARTIFACT_INVALID'});
});
test('source metadata field ordering is not confused with a different engineering source',t=>{
  const f=archiveFixture(t),archive=f.capture();archive.source=Object.fromEntries(Object.entries(archive.source).reverse());archive.source.bodies[0]=Object.fromEntries(Object.entries(archive.source.bodies[0]).reverse());assert.equal(validateProjectMeshArchive(archive).jobs.length,1);
});
test('original metadata and completion identities are read-only and restored-completion evidence is retained',t=>{
  const f=archiveFixture(t),metadata=path.join(f.store.directory(f.job),'metadata.json'),completion=JSON.parse(fs.readFileSync(path.join(f.store.directory(f.job),'completion.json')));assert.ok(completion.record);const before=fs.readFileSync(metadata);assert.equal(f.store.readPersisted(f.job).record.state,'complete');f.capture();assert.deepEqual(fs.readFileSync(metadata),before);
});
test('ordinary legacy output locators remain provenance only and cannot read a file outside the archive root',t=>{
  const f=archiveFixture(t),job={version:1,jobId:'mesh-'+crypto.randomUUID(),documentId:'doc',kind:'mesh',state:'running',source:f.f.source,options:{repairMode:'strict',qualityThreshold:.2},createdAt:'2026-11-18T00:00:00Z',artifact:{}};
  f.store.save(job);fs.mkdirSync(path.dirname(f.store.output(job)),{recursive:true});fs.writeFileSync(f.store.output(job),'legacy MSH bytes');const result={ok:true,protocolVersion:1,requestId:job.jobId,mesh:{dimension:3,nodeCount:4,elementCount:1,outputPath:f.store.output(job)}};Object.assign(job.artifact,f.store.writeResult(job,result));job.state='complete';job.finishedAt='2026-11-18T00:00:02Z';f.store.commitCompletion(job);
  const archive=captureProjectMeshArchive({store:f.store,documentId:'doc',source:f.f.source,jobs:[job]}),before=fs.readFileSync(f.store.output(job)),stage=stageProjectMeshArchive(archive,f.root);try{assert.equal(stage.summaries[0].normalMeshAdmitted,false);assert.deepEqual(fs.readFileSync(stage.store.output(stage.jobs[0])),before);assert.notEqual(stage.store.output(stage.jobs[0]),result.mesh.outputPath);assert.equal(stage.store.readResult(stage.jobs[0]).mesh.outputPath,result.mesh.outputPath);}finally{stage.cleanup();}assert.deepEqual(fs.readFileSync(f.store.output(job)),before);
});
test('linked source directories and hardlinked original files are refused without following them',t=>{
  const f=archiveFixture(t),metadata=path.join(f.store.directory(f.job),'metadata.json'),link=path.join(f.root,'metadata-hardlink');fs.linkSync(metadata,link);try{assert.throws(()=>f.capture(),/普通文件|类型/);}finally{fs.unlinkSync(link);}
  const outside=path.join(f.root,'outside');fs.mkdirSync(outside);const linked=path.join(f.root,'linked');fs.symlinkSync(outside,linked,process.platform==='win32'?'junction':'dir');const nested=new MeshJobStore(outside);assert.equal(fs.existsSync(nested.root),true);try{assert.throws(()=>stageProjectMeshArchive(f.capture(),linked),/链接/);}finally{assert.equal(fs.lstatSync(linked).isSymbolicLink(),true);fs.unlinkSync(linked);}
});
