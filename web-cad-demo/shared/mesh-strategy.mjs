import {normalizeMeshSizing,meshSizingTargetCurrent} from './mesh-sizing.mjs';
import {normalizeMeshQualityPolicy} from './mesh-quality-policy.mjs';
import {normalizeMeshOptimization,MESH_OPTIMIZATION_SCHEMA} from './mesh-optimization.mjs';
export const MESH_STRATEGY_LIMITS=Object.freeze({maxStrategies:32,maxName:80,maxSnapshotBytes:256*1024});
const identityProperties={kind:{type:'string'},bodyId:{type:'string',pattern:'^[A-Za-z0-9_-]{1,64}$'},bodyIdentity:{type:'string',pattern:'^[a-f0-9]{32}$'},topologyIdentity:{type:'string',pattern:'^[a-f0-9]{32}$'},topologyRevision:{type:'integer',minimum:0}};
const identityRequired=Object.keys(identityProperties);
export const MESH_STRATEGY_OPTIONS_SCHEMA={
  type:'object',required:['repairMode','qualityThreshold'],additionalProperties:false,
  properties:{
    repairMode:{type:'string',enum:['conservative','aggressive','strict']},
    qualityThreshold:{type:'number',minimum:0,maximum:1},
    qualityPolicy:{type:'string',enum:['warning','strict']},
    optimization:MESH_OPTIMIZATION_SCHEMA,
    sizing:{type:'object',required:['version','globalSize','rules'],additionalProperties:false,properties:{
      version:{const:1},globalSize:{type:'number',minimum:1e-6,maximum:1e6},
      rules:{type:'array',maxItems:16,items:{type:'object',required:['id','size','target'],additionalProperties:false,properties:{
        id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,64}$'},size:{type:'number',minimum:1e-6,maximum:1e6},transitionDistance:{type:'number',minimum:1e-6,maximum:1e6},
        target:{oneOf:[
          {type:'object',required:identityRequired,additionalProperties:false,properties:{...identityProperties,kind:{const:'body'}}},
          {type:'object',required:[...identityRequired,'cadFaceId'],additionalProperties:false,properties:{...identityProperties,kind:{const:'face'},cadFaceId:{type:'string',pattern:'^face-[0-9]+-[1-9][0-9]*$'}}}
        ]}
      }}}
    }}
  }
};
const identifier=/^mesh-strategy-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=message=>{throw Object.assign(Error(message),{code:'MESH_STRATEGY_INVALID'});};
export function meshStrategyKeys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('网格方案的字段或格式不合法。');}
export const validMeshStrategyId=value=>typeof value==='string'&&identifier.test(value);
export function normalizeMeshStrategyOptions(value){meshStrategyKeys(value,['repairMode','qualityThreshold','qualityPolicy','sizing','optimization']);if(!['conservative','aggressive','strict'].includes(value.repairMode)||typeof value.qualityThreshold!=='number'||!Number.isFinite(value.qualityThreshold)||value.qualityThreshold<0||value.qualityThreshold>1)fail('方案须包含有效的修复模式和质量阈值。');const sizing=normalizeMeshSizing(value.sizing),qualityPolicy=normalizeMeshQualityPolicy(value.qualityPolicy),optimization=normalizeMeshOptimization(value.optimization);return {repairMode:value.repairMode,qualityThreshold:value.qualityThreshold,...(qualityPolicy==='strict'?{qualityPolicy}:{}),...(sizing?{sizing}:{}),...(optimization?{optimization}:{})};}
export function normalizeMeshStrategyName(value){if(typeof value!=='string'||!value.trim()||value.trim().length>MESH_STRATEGY_LIMITS.maxName||/[\x00-\x1f\x7f]/.test(value))fail('方案名称须为 1～80 个可见字符。');return value.trim();}
export const emptyMeshStrategies=()=>({schemaVersion:1,strategies:[]});
export function normalizeMeshStrategies(value){
  meshStrategyKeys(value,['schemaVersion','strategies']);if(value.schemaVersion!==1||!Array.isArray(value.strategies)||value.strategies.length>MESH_STRATEGY_LIMITS.maxStrategies)fail('方案清单版本不支持或已超过 32 条。');
  const ids=new Set(),names=new Set();const strategies=value.strategies.map(row=>{
    meshStrategyKeys(row,['strategyId','name','revision','createdAt','updatedAt','options']);const name=normalizeMeshStrategyName(row.name),key=name.toLocaleLowerCase('en-US');
    if(!validMeshStrategyId(row.strategyId)||ids.has(row.strategyId)||names.has(key)||!Number.isSafeInteger(row.revision)||row.revision<1)fail('网格方案身份、版本或名称重复。');ids.add(row.strategyId);names.add(key);
    for(const field of ['createdAt','updatedAt'])if(typeof row[field]!=='string'||row[field].length>40||!Number.isFinite(Date.parse(row[field])))fail('网格方案时间元数据无效。');
    return {strategyId:row.strategyId,name,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,options:normalizeMeshStrategyOptions(row.options)};
  });return {schemaVersion:1,strategies};
}
export function normalizeMeshStrategyRef(value){meshStrategyKeys(value,['strategyId','revision','definitionHash']);if(!validMeshStrategyId(value.strategyId)||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.definitionHash!=='string'||!/^[a-f0-9]{64}$/.test(value.definitionHash))fail('网格方案引用缺少准确身份、版本或定义摘要。');return {strategyId:value.strategyId,revision:value.revision,definitionHash:value.definitionHash};}
export function meshStrategyState(strategy,view){const rules=strategy.options.sizing?.rules||[];const staleRuleIds=rules.filter(rule=>!meshSizingTargetCurrent(rule.target,view)).map(rule=>rule.id);return {state:staleRuleIds.length?'stale':'current',staleRuleIds};}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const meshStrategyOptionsEqual=(a,b)=>JSON.stringify(canonical(normalizeMeshStrategyOptions(a)))===JSON.stringify(canonical(normalizeMeshStrategyOptions(b)));
export function normalizeMeshStrategyListing(value){
  meshStrategyKeys(value,['schemaVersion','strategies']);if(!Array.isArray(value.strategies))fail('方案清单不可读。');
  const extras=value.strategies.map(row=>{meshStrategyKeys(row,['strategyId','name','revision','createdAt','updatedAt','options','definitionHash','state','staleRuleIds']);if(typeof row.definitionHash!=='string'||!/^[a-f0-9]{64}$/.test(row.definitionHash)||!['current','stale'].includes(row.state)||!Array.isArray(row.staleRuleIds)||row.staleRuleIds.length>16||new Set(row.staleRuleIds).size!==row.staleRuleIds.length||row.staleRuleIds.some(id=>typeof id!=='string'||!row.options?.sizing?.rules?.some(rule=>rule.id===id))||(row.state==='current')!==(row.staleRuleIds.length===0))fail('方案的定义证明或几何身份状态无效。');return {definitionHash:row.definitionHash,state:row.state,staleRuleIds:[...row.staleRuleIds]};});
  const normalized=normalizeMeshStrategies({schemaVersion:value.schemaVersion,strategies:value.strategies.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['definitionHash','state','staleRuleIds'].includes(key))))});return {...normalized,strategies:normalized.strategies.map((row,index)=>({...row,...extras[index]}))};
}
