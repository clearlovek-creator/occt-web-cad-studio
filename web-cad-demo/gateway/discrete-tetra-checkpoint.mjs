import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertOptimizationCheckpointInput,MESH_CHECKPOINT_PROTOCOL as P} from './mesh-checkpoint-protocol.mjs';
import {assertPatchedOptimizationInput,PATCHED_MESH_CHECKPOINT_PROTOCOL as PP} from './patched-checkpoint-protocol.mjs';
import {validateTetraPartition,tetraExecutionInput,tetraMeshInput,isConstrainedTetraJob} from './discrete-tetra-task-result.mjs';

export const TETRA_CHECKPOINT_BYTES=128*1024**2;
export const TETRA_CHECKPOINT_RESERVATION_BYTES=384*1024**2;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=()=>{throw Object.assign(Error('优化检查点与原工程来源、分区、设置或生成进程证明不一致。'),{code:'MESH_ARTIFACT_INVALID'});};
export function tetraTaskCheckpoint(job,snapshot,partition,result){
  return {version:isConstrainedTetraJob(job)?2:1,basis:isConstrainedTetraJob(job)?'cad-bound-constrained-pre-optimization-checkpoint-v1':'cad-bound-pre-optimization-checkpoint-v1',jobId:job.jobId,sourceProof:{...job.artifact.discreteSource},partitionProof:{...job.artifact.partition},sourceSnapshotSha256:hash(snapshot),result};
}
export function validateTetraTaskCheckpoint(value,job,snapshot,partition){
  validateTetraPartition(partition,job,snapshot);
  const constrained=isConstrainedTetraJob(job);
  if(!value||Object.keys(value).length!==7||!['version','basis','jobId','sourceProof','partitionProof','sourceSnapshotSha256','result'].every(key=>Object.hasOwn(value,key))||value.version!==(constrained?2:1)||value.basis!==(constrained?'cad-bound-constrained-pre-optimization-checkpoint-v1':'cad-bound-pre-optimization-checkpoint-v1')||value.jobId!==(job.optimizationRecovery?.checkpointJobId||job.jobId)||job.options.optimizationProcess!=='checkpoint-v1'||!job.options.discreteTetra.optimization||!isDeepStrictEqual(value.sourceProof,job.artifact.discreteSource)||!isDeepStrictEqual(value.partitionProof,job.artifact.partition)||value.sourceSnapshotSha256!==hash(snapshot)||Buffer.byteLength(JSON.stringify(value))>TETRA_CHECKPOINT_BYTES)fail();
  const input={generationInput:tetraMeshInput(snapshot,partition),checkpointResult:value.result};
  (constrained?assertPatchedOptimizationInput:assertOptimizationCheckpointInput)(input,{sourceInput:tetraExecutionInput(snapshot)});
  if(value.result.algorithm.basis!==(constrained?PP.basis:P.basis)||!isDeepStrictEqual(value.result.processResources,job.processResources?.generation))fail();
  const baseline=value.result.baseline;
  return {version:1,basis:value.basis,nodeCount:baseline.points.length,tetraCount:baseline.report.tetraCount,meetsRequestedQuality:baseline.quality.meetsRequestedQuality,normalMeshAdmitted:false};
}
