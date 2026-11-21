import {NativeChannelError} from './native-request-channel.mjs';
export const NATIVE_MEMORY_POLICY=Object.freeze({version:1,basis:'windows-job-commit-v1',minimumBytes:128*1024*1024,maximumBytes:8*1024**3,defaultBytes:2*1024**3});
export class NativeResourcePolicyError extends NativeChannelError {
  constructor(code,message){super(code,message);this.name='NativeResourcePolicyError';this.permanent=true;}
}
function memoryPolicy(environment,platform,variable,label,prefix){
  if(platform!=='win32')throw new NativeResourcePolicyError(prefix+'RESOURCE_PLATFORM_UNSUPPORTED',label+'进程内存硬限制当前仅通过 Windows 验收，不会静默退回无保护模式。');
  const raw=environment[variable];
  if(raw!==undefined&&(typeof raw!=='string'||!/^\d{1,20}$/.test(raw)))throw new NativeResourcePolicyError(prefix+'RESOURCE_CONFIG_INVALID',variable+' 必须是 128 MiB 到 8 GiB 的整数字节值。');
  const limitBytes=raw===undefined?NATIVE_MEMORY_POLICY.defaultBytes:Number(raw);
  if(!Number.isSafeInteger(limitBytes)||limitBytes<NATIVE_MEMORY_POLICY.minimumBytes||limitBytes>NATIVE_MEMORY_POLICY.maximumBytes)throw new NativeResourcePolicyError(prefix+'RESOURCE_CONFIG_INVALID',label+'内存限制不能关闭，范围为 128 MiB 到 8 GiB。');
  return {...NATIVE_MEMORY_POLICY,limitBytes};
}
export const geometryMemoryPolicy=(environment=process.env,platform=process.platform)=>memoryPolicy(environment,platform,'GEOMETRY_WORKER_MEMORY_LIMIT_BYTES','几何','WORKER_');
export const meshMemoryPolicy=(environment=process.env,platform=process.platform)=>memoryPolicy(environment,platform,'MESH_WORKER_MEMORY_LIMIT_BYTES','网格','MESH_WORKER_');
export const discreteMemoryPolicy=(environment=process.env,platform=process.platform)=>memoryPolicy(environment,platform,'DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES','离散表面重构','SURFACE_');
export function assertNativeMemoryGuard(health,policy,service='occt-geometry-worker'){
  const value=health?.capabilities?.processResources;
  if(health?.ok!==true||health.protocolVersion!==1||health.service!==service||health.capabilities?.version!==1||value?.version!==1||value.basis!==policy.basis||value.enforced!==true||value.processLimitBytes!==policy.limitBytes||value.jobLimitBytes!==policy.limitBytes||value.failurePolicy!=='retire-on-memory-event-or-allocator-failure-v1')
    throw new NativeResourcePolicyError(service==='cad-discrete-surface-worker'?'SURFACE_RESOURCE_GUARD_UNAVAILABLE':service==='gmsh-mesh-worker'?'MESH_WORKER_RESOURCE_GUARD_UNAVAILABLE':'WORKER_RESOURCE_GUARD_UNAVAILABLE','实际原生进程未证明按指定预算启用内存硬限制，已停止；不能使用旧内核或无保护回退。');
  return {version:1,basis:value.basis,processLimitBytes:value.processLimitBytes,jobLimitBytes:value.jobLimitBytes,enforced:true,failurePolicy:value.failurePolicy};
}
export function discreteResourceExitError(code,policy){
  if(code===86)return new NativeChannelError('SURFACE_MEMORY_LIMIT',`表面重构进程触发 ${Math.round(policy.limitBytes/1024/1024)} MiB 提交内存预算，已退出；未发布结果，不会自动重试。`);
  if(code===87)return new NativeChannelError('SURFACE_MEMORY_EXHAUSTED','表面重构进程无法分配内存，已退出；未发布结果，不会自动重试。');
  if(code===88)return new NativeResourcePolicyError('SURFACE_RESOURCE_GUARD_UNAVAILABLE','表面重构无法建立内存硬限制，已阻止无保护启动。');
  if(code===89)return new NativeResourcePolicyError('SURFACE_RESOURCE_CONFIG_INVALID','表面重构拒绝内存限制配置，已阻止启动。');
  return new NativeChannelError('WORKER_UNAVAILABLE','表面重构进程已退出。');
}
export function meshResourceExitError(code,policy){
  if(code===86)return new NativeChannelError('MESH_WORKER_MEMORY_LIMIT',`网格进程触发 ${Math.round(policy.limitBytes/1024/1024)} MiB 提交内存预算，已退出；没有发布网格，不会自动重试。`);
  if(code===87)return new NativeChannelError('MESH_WORKER_MEMORY_EXHAUSTED','网格进程无法分配内存，可能是预算拒绝或系统内存不足；没有发布网格，不会自动重试。');
  if(code===88)return new NativeResourcePolicyError('MESH_WORKER_RESOURCE_GUARD_UNAVAILABLE','网格进程无法建立操作系统内存限制，已阻止无保护启动。');
  if(code===89)return new NativeResourcePolicyError('MESH_WORKER_RESOURCE_CONFIG_INVALID','网格进程拒绝内存限制配置，已阻止启动。');
  return new NativeChannelError('MESH_WORKER_EXITED',`Mesh worker exited with code ${code}.`);
}
export function nativeResourceExitError(code,policy){
  if(code===86)return new NativeChannelError('WORKER_MEMORY_LIMIT',`几何进程触发 ${Math.round(policy.limitBytes/1024/1024)} MiB 提交内存预算，已退出；需恢复并核对工程。`);
  if(code===87)return new NativeChannelError('WORKER_MEMORY_EXHAUSTED','几何进程在受限预算下无法分配内存，可能是预算拒绝或系统内存不足，已退出；不会自动重复建模。');
  if(code===88)return new NativeResourcePolicyError('WORKER_RESOURCE_GUARD_UNAVAILABLE','几何进程无法建立或验证操作系统内存限制，已阻止无保护重启。');
  if(code===89)return new NativeResourcePolicyError('WORKER_RESOURCE_CONFIG_INVALID','几何进程拒绝了内存限制配置，已阻止自动重启。');
  return new NativeChannelError('WORKER_UNAVAILABLE',`Geometry worker exited with code ${code}.`);
}
