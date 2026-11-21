import test from 'node:test';
import assert from 'node:assert/strict';
import {LinearTetraSpatial,MESH_SPATIAL_LIMITS} from '../gateway/mesh-spatial.mjs';

test('a fully curved mesh does not reserve a linear spatial index for every skipped cell',()=>{
  const spatial=new LinearTetraSpatial(MESH_SPATIAL_LIMITS.cells,()=>0);
  for(let i=0;i<MESH_SPATIAL_LIMITS.cells;i++)spatial.add({order:2,elementType:11});
  const report=spatial.finish();
  assert.equal(report.checkedTetraCount,0);assert.equal(report.skippedHighOrderCount,MESH_SPATIAL_LIMITS.cells);
  assert.equal(report.resources.accountedBytes,0);assert.equal(report.status,'partial');
});
const positions=[0,0,0,1,0,0,0,1,0,0,0,1],cell={elementId:'1',elementType:4,order:1,volumeTag:7,corners:[0,1,2,3]};
test('mixed meshes reserve by actual linear coverage and preserve exact volume tags in overlap samples',()=>{
  const spatial=new LinearTetraSpatial(100002,n=>positions[n]);
  for(let i=0;i<100000;i++)spatial.add({order:2,elementType:11});
  spatial.add(cell);spatial.add({...cell,elementId:'2',volumeTag:9});
  const report=spatial.finish();assert.equal(report.checkedTetraCount,2);assert.ok(report.resources.accountedBytes<100000);assert.deepEqual(report.samples[0].volumeTags,[7,9]);
});
test('block growth counts all retained blocks and failure preserves old records but cannot publish a partial report',()=>{
  const spatial=new LinearTetraSpatial(2048,n=>positions[n],{bytes:100000});
  for(let i=0;i<1024;i++)spatial.add({...cell,elementId:String(i+1)});
  const old=spatial.blocks[0].corners,oldIds=spatial.blocks[0].ids;
  assert.throws(()=>spatial.add({...cell,elementId:'1025'}),{code:'MESH_ARTIFACT_LIMIT'});
  assert.equal(spatial.blocks[0].corners,old);assert.equal(spatial.blocks[0].ids,oldIds);assert.equal(spatial.size,1024);assert.equal(spatial.blocks[0].ids[0],'1');
  assert.throws(()=>spatial.finish(),{code:'MESH_ARTIFACT_LIMIT'});assert.throws(()=>spatial.add(cell),{code:'MESH_ARTIFACT_LIMIT'});
});
test('the full consumed stream is required and a sealed spatial report is idempotent',()=>{
  const partial=new LinearTetraSpatial(2,n=>positions[n]);partial.add(cell);assert.throws(()=>partial.finish(),{code:'MESH_ARTIFACT_LIMIT'});
  const complete=new LinearTetraSpatial(1,n=>positions[n]);complete.add(cell);const report=complete.finish();assert.equal(complete.finish(),report);assert.equal(report.overlapPairCount,0);
  assert.throws(()=>complete.add(cell),{code:'MESH_ARTIFACT_LIMIT'});
});
test('IDs, volume provenance and coordinates remain exact across a 1024-cell block boundary',()=>{
  const positions=[],spatial=new LinearTetraSpatial(1025,n=>positions[n]);
  for(let i=0;i<1025;i++){
    const x=Math.min(i,1023)*3,base=positions.length/3;positions.push(x,0,0,x+1,0,0,x,1,0,x,0,1);
    spatial.add({...cell,elementId:String(1000000000000n+BigInt(i)),volumeTag:i===1024?23:17,corners:[base,base+1,base+2,base+3]},true);
  }
  const report=spatial.finish();assert.equal(spatial.blocks.length,2);assert.equal(report.overlapPairCount,1);assert.deepEqual(report.samples[0].elementIds,['1000000001023','1000000001024']);assert.deepEqual(report.samples[0].volumeTags,[17,23]);assert.deepEqual(report.samples[0].ownersVerified,[true,true]);assert.deepEqual(report.samples[0].corners[0],report.samples[0].corners[1]);
});
