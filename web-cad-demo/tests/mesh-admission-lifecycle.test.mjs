import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
import {ProjectMeshService} from '../gateway/project-mesh-service.mjs';
import {admissionFixture} from './helpers/mesh-admission-fixture.mjs';
import {stopTestChild} from './helpers/stop-test-child.mjs';

// Deliberate numeric/report fault injection. Real Gmsh geometry coverage is
// tested separately by mesh-industrial-corpus and mesh-preparation-integration.
function fixture(kind='accepted'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-admission-')),f=admissionFixture({threshold:kind==='warning'?.9:.2}),store=new MeshJobStore(root);
  const job={version:1,jobId:'mesh-'+crypto.randomUUID(),documentId:f.source.documentId,source:f.source,state:'complete',createdAt:new Date().toISOString(),options:{repairMode:'strict',qualityThreshold:f.index.threshold}};
  f.index.requestId=job.jobId;
  if(kind==='blocked'){f.index.cells[0].quality=-.8;f.index.cells[0].minJacobian=-1;Object.assign(f.mesh.quality,{minQuality:-.8,maxQuality:-.8,averageQuality:-.8,badCount:1,invertedCount:1});}
  if(kind==='warning')f.mesh.quality.badCount=1;
  if(kind==='unverified')delete f.mesh.sourceInventory;
  fs.mkdirSync(store.directory(job),{recursive:true});fs.mkdirSync(path.dirname(store.output(job)),{recursive:true});
  fs.writeFileSync(store.output(job),'$MeshFormat\n2.2 0 8\n$EndMeshFormat\n$Nodes\n4\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\n$EndNodes\n$Elements\n1\n1 4 2 1 1 1 2 3 4\n$EndElements\n');
  fs.writeFileSync(store.qualityOutput(job),JSON.stringify(f.index));
  f.mesh.outputPath=store.output(job);job.artifact=store.writeResult(job,{ok:true,requestId:job.jobId,mesh:f.mesh});
  job.meshSummary={dimension:3,nodeCount:4,elementCount:1,admission:f.mesh.admission};store.save(job);
  const options={dataDir:root,serializeDocument:async(_id,action)=>action(),command:async operation=>{assert.equal(operation,'document.summary');return {ok:true,documentId:job.documentId,revision:f.source.revision,bodyCount:1,bodyMetadata:structuredClone(f.source.bodies)};}};
  const service=new ProjectMeshService(options),key=`/api/mesh/jobs/${job.jobId}`;
  const cleanup=()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});};
  return {...f,root,job,store,service,options,key,cleanup};
}

test('blocked engineering admission retains complete diagnostic files and bad-cell localization while refusing normal use',async()=>{
  const f=fixture('blocked');try{
    const loaded=await f.service.handle('GET',f.key);assert.equal(loaded.payload.meshJob.state,'complete');assert.equal(loaded.payload.mesh.admission.status,'blocked');assert.equal(loaded.payload.meshJob.freshness.status,'current');
    const show=await f.service.handle('POST',f.key+'/visibility',{visible:true});assert.equal(show.status,409);assert.equal(show.payload.code,'MESH_ADMISSION_REQUIRED');
    assert.equal((await f.service.outputAccess(path.basename(f.mesh.outputPath))).payload.code,'MESH_ADMISSION_REQUIRED');
    const diagnostic=await f.service.outputAccess(path.basename(f.mesh.outputPath),true);assert.equal(diagnostic.status,200);assert.match(diagnostic.filename,/^diagnostic-/);assert.equal(diagnostic.headers['X-CAD-Mesh-Admission'],'blocked');
    const quality=await f.service.handle('GET',f.key+'/quality',{issue:'inverted'});assert.equal(quality.status,200);assert.equal(quality.payload.total,1);assert.equal(quality.payload.cells[0].inverted,true);assert.equal(quality.payload.cells[0].locatable,true);
    for(const file of [f.store.output(f.job),f.store.qualityOutput(f.job)])assert.ok(fs.existsSync(file));
    const restored=new ProjectMeshService(f.options),again=await restored.handle('GET',f.key);assert.equal(again.payload.mesh.admission.status,'blocked');assert.equal(again.payload.meshJob.visible,false);
  }finally{f.cleanup();}
});

test('accepted and advisory-warning meshes may be displayed and normally downloaded after verification',async()=>{
  for(const kind of ['accepted','warning']){const f=fixture(kind);try{
    const show=await f.service.handle('POST',f.key+'/visibility',{visible:true});assert.equal(show.status,200);assert.equal(show.payload.meshJob.visible,true);assert.equal(show.payload.meshJob.admission.status,kind);
    const access=await f.service.outputAccess(path.basename(f.mesh.outputPath));assert.equal(access.status,200);assert.equal(access.filename,path.basename(f.mesh.outputPath));assert.equal(access.headers['X-CAD-Mesh-Admission'],kind);
  }finally{f.cleanup();}}
});

test('legacy results remain diagnostic-only and serialized accepted flags never override a recomputed policy',async()=>{
  for(const kind of ['blocked','unverified']){const f=fixture(kind);try{
    const resultPath=path.join(f.store.directory(f.job),'result.json'),result=JSON.parse(fs.readFileSync(resultPath));result.mesh.admission={version:1,status:'accepted',usable:true};
    fs.writeFileSync(resultPath,JSON.stringify(result));f.job.artifact.result={bytes:fs.statSync(resultPath).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(resultPath)).digest('hex')};f.job.meshSummary.admission=result.mesh.admission;f.store.save(f.job);
    const restored=new ProjectMeshService(f.options);await restored.ready;const list=await restored.handle('GET','/api/documents/admission/mesh/jobs');assert.equal(list.payload.jobs[0].admission,null,'Unverified metadata cannot display accepted on restart');
    const loaded=await restored.handle('GET',f.key);assert.equal(loaded.payload.mesh.admission.status,kind);assert.equal((await restored.outputAccess(path.basename(f.mesh.outputPath))).status,409);
  }finally{f.cleanup();}}
});

