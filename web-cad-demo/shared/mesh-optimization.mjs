export const MESH_OPTIMIZATION_SCHEMA={type:'object',required:['version','method','iterations'],additionalProperties:false,properties:{version:{const:1},method:{const:'netgen'},iterations:{type:'integer',minimum:1,maximum:5}}};
const fail=message=>{throw Object.assign(Error(message),{code:'MESH_OPTIMIZATION_INVALID'});};
export function normalizeMeshOptimization(value){
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['version','method','iterations'].includes(key))||value.version!==1||value.method!=='netgen'||!Number.isInteger(value.iterations)||value.iterations<1||value.iterations>5)fail('优化设置仅支持显式 Netgen，迭代次数为 1～5。');
  return {version:1,method:'netgen',iterations:value.iterations};
}
export function validateMeshOptimizationReport(report,requested,mesh){
  const expected=normalizeMeshOptimization(requested),bad=()=>{throw Object.assign(Error('网格优化执行报告与原任务或最终质量不一致。'),{code:'MESH_OPTIMIZATION_REPORT_INVALID'});};
  if(!expected){if(report!==undefined)bad();return;}
  if(!report||report.version!==1||report.method!==expected.method||report.iterations!==expected.iterations)bad();
  const fields=['qualityName','threshold','tetraCount','finiteCount','badCount','invalidCount','invertedCount','degenerateCount','minQuality','maxQuality','averageQuality','unsupportedElementCount'];
  if(!report.before||!report.after||fields.some(key=>report.after[key]!==mesh?.quality?.[key]))bad();
  for(const row of [report.before,report.after]){
    if(row.version!==2||row.qualityName!=='minSICN'||row.status!=='complete'||row.unsupportedElementCount!==0||row.threshold!==mesh.quality.threshold)bad();
    for(const key of ['tetraCount','finiteCount','badCount','invalidCount','invertedCount','degenerateCount'])if(!Number.isSafeInteger(row[key])||row[key]<0||row[key]>row.tetraCount)bad();
    if(!row.tetraCount||row.finiteCount!==row.tetraCount||['minQuality','maxQuality','averageQuality'].some(key=>typeof row[key]!=='number'||!Number.isFinite(row[key])||row[key]<-1||row[key]>1)||row.minQuality>row.averageQuality||row.averageQuality>row.maxQuality)bad();
  }
}
