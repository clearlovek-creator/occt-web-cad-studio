export const MESH_SIZING_LIMITS=Object.freeze({minSize:1e-6,maxSize:1e6,maxRules:16});
const identity=/^[a-f0-9]{32}$/,id=/^[A-Za-z0-9_-]{1,64}$/;
const fail=(message,code='MESH_SIZING_INVALID')=>{throw Object.assign(Error(message),{code});};
function keys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('网格尺寸设置含未知字段或格式不合法。');}
const size=value=>typeof value==='number'&&Number.isFinite(value)&&value>=MESH_SIZING_LIMITS.minSize&&value<=MESH_SIZING_LIMITS.maxSize;
export const meshSizingTargetKey=target=>[target.kind,target.bodyId,target.bodyIdentity,target.topologyIdentity,target.topologyRevision,target.cadFaceId||''].join('/');
/** Strict, detached request data. Sizes are canonical model millimetres. */
export function normalizeMeshSizing(value){
  if(value===undefined)return undefined;
  keys(value,['version','globalSize','rules']);if(value.version!==1||!size(value.globalSize)||!Array.isArray(value.rules)||value.rules.length>MESH_SIZING_LIMITS.maxRules)fail('全局目标尺寸须为 0.000001～1000000 mm，局部规则最多 16 条。');
  const ids=new Set(),targets=new Set();
  const rules=value.rules.map(rule=>{
    keys(rule,['id','size','target','transitionDistance']);const target=rule.target;keys(target,['kind','bodyId','bodyIdentity','topologyIdentity','topologyRevision','cadFaceId']);
    if(typeof rule.id!=='string'||!id.test(rule.id)||ids.has(rule.id)||!size(rule.size)||rule.size>value.globalSize)fail('局部尺寸须不大于全局目标尺寸，且规则编号不可重复。');ids.add(rule.id);
    if(rule.transitionDistance!==undefined&&!size(rule.transitionDistance))fail('过渡宽度须为 0.000001～1000000 mm 的有限数值；留空表示不启用。');
    if(!['body','face'].includes(target.kind)||typeof target.bodyId!=='string'||!id.test(target.bodyId)||typeof target.bodyIdentity!=='string'||typeof target.topologyIdentity!=='string'||!identity.test(target.bodyIdentity)||!identity.test(target.topologyIdentity)||!Number.isSafeInteger(target.topologyRevision)||target.topologyRevision<0)fail('局部尺寸缺少准确的 Body 与拓扑身份。');
    if(target.kind==='body'&&target.cadFaceId!==undefined||target.kind==='face'&&!new RegExp('^face-'+target.topologyRevision+'-[1-9]\\d*$').test(target.cadFaceId||''))fail('局部面的编号与其几何版本不一致。');
    const key=meshSizingTargetKey(target);if(targets.has(key))fail('同一几何目标不能重复设置局部尺寸。');targets.add(key);
    return {id:rule.id,size:rule.size,target:{...target},...(rule.transitionDistance!==undefined?{transitionDistance:rule.transitionDistance}:{})};
  });return {version:1,globalSize:value.globalSize,rules};
}
export function meshSizingTargetCurrent(target,view){const body=(view?.bodyMetadata||view?.bodies||[]).find(body=>body.bodyId===target.bodyId);return Boolean(body&&body.bodyIdentity===target.bodyIdentity&&body.topologyIdentity===target.topologyIdentity&&body.topologyRevision===target.topologyRevision);}
export function validateMeshSizingSource(sizing,view){if(!sizing)return;for(const rule of sizing.rules)if(!meshSizingTargetCurrent(rule.target,view))fail('局部尺寸目标已变化或不存在，请重新选择体或面。','MESH_SIZING_TARGET_STALE');}
/** Resolve only through the sealed OCCT history manifest, never geometry proximity. */
export function resolveMeshSizing(sizing,manifest){
  if(!sizing)return [];
  validateMeshSizingSource(sizing,manifest);
  return sizing.rules.map(rule=>{
    const t=rule.target,solidIndices=[],faceIndices=[];
    for(const [i,solid] of (manifest.solids||[]).entries())if(t.kind==='body'&&solid.sources.some(source=>source.bodyId===t.bodyId))solidIndices.push(i);
    for(const [i,face] of (manifest.faces||[]).entries())if(face.sources.some(source=>source.bodyId===t.bodyId&&(t.kind==='body'||source.cadFaceId===t.cadFaceId)))faceIndices.push(i);
    if(!solidIndices.length&&!faceIndices.length)fail('局部尺寸目标在修复/分割后没有可证明的网格实体，未忽略该规则。','MESH_SIZING_TARGET_UNRESOLVED');
    return {id:rule.id,solidIndices,faceIndices};
  });
}
export function validateMeshSizingReport(report,sizing,mesh){
  if(!sizing){if(report!==undefined)fail('网格返回了未请求的尺寸控制。','MESH_SIZING_REPORT_INVALID');return;}
  const bad=()=>fail('网格未提供与请求、CAD 来源一致的尺寸执行证明。','MESH_SIZING_REPORT_INVALID');
  if(report?.version!==1||report.strategy!=='min-restrict-v1'||report.globalSize!==sizing.globalSize||!Array.isArray(report.rules)||report.rules.length!==sizing.rules.length)bad();
  const same=(a,b)=>Array.isArray(a)&&a.length===new Set(a).size&&a.every(tag=>Number.isSafeInteger(tag)&&tag>0)&&a.length===b.size&&a.every(tag=>b.has(tag));
  for(const [index,rule] of sizing.rules.entries()){
    const row=report.rules[index],t=rule.target,volumes=new Set(),surfaces=new Set();
    for(const assignment of mesh.render?.ownership?.assignments||[])if(t.kind==='body'&&assignment.bodyId===t.bodyId)volumes.add(assignment.volumeTag);
    for(const face of mesh.boundaryMapping?.sourceFaces||[])if(face.source.bodyId===t.bodyId&&(t.kind==='body'||face.source.cadFaceId===t.cadFaceId))for(const tag of face.surfaceTags)surfaces.add(tag);
    if(!row||row.id!==rule.id||row.size!==rule.size||!row.target||Object.keys(row.target).length!==Object.keys(t).length||meshSizingTargetKey(row.target)!==meshSizingTargetKey(t)||!same(row.volumeTags,volumes)||!same(row.surfaceTags,surfaces)||!volumes.size&&!surfaces.size)bad();
    if(rule.transitionDistance!==undefined){if(!surfaces.size||!row.transition||Object.keys(row.transition).length!==3||row.transition.distance!==rule.transitionDistance||row.transition.sampling!==100||row.transition.basis!=='source-surfaces-distance-v1')bad();}
    else if(row.transition!==undefined)bad();
  }
}
