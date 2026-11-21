import test from 'node:test';import assert from 'node:assert/strict';
import {assertPatchedCheckpointInput,patchedCheckpointRequest,assertPatchedCheckpointRequest,checkpointGenerationInput,assertPatchedCheckpointHandshake,assertPatchedCheckpointResult,assertPatchedOptimizationInput,assertPatchedOptimizationResult,PATCHED_MESH_CHECKPOINT_PROTOCOL as P} from '../gateway/patched-checkpoint-protocol.mjs';
import {assertCheckpointInput,assertCheckpointResult} from '../gateway/mesh-checkpoint-protocol.mjs';
import {validateDiscreteNativePacket} from '../gateway/discrete-native-validation.mjs';import {discreteValidationBinary,assertDiscreteValidationReceipt} from '../gateway/discrete-validation-envelope.mjs';
import {patchedCheckpointFixture} from './helpers/patched-checkpoint-fixture.mjs';
test('patched checkpoint pins its own capability and versioned embedded snapshot without reinterpreting legacy input',()=>{
  const f=patchedCheckpointFixture();assertPatchedCheckpointInput(f.input,{sourceInput:f.source});assert.equal(assertPatchedCheckpointHandshake(f.health).basis,P.basis);assert.throws(()=>assertCheckpointInput(f.input,{sourceInput:f.source}));assert.throws(()=>assertCheckpointResult(f.saved,f.input,'saved'));
  for(const key of Object.keys(P)){const health=structuredClone(f.health);health.capabilities.patchedMeshCheckpoint[key]=null;assert.throws(()=>assertPatchedCheckpointHandshake(health));}
});
test('embedded curve-in-face and face-in-volume identities are both required, not just matching coordinates',()=>{
  const f=patchedCheckpointFixture();assertPatchedCheckpointResult(f.saved,f.input,'saved');assert.ok(f.saved.checkpoint.entities.some(e=>e.dimension===2&&e.embedded.length));assert.ok(f.saved.checkpoint.entities.some(e=>e.dimension===3&&e.embedded.length));assertPatchedOptimizationInput(f.optimizationInput,{sourceInput:f.source});
});
test('an exterior Sheet checkpoint never invents an embedded volume owner',()=>{
  const f=patchedCheckpointFixture({sheet:'exterior'});assertPatchedCheckpointResult(f.saved,f.input,'saved');assertPatchedOptimizationResult(f.output,f.optimizationInput,'optimized');assert.ok(f.saved.checkpoint.entities.filter(e=>e.dimension===3).every(e=>e.embedded.length===0));
});
test('separate optimization validates the original baseline and protects all source patches with exact tag identity',()=>{
  const f=patchedCheckpointFixture();assertPatchedOptimizationInput(f.optimizationInput,{sourceInput:f.source});assertPatchedOptimizationResult(f.output,f.optimizationInput,'optimized');assert.equal(f.output.normalMeshAdmitted,false);
});
test('persisted native key ordering is independent of the original request bytes used for source digests',()=>{
  const f=patchedCheckpointFixture(),sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value;
  f.saved=JSON.parse(JSON.stringify(sort(f.saved)));assert.notEqual(JSON.stringify(f.saved.generationInput),f.saved.generationInputWire);
  const input={generationInput:f.saved.generationInput,checkpointResult:f.saved};assert.deepEqual(checkpointGenerationInput(f.saved),f.input);assertPatchedOptimizationInput(input,{sourceInput:f.source});assertPatchedOptimizationResult(f.output,input,'optimized');
  const request=patchedCheckpointRequest(f.input);assertPatchedCheckpointRequest(request,{sourceInput:f.source});assertPatchedCheckpointResult(f.saved,request,'saved');
  assert.throws(()=>assertPatchedCheckpointInput(f.saved.generationInput,{sourceInput:f.source}));
});
test('original generation bytes cannot be missing, malformed, changed, duplicated or unbounded',()=>{
  for(const mutate of [r=>delete r.generationInputWire,r=>r.generationInputWire='{',r=>r.generationInputWire+=' ',r=>r.generationInputWire=r.generationInputWire.replace('{','{"meshSize":123,'),r=>{const input=JSON.parse(r.generationInputWire);input.meshSize+=1;r.generationInputWire=JSON.stringify(input);},r=>r.generationInputWire=' '.repeat(8*1024**2+1)]){const f=patchedCheckpointFixture();mutate(f.saved);assert.throws(()=>assertPatchedOptimizationInput({generationInput:f.input,checkpointResult:f.saved},{sourceInput:f.source}),{code:'MESH_CHECKPOINT_INVALID'});}
  const f=patchedCheckpointFixture();f.saved.algorithm.generationInputBinding='semantic-only';assert.throws(()=>assertPatchedOptimizationInput(f.optimizationInput,{sourceInput:f.source}),{code:'MESH_CHECKPOINT_INVALID'});
});
const mutations={
  'old snapshot version':r=>r.checkpoint.version=1,
  'old snapshot basis':r=>r.checkpoint.basis='bounded-gmsh-entity-mesh-v1',
  'missing embedded volume face':r=>r.checkpoint.entities.find(e=>e.dimension===3).embedded=[],
  'missing embedded face curve':r=>r.checkpoint.entities.find(e=>e.dimension===2&&e.embedded.length).embedded=[],
  'invented embedded endpoint':r=>r.checkpoint.entities.find(e=>e.dimension===2).embedded=[[0,1]],
  'embedded boundary instead of internal curve':r=>{const e=r.checkpoint.entities.find(e=>e.dimension===2);e.embedded=[[1,Math.abs(e.boundary[0])]];},
  'duplicate embedded entity':r=>{const e=r.checkpoint.entities.find(e=>e.dimension===3);e.embedded.push([...e.embedded[0]]);},
  'foreign containing volume':r=>r.checkpoint.entities.find(e=>e.dimension===3).embedded=[[2,99999]],
  'missing entity embedded field':r=>delete r.checkpoint.entities[0].embedded,
  'reversed source curve elements':r=>r.checkpoint.entities.find(e=>e.dimension===1).vertices[0].reverse(),
  'reversed patch triangle':r=>{const e=r.checkpoint.entities.find(e=>e.dimension===2);[e.vertices[0][0],e.vertices[0][1]]=[e.vertices[0][1],e.vertices[0][0]];},
  'changed signed volume boundary':r=>{const e=r.checkpoint.entities.find(e=>e.dimension===3);e.boundary=e.boundary.map(n=>-n).sort((a,b)=>a-b);},
  'changed node identity':r=>r.checkpoint.pointNodeTags[0]=99999,
  'false mesh admission':r=>r.normalMeshAdmitted=true,
  'changed optimization policy':r=>r.generationInput.optimization.method='netgen',
  'changed point geometry':r=>r.checkpoint.entities[0].coordinates[0]+=.01,
  'non-finite parameters':r=>r.checkpoint.entities.find(e=>e.dimension===1).parameters=[Infinity],
};
for(const [name,mutate]of Object.entries(mutations))test('patched checkpoint rejects '+name,()=>{const f=patchedCheckpointFixture();mutate(f.saved);assert.throws(()=>assertPatchedCheckpointResult(f.saved,f.input,'saved'),{code:'MESH_CHECKPOINT_INVALID'});});
test('checkpoint optimization cannot start without original process exit, embedded capability or resource proof',()=>{
  for(const mutate of [r=>delete r.execution,r=>r.execution.exitCode=2,r=>r.algorithm.embeddedRelationships=false,r=>r.processResources.enforced=false]){const f=patchedCheckpointFixture();mutate(f.saved);assert.throws(()=>assertPatchedOptimizationInput(f.optimizationInput,{sourceInput:f.source}));}
});
test('optimized output refuses lost topology attestation, changed boundary tags, coordinates or baseline quality',()=>{
  for(const mutate of [r=>r.embeddedTopologyUnchanged=false,r=>r.restoredExactly=false,r=>r.pointNodeTags[0]=999999,r=>r.mesh.points[0][0]+=.01,r=>r.mesh.optimization.before.minimumSICN=.1]){const f=patchedCheckpointFixture();mutate(f.output);assert.throws(()=>assertPatchedOptimizationResult(f.output,f.optimizationInput,'optimized'));
  }
});
test('both patched checkpoint stages use the existing transferable material validator with phase-bound receipts',()=>{
  const f=patchedCheckpointFixture(),id='mesh-checkpoint-00000000-0000-4000-8000-000000000001';f.saved.requestId=id;f.output.requestId=id;
  for(const [operation,input,candidate]of [['mesh.discrete-patched-checkpoint',patchedCheckpointRequest(f.input),f.saved],['mesh.discrete-patched-optimize',f.optimizationInput,f.output]])for(const phase of ['input','result']){const {packet,sha256}=discreteValidationBinary({phase,operation,requestId:id,input,context:{sourceInput:f.source},...phase==='result'&&{candidate}});assertDiscreteValidationReceipt(validateDiscreteNativePacket(packet),packet,sha256);}
});
