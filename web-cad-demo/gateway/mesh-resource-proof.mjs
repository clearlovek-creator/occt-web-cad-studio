import {meshMemoryPolicy,assertNativeMemoryGuard} from './native-resource-policy.mjs';
/** Historical results remain historical: no invented proof for legacy jobs. */
export function validateMeshResourceProof(options,proof,{required=false}={}){
  const bytes=options?.nativeMemoryLimitBytes;
  if(bytes===undefined){if(proof!==undefined)throw Error('网格进程资源证明缺少对应任务预算。');return null;}
  if(typeof bytes!=='number'||!Number.isSafeInteger(bytes))throw Error('网格任务进程预算不是整数字节值。');
  const policy=meshMemoryPolicy({MESH_WORKER_MEMORY_LIMIT_BYTES:String(bytes)});
  if(proof===undefined&&!required)return null;
  return assertNativeMemoryGuard({ok:true,protocolVersion:1,service:'gmsh-mesh-worker',capabilities:{version:1,processResources:proof}},policy,'gmsh-mesh-worker');
}
export function validateMeshResourceExecution(job,result){
  const expected=validateMeshResourceProof(job.options,job.processResources,{required:job.options?.nativeMemoryLimitBytes!==undefined});
  const actual=validateMeshResourceProof(job.options,result.processResources,{required:job.options?.nativeMemoryLimitBytes!==undefined});
  if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('网格结果资源证明与任务预算记录不一致。');
}
