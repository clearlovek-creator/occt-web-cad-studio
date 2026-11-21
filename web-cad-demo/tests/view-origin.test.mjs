import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {importTestTypeScript} from './helpers/import-typescript.mjs';
const {createMeshQualityHighlight}=await importTestTypeScript('../app/model/mesh-quality-render.ts',import.meta.url);
const {createPreparationPreview}=await importTestTypeScript('../app/model/mesh-preparation-render.ts',import.meta.url);
const {makePropertyHighlight}=await importTestTypeScript('../app/modeling/property-highlight.ts',import.meta.url);
const {localizePositions,localizeCoordinateValues,viewportSpan,viewportOrbitLimits}=await importTestTypeScript('../app/model/viewport-coordinates.ts',import.meta.url);
const offset=1e9,corners=[0,0,0,8,0,0,0,6,0,0,0,4].map(n=>n+offset),indices=[0,2,1,0,1,3,1,2,3,2,0,3];
const cell={elementId:'1',corners,locatable:true,invalid:false,inverted:false,degenerate:false,quality:.8};
const dimensions=object=>new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray();
const dispose=object=>object.traverse(node=>{node.geometry?.dispose();if(Array.isArray(node.material))node.material.forEach(m=>m.dispose());else node.material?.dispose();});
test('quality diagnostics preserve an eight-by-six-by-four tetrahedron at a billion-unit global offset',()=>{
  const group=createMeshQualityHighlight(cell);try{assert.deepEqual(dimensions(group),[8,6,4]);const ray=new THREE.Raycaster(new THREE.Vector3(offset+1,offset+1,offset+10),new THREE.Vector3(0,0,-1));group.updateMatrixWorld(true);assert.ok(ray.intersectObject(group,true).length>0);}finally{dispose(group);}
});
test('read-only preparation previews preserve dimensions and do not change source coordinates',()=>{
  const positions=indices.flatMap(i=>corners.slice(i*3,i*3+3)),preview={positions,normals:Array.from({length:positions.length},(_,i)=>i%3===2?1:0),indices:positions.map((_,i)=>i).filter(i=>i<positions.length/3),edges:[]},before=JSON.stringify(preview),group=createPreparationPreview(preview);
  try{assert.deepEqual(dimensions(group),[8,6,4]);assert.equal(JSON.stringify(preview),before);}finally{dispose(group);}
});
test('property association highlights remain at their real global location with native extent and source untouched',()=>{
  const body={bodyId:'body-1',bodyIdentity:'a'.repeat(32),visible:true},presentation={bodyId:body.bodyId,positions:corners,normals:Array(12).fill(0),indices,triangleFaceIds:['face-1-1','face-1-2','face-1-3','face-1-4'],edges:[]},before=JSON.stringify(presentation),group=makePropertyHighlight([{kind:'body',bodyId:body.bodyId}],[body],[presentation],0xff0000,0);
  try{assert.deepEqual(dimensions(group),[8,6,4]);assert.equal(JSON.stringify(presentation),before);assert.equal(new THREE.Box3().setFromObject(group).min.x,offset);}finally{dispose(group);}
});
test('coordinate buffers contain only local float32 deltas and preserve caller-owned arrays and explicit shared anchors',()=>{
  const source=[offset,offset,offset,offset+8,offset+6,offset+4],before=[...source],local=localizePositions(source);
  assert.deepEqual(local.origin,[offset,offset,offset]);assert.deepEqual([...local.positions],[0,0,0,8,6,4]);assert.deepEqual(source,before);
  const subset=localizePositions(source.slice(3),local.origin);assert.deepEqual([...subset.positions],[8,6,4]);
  const bytes=new ArrayBuffer(48),view=new DataView(bytes);source.forEach((n,i)=>view.setFloat64(i*8,n,true));assert.deepEqual([...localizeCoordinateValues(6,i=>view.getFloat64(i*8,true)).positions],[0,0,0,8,6,4]);
});
test('invalid or unrepresentable local spans fail explicitly, while fit-to-model does not hide sub-unit geometry',()=>{
  for(const source of [[1,2], [NaN,0,0], [0,0,0,1e100,0,0]])assert.throws(()=>localizePositions(source),{code:'VIEWPORT_COORDINATES_INVALID'});
  assert.equal(viewportSpan(.0001),.0001);assert.equal(viewportSpan(0),1);assert.throws(()=>viewportSpan(Infinity),{code:'VIEWPORT_COORDINATES_INVALID'});
});

test('orbit navigation limits never clamp a fitted tiny or large part back to a fixed engineering-unit distance',()=>{
  for(const span of [.008,8,8000]){const limits=viewportOrbitLimits(span),fitDistance=span*2.1;assert.ok(limits.minDistance<fitDistance&&limits.maxDistance>fitDistance);assert.ok(limits.maxDistance<span*100);}
  assert.ok(viewportOrbitLimits(.008).minDistance<.001);assert.ok(viewportOrbitLimits(8000).maxDistance>5000);
});
