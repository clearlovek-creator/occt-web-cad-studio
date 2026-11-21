import {propertyTargets} from '../shared/property-targets.mjs';
import {isDiscreteMeshFamily} from './discrete-mesh-family.mjs';
const key=source=>`${source.bodyId}/${source.cadFaceId}`;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const check=(condition,message)=>{if(!condition)throw new Error(`网格面来源无效：${message}`);};

/** Validate identity and both directions of the relation before any use. A mesh
 * surface can carry several CAD faces; a CAD face can split into many surfaces. */
export function validateMeshBoundary(mapping,source,{sourceFamily='occt-history'}={}) {
  check((sourceFamily==='occt-history'||isDiscreteMeshFamily(sourceFamily))&&mapping?.version===(isDiscreteMeshFamily(sourceFamily)?2:1)&&mapping.backend===sourceFamily,'不支持的来源版本');
  check(Array.isArray(mapping.sourceFaces)&&Array.isArray(mapping.surfaces),'缺少面清单');
  const bodies=new Map(source?.bodies?.map(body=>[body.bodyId,body])||[]),faces=new Map(),surfaces=new Map();
  const anchor=value=>{
    const body=bodies.get(value?.bodyId),match=/^face-(\d+)-(\d+)$/.exec(value?.cadFaceId||'');
    check(body&&body.bodyIdentity===value.bodyIdentity&&body.topologyIdentity===value.topologyIdentity&&body.topologyRevision===value.topologyRevision,'CAD 面身份与任务快照不一致');
    check(match&&Number(match[1])===body.topologyRevision&&Number(match[2])>0&&value.cadFaceId===`face-${body.topologyRevision}-${Number(match[2])}`,'CAD 面编号无效');
    return key(value);
  };
  for(const face of mapping.sourceFaces){
    const id=anchor(face.source);check(!faces.has(id),'CAD 面重复');check(['mapped','removed','unresolved'].includes(face.state),'未知关联状态');
    check(Array.isArray(face.surfaceTags)&&face.surfaceTags.every(tag=>Number.isSafeInteger(tag)&&tag>0)&&new Set(face.surfaceTags).size===face.surfaceTags.length,'网格面编号无效');
    check((face.state==='mapped')===Boolean(face.surfaceTags.length),'关联状态与目的面清单矛盾');faces.set(id,face);
  }
  for(const surface of mapping.surfaces){
    check(Number.isSafeInteger(surface.surfaceTag)&&surface.surfaceTag>0&&!surfaces.has(surface.surfaceTag),'网格面编号重复或无效');
    check(surface.meshFaceId===`mesh-face-${surface.surfaceTag}`&&finite(surface.area)&&surface.area>=0&&Number.isSafeInteger(surface.elementCount)&&surface.elementCount>=0,'网格面几何数据无效');
    check(Array.isArray(surface.sources)&&Array.isArray(surface.adjacentSolidIds)&&surface.adjacentSolidIds.every(id=>/^solid-[1-9]\d*$/.test(id)),'来源或邻接体清单无效');
    if(surface.embeddedSolidIds!==undefined)check(Array.isArray(surface.embeddedSolidIds)&&surface.embeddedSolidIds.every(id=>/^solid-[1-9]\d*$/.test(id)&&!surface.adjacentSolidIds.includes(id)),'嵌入体清单无效');
    const seen=new Set();for(const value of surface.sources){const id=anchor(value);check(!seen.has(id)&&faces.get(id)?.surfaceTags.includes(surface.surfaceTag),'正反向关联不一致');seen.add(id);}
    surfaces.set(surface.surfaceTag,surface);
  }
  for(const [id,face] of faces)for(const tag of face.surfaceTags)check(surfaces.get(tag)?.sources.some(value=>key(value)===id),'CAD 面指向不存在的网格面');
  const complete=mapping.sourceFaces.every(face=>face.state!=='unresolved')&&mapping.surfaces.every(surface=>surface.sources.length>0);
  check(mapping.complete===complete,'完整性标志与明细不一致');return mapping;
}

export function queryMeshBoundary(mapping,job,{bodyId='',cadFaceId=''}={},schema=null,current=false,{sourceFamily='occt-history'}={}) {
  validateMeshBoundary(mapping,job.source,{sourceFamily});
  if(bodyId&&(!job.source.bodies.some(body=>body.bodyId===bodyId)||typeof bodyId!=='string'))throw new Error('Body 不属于此网格来源。');
  if(cadFaceId&&(!bodyId||typeof cadFaceId!=='string'))throw new Error('筛选 CAD 面时必须指定来源 Body。');
  const matching=mapping.sourceFaces.filter(face=>(!bodyId||face.source.bodyId===bodyId)&&(!cadFaceId||face.source.cadFaceId===cadFaceId));
  if(cadFaceId&&!matching.length)throw new Error('CAD 面不属于此网格来源。');
  const tags=new Set(matching.flatMap(face=>face.surfaceTags));
  const types=new Map((schema?.types||[]).map(type=>[type.typeId,type]));
  const instances=current?(schema?.instances||[]):[];
  const faces=matching.map(face=>({...face,properties:instances.filter(instance=>instance.state==='active'&&propertyTargets(instance).some(target=>target.kind==='face'&&target.bodyId===face.source.bodyId&&target.topologyId===face.source.cadFaceId&&target.bodyIdentity===face.source.bodyIdentity&&target.topologyIdentity===face.source.topologyIdentity)).map(instance=>({instanceId:instance.instanceId,name:instance.name,typeId:instance.typeId,typeName:types.get(instance.typeId)?.name||instance.typeId,value:instance.value}))}));
  return {version:1,complete:mapping.complete,backend:mapping.backend,repairMode:mapping.repairMode,sourceFaces:faces,surfaces:mapping.surfaces.filter(surface=>tags.has(surface.surfaceTag)||!bodyId&&!cadFaceId),
    propertyStatus:!current?'source-stale':schema?'current':'unavailable',
    unresolvedProperties:current?instances.filter(instance=>propertyTargets(instance).some(target=>target.kind==='face')&&instance.state!=='active').map(instance=>({instanceId:instance.instanceId,name:instance.name,state:instance.state,reason:instance.stateReason})):[]};
}
