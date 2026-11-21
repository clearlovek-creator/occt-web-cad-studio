import test from 'node:test';import assert from 'node:assert/strict';
import {assertPatchedDiscreteTetraInput,assertPatchedDiscreteTetraResult,assertPatchedDiscreteTetraHandshake,patchedDiscreteTetraFailure,PATCHED_DISCRETE_TETRA_PROTOCOL as P} from '../gateway/patched-tetra-protocol.mjs';
import {assertDiscreteTetraInput,assertConstrainedDiscreteTetraInput,assertDiscreteTetraResult} from '../gateway/discrete-tetra-protocol.mjs';
import {validateDiscreteNativePacket} from '../gateway/discrete-native-validation.mjs';
import {discreteValidationBinary,assertDiscreteValidationReceipt} from '../gateway/discrete-validation-envelope.mjs';
import {patchedTetraFixture} from './helpers/patched-tetra-fixture.mjs';
test('patched input binds exact topology and original native source proof without weakening either old family',()=>{
  const f=patchedTetraFixture();assertPatchedDiscreteTetraInput(f.input,{sourceInput:f.source});assert.throws(()=>assertDiscreteTetraInput(f.input,{sourceInput:f.source}));assert.throws(()=>assertConstrainedDiscreteTetraInput(f.input,{sourceInput:f.source}));
  const bad=structuredClone(f);bad.input.patchPlan.edges.pop();assert.throws(()=>assertPatchedDiscreteTetraInput(bad.input,{sourceInput:bad.source}),{code:'MESH_PATCH_INVALID'});
});
test('patched capability pins versions, topology basis and bounded coverage work independently of old capabilities',()=>{
  const f=patchedTetraFixture();assert.equal(assertPatchedDiscreteTetraHandshake(f.health).basis,P.basis);
  for(const key of Object.keys(P)){const h=structuredClone(f.health);h.capabilities.patchedDiscreteTetra[key]=null;assert.throws(()=>assertPatchedDiscreteTetraHandshake(h));}
  delete f.health.capabilities.patchedDiscreteTetra;assert.throws(()=>assertPatchedDiscreteTetraHandshake(f.health));
});
test('one patch retains full source-face and cell ownership, not a guessed single source triangle',()=>{
  const f=patchedTetraFixture();assert.equal(assertPatchedDiscreteTetraResult(f.output,f.input,'tetra'),f.output);assert.equal(f.output.patches.length,6);assert.throws(()=>assertDiscreteTetraResult(f.output,f.input,'tetra'));
});
test('mesh triangles may cross removed artificial source diagonals while original per-triangle coverage is independently conserved',()=>{
  const f=patchedTetraFixture({reflected:true});assertPatchedDiscreteTetraInput(f.input,{sourceInput:f.source});assertPatchedDiscreteTetraResult(f.output,f.input,'tetra');
  assert.ok(f.output.patches.some(p=>p.triangles.some(t=>!f.input.domain.triangles.some(s=>[...t].sort().join(',')===[...s].sort().join(',')))));
});
test('coverage clipping uses a local scaled frame rather than cancellation-prone world-coordinate areas',()=>{
  const f=patchedTetraFixture({offset:[1e9,-1e9,1e9]});assertPatchedDiscreteTetraInput(f.input,{sourceInput:f.source});assertPatchedDiscreteTetraResult(f.output,f.input,'tetra');
});
for(const sheet of ['embedded','exterior'])test('patched '+sheet+' Sheet keeps its precise volume relationship and shared curve identities',()=>{
  const f=patchedTetraFixture({sheet});assertPatchedDiscreteTetraInput(f.input,{sourceInput:f.source});assertPatchedDiscreteTetraResult(f.output,f.input,'tetra');
});
test('patched input/result phases run in the existing binary material validator, with exact receipt binding',()=>{
  const f=patchedTetraFixture(),id='tetra-00000000-0000-4000-8000-000000000001';f.output.requestId=id;
  for(const phase of ['input','result']){const {packet,sha256}=discreteValidationBinary({phase,operation:'mesh.discrete-patched-tetra',requestId:id,input:f.input,context:{sourceInput:f.source},...phase==='result'&&{candidate:f.output}});assertDiscreteValidationReceipt(validateDiscreteNativePacket(packet),packet,sha256);}
});
const mutations={
  'wrong result operation':r=>r.operation='mesh.discrete-constrained-tetra',
  'false topology binding':r=>r.patchDomainSha256='0'.repeat(64),
  'foreign source Face':r=>r.patches[0].sourceFaces[0].faceId='foreign',
  'missing triangle provenance':r=>r.patches[0].sourceTriangleIndexes.pop(),
  'wrong cell side':r=>r.patches[0].cellUses[0].orientation*=-1,
  'lost patch':r=>r.patches.pop(),
  'lost source area':r=>r.patches[0].triangles.pop(),
  'duplicate facet':r=>r.patches[0].triangles.push([...r.patches[0].triangles[0]]),
  'coordinate-only crack':r=>{const t=r.patches[0].triangles[0];r.points.push([...r.points[t[0]]]);t[0]=r.points.length-1;r.report.nodeCount++;},
  'false SICN':r=>r.quality.minimumSICN=1,
  'normal mesh admission':r=>r.report.normalMeshAdmitted=true,
  'false surface counts':r=>r.report.surfaceTriangleCount++,
  'unbounded extra payload':r=>r.rawBodyData=[],
};
for(const [name,mutate]of Object.entries(mutations))test('patched protocol rejects '+name,()=>{const f=patchedTetraFixture(),r=structuredClone(f.output);mutate(r);assert.throws(()=>assertPatchedDiscreteTetraResult(r,f.input,'tetra'),{code:'MESH_PROTOCOL_INVALID'});});
test('structured failure cannot smuggle patch arrays into a refused result',()=>{
  const f=patchedTetraFixture(),r={ok:false,operation:'mesh.discrete-patched-tetra',code:'MESH_PATCH_INVALID',error:'invalid'};assert.equal(patchedDiscreteTetraFailure(r,f.input).code,r.code);assert.throws(()=>patchedDiscreteTetraFailure({...r,patches:[]},f.input));
});
