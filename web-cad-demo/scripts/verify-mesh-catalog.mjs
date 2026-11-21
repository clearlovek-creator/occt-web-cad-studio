/* Real HTTP/native recovery checks in an isolated data directory. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
import {gatedGeometryGateway} from '../tests/helpers/gated-geometry-gateway.mjs';
const root=path.resolve(import.meta.dirname,'..'),backend=selectBackendRelease(path.resolve(process.env.CAD_TEST_GATEWAY_RELEASE_ROOT||'.artifacts/mesh-catalog-backend-releases'));
const artifacts=path.resolve(process.env.MESH_CATALOG_ARTIFACTS||'.artifacts/mesh-catalog-real');assert.ok(artifacts.startsWith(path.join(root,'.artifacts')+path.sep)&&!fs.existsSync(artifacts));fs.mkdirSync(artifacts,{recursive:true});
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),checks=[],exits=[];let gateway;
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
const environment={CAD_TEST_GATEWAY_RELEASE_ROOT:path.dirname(backend.directory),CAD_TEST_GATEWAY_RELEASE_ID:backend.releaseId};
async function stop(){if(gateway){const code=await gateway.stop();assert.equal(code,0);exits.push(code);gateway=null;}}
try{
  const damaged=path.join(artifacts,'conflict-data'),store=new MeshJobStore(damaged),jobId='mesh-00000000-0000-4000-8000-000000000001';
  for(const documentId of ['one','two'])store.save({jobId,documentId,state:'queued',createdAt:'2026-11-17T00:00:00.000Z'});
  const files=['one','two'].map(documentId=>path.join(store.directory({jobId,documentId}),'metadata.json')),before=files.map(digest);
  gateway=await gatedGeometryGateway(damaged,environment);
  await check('real frozen Gateway reports an unavailable catalog with unknown capacity rather than zero',async()=>{
    const health=await gateway.until(async()=>{const h=await gateway.get('/health');return h.meshCatalog.state!=='recovering'&&h;},'Catalog recovery did not settle');
    assert.equal(health.meshCatalog.state,'unavailable');assert.equal(health.meshCatalog.code,'MESH_CATALOG_ID_CONFLICT');assert.equal(health.runtime.meshTaskCapacity.stored,null);assert.equal(health.backendRelease.releaseId,backend.releaseId);
  });
  await check('listing and new meshing refuse a conflicting catalog without returning an empty success',async()=>{
    const response=await fetch(gateway.api+'/documents/one/mesh/jobs');assert.equal(response.status,503);const list=await response.json();assert.equal(list.code,'MESH_CATALOG_ID_CONFLICT');assert.equal(list.jobs,undefined);
    const created=await gateway.post('/documents/one/mesh/jobs',{background:true});assert.equal(created.status,503);assert.equal(created.value.code,'MESH_CATALOG_ID_CONFLICT');
  });
  await check('catalog failure does not block unrelated real OCCT modeling or overwrite either project record',async()=>{
    const box=await gateway.cad('primitive.box',{width:2,depth:3,height:4});assert.ok(box.bodyId);assert.deepEqual(files.map(digest),before);const health=await gateway.get('/health');assert.equal(health.meshCatalog.state,'unavailable');
  });await stop();
  const normal=path.join(artifacts,'normal-data');fs.mkdirSync(normal);gateway=await gatedGeometryGateway(normal,environment);let meshId,sourceToken,meshHash,metadataFile;
  await check('the real empty catalog settles and a conforming native mesh is created normally',async()=>{
    const box=await gateway.cad('primitive.box',{width:2,depth:2,height:2});sourceToken=box.stateToken;
    const response=await gateway.post('/documents/default/mesh/jobs',{qualityThreshold:0});assert.equal(response.status,200,JSON.stringify(response.value));assert.equal(response.value.meshJob.state,'complete');assert.equal(response.value.meshJob.visible,false);meshId=response.value.meshJob.jobId;
    const store=new MeshJobStore(normal),identity={jobId:meshId,documentId:'default'};meshHash=digest(store.output(identity));metadataFile=path.join(store.directory(identity),'metadata.json');assert.equal(JSON.parse(fs.readFileSync(metadataFile)).state,'complete');
  });await stop();gateway=await gatedGeometryGateway(normal,environment);
  await check('actual Gateway restart recovers checked mesh history hidden without remeshing or changing source',async()=>{
    const list=await gateway.get('/documents/default/mesh/jobs');assert.equal(list.ok,true);assert.equal(list.jobs.length,1);assert.equal(list.jobs[0].jobId,meshId);assert.equal(list.jobs[0].visible,false);assert.equal(list.jobs[0].recovered,true);
    const state=await gateway.get('/documents/default');assert.equal(state.stateToken,sourceToken);assert.equal(digest(new MeshJobStore(normal).output({jobId:meshId,documentId:'default'})),meshHash);
  });
  await check('recovered results still require artifact admission and retain exact Body and Face ownership',async()=>{
    const result=await gateway.get('/mesh/jobs/'+meshId);assert.equal(result.ok,true);assert.equal(result.meshJob.state,'complete');assert.ok(result.mesh.admission.usable);assert.equal(result.meshJob.visible,false);
    const boundary=await gateway.get('/mesh/jobs/'+meshId+'/boundary');assert.equal(boundary.ok,true);assert.equal(boundary.boundary.complete,true);assert.equal(boundary.boundary.sourceFaces.length,6);
    const visible=await gateway.post('/mesh/jobs/'+meshId+'/visibility',{visible:true});assert.equal(visible.value.meshJob.visible,true);assert.equal(JSON.parse(fs.readFileSync(metadataFile)).state,'complete');
  });await stop();
  const result={ok:true,passed:checks.length,checks,backend:backend.releaseId,backendSourceSha256:backend.sourceSha256,childrenExited:true,exitCodes:exits,actualOcct:true,actualGmsh:true,paidProviderCalls:0,dailyProjectTouched:false};fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
}finally{await stop();}
