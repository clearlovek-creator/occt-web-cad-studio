const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/,JOB=/^mesh-[a-f0-9-]{36}$/,DOC=/^[A-Za-z0-9_-]{1,64}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,names)=>plain(value)&&Object.keys(value).length===names.length&&names.every(key=>Object.hasOwn(value,key));
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const fault=()=>Object.assign(Error('优化恢复请求或状态身份无效，未采用。'),{code:'MESH_OPTIMIZATION_RECOVERY_REQUEST_INVALID'});
/** @typedef {{requestId:string,failedStateToken:string,checkpointToken:string}} OptimizationRecoveryRequest */
/** @typedef {{version:1,state:'available',failedStateToken:string,checkpointToken:string,canStart:boolean,automaticReplay:false,newAttempt:true}} OptimizationRecoveryInfo */
/** @typedef {{version:1,requestId:string,originKind:'native'|'asset',originHandle:string,originJobId:string,originDocumentId:string,checkpointJobId:string,failedStateToken:string,checkpointToken:string,originRecordSha256:string}} OptimizationAttempt */
/** @returns {OptimizationRecoveryRequest} */
export function parseOptimizationRecoveryRequest(value){
  if(!fields(value,['requestId','failedStateToken','checkpointToken'])||!matches(UUID,value.requestId)||!matches(HASH,value.failedStateToken)||!matches(HASH,value.checkpointToken))throw fault();
  return {requestId:value.requestId,failedStateToken:value.failedStateToken,checkpointToken:value.checkpointToken};
}
/** @returns {OptimizationRecoveryInfo} */
export function parseOptimizationRecoveryInfo(value){
  if(!fields(value,['version','state','failedStateToken','checkpointToken','canStart','automaticReplay','newAttempt'])||value.version!==1||value.state!=='available'||![value.failedStateToken,value.checkpointToken].every(token=>matches(HASH,token))||typeof value.canStart!=='boolean'||value.automaticReplay!==false||value.newAttempt!==true)throw fault();
  return {...value};
}
/** @returns {OptimizationAttempt} */
export function parseOptimizationAttempt(value){
  if(!fields(value,['version','requestId','originKind','originHandle','originJobId','originDocumentId','checkpointJobId','failedStateToken','checkpointToken','originRecordSha256'])||value.version!==1||!matches(UUID,value.requestId)||!['native','asset'].includes(value.originKind)||![value.originHandle,value.originJobId,value.checkpointJobId].every(id=>matches(JOB,id))||!matches(DOC,value.originDocumentId)||![value.failedStateToken,value.checkpointToken,value.originRecordSha256].every(token=>matches(HASH,token)))throw fault();
  return {...value};
}
