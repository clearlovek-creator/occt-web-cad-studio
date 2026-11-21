import crypto from 'node:crypto';
import {DISCRETE_MESH_FILE_LIMITS} from './discrete-mesh-files.mjs';
export const DERIVED_MESH_RESERVATION_BYTES=DISCRETE_MESH_FILE_LIMITS.mesh+DISCRETE_MESH_FILE_LIMITS.quality+DISCRETE_MESH_FILE_LIMITS.render+2*DISCRETE_MESH_FILE_LIMITS.manifest;
export function discreteMeshSourceToken(job){
  if(job.kind!=='discrete-tetra'||!job.artifact?.discreteSource||!job.artifact?.partition||!job.artifact?.result)return null;
  return crypto.createHash('sha256').update(JSON.stringify([job.source,job.options,job.materialSourceSha256,job.artifact.discreteSource,job.artifact.partition,job.artifact.result,...(job.artifact.checkpoint?[job.artifact.checkpoint]:[]),...(job.optimizationRecovery?[job.optimizationRecovery,job.artifact.optimizationOrigin]:[])])).digest('hex');
}
export function parseDiscreteMeshDerivation(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Object.keys(input).every(key=>['requestId','sourceToken'].includes(key))||typeof input.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId)||!/^[a-f0-9]{64}$/.test(input.sourceToken||''))throw Object.assign(Error('网格派生请求必须绑定原始来源和本次操作身份，不能附带路径或建模设置。'),{code:'MESH_DERIVATION_REQUEST_INVALID'});
  return {requestId:input.requestId,sourceToken:input.sourceToken};
}
