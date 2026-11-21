import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMeshAdmission,captureMeshInventory} from '../gateway/mesh-admission.mjs';
import {meshAdmitted} from '../shared/mesh-admission.mjs';
import {admissionFixture} from './helpers/mesh-admission-fixture.mjs';
const assess=fixture=>assessMeshAdmission(fixture.mesh,fixture.index,fixture.source);
test('a complete indexed tetrahedral mesh is admitted independently of job completion and freshness',()=>{
  const f=admissionFixture(),report=assess(f);assert.equal(report.status,'accepted');assert.equal(meshAdmitted(report),true);assert.deepEqual(report.reasons,[]);assert.equal(report.counts.volumeCount,1);assert.equal(report.counts.meshedVolumeCount,1);
  for(const value of [undefined,{version:1,status:'blocked',usable:true},{version:2,status:'accepted',usable:true}])assert.equal(meshAdmitted(value),false);
});
test('a user quality threshold remains advisory, not a hidden rejection of valid thin/sliver cells',()=>{
  const f=admissionFixture({threshold:.9});f.mesh.quality.badCount=1;const report=assess(f);assert.equal(report.status,'warning');assert.equal(report.usable,true);assert.equal(report.counts.lowQualityCount,1);
});
test('inverted, degenerate and invalid cells are rejected from numerical data even when saved boolean flags claim success',()=>{
  for(const type of ['inverted','degenerate','invalid']){const f=admissionFixture(),cell=f.index.cells[0];if(type==='inverted')cell.minJacobian=-1;else if(type==='degenerate')cell.minJacobian=0;else cell.quality=null;
    const report=assess(f);assert.equal(report.status,'blocked');assert.equal(report.usable,false);assert.equal(report.counts[type+'Count'],1);assert.ok(report.reasons.some(row=>row.code==='QUALITY_SUMMARY_INCONSISTENT'));}
});
test('an empty fragment of a multi-Solid Body is not masked by another successfully meshed fragment',()=>{
  const f=admissionFixture();f.mesh.render.groups.push({...f.mesh.render.groups[0],solidId:'solid-2',groupId:'solid-2/owner/body-1'});f.mesh.render.ownership.assignments.push({volumeTag:2,solidIndex:1,bodyId:'body-1',confidence:1});const report=assess(f);assert.equal(report.status,'blocked');assert.equal(report.counts.volumeCount,2);assert.equal(report.counts.meshedVolumeCount,1);assert.ok(report.reasons.some(row=>row.code==='EMPTY_MESH_VOLUMES'));
});
test('partial coverage, unmapped ownership and inconsistent summary counters cannot pass the gate',()=>{
  for(const damage of [f=>f.mesh.quality.unsupportedElementCount=1,f=>f.mesh.quality.tetraCount=2,f=>f.mesh.quality.badCount=100,f=>f.mesh.nodeCount=100,f=>f.index.cells[0].volumeTag=99,f=>f.mesh.render.ownership.unmappedBodyIds=['body-1'],f=>f.mesh.boundaryMapping.complete=false,f=>f.mesh.boundaryMapping.surfaces[0].elementCount=0,f=>f.mesh.conformity.nonConformalCount=1]){const f=admissionFixture();damage(f);assert.equal(assess(f).usable,false);}
});
test('a Sheet with no surface elements is not silently dropped from an all-geometry mesh',()=>{
  const f=admissionFixture();f.source.bodies.push({...f.source.bodies[0],bodyId:'sheet-1',kind:'sheet'});const report=assess(f);assert.equal(report.status,'blocked');assert.ok(report.reasons.some(row=>row.code==='SHEET_COVERAGE_MISSING'));
});
test('shared volume cells count once globally while retaining every owning Body',()=>{
  const f=admissionFixture(),body={...f.source.bodies[0],bodyId:'body-2'};f.source.bodies.push(body);f.mesh.sourceInventory.solids[0].bodyIds.push(body.bodyId);f.mesh.render.groups.push({...f.mesh.render.groups[0],bodyId:body.bodyId,groupId:'solid-1/owner/body-2'});f.mesh.render.ownership.assignments.push({...f.mesh.render.ownership.assignments[0],bodyId:body.bodyId});f.index.cells[0].bodyIds.push(body.bodyId);const report=assess(f);assert.equal(report.status,'accepted');assert.equal(report.counts.tetraCount,1);assert.equal(report.counts.volumeCount,1);
});

