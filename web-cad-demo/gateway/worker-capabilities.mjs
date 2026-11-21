/** Allowlisted statements made by the actual native process, never installed-file claims. */
import {DISCRETE_SOURCE_CAPABILITY,discreteSourceDeclaration} from '../shared/discrete-surface-source.mjs';
export const LOFT_HOLES_CAPABILITY='loft-through-holes-v1';
export const IMPORTED_NAMING_CAPABILITY='immutable-step-topology-v1';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
const importedNaming=value=>value?.version===1&&value.basis==='immutable-step-brep-v1'&&value.sourceFingerprintAlgorithm==='sha256-chain-1m-v1';
function namingUpgradePolicy(value){
  if(value?.version!==1||value.basis!=='unchanged-dual-replay-v1')return null;
  if(value.archivedRecovery===false)return {version:1,basis:value.basis,archivedRecovery:false};
  if(value.archivedRecovery==='exact-recertification-v1'&&integer(value.maxArchivedSources,1,64)&&integer(value.maxArchivedProofs,1,256))
    return {version:1,basis:value.basis,archivedRecovery:value.archivedRecovery,maxArchivedSources:value.maxArchivedSources,maxArchivedProofs:value.maxArchivedProofs};
  return null;
}
export function nativeGeometryFeatures(health){
  const result={};
  if(health?.ok!==true||health.protocolVersion!==1||health.service!=='occt-geometry-worker'||health.capabilities?.version!==1)return result;
  const holes=health.capabilities.loftThroughHoles,loops=health.capabilities.faceBoundaryLoops;
  if(holes?.version===1&&integer(holes.maxSections,2,32)&&integer(holes.maxHolesPerSection,1,16)&&loops?.version===1)
    result[LOFT_HOLES_CAPABILITY]={maxSections:holes.maxSections,maxHolesPerSection:holes.maxHolesPerSection,boundaryLoopsVersion:1};
  const imported=health.capabilities.importedTopologyNaming;
  if(importedNaming(imported))
    result[IMPORTED_NAMING_CAPABILITY]={version:1,basis:'immutable-step-brep-v1',sourceFingerprintAlgorithm:'sha256-chain-1m-v1'};
  const upgrade=namingUpgradePolicy(imported?.upgrade);
  if(result[IMPORTED_NAMING_CAPABILITY]&&upgrade)result[IMPORTED_NAMING_CAPABILITY].upgrade=upgrade;
  const discrete=discreteSourceDeclaration(health.capabilities.discreteSurfaceExport);
  if(discrete)result[DISCRETE_SOURCE_CAPABILITY]=discrete;
  return result;
}
export function capabilitySnapshot(instance,ready,features){return {version:1,source:'native-handshake',ready:Boolean(ready&&instance),workerInstance:ready?instance:null,features:ready?features:{}};}
export function loftHoleLimits(snapshot){
  const limits=snapshot?.features?.[LOFT_HOLES_CAPABILITY];
  return snapshot?.version===1&&snapshot.source==='native-handshake'&&snapshot.ready===true&&typeof snapshot.workerInstance==='string'&&/^[a-f0-9-]{36}$/.test(snapshot.workerInstance)&&limits?.boundaryLoopsVersion===1&&integer(limits.maxSections,2,32)&&integer(limits.maxHolesPerSection,1,16)?{maxSections:limits.maxSections,maxHolesPerSection:limits.maxHolesPerSection}:null;
}
export class WorkerCapabilityError extends Error{constructor(code,message){super(message);this.name='WorkerCapabilityError';this.code=code;this.retryableByModel=false;}}
export function assertImportedNamingUpgrade(snapshot){
  const imported=snapshot?.features?.[IMPORTED_NAMING_CAPABILITY];
  if(snapshot?.version!==1 || snapshot.source!=='native-handshake' || snapshot.ready!==true || typeof snapshot.workerInstance!=='string' || !/^[a-f0-9-]{36}$/.test(snapshot.workerInstance) || !importedNaming(imported) || !namingUpgradePolicy(imported.upgrade))
    throw new WorkerCapabilityError('WORKER_CAPABILITY_UNAVAILABLE','当前实际几何进程未声明支持旧工程命名升级；未执行修改，请使用经过验收的兼容内核。');
}
export function validateCapabilityPrecondition(value){
  if(!object(value)||Object.keys(value).some(key=>!['version','workerInstance','capability'].includes(key))||value.version!==1||typeof value.workerInstance!=='string'||!/^[a-f0-9-]{36}$/.test(value.workerInstance)||![LOFT_HOLES_CAPABILITY,DISCRETE_SOURCE_CAPABILITY].includes(value.capability))
    throw new WorkerCapabilityError('WORKER_CAPABILITY_PRECONDITION_INVALID','几何能力前置条件无效；请重新查询实际运行能力。');
}
export function assertCapabilityPrecondition(value,snapshot){
  if(value===undefined)return;
  validateCapabilityPrecondition(value);
  if(!snapshot.ready||value.workerInstance!==snapshot.workerInstance)throw new WorkerCapabilityError('WORKER_INSTANCE_CHANGED','几何进程已变化，旧能力凭据不再有效；未执行旧请求，请重新查询工程和运行能力。');
  if(value.capability===LOFT_HOLES_CAPABILITY&&!loftHoleLimits(snapshot))throw new WorkerCapabilityError('WORKER_CAPABILITY_UNAVAILABLE','当前实际几何进程未证明支持多孔放样；未执行请求，请使用兼容内核并重新连接工具。');
  if(value.capability===DISCRETE_SOURCE_CAPABILITY&&!discreteSourceDeclaration(snapshot.features?.[DISCRETE_SOURCE_CAPABILITY]))throw new WorkerCapabilityError('WORKER_CAPABILITY_UNAVAILABLE','当前实际几何进程未证明支持完整 CAD 表面来源导出；未使用显示网格或旧内核回退。');
}
