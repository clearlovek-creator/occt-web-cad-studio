const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const fault=()=>Object.assign(Error('恢复请求或状态身份无效，未采用。'),{code:'MESH_COMPLETION_RECOVERY_INVALID_REQUEST'});
export function parseMeshRecoveryRequest(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'requestId')||!Object.hasOwn(value,'failedStateToken')||typeof value.requestId!=='string'||typeof value.failedStateToken!=='string'||!UUID.test(value.requestId)||!HASH.test(value.failedStateToken))throw fault();
  return {requestId:value.requestId,failedStateToken:value.failedStateToken};
}
export function parseMeshRecoveryInfo(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||!['available','checking','failed','complete'].includes(value.state)||typeof value.failedStateToken!=='string'||!HASH.test(value.failedStateToken)||value.state!=='available'&&(typeof value.requestId!=='string'||!UUID.test(value.requestId)))throw fault();
  const result={version:1,state:value.state,failedStateToken:value.failedStateToken,...(value.state!=='available'?{requestId:value.requestId}:{})};
  if(value.code!==undefined){if(typeof value.code!=='string'||!/^[A-Z][A-Z0-9_]{0,79}$/.test(value.code))throw fault();result.code=value.code;}
  if(value.error!==undefined){if(typeof value.error!=='string'||value.error.length>300||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value.error))throw fault();result.error=value.error;}
  return result;
}
