import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {normalizeDiscreteTetraSettings} from '../shared/discrete-tetra-task.mjs';
import {captureProjectDiscreteTetraSource,validateCadDiscreteTetraSnapshot,executeCadDiscreteTetra,validateCadDiscreteTetraResult,assessCadDiscreteTetraSource} from '../gateway/cad-discrete-tetra.mjs';
import {captureCadMeshMaterials,validateCadMeshMaterials} from '../gateway/cad-mesh-materials.mjs';
import {capabilitySnapshot} from '../gateway/worker-capabilities.mjs';
import {DISCRETE_SOURCE_CAPABILITY,DISCRETE_SOURCE} from '../shared/discrete-surface-source.mjs';
import {cadDiscreteTetraFixture} from './helpers/cad-discrete-tetra-fixture.mjs';

function captureFixture(options={}){
  const f=cadDiscreteTetraFixture(options);f.depth=0;f.calls=[];
  f.capture={documentId:'doc',getCapabilities:()=>capabilitySnapshot(f.binding.workerInstance,true,{[DISCRETE_SOURCE_CAPABILITY]:DISCRETE_SOURCE}),serializeDocument:async(id,action)=>{assert.equal(id,'doc');f.depth++;try{return await action();}finally{f.depth--; }},command:async(operation)=>{
    assert.equal(f.depth,1);f.calls.push(operation);
    if(operation==='document.summary')return structuredClone(f.view);
    if(operation==='mesh.discrete.export'){options.onExport?.(f);return {ok:true,protocolVersion:1,documentId:'doc',revision:1,discreteSurface:structuredClone(f.bundle)};}
    throw Error('Unexpected CAD operation');
  }};return f;
}

test('CAD tetra settings bound complete-project source, quality and material policy',()=>{
  const defaults=normalizeDiscreteTetraSettings();assert.equal(defaults.source.maxTriangles,4096);assert.equal(defaults.materialPolicy,'require-consistent');assert.equal(defaults.quality.mode,'strict');
  assert.equal(normalizeDiscreteTetraSettings({source:{linearDeflection:.01}}).source.maxTriangles,4096);
  for(const value of [null,[],{selection:'body-1'},{source:{maxTriangles:4097}},{path:'mesh.msh'},{meshSize:0},{quality:{version:1,mode:'strict',threshold:NaN,maxBadFraction:0}},{materialPolicy:'first-body-wins'},{optimization:{version:1,method:'netgen',iterations:1,acceptance:'diagnostic'}}])assert.throws(()=>normalizeDiscreteTetraSettings(value));
});

test('material snapshots include only used definitions, sort keys and preserve explicit unassigned bodies',()=>{
  const f=cadDiscreteTetraFixture({materials:['Copper',null]}),material=captureCadMeshMaterials(f.view,f.source);assert.equal(material.materials.length,1);assert.equal(material.bodies[1].material,null);assert.equal(validateCadMeshMaterials(material,f.source),material);
  const changed=structuredClone(f.view);changed.materials[1].conductivity=1;assert.equal(captureCadMeshMaterials(changed,f.source).sha256,material.sha256);changed.materials[0].conductivity=1;assert.notEqual(captureCadMeshMaterials(changed,f.source).sha256,material.sha256);
  const reordered=structuredClone(f.view);reordered.materials[0]=Object.fromEntries(Object.entries(reordered.materials[0]).reverse());assert.equal(captureCadMeshMaterials(reordered,f.source).sha256,material.sha256);
});

test('material source rejects duplicate, missing, unknown, malformed and altered definitions',()=>{
  for(const mutate of [v=>delete v.materials,v=>v.materials.push(v.materials[0]),v=>v.bodyMetadata[0].material='Missing',v=>delete v.bodyMetadata[0].material,v=>v.materials[0].conductivity=Infinity]){
    const f=cadDiscreteTetraFixture();mutate(f.view);assert.throws(()=>captureCadMeshMaterials(f.view,f.source),{code:'MESH_MATERIAL_SOURCE_INVALID'});
  }
  for(const mutate of [m=>m.sha256='f'.repeat(64),m=>m.materials[0].definition.conductivity=0,m=>m.bodies[0].bodyId='foreign',m=>m.extra=true]){
    const f=cadDiscreteTetraFixture();mutate(f.snapshot.materials);assert.throws(()=>validateCadMeshMaterials(f.snapshot.materials,f.source),{code:'MESH_MATERIAL_SOURCE_INVALID'});
  }
});

