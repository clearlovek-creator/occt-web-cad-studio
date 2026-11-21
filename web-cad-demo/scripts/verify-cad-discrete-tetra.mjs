import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../gateway/native-runtime-release.mjs';
import {fileInventory,hashFile,assertRegularDirectory} from '../gateway/frontend-release.mjs';

const root=path.resolve(import.meta.dirname,'..'),releaseRoot=path.resolve(process.env.CAD_DISCRETE_TETRA_BACKEND_ROOT||'.artifacts/cad-discrete-tetra-backend-releases'),output=path.resolve(process.env.CAD_DISCRETE_TETRA_ARTIFACTS||'.artifacts/cad-discrete-tetra-native-checks');
for(const directory of [releaseRoot,output])assert.ok(directory.startsWith(path.join(root,'.artifacts')+path.sep));assert.ok(!fs.existsSync(output));for(let p=path.dirname(output);p!==root;p=path.dirname(p))if(fs.existsSync(p))assertRegularDirectory(p);
const backend=selectBackendRelease(releaseRoot),native=validateNativeRuntime(path.join(backend.directory,'native'),backend.native);
const runtimeImport=file=>import(pathToFileURL(path.join(backend.directory,'runtime',file)).href);
const [{MeshWorkerClient},{DiscreteSurfaceClient},{DiscreteTetraClient},{DocumentActionQueue},cap,resource,bound]=await Promise.all(['gateway/mesh-worker-client.mjs','gateway/discrete-surface-client.mjs','gateway/discrete-tetra-client.mjs','gateway/document-action-queue.mjs','gateway/worker-capabilities.mjs','gateway/native-resource-policy.mjs','gateway/cad-discrete-tetra.mjs'].map(runtimeImport));
const sourceFiles=['scripts/verify-cad-discrete-tetra.mjs','gateway/cad-discrete-tetra.mjs','gateway/cad-mesh-materials.mjs','gateway/discrete-surface-source.mjs','gateway/discrete-surface-task-result.mjs','shared/discrete-tetra-task.mjs','gateway/single-job-native-client.mjs','gateway/native-request-channel.mjs'];
const sourceProof=sourceFiles.map(file=>({file,sha256:hashFile(path.join(root,file))}));
function verify(){assert.equal(selectBackendRelease(releaseRoot,backend.releaseId).manifestSha256,backend.manifestSha256);validateNativeRuntime(path.join(backend.directory,'native'),backend.native);for(const item of sourceProof)assert.equal(hashFile(path.join(root,item.file)),item.sha256);}
verify();fs.mkdirSync(output);const children=new Set(),records=[],queue=new DocumentActionQueue(),owned=new Set();let revision=0,sequence=0,capabilities;
function trackedSpawn(...args){const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));return child;}
const geometry=new MeshWorkerClient({workerPath:native.roles.geometry,runtimePath:native.geometryBin,timeoutMs:60000,spawnImpl:trackedSpawn,environment:{Path:native.geometryBin,GEOMETRY_WORKER_MEMORY_LIMIT_BYTES:String(2*1024**3)}});owned.add(geometry);
async function command(operation,fields={}){
  if(fields.workerCapabilityPrecondition)cap.assertCapabilityPrecondition(fields.workerCapabilityPrecondition,capabilities);
  const response=await geometry.request({protocolVersion:1,requestId:'cad-tetra-'+(++sequence),operation,documentId:'cad-tetra-test',baseRevision:revision,...fields});if(Number.isSafeInteger(response.revision))revision=response.revision;return response;
}
const cad=(operation,parameters={},inputs={})=>queue.run('cad-tetra-test',()=>command(operation,{parameters,inputs}));
const capture={documentId:'cad-tetra-test',command,serializeDocument:(id,action)=>queue.run(id,action),getCapabilities:()=>capabilities};
const save=(name,value)=>fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(value),{flag:'wx'});
async function check(name,action){const start=performance.now();try{const details=await action();records.push({name,ok:true,elapsedMs:Math.round(performance.now()-start),...details});console.log('PASS '+name);}catch(error){records.push({name,ok:false,error:{code:error.code,message:error.message,stack:error.stack}});console.error('FAIL '+name+': '+error.message);}}
const diagnostic={version:1,mode:'diagnostic',threshold:.2,maxBadFraction:0};
async function model(placements,materials){
  await cad('document.create');const bodies=[];
  for(let i=0;i<placements.length;i++){const box=await cad('primitive.box',{width:2,depth:2,height:2,...placements[i]});const bodyId=box.bodyId;bodies.push(bodyId);if(materials?.[i])await cad('body.update',{material:materials[i]},{bodyId});}
  return bodies;
}
async function run(name,{settings={},expectConflict=false,afterPartition}={}){
  const before=await cad('document.summary'),snapshot=await bound.captureProjectDiscreteTetraSource({...capture,settings}),partitionClient=new DiscreteSurfaceClient({workerPath:native.roles.discrete,runtimePath:native.discreteBin,spawnImpl:trackedSpawn}),tetraClient=new DiscreteTetraClient({workerPath:native.roles.mesh,runtimePath:native.meshBin,spawnImpl:trackedSpawn});owned.add(partitionClient);owned.add(tetraClient);
  save(name+'.source',snapshot);let tetraCalls=0;const tetrahedralize=tetraClient.tetrahedralize.bind(tetraClient);tetraClient.tetrahedralize=(...args)=>{tetraCalls++;return tetrahedralize(...args);};
  if(afterPartition){const partition=partitionClient.partition.bind(partitionClient);partitionClient.partition=async(...args)=>{const value=await partition(...args);await afterPartition();return value;};}
  try{
    if(expectConflict){let error;try{await bound.executeCadDiscreteTetra({snapshot,partitionClient,tetraClient});}catch(cause){error=cause;}assert.equal(error?.code,'MESH_MATERIAL_CONFLICT');assert.ok(error.details.conflictCellCount>0);assert.equal(tetraCalls,0);save(name+'.conflict',{code:error.code,details:error.details});return {conflictCellCount:error.details.conflictCellCount,tetraCalls};}
    const result=await bound.executeCadDiscreteTetra({snapshot,partitionClient,tetraClient}),summary=bound.validateCadDiscreteTetraResult(result,snapshot),after=await cad('document.summary'),freshness=bound.assessCadDiscreteTetraSource(snapshot,after);if(!afterPartition)assert.deepEqual(after,{...before,requestId:after.requestId});
    assert.equal(result.output.execution.exitCode,0);assert.equal(result.partition.execution.exitCode,0);assert.equal(result.normalMeshAdmitted,false);save(name+'.result',result);save(name+'.summary',{summary,freshness});
    const reopened=JSON.parse(fs.readFileSync(path.join(output,name+'.result.json'),'utf8')),reopenedSource=JSON.parse(fs.readFileSync(path.join(output,name+'.source.json'),'utf8'));assert.deepEqual(bound.validateCadDiscreteTetraResult(reopened,reopenedSource),summary);assert.equal(tetraCalls,1);
    return {summary,freshness:freshness.status,sourceMemberships:result.cellMaterials.cells.map(cell=>cell.sources.length),unionVolume:result.partition.report.unionVolume};
  }finally{await partitionClient.closeAndWait();await tetraClient.closeAndWait();assert.equal(partitionClient.children.size,0);assert.equal(tetraClient.children.size,0);}
}
try{
  const health=await command('health.ping');resource.assertNativeMemoryGuard(health,resource.geometryMemoryPolicy());capabilities=cap.capabilitySnapshot(crypto.randomUUID(),true,cap.nativeGeometryFeatures(health));
  await check('actual-CAD-single-box-strict-quality-and-Copper-binding',async()=>{await model([{}],['Copper']);const value=await run('single-box');assert.equal(value.freshness,'current');return value;});
  await check('actual-CAD-Boolean-hollow-Solid-preserves-its-cavity-through-partition-and-tetra',async()=>{
    await cad('document.create');const outer=await cad('primitive.box',{width:2,depth:2,height:2}),inner=await cad('primitive.box',{width:1,depth:1,height:1,x:.5,y:.5,z:.5});
    const cut=await cad('boolean.cut',{}, {targetBody:outer.bodyId,toolBody:inner.bodyId});assert.equal(cut.ok,true);const value=await run('actual-hollow-Solid',{settings:{quality:diagnostic}});assert.equal(value.summary.bodyCount,1);assert.equal(value.summary.solidCount,1);assert.equal(value.summary.cellCount,1);assert.ok(Math.abs(value.unionVolume-7)<1e-8);return value;
  });
  await check('actual-CAD-all-overlapping-bodies-share-one-conformal-partition',async()=>{await model([{}, {x:1,y:.5,z:.5}],['Copper','Copper']);const value=await run('same-material-overlap',{settings:{quality:diagnostic}});assert.equal(value.summary.bodyCount,2);assert.ok(value.sourceMemberships.includes(2));return value;});
  await check('actual-CAD-conflicting-overlap-stops-before-Gmsh',async()=>{await model([{}, {x:1,y:.5,z:.5}],['Copper','Steel']);return run('conflicting-overlap',{settings:{quality:diagnostic},expectConflict:true});});
  await check('actual-CAD-partly-unassigned-overlap-is-a-conflict',async()=>{await model([{}, {x:1,y:.5,z:.5}],['Copper',null]);return run('partly-unassigned',{settings:{quality:diagnostic},expectConflict:true});});
  await check('actual-CAD-disjoint-different-materials-do-not-conflict',async()=>{await model([{}, {x:4}],['Copper','Steel']);const value=await run('disjoint-materials',{settings:{quality:diagnostic}});assert.equal(value.summary.cellCount,2);return value;});
  await check('actual-CAD-all-unassigned-remains-explicit',async()=>{await model([{}]);const value=await run('unassigned');assert.equal(value.summary.unassignedCellCount,1);return value;});
  await check('material-only-edit-during-computation-makes-source-stale',async()=>{const bodies=await model([{}],['Copper']);const value=await run('changed-material',{afterPartition:()=>cad('body.update',{material:'Steel'},{bodyId:bodies[0]})});assert.equal(value.freshness,'stale');return value;});
  await check('upstream-geometry-edit-does-not-rebind-old-Faces-or-Solids',async()=>{await model([{}],['Copper']);const summary=await cad('document.summary'),featureId=summary.features.at(-1).id;const value=await run('changed-geometry',{afterPartition:()=>cad('feature.update',{width:3},{featureId})});assert.equal(value.freshness,'stale');return value;});
  await check('free-Sheet-is-rejected-before-partition-or-tetra-start',async()=>{await cad('document.create');await cad('surface.rectangle',{width:2,height:2});await assert.rejects(bound.captureProjectDiscreteTetraSource(capture),{code:'VOLUME_FREE_SHEET_UNSUPPORTED'});return {onlyGeometryProcess:true};});
  await check('strict-quality-refusal-retains-complete-native-exit-and-quality-proof',async()=>{
    await model([{}],['Copper']);const snapshot=await bound.captureProjectDiscreteTetraSource({...capture,settings:{quality:{version:1,mode:'strict',threshold:.9999,maxBadFraction:0}}}),partitionClient=new DiscreteSurfaceClient({workerPath:native.roles.discrete,runtimePath:native.discreteBin,spawnImpl:trackedSpawn}),tetraClient=new DiscreteTetraClient({workerPath:native.roles.mesh,runtimePath:native.meshBin,spawnImpl:trackedSpawn});owned.add(partitionClient);owned.add(tetraClient);
    try{let error;try{await bound.executeCadDiscreteTetra({snapshot,partitionClient,tetraClient});}catch(cause){error=cause;}assert.equal(error?.code,'MESH_QUALITY_REJECTED');assert.equal(error.execution.exitCode,2);assert.equal(error.processResources.enforced,true);assert.equal(error.details.quality.meetsRequestedQuality,false);save('strict-quality-refusal',{code:error.code,details:error.details,execution:error.execution,algorithm:error.algorithm,processResources:error.processResources});return {failureExitConfirmed:true};}finally{await partitionClient.closeAndWait();await tetraClient.closeAndWait();}
  });
}finally{await Promise.all([...owned].map(client=>client.closeAndWait()));}
verify();assert.equal(children.size,0);const files=fileInventory(output),result={format:'web-cad-bound-discrete-tetra-verification',version:1,ok:records.every(row=>row.ok),createdAt:new Date().toISOString(),backend:{releaseId:backend.releaseId,manifestSha256:backend.manifestSha256,sourceSha256:backend.sourceSha256,nativeSha256:backend.native.sha256},sourceProof,files,counts:{total:records.length,passed:records.filter(row=>row.ok).length,failed:records.filter(row=>!row.ok).length},records,childrenExited:true,dailyServicesChanged:false,paidProviderCalls:0,normalMeshAdmitted:false,durableProjectTaskIntegration:false,publicDistributionQualified:false};
save('result',result);console.log(JSON.stringify({ok:result.ok,counts:result.counts,output}));if(!result.ok)process.exitCode=1;
