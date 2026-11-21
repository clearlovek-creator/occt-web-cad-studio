import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {validateCadDiscreteTetraSnapshot,validateCadDiscreteTetraResult,cadTetraSurfaceRows,executeCadDiscreteTetra,captureProjectConstrainedTetraSource,captureProjectDiscreteTetraSource,assessCadDiscreteTetraSource,CAD_CONSTRAINED_TETRA_RESULT_BASIS} from '../gateway/cad-discrete-tetra.mjs';
import {adaptDiscreteTetraMesh} from '../gateway/discrete-mesh-adapter.mjs';
import {DISCRETE_CONSTRAINED_MESH_FAMILY as F,validateDiscreteMeshFamily} from '../gateway/discrete-mesh-family.mjs';
import {queryMeshBoundary} from '../gateway/mesh-boundary-query.mjs';
import {writeDiscreteMeshFiles,expectedDiscreteMeshFiles} from '../gateway/discrete-mesh-files.mjs';
import {cadConstrainedTetraFixture} from './helpers/cad-constrained-tetra-fixture.mjs';
import {capabilitySnapshot} from '../gateway/worker-capabilities.mjs';
import {DISCRETE_SOURCE_CAPABILITY,DISCRETE_SOURCE} from '../shared/discrete-surface-source.mjs';
import {qualifyMeshGroups} from '../shared/mesh-source.mjs';
import {validateMeshRender,readMeshRenderChunk,readRenderManifest} from '../gateway/mesh-render-store.mjs';
const jobId='mesh-00000000-0000-4000-8000-000000000001';
test('new CAD source/result family binds the complete Sheet and Solid inventory without changing old raw admission',()=>{
  const f=cadConstrainedTetraFixture(),before=JSON.stringify(f);validateCadDiscreteTetraSnapshot(f.snapshot);const summary=validateCadDiscreteTetraResult(f.result,f.snapshot);assert.equal(summary.basis,CAD_CONSTRAINED_TETRA_RESULT_BASIS);assert.equal(summary.bodyCount,2);assert.equal(summary.solidCount,1);assert.equal(summary.normalMeshAdmitted,false);assert.equal(JSON.stringify(f),before);
});
test('trusted constrained capture uses one engineering action while the existing product capture still rejects Sheets',async()=>{
  const f=cadConstrainedTetraFixture();let depth=0;const calls=[],capture={documentId:'doc',getCapabilities:()=>capabilitySnapshot(f.binding.workerInstance,true,{[DISCRETE_SOURCE_CAPABILITY]:DISCRETE_SOURCE}),serializeDocument:async(id,action)=>{assert.equal(id,'doc');depth++;try{return await action();}finally{depth--;}},command:async operation=>{assert.equal(depth,1);calls.push(operation);return operation==='document.summary'?structuredClone(f.view):{ok:true,protocolVersion:1,documentId:'doc',revision:1,discreteSurface:structuredClone(f.bundle)};}};
  assert.deepEqual(await captureProjectConstrainedTetraSource(capture),f.snapshot);assert.deepEqual(calls,['document.summary','mesh.discrete.export','document.summary']);assert.equal(depth,0);await assert.rejects(captureProjectDiscreteTetraSource(capture),{code:'VOLUME_FREE_SHEET_UNSUPPORTED'});
});
test('constrained CAD coordinator selects only exact Sheet partition and patched execution, with no old-family fallback',async()=>{
  const f=cadConstrainedTetraFixture(),calls=[];
  const result=await executeCadDiscreteTetra({snapshot:f.snapshot,partitionClient:{partitionConstrained:async()=>{calls.push('partition');return structuredClone(f.domain);}},tetraClient:{tetrahedralizePatched:async()=>{calls.push('patched');return structuredClone(f.output);}}});assert.deepEqual(calls,['partition','patched']);assert.deepEqual(result,f.result);
  await assert.rejects(executeCadDiscreteTetra({snapshot:f.snapshot,partitionClient:{partition(){}},tetraClient:{tetrahedralize(){}}}),{code:'MESH_DISCRETE_BINDING_INVALID'});
});
for(const sheet of ['embedded','exterior'])test('CAD '+sheet+' Sheet owns a surface group, never a fictitious volume or material cell',()=>{
  const f=cadConstrainedTetraFixture({sheet}),p=adaptDiscreteTetraMesh({...f,jobId});assert.equal(p.basis,F);assert.equal(p.normalMeshAdmitted,true,JSON.stringify(p.mesh.admission));assert.equal(p.defaultVisible,false);assert.equal(p.mesh.sourceInventory.sourceSolids.length,1);assert.equal(p.mesh.materialMapping.cells.length,1);
  const groups=p.mesh.render.groups.filter(g=>g.bodyId==='body-2');assert.equal(groups.length,1);assert.equal(groups[0].kind,'face');assert.deepEqual(groups[0].cadFaceIds,['face-1-1']);assert.ok(p.mesh.render.ownership.assignments.every(a=>a.bodyId!=='body-2'));
  const face=p.mesh.boundaryMapping.surfaces.find(s=>s.sources.some(a=>a.bodyId==='body-2'));assert.deepEqual(face.adjacentSolidIds,[]);assert.deepEqual(face.embeddedSolidIds,sheet==='embedded'?['solid-1']:[]);assert.equal(p.mesh.conformity.embeddedSurfaceCount,sheet==='embedded'?1:0);
  validateDiscreteMeshFamily(p.mesh,p.source);assert.equal(p.index.cells[0].elementId,'14');assert.equal(p.mesh.elementCount,19);assert.equal(cadTetraSurfaceRows(f.result).length,7);
});
test('current Sheet Face properties use the same stable CAD anchors after patch mapping',()=>{
  const f=cadConstrainedTetraFixture(),p=adaptDiscreteTetraMesh({...f,jobId}),body=f.sheetBody,schema={types:[{typeId:'wave-port',name:'WavePort'}],instances:[{instanceId:'port-1',name:'Port1',typeId:'wave-port',value:{frequency:3e9},state:'active',targets:[{kind:'face',bodyId:body.bodyId,topologyId:'face-1-1',bodyIdentity:body.bodyIdentity,topologyIdentity:body.topologyIdentity}]}]};
  const response=queryMeshBoundary(p.mesh.boundaryMapping,{source:p.source},{bodyId:'body-2',cadFaceId:'face-1-1'},schema,true,{sourceFamily:F});assert.equal(response.sourceFaces.length,1);assert.equal(response.sourceFaces[0].properties[0].instanceId,'port-1');assert.equal(response.surfaces.length,1);
  schema.instances[0].targets[0].topologyIdentity='f'.repeat(32);assert.equal(queryMeshBoundary(p.mesh.boundaryMapping,{source:p.source},{bodyId:'body-2'},schema,true,{sourceFamily:F}).sourceFaces[0].properties.length,0);
});
test('MSH and render preserve every Sheet surface, assign its Body a 2D physical group and share the volume element identity',()=>{
  const f=cadConstrainedTetraFixture(),root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-constrained-files-'));
  try{const input={...f,jobId,directory:root},written=writeDiscreteMeshFiles(input),expected=expectedDiscreteMeshFiles(input);assert.deepEqual(written.manifest,expected.manifest);const msh=fs.readFileSync(path.join(root,'mesh.msh'),'utf8');assert.match(msh,/2 \d+ "body:body-2"/);assert.doesNotMatch(msh,/3 \d+ "body:body-2"/);assert.match(msh,/\$Elements\n8 19 1 19\n/);const derived=JSON.parse(fs.readFileSync(path.join(root,'result.json')));assert.equal(derived.mesh.render.groups.filter(g=>g.bodyId==='body-2').length,1);assert.equal(derived.mesh.sourceInventory.basis,F);
    const render=readRenderManifest(path.join(root,'result.json'),written.manifest.files.result,jobId);validateMeshRender(render);const groups=qualifyMeshGroups(render.groups,f.source),sheet=groups.find(g=>g.bodyId==='body-2');assert.equal(sheet.bodyIdentity,f.sheetBody.bodyIdentity);const wire=render.wires.find(w=>w.key===sheet.wireKey);assert.ok(wire.chunks.length>0);assert.equal(readMeshRenderChunk(path.join(root,'render.bin'),render,wire.key,0).length,wire.chunks[0].bytes);}
  finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-constrained-files-/);fs.rmSync(root,{recursive:true,force:true});}
});
test('Sheet-only material and topology changes invalidate the captured source rather than rebinding old Face properties',()=>{
  const f=cadConstrainedTetraFixture();assert.equal(assessCadDiscreteTetraSource(f.snapshot,f.view).status,'current');
  for(const mutate of [v=>v.bodyMetadata[1].material='Copper',v=>v.bodyMetadata[1].topologyIdentity='f'.repeat(32)]){const view=structuredClone(f.view);mutate(view);assert.equal(assessCadDiscreteTetraSource(f.snapshot,view).status,'stale');}
});
const mutations={
  'wrong source family':f=>f.snapshot.version=1,
  'changed original CAD identity':f=>f.snapshot.cad.source.bodies[1].bodyIdentity='f'.repeat(32),
  'changed patch provenance':f=>f.result.patchPlan.patches.at(-1).sourceFaces[0].bodyId='foreign',
  'changed native Face label':f=>f.result.output.patches.at(-1).sourceFaces[0].faceId='foreign',
  'changed algorithm topology basis':f=>f.result.output.algorithm.patchTopologyBasis='guessed',
  'fake Sheet volume':f=>f.result.cellMaterials.cells[0].sources.push({bodyId:'body-2',solidId:'fake',material:null}),
  'false original admission':f=>f.result.normalMeshAdmitted=true,
};
for(const [name,mutate]of Object.entries(mutations))test('CAD constrained binding rejects '+name,()=>{const f=cadConstrainedTetraFixture();mutate(f);assert.throws(()=>validateCadDiscreteTetraResult(f.result,f.snapshot));});
test('source-family structure rejects a removed Sheet group or invented volume owner',()=>{
  for(const mutate of [p=>p.mesh.render.groups=p.mesh.render.groups.filter(g=>g.bodyId!=='body-2'),p=>p.mesh.render.ownership.assignments.push({volumeTag:1,partitionCellIndex:0,bodyId:'body-2',sourceSolidIds:['fake']})]){const f=cadConstrainedTetraFixture(),p=adaptDiscreteTetraMesh({...f,jobId});mutate(p);assert.throws(()=>validateDiscreteMeshFamily(p.mesh,p.source));}
});
