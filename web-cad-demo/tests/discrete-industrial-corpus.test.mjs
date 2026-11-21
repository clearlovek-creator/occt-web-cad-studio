import test from 'node:test';
import assert from 'node:assert/strict';
import {discreteIndustrialCases,boxSoup} from './helpers/discrete-industrial-corpus.mjs';
import {assertVolumePartitionInput} from '../gateway/volume-partition-protocol.mjs';

test('synthetic discrete stress corpus is reproducible, bounded and explicitly labeled',()=>{
  const first=discreteIndustrialCases();assert.deepEqual(first,discreteIndustrialCases());
  assert.equal(new Set(first.map(row=>row.name)).size,first.length);
  assert.equal(first.length,13);
  for(const row of first){assertVolumePartitionInput(row.input);assert.equal(row.input.triangles.length,row.input.sources.length);assert.ok(row.input.triangles.length<=24);}
});

test('far-origin and rational-rotation samples preserve analytic geometry and source identities',()=>{
  const original=boxSoup([{min:[0,0,0],max:[2,2,2]}]);
  for(const options of [{offset:[1e6,-1e6,1e6]},{rotate:true},{rotate:true,offset:[1e6,-1e6,1e6]}]){
    const transformed=boxSoup([{min:[0,0,0],max:[2,2,2]}],options);
    assert.deepEqual(transformed.sources,original.sources);assert.deepEqual(transformed.triangles,original.triangles);
    for(let i=0;i<original.points.length;i++)for(let j=0;j<i;j++){
      const length=points=>Math.hypot(...points[i].map((x,k)=>x-points[j][k]));
      assert.ok(Math.abs(length(transformed.points)-length(original.points))<3e-10);
    }
  }
});

test('small-gap corpus does not pre-weld distinct source vertices or inflate the sliver',()=>{
  const cases=discreteIndustrialCases(),gap=cases.find(row=>row.name==='near-gap'),sliver=cases.find(row=>row.name==='narrow-overlap');
  assert.equal(gap.input.points[8][0],2.0001);assert.equal(gap.volume,16);
  assert.equal(sliver.input.points[8][0],1.9999);assert.equal(sliver.volume,15.9996);
  assert.notEqual(gap.input.sources[0].bodyId,gap.input.sources[12].bodyId);
  assert.deepEqual(cases.find(row=>row.name==='open-boundary').reject,['VOLUME_OPEN_BOUNDARY','VOLUME_NON_MANIFOLD']);
});
