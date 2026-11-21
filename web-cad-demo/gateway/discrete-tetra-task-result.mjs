import crypto from 'node:crypto';
import {DISCRETE_TETRA_TASK_KIND as KIND,normalizeDiscreteTetraSettings,CAD_DISCRETE_TETRA_SOURCE_BYTES} from '../shared/discrete-tetra-task.mjs';
import {validateCadDiscreteTetraSnapshot,validateCadDiscreteTetraResult,isConstrainedCadTetraSource,cadPatchedTetraInput,CAD_CONSTRAINED_TETRA_RESULT_BASIS} from './cad-discrete-tetra.mjs';
import {resolveCadCellMaterials} from './cad-mesh-materials.mjs';
import {assertDiscreteTetraInput,assertDiscreteTetraQualitySummary,discreteTetraFailure,DISCRETE_TETRA_PROTOCOL as P} from './discrete-tetra-protocol.mjs';
import {discreteMemoryPolicy,meshMemoryPolicy,assertNativeMemoryGuard} from './native-resource-policy.mjs';
import {checkpointOptimizationFailure,MESH_CHECKPOINT_PROTOCOL as CP} from './mesh-checkpoint-protocol.mjs';
import {assertPatchedDiscreteTetraInput,patchedDiscreteTetraFailure,PATCHED_DISCRETE_TETRA_PROTOCOL as PP} from './patched-tetra-protocol.mjs';
import {patchedOptimizationFailure,PATCHED_MESH_CHECKPOINT_PROTOCOL as PCP} from './patched-checkpoint-protocol.mjs';

export const TETRA_PARTITION_BYTES=64*1024**2,TETRA_FAILURE_BYTES=512*1024;
export const CONSTRAINED_TETRA_TASK_FAMILY='constrained-patches-v1';
export const isConstrainedTetraJob=job=>job?.options?.sourceFamily===CONSTRAINED_TETRA_TASK_FAMILY;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fault=()=>Object.assign(Error('离散体网格任务的来源、设置、进程证明或结果凭据不一致，未接纳材料。'),{code:'MESH_ARTIFACT_INVALID'});
const check=value=>{if(!value)throw fault();};
const proof=(value,max)=>plain(value)&&Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=max&&/^[a-f0-9]{64}$/.test(value.sha256||'');