test('an entirely omitted Solid or Face cannot disappear from both the result and its self-reported inventory',()=>{
  const f=admissionFixture();f.mesh.sourceInventory.solids.push({solidIndex:1,bodyIds:['body-1']});
  assert.ok(assess(f).reasons.some(row=>row.code==='PREPARED_COVERAGE_INCOMPLETE'));
  assert.equal(assess(f).counts.volumeCount,2);assert.equal(assess(f).counts.meshedVolumeCount,1,'The UI denominator must include an entirely omitted fragment');
  const g=admissionFixture();g.mesh.sourceInventory.surfaceCount=2;g.mesh.sourceInventory.sourceFaceKeys.push('body-1/face-2-2');assert.ok(assess(g).reasons.some(row=>row.code==='PREPARED_FACE_COVERAGE_INCOMPLETE'));
  const legacy=admissionFixture();delete legacy.mesh.sourceInventory;assert.equal(assess(legacy).status,'unverified');
});

test('interface and embedded-surface reports must cover the boundary inventory, not just self-reported counters',()=>{
  const f=admissionFixture();f.mesh.boundaryMapping.surfaces[0].embeddedSolidIds=['solid-1'];f.mesh.boundaryMapping.surfaces[0].adjacentSolidIds=[];
  const outer=structuredClone(f.mesh.boundaryMapping.surfaces[0]),anchor={...outer.sources[0],cadFaceId:'face-2-2'};Object.assign(outer,{surfaceTag:2,meshFaceId:'mesh-face-2',sources:[anchor],adjacentSolidIds:['solid-1'],embeddedSolidIds:[]});f.mesh.boundaryMapping.surfaces.push(outer);f.mesh.boundaryMapping.sourceFaces.push({source:anchor,state:'mapped',surfaceTags:[2]});f.mesh.sourceInventory.surfaceCount++;f.mesh.sourceInventory.sourceFaceKeys.push('body-1/face-2-2');
  assert.ok(assess(f).reasons.some(row=>row.code==='CONFORMITY_COVERAGE_INCOMPLETE'));
  f.mesh.conformity={basis:'shared-node-tags',interfaceCount:0,embeddedSurfaceCount:1,nonConformalCount:0,interfaces:[{surfaceTag:1,role:'embedded',nodeCount:3,missingNodeReferences:0,volumeTags:[1],bodyIds:['body-1']}]};assert.equal(assess(f).usable,true);
  for(const damage of [g=>g.mesh.conformity.interfaces[0].surfaceTag=99,g=>g.mesh.conformity.interfaces[0].bodyIds=[],g=>g.mesh.conformity.interfaces[0].role='interface',g=>g.mesh.conformity.interfaces.push(g.mesh.conformity.interfaces[0])]){const g=structuredClone(f);damage(g);assert.equal(assess(g).usable,false);}
});

test('reversed Jacobian ranges and contradictory summary counts are not accepted as finite valid cells',()=>{
  const f=admissionFixture();f.index.cells[0].maxJacobian=.5;const report=assess(f);assert.equal(report.status,'blocked');assert.equal(report.counts.badCount,1);assert.equal(report.counts.invalidCount,1);
});

test('prepared inventory is captured from the CAD manifest with shared owners deduplicated, never synthesized from mesh output',()=>{
  const manifest={version:2,format:'brep',preprocessing:{backend:'occt-history',indexOrder:'solids-first-recursive',conformal:true},bodies:[{bodyId:'body-1',kind:'solid'}],solids:[{solidIndex:0,sources:[{bodyId:'body-1',sourceSolidIndex:0},{bodyId:'body-1',sourceSolidIndex:1}]}],faces:[{}],sourceFaces:[{source:{bodyId:'body-1',cadFaceId:'face-2-1'}}]};
  const proof=captureMeshInventory(manifest);assert.deepEqual(proof.solids,[{solidIndex:0,bodyIds:['body-1']}]);manifest.solids[0].sources[0].bodyId='foreign';assert.throws(()=>captureMeshInventory(manifest),/来源无效/);assert.equal(captureMeshInventory({version:1}),null);
});
test('old results without numeric evidence remain readable but unverified, never silently grandfathered into normal use',()=>{
  const f=admissionFixture();const report=assessMeshAdmission(f.mesh,null,f.source);assert.equal(report.status,'unverified');assert.equal(report.usable,false);
});
test('linear corner connectivity is cross-checked instead of trusting a positive saved Jacobian',()=>{
  for(const damage of [f=>f.index.cells[0].corners=[0,2,1,3],f=>f.index.cells[0].corners=[0,1,1,3],f=>f.index.positions[11]=0]){const f=admissionFixture();damage(f);const report=assess(f);assert.equal(report.usable,false);assert.equal(report.counts.invalidCount,1);}
  const tiny=admissionFixture();tiny.index.positions=tiny.index.positions.map(value=>value*1e-200);assert.equal(assess(tiny).usable,true,'Scale alone must not invalidate a positive linear tetrahedron');
});