test('CAD geometry and material capture share one action, including both before/after checks',async()=>{
  const f=captureFixture(),snapshot=await captureProjectDiscreteTetraSource(f.capture);assert.deepEqual(f.calls,['document.summary','mesh.discrete.export','document.summary']);assert.equal(f.depth,0);assert.deepEqual(snapshot,f.snapshot);assert.equal(snapshot.cad.binding.workerInstance,f.binding.workerInstance);
});

test('material changes during capture are caught even with unchanged revision, topology and state token',async()=>{
  for(const mutate of [f=>f.view.bodyMetadata[0].material='Steel',f=>f.view.materials[0].conductivity=3]){
    const f=captureFixture({onExport:mutate});await assert.rejects(captureProjectDiscreteTetraSource(f.capture),{code:'MESH_MATERIAL_SOURCE_CHANGED'});
  }
});

test('missing material data blocks source capture before native export',async()=>{
  const f=captureFixture();delete f.view.materials;await assert.rejects(captureProjectDiscreteTetraSource(f.capture),{code:'MESH_MATERIAL_SOURCE_INVALID'});assert.deepEqual(f.calls,['document.summary']);
});

test('free Sheet has an explicit unsupported-domain error before the four-triangle volume minimum',async()=>{
  const f=captureFixture();
  for(const body of [f.bundle.source.bodies[0],f.bundle.inventory.bodies[0],f.view.bodyMetadata[0]])body.kind='sheet';
  f.bundle.inventory.bodies[0].solidCount=0;f.bundle.inventory.solids=[];f.bundle.inventory.faces=f.bundle.inventory.faces.slice(0,1);f.bundle.inventory.bodies[0].faceCount=1;f.bundle.inventory.faces[0].uses[0].solidId='';
  f.bundle.input.points=f.bundle.input.points.slice(0,6);f.bundle.input.triangles=f.bundle.input.triangles.slice(0,2);f.bundle.input.sources=f.bundle.input.sources.slice(0,2);for(const row of f.bundle.input.sources)delete row.solidId;
  Object.assign(f.bundle.report,{faceCount:1,solidCount:0,triangleCount:2});await assert.rejects(captureProjectDiscreteTetraSource(f.capture),{code:'VOLUME_FREE_SHEET_UNSUPPORTED'});assert.equal(f.calls.length,3);
});

test('generic persisted CAD source validator does not accept a changed material-bound source hash',()=>{
  const f=cadDiscreteTetraFixture();f.snapshot.cad.binding.bundleSha256=crypto.createHash('sha256').update('foreign').digest('hex');assert.throws(()=>validateCadDiscreteTetraSnapshot(f.snapshot),{code:'SURFACE_SOURCE_INVALID'});
});

test('CAD-bound coordinator validates both native stages and can revalidate artifacts without rerun',async()=>{
  const f=cadDiscreteTetraFixture();assert.equal(validateCadDiscreteTetraSnapshot(f.snapshot),f.snapshot);const out=await executeCadDiscreteTetra({snapshot:f.snapshot,...f.clients});
  const summary=validateCadDiscreteTetraResult(out,f.snapshot);assert.equal(summary.bodyCount,1);assert.equal(summary.faceCount,6);assert.equal(summary.solidCount,1);assert.equal(summary.tetraCount,6);assert.equal(summary.normalMeshAdmitted,false);assert.equal(out.cellMaterials.cells[0].material,'Copper');assert.equal(out.cellMaterials.materialPriorityAssigned,false);
});

test('identical overlapping bodies with the same material preserve all source Solid memberships',async()=>{
  const f=cadDiscreteTetraFixture({materials:['Copper','Copper']}),out=await executeCadDiscreteTetra({snapshot:f.snapshot,...f.clients});assert.equal(out.cellMaterials.cells[0].sources.length,2);assert.deepEqual(out.output.cells[0].sourceSolidIndexes,[0,1]);assert.equal(out.cellMaterials.cells[0].resolution,'consistent');
});

test('different or partially unassigned overlapping materials stop before tetra generation',async()=>{
  for(const materials of [['Copper','Steel'],['Copper',null]]){
    const f=cadDiscreteTetraFixture({materials});let calls=0;f.clients.tetraClient.tetrahedralize=async()=>{calls++;return f.output;};
    await assert.rejects(executeCadDiscreteTetra({snapshot:f.snapshot,...f.clients}),error=>{assert.equal(error.code,'MESH_MATERIAL_CONFLICT');assert.equal(error.details.conflictCellCount,1);assert.equal(error.details.cells[0].sources.length,2);assert.equal(error.details.materialPriorityAssigned,false);return true;});assert.equal(calls,0);
  }
});