export function validateTetraJobOptions(options){
  check(plain(options)&&Object.keys(options).every(key=>['discreteTetra','nativeSurfaceMemoryLimitBytes','nativeMemoryLimitBytes','storageReservationBytes','optimizationProcess','sourceFamily'].includes(key)));
  const settings=normalizeDiscreteTetraSettings(options.discreteTetra);check(same(settings,options.discreteTetra));
  check(options.optimizationProcess===undefined||options.optimizationProcess==='checkpoint-v1'&&settings.optimization!==undefined);
  check(options.sourceFamily===undefined||options.sourceFamily===CONSTRAINED_TETRA_TASK_FAMILY&&(!settings.optimization||options.optimizationProcess==='checkpoint-v1'));
  discreteMemoryPolicy({DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:String(options.nativeSurfaceMemoryLimitBytes)});meshMemoryPolicy({MESH_WORKER_MEMORY_LIMIT_BYTES:String(options.nativeMemoryLimitBytes)});
  check(options.storageReservationBytes===undefined||Number.isSafeInteger(options.storageReservationBytes)&&options.storageReservationBytes>0&&options.storageReservationBytes<=8*1024**3);return settings;
}
export function validateTetraResources(options,value,{required=false}={}){
  validateTetraJobOptions(options);if(value===undefined&&!required)return null;check(plain(value)&&Object.keys(value).every(key=>['partition','tetra','generation'].includes(key)));
  const out={};for(const stage of ['partition','tetra','generation']){
    if(value[stage]===undefined){check(!required||stage==='generation'&&options.optimizationProcess===undefined);continue;}
    if(stage==='generation')check(options.optimizationProcess==='checkpoint-v1');
    const partition=stage==='partition',service=partition?'cad-discrete-surface-worker':'gmsh-mesh-worker',policy=partition?discreteMemoryPolicy({DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:String(options.nativeSurfaceMemoryLimitBytes)}):meshMemoryPolicy({MESH_WORKER_MEMORY_LIMIT_BYTES:String(options.nativeMemoryLimitBytes)});
    out[stage]=assertNativeMemoryGuard({ok:true,protocolVersion:1,service,capabilities:{version:1,processResources:value[stage]}},policy,service);
  }return out;
}
export function validateTetraSummary(value,options){
  const settings=validateTetraJobOptions(options),integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
  check(plain(value)&&Object.keys(value).every(key=>['version','basis','bodyCount','faceCount','solidCount','cellCount','tetraCount','nodeCount','quality','unassignedCellCount','normalMeshAdmitted','appliedToCad'].includes(key))&&value.version===1&&value.basis===(isConstrainedTetraJob({options})?CAD_CONSTRAINED_TETRA_RESULT_BASIS:'cad-source-bound-partition-tetra-v1')&&integer(value.bodyCount,1,512)&&integer(value.faceCount,1,10000)&&integer(value.solidCount,1,6)&&integer(value.cellCount,1,128)&&integer(value.tetraCount,1,P.maxTetrahedra)&&integer(value.nodeCount,4,P.maxOutputPoints)&&integer(value.unassignedCellCount,0,value.cellCount)&&value.normalMeshAdmitted===false&&value.appliedToCad===false&&plain(value.quality)&&value.quality.tetraCount===value.tetraCount);
  assertDiscreteTetraQualitySummary(value.quality,settings.quality,value.cellCount);check(settings.quality.mode!=='strict'||value.quality.meetsRequestedQuality===true);return value;
}
export function validateTetraFailureSummary(value){
  check(plain(value)&&value.version===1&&value.normalMeshAdmitted===false);
  if(value.code==='MESH_MATERIAL_CONFLICT')check(Object.keys(value).every(key=>['version','code','conflictCellCount','normalMeshAdmitted'].includes(key))&&Number.isSafeInteger(value.conflictCellCount)&&value.conflictCellCount>=1&&value.conflictCellCount<=128);
  else check(value.code==='MESH_QUALITY_REJECTED'&&Object.keys(value).every(key=>['version','code','tetraCount','lowQualityCount','minimumSICN','threshold','normalMeshAdmitted'].includes(key))&&Number.isSafeInteger(value.tetraCount)&&value.tetraCount>=1&&value.tetraCount<=P.maxTetrahedra&&Number.isSafeInteger(value.lowQualityCount)&&value.lowQualityCount>=1&&value.lowQualityCount<=value.tetraCount&&Number.isFinite(value.minimumSICN)&&value.minimumSICN>0&&value.minimumSICN<=1+1e-12&&Number.isFinite(value.threshold)&&value.threshold>=0&&value.threshold<=1);return value;
}
export function validateTetraSource(snapshot,job){
  check(job.kind===KIND);validateTetraJobOptions(job.options);validateCadDiscreteTetraSnapshot(snapshot);check(isConstrainedCadTetraSource(snapshot)===isConstrainedTetraJob(job));
  const source=job.optimizationRecovery?{...snapshot.cad.source,documentId:job.documentId}:snapshot.cad.source;
  check(same(snapshot.settings,job.options.discreteTetra)&&same(source,job.source)&&snapshot.materials.sha256===job.materialSourceSha256);return snapshot;
}
export function tetraExecutionInput(snapshot){return {...snapshot.cad.bundle.input,options:{...snapshot.settings.repair}};}
export function tetraMeshInput(snapshot,partition){return isConstrainedCadTetraSource(snapshot)?cadPatchedTetraInput(snapshot,partition):{domain:partition,meshSize:snapshot.settings.meshSize,quality:{...snapshot.settings.quality},...(snapshot.settings.optimization&&{optimization:{...snapshot.settings.optimization}})};}
export function validateTetraPartition(partition,job,snapshot){
  validateTetraSource(snapshot,job);(isConstrainedTetraJob(job)?assertPatchedDiscreteTetraInput:assertDiscreteTetraInput)(tetraMeshInput(snapshot,partition),{sourceInput:tetraExecutionInput(snapshot)});
  check(same(validateTetraResources(job.options,{partition:partition.processResources}),validateTetraResources(job.options,{partition:job.processResources?.partition})));
  return resolveCadCellMaterials(snapshot,partition);
}
const taskResultVersion=job=>(isConstrainedTetraJob(job)?2:0)+(job.options.optimizationProcess?2:1);
export function tetraTaskResult(job,value){return {ok:true,protocolVersion:1,requestId:job.jobId,discreteTetra:{version:taskResultVersion(job),sourceProof:{...job.artifact.discreteSource},partitionProof:{...job.artifact.partition},...(job.options.optimizationProcess?{checkpointProof:{...job.artifact.checkpoint}}:{}),value}};}
export function validateTetraTaskResult(result,job,snapshot,partition,checkpoint){
  validateTetraSource(snapshot,job);const wrapper=result?.discreteTetra;
  const isolated=job.options.optimizationProcess==='checkpoint-v1';
  check(result?.ok===true&&result.protocolVersion===1&&result.requestId===job.jobId&&Object.keys(result).every(key=>['ok','protocolVersion','requestId','discreteTetra'].includes(key))&&plain(wrapper)&&Object.keys(wrapper).every(key=>(isolated?['version','sourceProof','partitionProof','checkpointProof','value']:['version','sourceProof','partitionProof','value']).includes(key))&&wrapper.version===taskResultVersion(job)&&wrapper.value?.version===taskResultVersion(job)&&proof(job.artifact?.discreteSource,CAD_DISCRETE_TETRA_SOURCE_BYTES)&&proof(job.artifact?.partition,TETRA_PARTITION_BYTES)&&same(wrapper.sourceProof,job.artifact.discreteSource)&&same(wrapper.partitionProof,job.artifact.partition)&&same(wrapper.value?.partition,partition));
  if(isolated)check(proof(job.artifact.checkpoint,128*1024**2)&&same(wrapper.checkpointProof,job.artifact.checkpoint)&&checkpoint!==undefined);else check(checkpoint===undefined);
  validateTetraPartition(partition,job,snapshot);const summary=validateCadDiscreteTetraResult(wrapper.value,snapshot,{checkpoint}),resources=validateTetraResources(job.options,job.processResources,{required:true});
  check(same(resources,{partition:partition.processResources,tetra:wrapper.value.output.processResources,...(isolated?{generation:checkpoint.result.processResources}:{})}));return summary;
}
export function tetraTaskFailure(job,snapshot,error){
  return {version:1,basis:'cad-bound-discrete-tetra-failure-v1',jobId:job.jobId,sourceProof:{...job.artifact.discreteSource},partitionProof:{...job.artifact.partition},sourceSnapshotSha256:hash(snapshot),code:error.code,message:error.message.slice(0,1024),details:error.details,...error.execution&&{execution:error.execution,algorithm:error.algorithm,processResources:error.processResources}};
}
export function validateTetraTaskFailure(value,job,snapshot,partition,checkpoint){
  validateTetraPartition(partition,job,snapshot);
  check(!job.artifact?.result&&proof(job.artifact?.discreteSource,CAD_DISCRETE_TETRA_SOURCE_BYTES)&&proof(job.artifact?.partition,TETRA_PARTITION_BYTES)&&plain(value)&&Object.keys(value).every(key=>['version','basis','jobId','sourceProof','partitionProof','sourceSnapshotSha256','code','message','details','execution','algorithm','processResources'].includes(key))&&value.version===1&&value.basis==='cad-bound-discrete-tetra-failure-v1'&&value.jobId===job.jobId&&same(value.sourceProof,job.artifact.discreteSource)&&same(value.partitionProof,job.artifact.partition)&&value.sourceSnapshotSha256===hash(snapshot)&&typeof value.message==='string'&&value.message.length<=1024&&Buffer.byteLength(JSON.stringify(value))<=TETRA_FAILURE_BYTES);
  if(value.code==='MESH_MATERIAL_CONFLICT'){
    const materials=resolveCadCellMaterials(snapshot,partition);check(materials.conflictCellCount>0&&same(materials,value.details)&&value.execution===undefined&&value.algorithm===undefined&&value.processResources===undefined);
    return {version:1,code:value.code,conflictCellCount:materials.conflictCellCount,normalMeshAdmitted:false};
  }
  check(value.code==='MESH_QUALITY_REJECTED'&&value.execution?.basis==='single-process-exit-confirmed-v1'&&value.execution.exitCode===2&&value.execution.automaticReplay===false);
  const isolated=job.options.optimizationProcess==='checkpoint-v1',constrained=isConstrainedTetraJob(job);
  check(value.algorithm?.version===1&&value.algorithm.basis===(constrained?isolated?PCP.optimizationBasis:PP.basis:isolated?CP.optimizationBasis:P.basis)&&value.algorithm.gmshVersion===P.gmshVersion&&value.algorithm.apiVersion===P.apiVersion&&value.algorithm.license===P.license);
  if(constrained)check(value.algorithm.patchTopologyBasis===PP.patchTopologyBasis&&(!isolated||value.algorithm.snapshotBasis===PCP.snapshotBasis&&value.algorithm.embeddedRelationships===true&&value.algorithm.generationInputBinding===PCP.generationInputBinding));
  const response={ok:false,operation:constrained?isolated?'mesh.discrete-patched-optimize':'mesh.discrete-patched-tetra':isolated?'mesh.discrete-optimize':'mesh.discrete-tetra',code:value.code,error:value.message,...value.details};
  if(isolated)check(checkpoint!==undefined);
  const error=isolated?(constrained?patchedOptimizationFailure:checkpointOptimizationFailure)(response,{generationInput:tetraMeshInput(snapshot,partition),checkpointResult:checkpoint.result}):(constrained?patchedDiscreteTetraFailure:discreteTetraFailure)(response,tetraMeshInput(snapshot,partition));check(same(error.details,value.details));
  const resources=validateTetraResources(job.options,{partition:partition.processResources,tetra:value.processResources,...(isolated?{generation:checkpoint.result.processResources}:{})},{required:true});check(same(resources,validateTetraResources(job.options,job.processResources,{required:true})));
  const q=error.details.quality;return {version:1,code:value.code,tetraCount:q.tetraCount,lowQualityCount:q.lowQualityCount,minimumSICN:q.minimumSICN,threshold:q.threshold,normalMeshAdmitted:false};
}
