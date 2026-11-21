import crypto from 'node:crypto';
import {normalizeMeshStrategies,normalizeMeshStrategyRef,normalizeMeshStrategyOptions} from '../shared/mesh-strategy.mjs';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const meshStrategyHash=value=>crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function validateMeshStrategyExecution(options){
  if(options?.strategyRef===undefined&&options?.strategySnapshot===undefined)return;
  const ref=normalizeMeshStrategyRef(options?.strategyRef),snapshot=normalizeMeshStrategies({schemaVersion:1,strategies:[options?.strategySnapshot]}).strategies[0];
  if(snapshot.strategyId!==ref.strategyId||snapshot.revision!==ref.revision||meshStrategyHash(snapshot)!==ref.definitionHash||meshStrategyHash(normalizeMeshStrategyOptions({repairMode:options.repairMode,qualityThreshold:options.qualityThreshold,...(options.qualityPolicy!==undefined?{qualityPolicy:options.qualityPolicy}:{}),...(options.sizing?{sizing:options.sizing}:{}),...(options.optimization?{optimization:options.optimization}:{})}))!==meshStrategyHash(snapshot.options))throw Object.assign(Error('网格任务的方案定义、摘要与实际设置不一致。'),{code:'MESH_STRATEGY_PROOF_INVALID'});
}
