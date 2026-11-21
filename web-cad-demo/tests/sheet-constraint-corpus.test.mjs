import test from 'node:test';
import assert from 'node:assert/strict';
import {sheetConstraintCases} from './helpers/sheet-constraint-corpus.mjs';
import {assertConstrainedVolumeInput} from '../gateway/volume-partition-protocol.mjs';
test('analytic Sheet corpus retains separate shell, embedding, exterior and refusal expectations',()=>{
  const cases=sheetConstraintCases();assert.deepEqual(cases,sheetConstraintCases());assert.equal(cases.length,17);assert.equal(new Set(cases.map(row=>row.name)).size,17);
  for(const row of cases){if(row.reject?.includes('VOLUME_SOLID_REQUIRED'))assert.throws(()=>assertConstrainedVolumeInput(row.input),{code:'VOLUME_SOLID_REQUIRED'});else assertConstrainedVolumeInput(row.input);}
});
test('a true hollow source uses one Solid identity and reverses only its inner shell',()=>{
  const cases=sheetConstraintCases(),hollow=cases.find(row=>row.name==='hollow-source-preserves-cavity-without-Sheets'),bad=cases.find(row=>row.name==='wrong-cavity-orientation-is-not-silently-reinterpreted');
  assert.equal(new Set(hollow.input.sources.map(row=>row.bodyId+'/'+row.solidId)).size,1);assert.equal(hollow.volume,7);assert.equal(hollow.input.triangles.length,24);
  assert.deepEqual(hollow.input.triangles.slice(0,12),bad.input.triangles.slice(0,12));
  for(let i=12;i<24;i++){const [a,b,c]=hollow.input.triangles[i];assert.deepEqual(bad.input.triangles[i],[a,c,b]);}
});
test('an open Sheet cannot replace missing source-Solid faces even when geometrically coincident',()=>{
  const row=sheetConstraintCases().find(item=>item.name==='Sheet-cannot-close-an-open-Solid');
  assert.equal(row.input.triangles.length,12);assert.equal(row.input.sources.filter(source=>source.solidId).length,10);assert.equal(row.input.sources.filter(source=>!source.solidId).length,2);assert.ok(row.reject.includes('VOLUME_OPEN_BOUNDARY'));
});
