import {cadConstrainedTetraFixture} from './cad-constrained-tetra-fixture.mjs';
import {patchedCheckpointFixture} from './patched-checkpoint-fixture.mjs';
import {tetraMeshInput} from '../../gateway/discrete-tetra-task-result.mjs';
import {PATCHED_MESH_CHECKPOINT_PROTOCOL as P} from '../../gateway/patched-checkpoint-protocol.mjs';
export function cadConstrainedCheckpointFixture({sheet='embedded'}={}){
  const f=cadConstrainedTetraFixture({sheet}),native=patchedCheckpointFixture({sheet});
  f.snapshot.settings.optimization=structuredClone(native.input.optimization);const input=tetraMeshInput(f.snapshot,f.domain),checkpoint=native.saved,optimized=native.output;
  checkpoint.generationInput=structuredClone(input);checkpoint.generationInputWire=JSON.stringify(input);
  for(const mesh of [checkpoint.baseline,optimized.mesh]){
    mesh.sources=structuredClone(f.output.sources);mesh.sourceSolids=structuredClone(f.output.sourceSolids);mesh.patchDomainSha256=input.patchPlan.domainSha256;mesh.patchSourceInputSha256=input.patchPlan.sourceInputSha256;
    for(let i=0;i<mesh.patches.length;i++){const plan=input.patchPlan.patches[i];Object.assign(mesh.patches[i],{sourceFaces:structuredClone(plan.sourceFaces),sourceTriangleIndexes:[...plan.triangleIndexes],sourceTriangleOrientations:[...plan.triangleOrientations],cellUses:structuredClone(plan.cellUses),constraint:structuredClone(plan.constraint)});}
  }
  Object.assign(optimized,{processResources:structuredClone(f.output.processResources),algorithm:{...checkpoint.algorithm,basis:P.optimizationBasis},execution:structuredClone(f.output.execution)});
  return {...f,input,checkpoint,optimized};
}
