import {cadDiscreteTetraFixture} from './cad-discrete-tetra-fixture.mjs';
import {checkpointInput,checkpointResult,optimizedCheckpointResult} from './mesh-checkpoint-fixture.mjs';
import {tetraMeshInput} from '../../gateway/discrete-tetra-task-result.mjs';
import {MESH_CHECKPOINT_PROTOCOL as P} from '../../gateway/mesh-checkpoint-protocol.mjs';
export function cadCheckpointFixture(){
  const f=cadDiscreteTetraFixture(),original=checkpointInput();f.snapshot.settings.optimization=structuredClone(original.optimization);
  const checkpoint=checkpointResult(),optimized=optimizedCheckpointResult();
  checkpoint.generationInput=tetraMeshInput(f.snapshot,f.domain);
  for(const mesh of [checkpoint.baseline,optimized.mesh]){
    mesh.sources=structuredClone(f.output.sources);mesh.sourceSolids=structuredClone(f.output.sourceSolids);
    mesh.boundaries.forEach((boundary,i)=>boundary.sourceTriangleIds=[...f.output.boundaries[i].sourceTriangleIds]);
  }
  Object.assign(optimized,{processResources:structuredClone(f.output.processResources),algorithm:{version:1,basis:P.optimizationBasis,gmshVersion:P.gmshVersion,apiVersion:P.apiVersion,license:P.license},execution:structuredClone(f.output.execution)});
  return {...f,checkpoint,optimized};
}
