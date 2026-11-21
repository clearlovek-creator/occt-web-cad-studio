import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {MeshArtifactPool} from '../gateway/mesh-artifact-pool.mjs';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
import {validateCadDiscreteTetraResult} from '../gateway/cad-discrete-tetra.mjs';
import {tetraTaskResult} from '../gateway/discrete-tetra-task-result.mjs';
import {denyWindowsFileRead} from './helpers/windows-file-sharing.mjs';
import {cadDiscreteTetraFixture} from './helpers/cad-discrete-tetra-fixture.mjs';
import {assembleCadDiscreteTetraResult} from '../gateway/cad-discrete-tetra.mjs';
import {adaptDiscreteTetraMesh,normalizeDiscreteSICN,DISCRETE_SICN_ROUNDOFF_TOLERANCE} from '../gateway/discrete-mesh-adapter.mjs';
import {writeDiscreteMeshFiles} from '../gateway/discrete-mesh-files.mjs';
import {DISCRETE_MESH_FAMILY,validateDiscreteMeshFamily} from '../gateway/discrete-mesh-family.mjs';
import {assessMeshAdmission} from '../gateway/mesh-admission.mjs';
import {validateMeshBoundary,queryMeshBoundary} from '../gateway/mesh-boundary-query.mjs';
import {validateQualityIndex,queryMeshQuality} from '../gateway/mesh-quality-query.mjs';
import {validateMeshRender,readMeshRenderChunk,readRenderManifest} from '../gateway/mesh-render-store.mjs';
import {discreteTetraMetrics} from '../gateway/discrete-tetra-protocol.mjs';
const jobId='mesh-11111111-1111-4111-8111-111111111111',hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(options){const f=cadDiscreteTetraFixture(options);f.result=assembleCadDiscreteTetraResult(f.snapshot,f.domain,f.output);f.input={snapshot:f.snapshot,result:f.result,jobId};return f;}
function directory(t,beforeCleanup=async()=>{}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cad-discrete-projection-'));t.after(async()=>{await beforeCleanup();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^cad-discrete-projection-/);fs.rmSync(dir,{recursive:true,force:true});});return dir;}
const assess=p=>assessMeshAdmission(p.mesh,p.index,p.source,{sourceFamily:DISCRETE_MESH_FAMILY,qualityPolicy:'strict',qualityThreshold:p.index.threshold});

test('coordinate SICN at the physical unit bound normalizes only a bounded floating-point overshoot',()=>{
  const points=[[1,0,0],[1,.16666666666666677,.1666666666666667],[.8333333333333335,.16666666666666669,0],[.8333333333333333,0,.1666666666666668]],metric=discreteTetraMetrics(...points);
  assert.equal(metric.quality,1.0000000000000002);assert.equal(normalizeDiscreteSICN(metric.quality),1);assert.equal(normalizeDiscreteSICN(1),1);assert.equal(normalizeDiscreteSICN(1+DISCRETE_SICN_ROUNDOFF_TOLERANCE),1);
});
test('SICN normalization does not raise low quality, accept true range errors or relax the shared saved-cell validator',()=>{
  for(const value of [.001,.19999999999999998,.2,.8,1-Number.EPSILON])assert.equal(normalizeDiscreteSICN(value),value);
  for(const value of [null,'1',0,-1,NaN,Infinity,1+2*DISCRETE_SICN_ROUNDOFF_TOLERANCE,1.01])assert.throws(()=>normalizeDiscreteSICN(value),{code:'MESH_DISCRETE_PROJECTION_INVALID'});
  const p=adaptDiscreteTetraMesh(fixture().input);p.index.cells[0].quality=1.0000000000000002;const report=assess(p);assert.equal(report.usable,false);assert.ok(report.reasons.some(row=>row.code==='INVALID_ELEMENTS'));
});
test('already qualified projections without roundoff retain their original file content shape',()=>{
  const p=adaptDiscreteTetraMesh(fixture().input);assert.equal(p.mesh.quality.roundoffNormalization,undefined);assert.equal(p.index.cells.every(cell=>cell.quality===discreteTetraMetrics(...cell.corners.map(node=>p.index.positions.slice(node*3,node*3+3))).quality),true);
});

test('authenticated CAD tetra result derives a separate source family without changing original flags',()=>{
  const f=fixture(),before=JSON.stringify(f.input),p=adaptDiscreteTetraMesh(f.input);assert.equal(p.normalMeshAdmitted,true);assert.equal(p.defaultVisible,false);assert.equal(p.mesh.admission.status,'accepted');assert.equal(p.basis,DISCRETE_MESH_FAMILY);assert.equal(p.mesh.sourceInventory.version,2);assert.equal(p.mesh.boundaryMapping.version,2);assert.equal(JSON.stringify(f.input),before);assert.equal(f.result.normalMeshAdmitted,false);assert.equal(f.result.output.report.normalMeshAdmitted,false);assert.equal(p.mesh.approximation.distanceBoundCertified,false);
});
test('discrete metadata cannot opt itself into the BREP-only default admission or boundary parser',()=>{
  const p=adaptDiscreteTetraMesh(fixture().input);assert.equal(assessMeshAdmission(p.mesh,p.index,p.source).usable,false);assert.throws(()=>validateMeshBoundary(p.mesh.boundaryMapping,p.source));assert.throws(()=>assessMeshAdmission(p.mesh,p.index,p.source,{sourceFamily:'unknown'}));assert.equal(validateMeshBoundary(p.mesh.boundaryMapping,p.source,{sourceFamily:DISCRETE_MESH_FAMILY}),p.mesh.boundaryMapping);
});
test('identical same-material bodies keep every Body and original Solid without duplicate tetrahedra',()=>{
  const p=adaptDiscreteTetraMesh(fixture({materials:['Copper','Copper']}).input);assert.equal(p.mesh.sourceInventory.cells.length,1);assert.equal(p.mesh.sourceInventory.sourceSolids.length,2);assert.deepEqual(p.mesh.sourceInventory.cells[0].sourceSolidIndexes,[0,1]);assert.deepEqual(p.index.cells[0].bodyIds,['body-1','body-2']);assert.equal(p.index.cells.length,6);assert.equal(p.mesh.render.groups.length,2);assert.equal(p.mesh.render.groups[0].wireKey,p.mesh.render.groups[1].wireKey);assert.deepEqual(p.mesh.render.groups.map(g=>g.sourceSolidIds),[['solid-body-1-0'],['solid-body-2-0']]);assert.equal(p.mesh.boundaryMapping.surfaces[0].sources.length,2);assert.equal(p.normalMeshAdmitted,true);
});
test('cell/Body/Solid omissions, duplicate groups and forged BREP links cannot pass discrete admission',()=>{
  for(const mutate of [p=>p.mesh.sourceInventory.sourceSolids.pop(),p=>p.mesh.sourceInventory.cells[0].sourceSolidIndexes.pop(),p=>p.mesh.render.groups.pop(),p=>p.mesh.render.groups.push(p.mesh.render.groups[0]),p=>p.mesh.render.ownership.assignments.pop(),p=>p.mesh.render.ownership.assignments[0].preparedSolidIndex=0,p=>p.mesh.render.ownership.assignments[0].sourceSolidIds=[],p=>p.mesh.render.groups[0].sourceSolidIds=[],p=>p.mesh.boundaryMapping.provenance.nativeResultSha256='f'.repeat(64)]){
    const p=adaptDiscreteTetraMesh(fixture({materials:['Copper','Copper']}).input);mutate(p);assert.throws(()=>validateDiscreteMeshFamily(p.mesh,p.source));assert.equal(assess(p).usable,false);
  }
});
test('source, native exit, quality and material tampering are rejected before adaptation',()=>{
  for(const mutate of [f=>f.result.sourceSnapshotSha256='f'.repeat(64),f=>f.result.output.execution.exitCode=2,f=>f.result.output.processResources.enforced=false,f=>f.result.output.cells[0].qualities[0]=.99,f=>f.result.partition.cells[0].sourceSolidIndexes=[],f=>f.result.normalMeshAdmitted=true,f=>f.result.cellMaterials.cells[0].material='Steel']){const f=fixture();mutate(f);assert.throws(()=>adaptDiscreteTetraMesh(f.input));}
  const conflict=fixture({materials:['Copper','Steel']});assert.throws(()=>adaptDiscreteTetraMesh(conflict.input));
});
test('numeric quality rows are recomputed from coordinates with exact export element IDs',()=>{
  const p=adaptDiscreteTetraMesh(fixture().input);validateQualityIndex(p.index,{jobId,source:p.source});assert.deepEqual(p.index.cells.map(c=>c.elementId),['13','14','15','16','17','18']);for(const c of p.index.cells){const m=discreteTetraMetrics(...c.corners.map(n=>p.index.positions.slice(n*3,n*3+3)));assert.equal(c.quality,m.quality);assert.equal(c.minJacobian,m.volume*6);assert.equal(c.maxJacobian,m.volume*6);}assert.equal(queryMeshQuality(p.index,{jobId,source:p.source},{issue:'all'}).cells.every(c=>c.locatable),true);
});
test('ordinary admission still independently detects positive-volume overlaps in projected cells',()=>{
  const p=adaptDiscreteTetraMesh(fixture().input),n=p.index.positions.length/3,points=[[.1,.1,.1],[1.1,.1,.1],[.1,1.1,.1],[.1,.1,1.1]],m=discreteTetraMetrics(...points);p.index.positions.push(...points.flat());p.index.cells.push({...p.index.cells[0],elementId:'19',corners:[n,n+1,n+2,n+3],quality:m.quality,minJacobian:m.volume*6,maxJacobian:m.volume*6});p.mesh.nodeCount+=4;const quality=queryMeshQuality(p.index,{jobId,source:p.source},{issue:'all'}).quality;Object.assign(p.mesh.quality,quality);const report=assess(p);assert.equal(report.usable,false);assert.ok(report.reasons.some(row=>row.code==='OVERLAPPING_TETRAHEDRA'));
});
test('exhausting a spatial budget is an explicit failure, not normal admission',()=>{
  assert.throws(()=>adaptDiscreteTetraMesh({...fixture().input,spatialLimits:{pairs:1}}),{code:'MESH_ARTIFACT_LIMIT'});
});
test('diagnostic-only tasks never become ordinary meshes even when their tetrahedra are good',()=>{
  const f=fixture();f.snapshot.settings.quality.mode='diagnostic';f.output.quality.mode='diagnostic';f.result=assembleCadDiscreteTetraResult(f.snapshot,f.domain,f.output);const p=adaptDiscreteTetraMesh({...f.input,result:f.result});assert.equal(p.normalMeshAdmitted,false);assert.ok(p.mesh.admission.reasons.some(row=>row.code==='DISCRETE_DIAGNOSTIC_ONLY'));
});
test('CAD Face boundary queries preserve each split destination and current property association',()=>{
  const p=adaptDiscreteTetraMesh(fixture({materials:['Copper','Copper']}).input),face=p.mesh.boundaryMapping.sourceFaces[0],target={kind:'face',bodyId:face.source.bodyId,topologyId:face.source.cadFaceId,bodyIdentity:face.source.bodyIdentity,topologyIdentity:face.source.topologyIdentity},schema={types:[{typeId:'wave',name:'WavePort'}],instances:[{instanceId:'port-1',name:'Port1',typeId:'wave',value:{mode:1},state:'active',target}]};
  const found=queryMeshBoundary(p.mesh.boundaryMapping,{source:p.source},{bodyId:face.source.bodyId,cadFaceId:face.source.cadFaceId},schema,true,{sourceFamily:DISCRETE_MESH_FAMILY});assert.equal(found.sourceFaces.length,1);assert.equal(found.surfaces.length,2);assert.equal(found.sourceFaces[0].properties[0].instanceId,'port-1');assert.equal(found.backend,DISCRETE_MESH_FAMILY);assert.throws(()=>queryMeshBoundary(p.mesh.boundaryMapping,{source:p.source},{bodyId:'foreign'},null,false,{sourceFamily:DISCRETE_MESH_FAMILY}));
});
test('derived files carry verified MSH, quality and chunked wires while original inputs remain immutable',t=>{
  const f=fixture({materials:['Copper','Copper']}),dir=directory(t),before=JSON.stringify(f.input),result=writeDiscreteMeshFiles({directory:dir,...f.input});assert.equal(JSON.stringify(f.input),before);assert.equal(result.manifest.normalMeshAdmitted,true);assert.equal(result.manifest.rawResultNormalMeshAdmitted,false);assert.equal(result.manifest.defaultVisible,false);
  for(const [kind,name]of Object.entries({mesh:'mesh.msh',quality:'quality.json',render:'render.bin',result:'result.json'})){const bytes=fs.readFileSync(path.join(dir,name));assert.equal(bytes.length,result.manifest.files[kind].bytes);assert.equal(hash(bytes),result.manifest.files[kind].sha256);}
  const sealed=JSON.parse(fs.readFileSync(path.join(dir,'result.json'))),index=JSON.parse(fs.readFileSync(path.join(dir,'quality.json')));validateQualityIndex(index,{jobId,source:f.source});const render=readRenderManifest(path.join(dir,'result.json'),result.manifest.files.result,jobId);validateMeshRender(render);assert.equal(render.wires.length,13);assert.equal(render.groups.length,2);for(const wire of render.wires)for(let i=0;i<wire.chunks.length;i++)assert.equal(readMeshRenderChunk(path.join(dir,'render.bin'),render,wire.key,i).length,wire.chunks[i].bytes);assert.equal(sealed.mesh.exportMapping.physicalGroups.filter(g=>g.dimension===3).length,4);
  const msh=fs.readFileSync(path.join(dir,'mesh.msh'),'utf8');assert.match(msh,/\$MeshFormat\n4\.1 0 8/);assert.match(msh,/3 1 "body:body-1"/);assert.match(msh,/3 2 "body:body-2"/);assert.match(msh,/3 4 "solid:body-2\/solid-body-2-0"/);assert.match(msh,/\$Elements\n13 18 1 18\n/);assert.match(msh,/\n13 1 2 3 7\n/);
});
test('repeated writes refuse nonempty staging without modifying published files',t=>{
  const f=fixture(),dir=directory(t);writeDiscreteMeshFiles({directory:dir,...f.input});const names=fs.readdirSync(dir),before=names.map(name=>hash(fs.readFileSync(path.join(dir,name))));assert.throws(()=>writeDiscreteMeshFiles({directory:dir,...f.input}),{code:'MESH_ARTIFACT_INVALID'});assert.deepEqual(names.map(name=>hash(fs.readFileSync(path.join(dir,name)))),before);
});
test('blocked diagnostic files produce no mesh, manifest or partially usable export',t=>{
  const f=fixture(),dir=directory(t);f.snapshot.settings.quality.mode='diagnostic';f.output.quality.mode='diagnostic';f.result=assembleCadDiscreteTetraResult(f.snapshot,f.domain,f.output);assert.throws(()=>writeDiscreteMeshFiles({directory:dir,...f.input,result:f.result}),{code:'MESH_DISCRETE_ADMISSION_REJECTED'});assert.deepEqual(fs.readdirSync(dir),[]);
});

async function pooled(t,{held=false,busy=false,diagnostic=false,timeoutMs=10000}={}){
  let retire=async()=>{};const data=directory(t,()=>retire()),f=fixture();if(diagnostic){f.snapshot.settings.quality.mode='diagnostic';f.output.quality.mode='diagnostic';f.result=assembleCadDiscreteTetraResult(f.snapshot,f.domain,f.output);}
  const store=new MeshJobStore(data),job={version:1,jobId,documentId:f.source.documentId,kind:'discrete-tetra',state:'complete',source:f.source,options:{discreteTetra:f.snapshot.settings,nativeSurfaceMemoryLimitBytes:2*1024**3,nativeMemoryLimitBytes:2*1024**3},materialSourceSha256:f.snapshot.materials.sha256,processResources:{partition:f.domain.processResources,tetra:f.output.processResources},artifact:{},discreteStage:'complete',discreteTetraSummary:validateCadDiscreteTetraResult(f.result,f.snapshot)};
  job.createdAt=new Date().toISOString();job.artifact=store.writeTetraArtifact(job,'discreteSource',f.snapshot).artifact;
  Object.assign(job.artifact,store.writeTetraArtifact(job,'partition',f.domain).artifact);Object.assign(job.artifact,store.writeResult(job,tetraTaskResult(job,f.result)));store.save(job);
  const control=new Int32Array(new SharedArrayBuffer(8)),workers=[],pool=new MeshArtifactPool({dataDir:data,timeoutMs,workerFactory:(url,config)=>{const worker=new Worker(held?new URL(busy?'./fixtures/busy-discrete-projection-thread.mjs':'./fixtures/held-discrete-projection-thread.mjs',import.meta.url):url,{...config,workerData:{...config.workerData,projectionControl:control.buffer}});workers.push(worker);return worker;}});
  retire=async()=>{Atomics.store(control,0,1);Atomics.notify(control,0);await pool.close();assert.equal(workers.every(worker=>worker.threadId===-1),true);};
  const waitHeld=async()=>{const deadline=Date.now()+5000;while(Atomics.load(control,1)!==1){assert.ok(Date.now()<deadline,'Original projection worker did not reach its held point.');await new Promise(resolve=>setTimeout(resolve,5));}};
  return {data,f,store,job,pool,workers,control,waitHeld,release:()=>{Atomics.store(control,0,1);Atomics.notify(control,0);},target:path.join(store.directory(job),'derived-mesh')};
}
test('existing artifact pool authenticates saved originals and publishes all derived files only after actual worker exit',async t=>{
  const f=await pooled(t,{held:true}),raw=fs.readFileSync(path.join(f.store.directory(f.job),'result.json')),metadata=fs.readFileSync(path.join(f.store.directory(f.job),'metadata.json')),work=f.pool.execute({operation:'derive-tetra-mesh',job:f.job});await f.waitHeld();assert.equal(fs.existsSync(f.target),false);assert.notEqual(f.workers[0].threadId,-1);f.release();const result=await work;assert.equal(f.workers[0].threadId,-1);assert.equal(result.manifest.normalMeshAdmitted,true);assert.equal(result.identity,undefined);assert.equal(result.files,undefined);assert.equal(fs.readdirSync(f.target).length,5);assert.deepEqual(fs.readFileSync(path.join(f.store.directory(f.job),'result.json')),raw);assert.deepEqual(fs.readFileSync(path.join(f.store.directory(f.job),'metadata.json')),metadata);
});
test('cancellation after a valid projection reply waits for exit and removes only uncommitted staging',async t=>{
  const f=await pooled(t,{held:true}),controller=new AbortController(),work=f.pool.execute({operation:'derive-tetra-mesh',job:f.job,signal:controller.signal}),checked=assert.rejects(work,{code:'MESH_ARTIFACT_CANCELLED'});await f.waitHeld();controller.abort();await checked;assert.equal(f.workers[0].threadId,-1);assert.equal(fs.existsSync(f.target),false);assert.equal(fs.readdirSync(f.store.directory(f.job)).some(name=>name.startsWith('artifact-')),false);assert.ok(f.store.readTetraMaterials(f.job).result);
});
test('a held projection deadline cannot publish its already-computed files',async t=>{
  const f=await pooled(t,{held:true,timeoutMs:1000}),work=f.pool.execute({operation:'derive-tetra-mesh',job:f.job}),checked=assert.rejects(work,{code:'MESH_ARTIFACT_TIMEOUT'});await f.waitHeld();await checked;assert.equal(f.workers[0].threadId,-1);assert.equal(fs.existsSync(f.target),false);assert.equal(fs.readdirSync(f.store.directory(f.job)).some(name=>name.startsWith('artifact-')),false);
});
test('a CPU-busy replied projection is actually terminated on cancel before any staging is removed',async t=>{
  const f=await pooled(t,{held:true,busy:true}),raw=fs.readFileSync(path.join(f.store.directory(f.job),'result.json')),controller=new AbortController(),work=f.pool.execute({operation:'derive-tetra-mesh',job:f.job,signal:controller.signal}),checked=assert.rejects(work,{code:'MESH_ARTIFACT_CANCELLED'});await f.waitHeld();assert.notEqual(f.workers[0].threadId,-1);assert.equal(fs.existsSync(f.target),false);controller.abort();await checked;assert.equal(f.workers[0].threadId,-1);assert.equal(f.pool.status().active,false);assert.equal(fs.existsSync(f.target),false);assert.equal(fs.readdirSync(f.store.directory(f.job)).some(name=>name.startsWith('artifact-')),false);assert.deepEqual(fs.readFileSync(path.join(f.store.directory(f.job),'result.json')),raw);
});
test('a CPU-busy replied projection deadline waits for real exit and cannot publish late output',async t=>{
  const f=await pooled(t,{held:true,busy:true,timeoutMs:1000}),raw=fs.readFileSync(path.join(f.store.directory(f.job),'result.json')),work=f.pool.execute({operation:'derive-tetra-mesh',job:f.job}),checked=assert.rejects(work,{code:'MESH_ARTIFACT_TIMEOUT'});await f.waitHeld();assert.notEqual(f.workers[0].threadId,-1);await checked;assert.equal(f.workers[0].threadId,-1);assert.equal(f.pool.status().active,false);assert.equal(fs.existsSync(f.target),false);assert.equal(fs.readdirSync(f.store.directory(f.job)).some(name=>name.startsWith('artifact-')),false);assert.deepEqual(fs.readFileSync(path.join(f.store.directory(f.job),'result.json')),raw);
});
test('changed staged file after worker reply fails publication instead of accepting its old digest',async t=>{
  const f=await pooled(t,{held:true}),work=f.pool.execute({operation:'derive-tetra-mesh',job:f.job}),checked=assert.rejects(work,{code:'MESH_ARTIFACT_INVALID'});await f.waitHeld();const stage=fs.readdirSync(f.store.directory(f.job)).find(name=>name.startsWith('artifact-'));fs.appendFileSync(path.join(f.store.directory(f.job),stage,'mesh.msh'),' ');f.release();await checked;assert.equal(fs.existsSync(f.target),false);assert.equal(f.workers[0].threadId,-1);
});
test('two queued derivations cannot overwrite the first published complete set',async t=>{
  const f=await pooled(t,{held:true}),first=f.pool.execute({operation:'derive-tetra-mesh',job:f.job}),second=f.pool.execute({operation:'derive-tetra-mesh',job:f.job}),checked=assert.rejects(second,{code:'MESH_DISCRETE_DERIVATION_EXISTS'});await f.waitHeld();f.release();const original=await first;await checked;assert.equal(hash(fs.readFileSync(path.join(f.target,'manifest.json'))),original.manifestProof.sha256);assert.equal(fs.readdirSync(f.store.directory(f.job)).some(name=>name.startsWith('artifact-')),false);
});
test('corrupt original bytes and diagnostic jobs cannot create a derived published set',async t=>{
  for(const diagnostic of [false,true]){const f=await pooled(t,{diagnostic});if(!diagnostic)fs.appendFileSync(f.store.tetraFile(f.job,'discreteSource'),' ');await assert.rejects(f.pool.execute({operation:'derive-tetra-mesh',job:f.job}),{code:diagnostic?'MESH_DISCRETE_ADMISSION_REJECTED':'MESH_ARTIFACT_INVALID'});assert.equal(fs.existsSync(f.target),false);assert.equal(f.workers[0].threadId,-1);}
});
test('temporary Windows source lock is I/O refusal, not corruption, and unlocking allows original derivation',async t=>{
  const f=await pooled(t),metadata=fs.readFileSync(path.join(f.store.directory(f.job),'metadata.json')),held=await denyWindowsFileRead(f.store.tetraFile(f.job,'discreteSource'));
  try{await assert.rejects(f.pool.execute({operation:'derive-tetra-mesh',job:f.job}),{code:'MESH_ARTIFACT_IO'});}finally{await held.release();}
  assert.equal(fs.existsSync(f.target),false);assert.deepEqual(fs.readFileSync(path.join(f.store.directory(f.job),'metadata.json')),metadata);const derived=await f.pool.execute({operation:'derive-tetra-mesh',job:f.job});assert.equal(derived.manifest.normalMeshAdmitted,true);
});