test('corrupt blocked mesh artifacts are retained as evidence but even diagnostic download is refused',async()=>{
  const f=fixture('blocked');try{fs.appendFileSync(f.store.output(f.job),'damage');const access=await f.service.outputAccess(path.basename(f.mesh.outputPath),true);assert.equal(access.status,409);assert.equal(access.payload.code,'MESH_ARTIFACT_INVALID');assert.ok(fs.existsSync(f.store.output(f.job)));}finally{f.cleanup();}
});

test('query capacity, cancellation and resource failures never mark a valid original mesh as corrupt',async()=>{
  const f=fixture();try{
    for(const code of ['MESH_QUALITY_QUERY_BUSY','MESH_QUALITY_QUERY_LIMIT','MESH_QUALITY_QUERY_IO','MESH_QUALITY_CACHE_INVALID','MESH_QUALITY_QUERY_CANCELLED','MESH_QUALITY_QUERY_TIMEOUT','MESH_QUALITY_QUERY_CLOSED','MESH_QUALITY_CACHE_CAPACITY']){
      f.service.qualityQueries.query=async()=>{throw Object.assign(Error('read-only query stopped'),{code});};
      const response=await f.service.handle('GET',f.key+'/quality',{});assert.equal(response.status,code==='MESH_QUALITY_QUERY_CANCELLED'?499:503);assert.equal(response.payload.code,code);assert.equal(f.service.jobs.get(f.job.jobId).state,'complete');
    }
    assert.equal((await f.service.handle('GET',f.key)).payload.mesh.admission.status,'accepted');
  }finally{f.cleanup();}
});

test('numeric source corruption is distinguished from a disposable cache fault and remains preserved for diagnosis',async()=>{
  const f=fixture();try{const file=f.store.qualityOutput(f.job),bytes=fs.readFileSync(file);bytes[20]^=1;fs.writeFileSync(file,bytes);const response=await f.service.handle('GET',f.key+'/quality',{});assert.equal(response.status,409);assert.equal(response.payload.code,'MESH_ARTIFACT_INVALID');assert.equal(f.service.jobs.get(f.job.jobId).state,'failed');assert.deepEqual(fs.readFileSync(file),bytes);}finally{f.cleanup();}
});

test('an asynchronous quality report observes post-query geometry rather than certifying a stale pre-query view',async()=>{
  const f=fixture();let resolveQuery,arrive;const entered=new Promise(resolve=>arrive=resolve);try{
    const view={ok:true,documentId:f.job.documentId,revision:2,bodyMetadata:structuredClone(f.source.bodies)};
    f.service.command=async()=>structuredClone(view);f.service.qualityQueries.query=()=>new Promise(resolve=>{resolveQuery=resolve;arrive();});
    const reading=f.service.handle('GET',f.key+'/quality',{});await entered;view.revision=3;view.bodyMetadata[0].topologyIdentity='c'.repeat(32);resolveQuery({quality:{tetraCount:1},cells:[],total:0});
    const response=await reading;assert.equal(response.status,200);assert.equal(response.payload.meshJob.freshness.status,'stale');
  }finally{f.cleanup();}
});

test('a task deleted while a completed query waits for its final model observation cannot reappear in the response or on disk',async()=>{
  const f=fixture();let release,arrive;const entered=new Promise(resolve=>arrive=resolve),gate=new Promise(resolve=>release=resolve);try{
    f.service.qualityQueries.query=async()=>({quality:{tetraCount:1},cells:[],total:0});f.service.command=async()=>{arrive();await gate;return {ok:true,documentId:f.job.documentId,revision:2,bodyMetadata:f.source.bodies};};
    const reading=f.service.handle('GET',f.key+'/quality',{});await entered;assert.equal((await f.service.handle('DELETE',f.key)).status,200);release();const response=await reading;assert.equal(response.status,404);assert.equal(response.payload.code,'MESH_JOB_NOT_FOUND');assert.equal(fs.existsSync(f.store.directory(f.job)),false);
  }finally{release?.();f.cleanup();}
});

test('the real HTTP output route enforces admission and labels diagnostic attachment downloads',async()=>{
  const f=fixture('blocked'),server=net.createServer();let child;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
    child=spawn(process.execPath,['gateway/server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,GEOMETRY_PORT:String(port),GEOMETRY_DATA_DIR:f.root},windowsHide:true,stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{let diagnostic='';const timer=setTimeout(()=>reject(Error('Admission Gateway startup '+diagnostic)),15000);child.once('error',reject);child.stderr.on('data',chunk=>diagnostic+=chunk);child.stdout.on('data',chunk=>{if(String(chunk).includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
    const url=`http://127.0.0.1:${port}/api/mesh/outputs/${path.basename(f.mesh.outputPath)}`;
    const normal=await fetch(url);assert.equal(normal.status,409);assert.equal((await normal.json()).code,'MESH_ADMISSION_REQUIRED');
    const diagnostic=await fetch(url+'?diagnostic=1');assert.equal(diagnostic.status,200);assert.equal(diagnostic.headers.get('X-CAD-Mesh-Admission'),'blocked');assert.match(diagnostic.headers.get('Content-Disposition'),/diagnostic-mesh-/);assert.equal(await diagnostic.text(),fs.readFileSync(f.store.output(f.job),'utf8'));
  }finally{await stopTestChild(child);f.cleanup();}
});
