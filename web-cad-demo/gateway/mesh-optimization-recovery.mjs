import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateTetraTaskCheckpoint} from './discrete-tetra-checkpoint.mjs';
import {validateTetraTaskFailure} from './discrete-tetra-task-result.mjs';
export {parseOptimizationRecoveryRequest} from '../shared/mesh-optimization-recovery.mjs';
export const OPTIMIZATION_ORIGIN_BYTES=16*1024**2,MAX_OPTIMIZATION_ATTEMPTS=32;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,jobId=/^mesh-[a-f0-9-]{36}$/,documentId=/^[A-Za-z0-9_-]{1,64}$/,sha=/^[a-f0-9]{64}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),fields=(value,names)=>plain(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
export const optimizationRecordHash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid=(code='MESH_OPTIMIZATION_RECOVERY_CONFLICT')=>{throw Object.assign(Error('优化恢复请求、原失败记录或检查点已变化；未重新生成网格或覆盖原任务。'),{code});};
export function optimizationRecoverable(job){return job?.kind==='discrete-tetra'&&['failed','cancelled','interrupted'].includes(job.state)&&job.options?.optimizationProcess==='checkpoint-v1'&&Boolean(job.artifact?.checkpoint)&&!job.artifact?.result&&!job.client&&!job.stopUnconfirmed&&!job.deleting;}
export function validateOptimizationRecovery(value){
  if(!fields(value,['version','requestId','originKind','originHandle','originJobId','originDocumentId','checkpointJobId','failedStateToken','checkpointToken','originRecordSha256'])||value.version!==1||!['native','asset'].includes(value.originKind)||!uuid.test(value.requestId)||![value.originHandle,value.originJobId,value.checkpointJobId].every(id=>jobId.test(id))||!documentId.test(value.originDocumentId)||![value.failedStateToken,value.checkpointToken,value.originRecordSha256].every(id=>sha.test(id)))invalid();
  return value;
}
export function optimizationOrigin(record,failure=null){return {version:1,basis:'immutable-optimization-attempt-origin-v1',record,failure};}
export function validateOptimizationOrigin(value,target,snapshot,partition,checkpoint){
  const recovery=validateOptimizationRecovery(target.optimizationRecovery);
  if(!fields(value,['version','basis','record','failure'])||value.version!==1||value.basis!=='immutable-optimization-attempt-origin-v1'||Buffer.byteLength(JSON.stringify(value))>OPTIMIZATION_ORIGIN_BYTES)invalid();
  const origin=value.record;
  if(!optimizationRecoverable(origin)||origin.jobId!==recovery.originJobId||origin.documentId!==recovery.originDocumentId||optimizationRecordHash(origin)!==recovery.originRecordSha256||(origin.optimizationRecovery?.checkpointJobId||origin.jobId)!==recovery.checkpointJobId||origin.artifact.checkpoint.sha256!==recovery.checkpointToken||target.artifact.checkpoint.sha256!==recovery.checkpointToken||!isDeepStrictEqual(origin.source,{...target.source,documentId:origin.documentId})||origin.materialSourceSha256!==target.materialSourceSha256)invalid();
  for(const key of ['discreteTetra','optimizationProcess','sourceFamily','nativeSurfaceMemoryLimitBytes','nativeMemoryLimitBytes'])if(!isDeepStrictEqual(origin.options[key],target.options[key]))invalid();
  for(const key of ['discreteSource','partition','checkpoint'])if(!isDeepStrictEqual(origin.artifact[key],target.artifact[key]))invalid();
  for(const key of ['partition','generation'])if(!isDeepStrictEqual(origin.processResources[key],target.processResources[key]))invalid();
  validateTetraTaskCheckpoint(checkpoint,origin,snapshot,partition);validateTetraTaskCheckpoint(checkpoint,target,snapshot,partition);
  if(origin.artifact.discreteFailure){if(value.failure===null)invalid();validateTetraTaskFailure(value.failure,origin,snapshot,partition,checkpoint);}else if(value.failure!==null)invalid();
  return value;
}
