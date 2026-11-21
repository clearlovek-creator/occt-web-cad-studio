import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {MeshWorkerClient} from '../gateway/mesh-worker-client.mjs';
import {DiscreteSurfaceClient} from '../gateway/discrete-surface-client.mjs';
import {DocumentActionQueue} from '../gateway/document-action-queue.mjs';
import {nativeGeometryFeatures,capabilitySnapshot,assertCapabilityPrecondition} from '../gateway/worker-capabilities.mjs';
import {geometryMemoryPolicy,assertNativeMemoryGuard} from '../gateway/native-resource-policy.mjs';
import {captureProjectDiscreteSource,reconstructProjectSurfaceSnapshot} from '../gateway/discrete-surface-source.mjs';
import {createMeshSelfIntersectionFixture} from '../tests/helpers/mesh-self-intersection-fixture.mjs';
import {fileInventory,hashFile,readSmallJson,assertRegularDirectory} from '../gateway/frontend-release.mjs';
import {selectNativeTestRuntime,validateNativeTestRuntime} from './test-native-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..'),output=path.resolve(process.env.DISCRETE_SOURCE_ARTIFACTS||'.artifacts/discrete-source-real'),cgalBuild=path.resolve(process.env.DISCRETE_SOURCE_WORKER_BUILD||'.artifacts/discrete-worker-native-final');
assert.ok(output.startsWith(path.join(root,'.artifacts')+path.sep)&&!fs.existsSync(output));for(let p=path.dirname(output);p!==root;p=path.dirname(p))if(fs.existsSync(p))assertRegularDirectory(p);fs.mkdirSync(output);
const native=selectNativeTestRuntime(root),cgalReceipt=readSmallJson(path.join(cgalBuild,'build.json')),cgalReceiptSha=hashFile(path.join(cgalBuild,'build.json'));
const cgalRuntime=path.join(cgalBuild,'runtime');assert.deepEqual(fileInventory(cgalRuntime),cgalReceipt.runtime.files);
for(const item of cgalReceipt.sources)assert.equal(hashFile(path.join(root,item.file)),item.sha256);
const sourceNames=['scripts/verify-discrete-source.mjs','shared/discrete-surface-source.mjs','gateway/discrete-surface-source.mjs','gateway/worker-capabilities.mjs','gateway/discrete-surface-client.mjs','gateway/discrete-surface-protocol.mjs'];
const sourceProof=sourceNames.map(file=>({file,sha256:hashFile(path.join(root,file))}));
const queue=new DocumentActionQueue(),geometry=new MeshWorkerClient({workerPath:native.geometry,runtimePath:path.resolve('../install-mingw-ucrt64/win64/gcc/bin')+';C:/msys64/ucrt64/bin',timeoutMs:60000,environment:{GEOMETRY_WORKER_MEMORY_LIMIT_BYTES:String(2*1024**3)}}),surface=new DiscreteSurfaceClient({workerPath:path.join(cgalRuntime,'cad_discrete_surface_worker.exe'),runtimePath:cgalRuntime,timeoutMs:60000});
let sequence=0,revision=0,capabilities,dirtyFixture,verified=false;const results=[];
async function command(operation,fields={}){if(fields.workerCapabilityPrecondition)assertCapabilityPrecondition(fields.workerCapabilityPrecondition,capabilities);const response=await geometry.request({protocolVersion:1,requestId:'source-'+(++sequence),operation,documentId:'source-test',baseRevision:revision,...fields});if(Number.isSafeInteger(response.revision))revision=response.revision;return response;}
const cad=(operation,parameters={},inputs={})=>queue.run('source-test',()=>command(operation,{parameters,inputs}));
const capture={documentId:'source-test',command,serializeDocument:(id,action)=>queue.run(id,action),getCapabilities:()=>capabilities};
async function check(name,action){const start=performance.now();await action();results.push({name,ok:true,elapsedMs:Math.round(performance.now()-start)});console.log('PASS '+name);}
const save=(name,value)=>fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(value,null,2),{flag:'wx'});
const algorithmCases=[];
async function checkCapturedAlgorithm(name,snapshot){
  console.log('CASE '+name);const value=await surface.refine(snapshot.bundle.input);
  assert.equal(value.execution.exitCode,0);assert.equal(value.report.outputHasCrossings,false);assert.equal(value.report.tetrahedralReady,false);assert.deepEqual(value.sources,snapshot.bundle.input.sources);
  const proof={name,inputTriangles:snapshot.bundle.input.triangles.length,outputTriangles:value.triangles.length,inputHadCrossings:value.report.inputHadCrossings,removedDegenerateInputTriangles:value.report.removedDegenerateInputTriangles,exitConfirmed:true};algorithmCases.push(proof);return proof;
}
async function unchanged(action){const before=await cad('document.summary'),result=await action(),after=await cad('document.summary');assert.deepEqual(after,{...before,requestId:after.requestId});return result;}
try{
  const health=await command('health.ping');assertNativeMemoryGuard(health,geometryMemoryPolicy({},'win32'));capabilities=capabilitySnapshot(crypto.randomUUID(),true,nativeGeometryFeatures(health));
  await check('all-nine-Solid-constructors-produce-complete-dedicated-CAD-sources',async()=>{
    for(const [kind,parameters]of Object.entries({box:{width:4,depth:5,height:6},cylinder:{radius:3,height:6},cone:{radius1:4,radius2:2,height:6},sphere:{radius:4},torus:{majorRadius:6,minorRadius:2},wedge:{width:4,depth:5,height:6,topLength:2},prism:{radius:4,sides:6,height:6},pyramid:{baseWidth:4,baseDepth:5,topWidth:2,topDepth:2,height:6},tube:{outerRadius:4,innerRadius:2,height:6}})){
      await cad('document.create');await cad('primitive.'+kind,parameters);const snapshot=await unchanged(()=>captureProjectDiscreteSource(capture));assert.equal(snapshot.bundle.inventory.bodies.length,1,kind);assert.equal(snapshot.bundle.inventory.solids.length,1,kind);assert.equal(snapshot.bundle.report.complete,true,kind);assert.ok(snapshot.bundle.inventory.faces.every(face=>face.uses.every(use=>use.solidId)),kind);const algorithm=await checkCapturedAlgorithm('primitive-'+kind,snapshot);save('primitive-'+kind,{algorithm,source:snapshot.source,policy:snapshot.bundle.policy,report:snapshot.bundle.report});
    }
  });
  await check('all-five-Sheet-constructors-remain-unowned-by-Solids-and-surface-only',async()=>{
    for(const [kind,parameters]of Object.entries({rectangle:{width:6,height:5},disk:{radius:4},cylinder:{radius:4,height:6},cone:{radius1:4,radius2:2,height:6},sphere:{radius:4}})){
      await cad('document.create');await cad('surface.'+kind,parameters);const snapshot=await unchanged(()=>captureProjectDiscreteSource(capture));assert.equal(snapshot.bundle.inventory.solids.length,0,kind);assert.ok(snapshot.bundle.input.sources.every(source=>source.solidId===undefined),kind);assert.equal(snapshot.bundle.report.tetrahedralReady,false,kind);const algorithm=await checkCapturedAlgorithm('sheet-'+kind,snapshot);save('sheet-'+kind,{algorithm,source:snapshot.source,report:snapshot.bundle.report});
    }
  });
  await check('overlapping-CAD-Boxes-refine-through-formal-CGAL-with-real-Body-Face-Solid-source-binding',async()=>{
    await cad('document.create');await cad('primitive.box',{width:2,depth:2,height:2});await cad('primitive.box',{width:2,depth:2,height:2,x:1,y:0.5,z:0.5});
    const result=await unchanged(()=>reconstructProjectSurfaceSnapshot({...capture,client:surface}));assert.equal(result.sourceBundle.input.triangles.length,24);assert.ok(result.result.triangles.length>24);assert.equal(result.result.report.inputHadCrossings,true);assert.equal(result.result.report.outputHasCrossings,false);assert.equal(result.sourceCurrent,true);assert.equal(result.projectBinding.source.bodies.length,2);assert.equal(result.result.execution.exitCode,0);assert.equal(result.tetrahedralReady,false);save('overlapping-boxes',result);
  });
  await check('dedicated-source-does-not-change-original-BREP-or-reuse-view-tessellation',async()=>{
    await cad('document.create');const body=await cad('primitive.cylinder',{radius:5,height:10,x:11,y:-7,z:9});await cad('body.presentation',{}, {bodyId:body.bodyId});const before=path.join(output,'before.brep'),after=path.join(output,'after.brep');await cad('brep.export',{path:before});
    const coarse=await captureProjectDiscreteSource({...capture,options:{linearDeflection:0.5,angularDeflection:0.5}}),fine=await captureProjectDiscreteSource({...capture,options:{linearDeflection:0.01,angularDeflection:0.05}});await cad('brep.export',{path:after});assert.equal(hashFile(before),hashFile(after));assert.ok(fine.bundle.input.triangles.length>coarse.bundle.input.triangles.length);const points=fine.bundle.input.points;assert.ok(Math.abs(Math.min(...points.map(p=>p[2]))-9)<1e-10);assert.ok(Math.abs(Math.max(...points.map(p=>p[2]))-19)<1e-10);assert.ok(Math.min(...points.map(p=>p[0]))>=5.99&&Math.max(...points.map(p=>p[0]))<=16.01);save('cache-isolation',{beforeSha256:hashFile(before),afterSha256:hashFile(after),coarse:coarse.bundle.report,fine:fine.bundle.report,policy:fine.bundle.policy});
  });
  await check('source-budget-rejection-leaves-current-model-and-later-export-usable',async()=>{const before=await cad('document.summary');await assert.rejects(captureProjectDiscreteSource({...capture,options:{maxTriangles:1}}),{code:'SURFACE_EXPORT_TRIANGLE_LIMIT'});const after=await cad('document.summary');assert.deepEqual(after,{...before,requestId:after.requestId});assert.equal((await captureProjectDiscreteSource(capture)).bundle.report.complete,true);});
  await check('captured-source-stays-bound-and-is-marked-stale-after-an-upstream-edit',async()=>{
    await cad('document.create');const box=await cad('primitive.box',{width:2,depth:2,height:2});let edited=false;
    const result=await reconstructProjectSurfaceSnapshot({...capture,client:{refine:async(input,options)=>{await cad('feature.update',{width:3},{featureId:box.features.at(-1).id});edited=true;return surface.refine(input,options);}}});assert.equal(edited,true);assert.equal(result.sourceCurrent,false);assert.equal(result.freshness.status,'stale');assert.equal(result.projectBinding.source.bodies[0].topologyIdentity===((await cad('document.summary')).bodyMetadata[0].topologyIdentity),false);assert.equal(result.appliedToCad,false);save('stale-capture',result);
  });
  await check('actual-folded-STEP-source-crossings-are-reconstructed-without-misclaiming-a-closed-domain',async()=>{
    dirtyFixture=createMeshSelfIntersectionFixture();await cad('document.create');await cad('step.import',{path:path.join(dirtyFixture.root,'folded.step')});
    const result=await unchanged(()=>reconstructProjectSurfaceSnapshot({...capture,client:surface}));assert.equal(result.projectBinding.source.bodies.length,1);assert.equal(result.sourceBundle.inventory.solids.length,1);assert.equal(result.result.report.inputHadCrossings,true);assert.equal(result.result.report.outputHasCrossings,false);assert.equal(result.result.report.tetrahedralReady,false);assert.equal(result.result.report.volumeDomainReconstruction,'not-performed');assert.equal(result.sourceBundle.report.sourceGeometryUnchanged,true);save('folded-step',result);
  });
  validateNativeTestRuntime(native.manifest,root);for(const item of sourceProof)assert.equal(hashFile(path.join(root,item.file)),item.sha256);assert.equal(hashFile(path.join(cgalBuild,'build.json')),cgalReceiptSha);assert.deepEqual(fileInventory(cgalRuntime),cgalReceipt.runtime.files);
  await surface.closeAndWait();await geometry.closeAndWait();assert.equal(surface.children.size,0);assert.equal(geometry.children.size,0);verified=true;
  save('result',{ok:true,format:'web-cad-discrete-source-verification',version:1,passed:results.length,results,algorithmCases,scope:'actual-CAD-source-export-and-bound-surface-reconstruction-not-durable-project-task-or-volume-integration',nativeManifestSha256:native.manifestSha256,cgalBuildSha256:cgalReceiptSha,sourceProof,childrenExited:true,dailyServicesChanged:false,paidProviderCalls:0,tetrahedralReady:false});console.log(JSON.stringify({ok:true,passed:results.length,output}));
}catch(error){save('failure',{ok:false,passed:results.length,results,error:{code:error.code,message:error.message,stack:error.stack}});throw error;}
finally{await surface.closeAndWait();await geometry.closeAndWait();if(verified)dirtyFixture?.cleanup();}
