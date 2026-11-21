import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {assessMeshAdmission} from '../gateway/mesh-admission.mjs';
import {admissionFixture} from './helpers/mesh-admission-fixture.mjs';
import {importTestTypeScript} from './helpers/import-typescript.mjs';
const {spatialSampleSelection,spatialSampleProblem,diagnosticSelectionProblem,diagnosticCellsVisible}=await importTestTypeScript('../app/model/mesh-spatial.ts',import.meta.url);
const {createMeshDiagnosticHighlight}=await importTestTypeScript('../app/model/mesh-quality-render.ts',import.meta.url);
const {MeshSpatialSamples}=await importTestTypeScript('../app/MeshSpatialSamples.tsx',import.meta.url);
function fixture(){
  const f=admissionFixture(),first=f.index.cells[0];f.index.positions.push(.1,.1,.1,.3,.1,.1,.1,.3,.1,.1,.1,.3);
  f.index.cells.push({...first,elementId:'9007199254740993',corners:[4,5,6,7],extra:'not-part-of-sample'});
  f.mesh.nodeCount=8;f.mesh.elementCount=2;Object.assign(f.mesh.quality,{tetraCount:2,finiteCount:2});f.mesh.boundaryMapping.surfaces[0].elementCount=8;
  f.mesh.admission=assessMeshAdmission(f.mesh,f.index,f.source);
  const result={meshJob:{jobId:'pair-job',documentId:f.source.documentId,source:f.source},mesh:f.mesh};
  return {...f,result,sample:f.mesh.admission.spatial.samples[0]};
}
test('both spatial participants carry certified volume/body identity and exact coordinates without fabricated quality',()=>{
  const f=fixture();assert.equal(f.mesh.admission.spatial.overlapPairCount,1);assert.deepEqual(f.sample.ownersVerified,[true,true]);assert.deepEqual(f.sample.volumeTags,[1,1]);
  for(let i=0;i<2;i++){const cell=f.sample.cells[i];assert.equal(cell.locatable,true);assert.equal(cell.elementId,f.sample.elementIds[i]);assert.deepEqual(cell.corners,f.sample.corners[i]);assert.equal(cell.bodyIdentities['body-1'].bodyIdentity,f.source.bodies[0].bodyIdentity);assert.equal(Object.hasOwn(cell,'quality'),false);assert.equal(Object.hasOwn(cell,'invalid'),false);}
  assert.equal(JSON.stringify(f.sample).includes('not-part-of-sample'),false);assert.equal(spatialSampleProblem(f.result,f.sample),'');
});
test('contradictory original cell owners never get replaced by inferred valid-looking sample owners',()=>{
  const f=fixture();f.index.cells[1].bodyIds=['body-unknown'];const report=assessMeshAdmission(f.mesh,f.index,f.source),sample=report.spatial.samples[0];
  assert.deepEqual(sample.ownersVerified,[true,false]);assert.equal(sample.cells[1],null);assert.ok(spatialSampleProblem(f.result,sample));assert.equal(spatialSampleSelection(f.result,sample,0),null);
});
test('pair adoption rejects peer coordinate tampering, overflow, malformed arrays, truncation and identity changes',()=>{
  const f=fixture();
  for(const mutate of [s=>s.elementIdsTruncated[1]=true,s=>s.cells[1].corners[0]+=1,s=>{s.cells[1].corners[0]=s.corners[1][0]=1e40;},s=>s.cells[1].corners='abcdefghijkl',s=>s.cells[1]=null,s=>s.cells[1].bodyIdentities['body-1'].topologyIdentity='c'.repeat(32),s=>s.elementIds[1]=s.elementIds[0]]){
    const sample=JSON.parse(JSON.stringify(f.sample));mutate(sample);assert.ok(spatialSampleProblem(f.result,sample));assert.equal(spatialSampleSelection(f.result,sample,0),null);
  }
  assert.equal(spatialSampleSelection(f.result,f.sample,8),null);
});
test('a pair creates two separately inspectable actual tetrahedra with independent colours, not a fake bad-quality flag',()=>{
  const f=fixture(),selection=spatialSampleSelection(f.result,f.sample,0);assert.equal(diagnosticSelectionProblem(selection),'');
  const group=createMeshDiagnosticHighlight(selection),a=group.getObjectByName('mesh-spatial-primary'),b=group.getObjectByName('mesh-spatial-peer');assert.equal(group.children.length,2);
  assert.equal(a.children[0].material.color.getHex(),0xff6b63);assert.equal(b.children[0].material.color.getHex(),0xffc247);
  b.updateWorldMatrix(true,true);const attribute=b.children[0].geometry.attributes.position;for(let i=0;i<attribute.count;i++){const point=new THREE.Vector3().fromBufferAttribute(attribute,i).applyMatrix4(b.children[0].matrixWorld);point.toArray().forEach((n,axis)=>assert.ok(Math.abs(n-f.sample.corners[1][i*3+axis])<1e-7));}assert.equal(group.getObjectByName('mesh-topology-common-face'),undefined);
  group.traverse(object=>{object.geometry?.dispose();if(Array.isArray(object.material))object.material.forEach(m=>m.dispose());else object.material?.dispose();});
});
test('all participant bodies must have a visible valid owner; a visible primary cannot expose a hidden peer',()=>{
  const f=fixture(),selection=spatialSampleSelection(f.result,f.sample,0),body={...f.source.bodies[0],bodyId:'body-2',bodyIdentity:'c'.repeat(32),topologyIdentity:'d'.repeat(32)};
  selection.source.bodies.push(body);selection.spatial.peer.bodyIds=['body-2'];selection.spatial.peer.bodyIdentities={'body-2':{bodyIdentity:body.bodyIdentity,topologyIdentity:body.topologyIdentity}};
  assert.equal(diagnosticSelectionProblem(selection),'');assert.equal(diagnosticCellsVisible(selection,['body-1']),false);assert.equal(diagnosticCellsVisible(selection,['body-1','body-2']),true);assert.equal(diagnosticCellsVisible(selection,['body-2']),false);
});
test('report controls remain native and expose stale, hidden, missing and partial coverage without unsafe locators',()=>{
  const f=fixture(),render=props=>renderToStaticMarkup(React.createElement(MeshSpatialSamples,{result:f.result,current:true,visibleBodyIds:['body-1'],bodyNames:{'body-1':'Box'},selection:null,onLocate(){},...props}));
  const normal=render({});assert.match(normal,/定位重叠样例 1/);assert.match(normal,/A 为红色、B 为黄色/);assert.match(normal,/Box/);assert.doesNotMatch(normal,/disabled=""/);
  assert.match(render({current:false}),/disabled=""/);assert.match(render({visibleBodyIds:[]}),/部分所属 Body 已隐藏/);
  const bad=structuredClone(f.result);bad.mesh.admission.spatial.samples[0].cells[1].bodyIds={not:'array'};assert.match(render({result:bad}),/disabled=""/);
  bad.mesh.admission.spatial.samples=[];bad.mesh.admission.spatial.status='partial';bad.mesh.admission.spatial.skippedHighOrderCount=2;assert.match(render({result:bad}),/不能据此证明高阶曲边单元无相交/);
});
