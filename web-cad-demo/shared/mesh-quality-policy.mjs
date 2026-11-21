/** Omitted policy is the historical warning-only behavior. */
export function normalizeMeshQualityPolicy(value){
  if(value===undefined)return 'warning';
  if(value!=='warning'&&value!=='strict')throw Object.assign(Error('质量验收规则必须为 warning 或 strict。'),{code:'MESH_QUALITY_POLICY_INVALID'});
  return value;
}
export function meshAcceptanceSettings(options){
  const qualityPolicy=normalizeMeshQualityPolicy(options?.qualityPolicy),qualityThreshold=options?.qualityThreshold;
  if(typeof qualityThreshold!=='number'||!Number.isFinite(qualityThreshold)||qualityThreshold<0||qualityThreshold>1)throw Object.assign(Error('质量验收阈值必须为 0 到 1 的有限数值。'),{code:'MESH_QUALITY_POLICY_INVALID'});
  return {version:1,qualityPolicy,qualityThreshold};
}
export function validateMeshAcceptanceSettings(value,options){
  // Old artifacts remain readable under their original warning-only policy.
  if(value===undefined&&options?.qualityPolicy===undefined)return;
  const expected=meshAcceptanceSettings(options);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||Object.keys(expected).some(key=>value[key]!==expected[key]))throw Object.assign(Error('网格验收规则与封存任务不一致。'),{code:'MESH_ARTIFACT_INVALID'});
}
