import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {importTestTypeScript} from './helpers/import-typescript.mjs';
const {canonicalPropertyHighlightTargets,makePropertyHighlight}=await importTestTypeScript('../app/modeling/property-highlight.ts',import.meta.url);
const body={bodyId:'body-1',bodyIdentity:'a'.repeat(32),topologyIdentity:'b'.repeat(32),topologyRevision:1,faceCount:2,edgeCount:1,visible:true};
const target=kind=>({kind,bodyId:body.bodyId,...(kind==='body'?{}:{topologyId:`${kind}-1-1`})});
const presentation={bodyId:body.bodyId,positions:[0,0,0,2,0,0,0,2,0,0,0,2],normals:[0,0,1,0,0,1,0,0,1,0,1,0],indices:[0,1,2,0,1,3],triangleFaceIds:['face-1-1','face-1-2'],edges:[{edgeId:'edge-1-1',points:[0,0,0,2,0,0]}]};
const dispose=group=>group.traverse(item=>{item.geometry?.dispose();item.material?.dispose();});
test('association overlays use real indexed faces and edge curves, deduplicate picks and own only their own buffers',()=>{
  const original=JSON.stringify(presentation),group=makePropertyHighlight([target('face'),target('edge'),target('face')],[body],[presentation],0xff0000,0);
  assert.equal(group.children.length,2);assert.equal(group.userData.renderedTargets,2);
  assert.deepEqual([...group.children[0].geometry.attributes.position.array],[0,0,0,2,0,0,0,2,0]);
  assert.deepEqual([...group.children[1].geometry.attributes.position.array],[0,0,0,2,0,0]);
  dispose(group);assert.equal(JSON.stringify(presentation),original);
  const hidden=makePropertyHighlight([target('face')],[{...body,visible:false}],[],1,0);assert.equal(hidden.children.length,0);assert.equal(hidden.userData.renderedTargets,0);dispose(hidden);
});
test('association overlays reject stale identities, topology revisions, malformed data and unbounded collections',()=>{
  for(const changed of [{...target('face'),bodyIdentity:'c'.repeat(32)},{...target('edge'),topologyIdentity:'c'.repeat(32)},{...target('face'),topologyRevision:2},{...target('face'),topologyId:'face-1-01'},{kind:'unknown',bodyId:body.bodyId}])assert.throws(()=>canonicalPropertyHighlightTargets([changed],[body]));
  assert.throws(()=>canonicalPropertyHighlightTargets(Array.from({length:257},()=>target('body')),[body]),/256/);
  assert.throws(()=>makePropertyHighlight([target('face')],[body],[{...presentation,positions:[NaN]}],1,0),/显示数据/);
  let geometries=0,materials=0;const oldGeometry=THREE.BufferGeometry.prototype.dispose,oldMaterial=THREE.Material.prototype.dispose;
  THREE.BufferGeometry.prototype.dispose=function(){geometries++;return oldGeometry.call(this);};THREE.Material.prototype.dispose=function(){materials++;return oldMaterial.call(this);};
  try{assert.throws(()=>makePropertyHighlight([target('face'),{...target('face'),topologyId:'face-1-2'}],[body],[{...presentation,triangleFaceIds:['face-1-1']}],1,0),/显示数据/);assert.equal(geometries,1);assert.equal(materials,1);}finally{THREE.BufferGeometry.prototype.dispose=oldGeometry;THREE.Material.prototype.dispose=oldMaterial;}
});