test('explicitly unassigned CAD cells are not invented as a default material',async()=>{
  const f=cadDiscreteTetraFixture({materials:[null]}),out=await executeCadDiscreteTetra({snapshot:f.snapshot,...f.clients});assert.equal(out.cellMaterials.unassignedCellCount,1);assert.equal(out.cellMaterials.cells[0].material,null);assert.equal(out.cellMaterials.cells[0].resolution,'unassigned');
});

test('snapshot is fixed before either asynchronous stage',async()=>{
  const f=cadDiscreteTetraFixture();let release;const pending=new Promise(resolve=>release=resolve);f.clients.partitionClient.partition=async()=>{await pending;return structuredClone(f.domain);};
  const work=executeCadDiscreteTetra({snapshot:f.snapshot,...f.clients});f.snapshot.materials.bodies[0].material='Steel';f.snapshot.cad.bundle.input.points[0][0]=99;release();const out=await work;assert.equal(out.cellMaterials.cells[0].material,'Copper');
});

test('native clients cannot mutate the captured partition or tetra command in place',async()=>{
  const f=cadDiscreteTetraFixture();f.clients.partitionClient.partition=async input=>{input.points[0][0]=9;return structuredClone(f.domain);};await assert.rejects(executeCadDiscreteTetra({snapshot:f.snapshot,...f.clients}),{code:'MESH_DISCRETE_BINDING_INVALID'});
  const g=cadDiscreteTetraFixture();g.clients.tetraClient.tetrahedralize=async command=>{command.meshSize=9;return structuredClone(g.output);};await assert.rejects(executeCadDiscreteTetra({snapshot:g.snapshot,...g.clients}),{code:'MESH_DISCRETE_BINDING_INVALID'});
});

test('foreign source, false process proof, changed material result and false admission are rejected',async()=>{
  const f=cadDiscreteTetraFixture(),out=await executeCadDiscreteTetra({snapshot:f.snapshot,...f.clients});
  for(const mutate of [v=>v.sourceSnapshotSha256='a'.repeat(64),v=>v.partition.sources[0].faceId='foreign',v=>v.partition.execution.exitCode=2,v=>v.output.execution.exitCode=2,v=>v.output.processResources.enforced=false,v=>v.output.algorithm.license='other',v=>v.cellMaterials.cells[0].material='Steel',v=>v.normalMeshAdmitted=true]){const bad=structuredClone(out);mutate(bad);assert.throws(()=>validateCadDiscreteTetraResult(bad,f.snapshot));}
});

test('source freshness includes used material definitions but not unrelated material edits or visibility',()=>{
  const f=cadDiscreteTetraFixture();assert.equal(assessCadDiscreteTetraSource(f.snapshot,f.view).status,'current');
  for(const mutate of [v=>v.bodyMetadata[0].material='Steel',v=>v.materials[0].conductivity=1,v=>v.bodyMetadata[0].topologyIdentity='f'.repeat(32)]){const view=structuredClone(f.view);mutate(view);assert.equal(assessCadDiscreteTetraSource(f.snapshot,view).status,'stale');}
  const view=structuredClone(f.view);view.materials[1].conductivity=1;view.revision++;view.bodyMetadata[0].visible=false;assert.equal(assessCadDiscreteTetraSource(f.snapshot,view).status,'current');delete view.materials;assert.equal(assessCadDiscreteTetraSource(f.snapshot,view).status,'unverified');
});

test('cancellation before capture or between stages neither starts another stage nor publishes a late result',async()=>{
  const controller=new AbortController();controller.abort();const early=captureFixture();await assert.rejects(captureProjectDiscreteTetraSource({...early.capture,signal:controller.signal}),{code:'MESH_CANCELLED'});assert.equal(early.calls.length,0);
  for(const stage of ['partition','tetra']){
    const f=cadDiscreteTetraFixture(),abort=new AbortController();let tetraCalls=0;f.clients.partitionClient.partition=async()=>{if(stage==='partition')abort.abort();return structuredClone(f.domain);};f.clients.tetraClient.tetrahedralize=async()=>{tetraCalls++;abort.abort();return structuredClone(f.output);};
    await assert.rejects(executeCadDiscreteTetra({snapshot:f.snapshot,...f.clients,signal:abort.signal}),{code:'MESH_CANCELLED'});assert.equal(tetraCalls,stage==='partition'?0:1);
  }
});
