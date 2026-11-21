import crypto from 'node:crypto';
import {normalizeSurfaceTaskSettings,SURFACE_TASK_KIND,SURFACE_SOURCE_BYTES,SURFACE_RESULT_BYTES} from '../shared/discrete-surface-task.mjs';
import {validateProjectDiscreteSourceSnapshot} from './discrete-surface-source.mjs';
import {assertDiscreteResult,DISCRETE_SURFACE_PROTOCOL as P} from './discrete-surface-protocol.mjs';
import {discreteMemoryPolicy,assertNativeMemoryGuard} from './native-resource-policy.mjs';
const fault=()=>Object.assign(Error('表面重构结果的工程来源、输入、执行证明或保存设置无法核对；未作为体网格接纳。'),{code:'MESH_ARTIFACT_INVALID'});
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const proof=value=>plain(value)&&Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=SURFACE_SOURCE_BYTES&&/^[a-f0-9]{64}$/.test(value.sha256||'');
export function validateSurfaceJobOptions(options){
  if(!plain(options)||Object.keys(options).some(key=>!['surface','nativeSurfaceMemoryLimitBytes','storageReservationBytes'].includes(key)))throw fault();
  const normalized=normalizeSurfaceTaskSettings(options.surface);if(!same(normalized,options.surface))throw fault();
  discreteMemoryPolicy({DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:String(options.nativeSurfaceMemoryLimitBytes)});
  if(options.storageReservationBytes!==undefined&&(!Number.isSafeInteger(options.storageReservationBytes)||options.storageReservationBytes<1||options.storageReservationBytes>8*1024**3))throw fault();
  return normalized;
}
export function validateSurfaceResourceProof(options,value,{required=false}={}){
  const policy=discreteMemoryPolicy({DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:String(options.nativeSurfaceMemoryLimitBytes)});
  if(value===undefined&&!required)return null;
  return assertNativeMemoryGuard({ok:true,protocolVersion:1,service:P.service,capabilities:{version:1,processResources:value}},policy,P.service);
}
export function validateSurfaceSummary(value,options){
  const settings=validateSurfaceJobOptions(options),integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
  if(!plain(value)||value.version!==1||value.basis!=='cad-source-bound-discrete-surface-v1'||!integer(value.bodyCount,1,512)||!integer(value.faceCount,1,10000)||!integer(value.solidCount,0,4096)||!integer(value.inputTriangles,1,settings.source.maxTriangles)||!integer(value.outputTriangles,1,P.maxOutputTriangles)||!integer(value.points,3,P.maxPoints)||!integer(value.removedDegenerateTriangles,0,value.inputTriangles)||!integer(value.estimateExceedsRequestedFaceCount,0,value.faceCount)||typeof value.inputHadCrossings!=='boolean'||value.outputHasCrossings!==false||!Number.isFinite(value.maxSourceDeviation)||value.maxSourceDeviation<0||value.maxSourceDeviation>settings.repair.tolerance||!Number.isFinite(value.maxRelativeSourceAreaError)||value.maxRelativeSourceAreaError<0||value.maxRelativeSourceAreaError>2e-6||value.distanceBoundCertified!==false||value.normalMeshAdmitted!==false||value.tetrahedralReady!==false||value.appliedToCad!==false)throw fault();return value;
}
export function validateSurfaceSourceSnapshot(snapshot,job){
  if(job.kind!==SURFACE_TASK_KIND||!plain(snapshot)||Object.keys(snapshot).some(key=>!['bundle','source','binding'].includes(key))||!same(snapshot.source,job.source))throw fault();
  const settings=validateSurfaceJobOptions(job.options);
  try{validateProjectDiscreteSourceSnapshot(snapshot,job.source,settings.source);}catch{throw fault();}
  if(Buffer.byteLength(JSON.stringify(snapshot))>SURFACE_SOURCE_BYTES)throw Object.assign(Error('完整表面来源快照超过 20 MiB，未截断保存。'),{code:'MESH_ARTIFACT_LIMIT'});
  return snapshot;
}
export function surfaceExecutionInput(snapshot,settings){return {...snapshot.bundle.input,options:{...settings.repair}};}
export function surfaceTaskResult(job,snapshot,output){
  const settings=validateSurfaceJobOptions(job.options),input=surfaceExecutionInput(snapshot,settings);
  return {ok:true,protocolVersion:1,requestId:job.jobId,surfaceReconstruction:{version:1,basis:'cad-source-bound-discrete-surface-v1',sourceProof:{...job.artifact.surfaceSource},projectBinding:snapshot.binding,executionInputSha256:hash(input),output,normalMeshAdmitted:false,appliedToCad:false,tetrahedralReady:false}};
}
export function validateSurfaceTaskResult(result,job,snapshot){
  validateSurfaceSourceSnapshot(snapshot,job);const settings=validateSurfaceJobOptions(job.options),value=result?.surfaceReconstruction,input=surfaceExecutionInput(snapshot,settings);
  if(result?.ok!==true||result.protocolVersion!==1||result.requestId!==job.jobId||result.mesh!==undefined||result.preparation!==undefined||!plain(value)||value.version!==1||value.basis!=='cad-source-bound-discrete-surface-v1'||!proof(job.artifact?.surfaceSource)||!same(value.sourceProof,job.artifact.surfaceSource)||!same(value.projectBinding,snapshot.binding)||value.executionInputSha256!==hash(input)||value.normalMeshAdmitted!==false||value.appliedToCad!==false||value.tetrahedralReady!==false)throw fault();
  assertDiscreteResult(value.output,input,value.output?.requestId);
  const out=value.output,resource=validateSurfaceResourceProof(job.options,out.processResources,{required:true});
  if(!same(resource,validateSurfaceResourceProof(job.options,job.processResources,{required:true})))throw fault();
  if(out.execution?.basis!=='single-process-exit-confirmed-v1'||out.execution.exitCode!==0||out.execution.automaticReplay!==false||out.algorithm?.version!==1||out.algorithm.basis!==P.basis||out.algorithm.cgalVersion!==P.cgalVersion||out.algorithm.license!==P.license)throw fault();
  if(Buffer.byteLength(JSON.stringify(result))>SURFACE_RESULT_BYTES)throw Object.assign(Error('表面重构报告超过 96 MiB，未截断保存。'),{code:'MESH_ARTIFACT_LIMIT'});
  const report=out.report,inventory=snapshot.bundle.inventory;
  return {version:1,basis:value.basis,bodyCount:inventory.bodies.length,faceCount:inventory.faces.length,solidCount:inventory.solids.length,inputTriangles:report.inputTriangles,outputTriangles:report.outputTriangles,points:out.points.length,inputHadCrossings:report.inputHadCrossings,outputHasCrossings:false,removedDegenerateTriangles:report.removedDegenerateInputTriangles.length,maxSourceDeviation:report.maxSourceDeviation,maxRelativeSourceAreaError:report.maxRelativeSourceAreaError,estimateExceedsRequestedFaceCount:snapshot.bundle.report.estimateExceedsRequestedFaceCount,distanceBoundCertified:false,normalMeshAdmitted:false,tetrahedralReady:false,appliedToCad:false};
}
