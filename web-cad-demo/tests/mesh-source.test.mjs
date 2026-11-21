import test from 'node:test';
import assert from 'node:assert/strict';
import {captureMeshSource,assessMeshSource,qualifyMeshGroups} from '../shared/mesh-source.mjs';
const body=(bodyId='body-1',bodyIdentity='a'.repeat(32),topologyIdentity='b'.repeat(32))=>({bodyId,bodyIdentity,topologyIdentity,topologyRevision:2,kind:'solid'});
const view=(bodies=[body()],revision=2)=>({ok:true,documentId:'test',revision,bodyCount:bodies.length,bodyMetadata:bodies});
test('mesh validity compares complete persistent geometry, not reused revision numbers',()=>{
  const source=captureMeshSource(view());assert.equal(assessMeshSource(source,view()).status,'current');
  assert.equal(assessMeshSource(source,view([body()],9)).status,'current','Metadata-only document changes retain the same geometry');
  assert.equal(assessMeshSource(source,view([body('body-1','c'.repeat(32))])).status,'stale');
  assert.equal(assessMeshSource(source,view([body('body-1','a'.repeat(32),'d'.repeat(32))])).status,'stale');
  assert.equal(assessMeshSource(source,view([body(),body('body-2')])).status,'stale','New bodies invalidate an all-geometry mesh');
  assert.equal(assessMeshSource(source,view([])).status,'stale');
  assert.equal(assessMeshSource(source,{...view(),documentId:'other'}).status,'stale');
  assert.equal(assessMeshSource(source,view()).status,'current','Undo to the exact identity is valid again');
});
test('legacy and incomplete mesh evidence fails closed; groups receive the exact source identity',()=>{
  assert.equal(assessMeshSource(undefined,view()).status,'unverified');
  const source=captureMeshSource(view());assert.equal(assessMeshSource(source,{ok:false,documentId:'test'}).status,'unverified');
  assert.throws(()=>captureMeshSource({...view(),bodyCount:2}),/不完整/);
  const groups=qualifyMeshGroups([{groupId:'s',bodyId:'body-1',faces:[{groupId:'f',bodyId:'body-1'}]}],source);
  assert.equal(groups[0].faces[0].topologyIdentity,source.bodies[0].topologyIdentity);
  assert.throws(()=>qualifyMeshGroups([{bodyId:'missing'}],source),/来源 Body/);
});

test('an analysis-policy/precision upgrade cannot invalidate a mesh whose complete persistent BRep identity is unchanged',()=>{
  const prior=view([{...body(),bounds:{min:[-1e-7,-1e-7,-1e-7],max:[10.0000001,10.0000001,10.0000001]},volume:1000}]),source=captureMeshSource(prior),current=view([{...body(),bounds:{min:[0,0,0],max:[10,10,10]},volume:999.9999999999999,area:600}]);current.spatialPolicy={version:1};assert.equal(assessMeshSource(source,current).status,'current');
});
