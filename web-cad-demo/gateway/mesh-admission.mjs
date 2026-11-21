import {qualityCellState} from '../shared/mesh-admission.mjs';
import {addQualityValue} from '../shared/mesh-statistics.mjs';
import {TetraConnectivity} from './mesh-connectivity.mjs';
import {LinearTetraSpatial} from './mesh-spatial.mjs';
import {normalizeMeshQualityPolicy} from '../shared/mesh-quality-policy.mjs';
import {isDiscreteMeshFamily,validateDiscreteMeshFamily} from './discrete-mesh-family.mjs';

const integer=value=>Number.isSafeInteger(value)&&value>=0;
const sameSet=(a,b)=>a.size===b.size&&[...a].every(value=>b.has(value));
/** Capture the CAD worker's complete prepared inventory, not the mesh worker's
 * claimed output inventory. The gateway overwrites any worker-supplied proof. */
export function captureMeshInventory(manifest){
  if(manifest?.version!==2||manifest.format!=='brep'||manifest.preprocessing?.backend!=='occt-history'||manifest.preprocessing.indexOrder!=='solids-first-recursive'||manifest.preprocessing.conformal!==true)return null;
  if(!Array.isArray(manifest.solids)||!Array.isArray(manifest.faces)||!Array.isArray(manifest.sourceFaces))throw new Error('剖分前来源清单不完整。');
  const solidBodies=new Set(manifest.bodies.filter(body=>body.kind==='solid').map(body=>body.bodyId));
  const solids=manifest.solids.map((solid,index)=>{
    if(solid.solidIndex!==index||!Array.isArray(solid.sources)||!solid.sources.length||solid.sources.some(row=>!solidBodies.has(row.bodyId)))throw new Error('剖分前体来源无效。');
    return {solidIndex:index,bodyIds:[...new Set(solid.sources.map(row=>row.bodyId))].sort()};
  });
  const sourceFaceKeys=manifest.sourceFaces.map(row=>`${row.source.bodyId}/${row.source.cadFaceId}`).sort();
  if(new Set(sourceFaceKeys).size!==sourceFaceKeys.length)throw new Error('剖分前来源面重复。');
  return {version:1,solids,surfaceCount:manifest.faces.length,sourceFaceKeys};
}
/** Certified numerical/connection admission plus bounded spatial BVH/SAT.
 * Spatial cost is data-dependent; exhausted budgets never become a pass. */
export function assessMeshAdmission(mesh,index,source,{spatialLimits,qualityPolicy:requestedPolicy,qualityThreshold,sourceFamily='occt-history'}={}){
  if(sourceFamily!=='occt-history'&&!isDiscreteMeshFamily(sourceFamily))throw Error('不支持的网格来源准入类型。');
  const discrete=isDiscreteMeshFamily(sourceFamily);
  const qualityPolicy=normalizeMeshQualityPolicy(requestedPolicy);
  const reasons=[],seen=new Set(),add=(code,severity,message,count=1)=>{if(!seen.has(code)){seen.add(code);reasons.push({code,severity,message,count});}};
  const counts={tetraCount:index?.cells?.length||0,volumeCount:0,meshedVolumeCount:0,badCount:0,invalidCount:0,invertedCount:0,degenerateCount:0,lowQualityCount:0};
  const quality=mesh?.quality;
  if(qualityThreshold!==undefined&&(typeof qualityThreshold!=='number'||!Number.isFinite(qualityThreshold)||qualityThreshold<0||qualityThreshold>1||index?.threshold!==qualityThreshold||quality?.threshold!==qualityThreshold))add('QUALITY_THRESHOLD_INCONSISTENT','error','数值质量证据的阈值与封存任务不一致，不能按其他阈值验收。');
  if(!index||quality?.version!==2||quality.qualityName!=='minSICN')add('QUALITY_EVIDENCE_MISSING','unknown','缺少完整的数值质量索引，请重新剖分或升级网格服务。');
  const groups=mesh?.render?.groups,ownership=mesh?.render?.ownership;
  if(!Array.isArray(groups)||ownership?.mode!==(discrete?sourceFamily:'occt-history-index'))add('SOURCE_EVIDENCE_MISSING','unknown','缺少与指定来源体系一致的网格实体清单。');
  if(discrete)try{validateDiscreteMeshFamily(mesh,source);}catch{add('DISCRETE_SOURCE_INCONSISTENT','error','离散分区和原始 Solid 的完整多源归属不一致。');}
  if(!index||quality?.version!==2)return {version:1,policy:'tetra-preprocessing-v2',status:'unverified',usable:false,counts,reasons};
  const volumes=new Map(),bodies=new Map((source?.bodies||[]).map(body=>[body.bodyId,body]));
  for(const group of groups||[]){
    if(group.kind!=='solid')continue;
    const match=/^solid-([1-9]\d*)$/.exec(group.solidId||''),tag=match?Number(match[1]):NaN;
    if(!Number.isSafeInteger(tag)||bodies.get(group.bodyId)?.kind!=='solid'){add('VOLUME_SOURCE_INVALID','error','网格体缺少可核对的来源编号。');continue;}
    if(!volumes.has(tag))volumes.set(tag,{owners:new Set(),cells:0});volumes.get(tag).owners.add(group.bodyId);
  }
  counts.volumeCount=volumes.size;
  if(!volumes.size)add('VOLUME_COVERAGE_MISSING','error','没有可验收的三维网格体。');
  const inventory=mesh?.sourceInventory;
  if(inventory?.version!==(discrete?2:1)||!Array.isArray(discrete?inventory.cells:inventory.solids)||!integer(inventory.surfaceCount)||!Array.isArray(inventory.sourceFaceKeys))add('PREPARED_INVENTORY_MISSING','unknown','缺少剖分前封存的完整实体清单，无法排除整块漏体或漏面。');
  else{
    const expected=new Map(),actual=new Map(),usedTags=new Set();
    const indexField=discrete?'cellIndex':'solidIndex',linkField=discrete?'partitionCellIndex':'preparedSolidIndex';
    for(const solid of discrete?inventory.cells:inventory.solids){
      const solidIndex=solid[indexField];
      if(!integer(solidIndex)||expected.has(solidIndex)||!Array.isArray(solid.bodyIds)||!solid.bodyIds.length||solid.bodyIds.some(id=>bodies.get(id)?.kind!=='solid'))add('PREPARED_INVENTORY_INVALID','error','封存的实体清单无效。');
      else expected.set(solidIndex,new Set(solid.bodyIds));
    }
    counts.volumeCount=Math.max(counts.volumeCount,expected.size);
    for(const row of ownership?.assignments||[]){
      const solidIndex=row[linkField];
      if(!integer(solidIndex)){add('PREPARED_LINK_MISSING','unknown','网格服务未返回封存体域到输出体的明确关系，请升级后重新剖分。');continue;}
      if(!actual.has(solidIndex))actual.set(solidIndex,{owners:new Set(),tag:row.volumeTag});
      const record=actual.get(solidIndex);record.owners.add(row.bodyId);
      if(record.tag!==row.volumeTag)add('PREPARED_COVERAGE_INCOMPLETE','error','剖分后的体编号与封存清单不一致。');
    }
    for(const record of actual.values()){if(usedTags.has(record.tag))add('PREPARED_COVERAGE_INCOMPLETE','error','多个来源体错误地复用了同一个网格体。');usedTags.add(record.tag);}
    if(!seen.has('PREPARED_LINK_MISSING')&&(expected.size!==actual.size||[...expected].some(([index,owners])=>!actual.has(index)||!sameSet(owners,actual.get(index).owners))))add('PREPARED_COVERAGE_INCOMPLETE','error','剖分前的完整 Solid 清单与结果不一致，存在漏体、额外体或错误归属。');
    const surfaceCount=mesh?.boundaryMapping?.surfaces?.length,faceKeys=new Set(mesh?.boundaryMapping?.sourceFaces?.map(row=>`${row.source.bodyId}/${row.source.cadFaceId}`)||[]);
    if(inventory.surfaceCount!==surfaceCount||!sameSet(new Set(inventory.sourceFaceKeys),faceKeys))add('PREPARED_FACE_COVERAGE_INCOMPLETE','error','剖分前的完整面清单与结果不一致，存在漏面。');
  }
  if(ownership){
    if(!Array.isArray(ownership.unmappedBodyIds)||!Array.isArray(ownership.unassignedVolumeTags)||ownership.unmappedBodyIds.length||ownership.unassignedVolumeTags.length)add('OWNERSHIP_INCOMPLETE','error','存在未归属的 Body 或网格体。');
    const declared=new Map();for(const row of ownership.assignments||[]){if(!declared.has(row.volumeTag))declared.set(row.volumeTag,new Set());declared.get(row.volumeTag).add(row.bodyId);}
    if(declared.size!==volumes.size||[...volumes].some(([tag,data])=>!declared.has(tag)||!sameSet(data.owners,declared.get(tag))))add('OWNERSHIP_INCONSISTENT','error','来源分组与体归属凭据不一致。');
  }
  const at=index.positionAt||((n)=>index.positions[n]);
  let finite=0,legacySum=0,min=null,max=null,bad=0;const total={sum:0,compensation:0},connectivity=new TetraConnectivity(),spatialCheck=new LinearTetraSpatial(index.cells.length,at,spatialLimits);
  for(const cell of index?.cells||[]){
    connectivity.add(cell);
    const state=qualityCellState(cell,index);for(const key of ['invalid','inverted','degenerate'])if(state[key])counts[key+'Count']++;
    if(!state.invalid&&!state.inverted&&!state.degenerate&&cell.quality<index.threshold)counts.lowQualityCount++;
    if(state.invalid||state.inverted||state.degenerate||cell.quality!==null&&cell.quality<index.threshold)bad++;
    if(cell.quality!==null){finite++;legacySum+=cell.quality;addQualityValue(total,cell.quality);min=min===null?cell.quality:Math.min(min,cell.quality);max=max===null?cell.quality:Math.max(max,cell.quality);}
    const volume=volumes.get(cell.volumeTag);
    spatialCheck.add(cell,Boolean(volume&&sameSet(volume.owners,new Set(cell.bodyIds))));
    if(!volume||!sameSet(volume.owners,new Set(cell.bodyIds)))add('CELL_OWNERSHIP_INVALID','error','四面体的体编号或 Body 归属与完整实体清单不一致。');else volume.cells++;
  }
  counts.meshedVolumeCount=[...volumes.values()].filter(volume=>volume.cells>0).length;
  counts.badCount=bad;
  const topology=connectivity.finish(),spatial=spatialCheck.finish();
  spatial.samples=spatial.samples.map(sample=>({...sample,cells:sample.elementIds.map((elementId,i)=>{
    const volume=volumes.get(sample.volumeTags[i]);
    if(!volume||sample.ownersVerified[i]!==true)return null;
    const bodyIds=[...volume.owners],bodyIdentities=Object.fromEntries(bodyIds.filter(id=>bodies.has(id)).map(id=>[id,{bodyIdentity:bodies.get(id).bodyIdentity,topologyIdentity:bodies.get(id).topologyIdentity}]));
    const locatable=sample.elementIdsTruncated[i]===false&&/^[1-9][0-9]*$/.test(elementId)&&sample.corners[i].length===12&&sample.corners[i].every(Number.isFinite)&&bodyIds.length>0&&bodyIds.every(id=>/^[a-f0-9]{32}$/.test(bodyIdentities[id]?.bodyIdentity||'')&&/^[a-f0-9]{32}$/.test(bodyIdentities[id]?.topologyIdentity||''));
    return {elementId,volumeTag:sample.volumeTags[i],corners:locatable?sample.corners[i]:null,locatable,bodyIds,bodyIdentities};
  })}));
  if(spatial.overlapPairCount)add('OVERLAPPING_TETRAHEDRA','error','存在线性四面体的正体积空间重叠；数值质量和连接关系正常也不能使用。',spatial.overlapPairCount);
  if(spatial.invalidGeometryCount)add('INVALID_LINEAR_TETRA_GEOMETRY','error','存在线性四面体的非有限坐标或零体积角点几何，空间检查未将其视为有效单元。',spatial.invalidGeometryCount);
  if(spatial.skippedHighOrderCount)add('CURVED_TETRA_SPATIAL_UNCHECKED','warning','高阶曲边单元未进行完整空间相交检查；本报告的空间检查仅覆盖线性四面体，不证明曲边网格无相交。',spatial.skippedHighOrderCount);
  // Only bounded samples retain cell details. Coordinates are read from the
  // same certified index used for admission, never from a second path lookup.
  topology.samples=topology.samples.map(({rawCell,...sample})=>{
    if(!rawCell)return {...sample,cell:null};
    const coordinates=rawCell.corners.flatMap(node=>[at(node*3),at(node*3+1),at(node*3+2)]);
    const bodyIdentities=Object.fromEntries(rawCell.bodyIds.filter(id=>bodies.has(id)).map(id=>[id,{bodyIdentity:bodies.get(id).bodyIdentity,topologyIdentity:bodies.get(id).topologyIdentity}]));
    const volume=volumes.get(rawCell.volumeTag),ownersVerified=volume&&sameSet(volume.owners,new Set(rawCell.bodyIds));
    const locatable=Boolean(ownersVerified)&&coordinates.length===12&&coordinates.every(Number.isFinite)&&rawCell.bodyIds.length>0&&rawCell.bodyIds.every(id=>/^[a-f0-9]{32}$/.test(bodyIdentities[id]?.bodyIdentity||'')&&/^[a-f0-9]{32}$/.test(bodyIdentities[id]?.topologyIdentity||''));
    return {...sample,cell:{...rawCell,...qualityCellState(rawCell,index),corners:locatable?coordinates:null,locatable,bodyIdentities}};
  });
  if(topology.duplicateTetraCount)add('DUPLICATE_TETRAHEDRA','error','存在角点连接相同的重复四面体；不同单元编号不能掩盖重复。',topology.duplicateTetraCount);
  if(topology.nonManifoldFaceCount)add('NON_MANIFOLD_TETRA_FACES','error','存在超过两个四面体共用的非流形面。',topology.nonManifoldFaceCount);
  if(topology.inconsistentOrientationFaceCount)add('INCONSISTENT_TETRA_FACE_ORIENTATION','error','共享四面体面的方向不一致，可能存在局部重叠或反向连接。',topology.inconsistentOrientationFaceCount);
  const empty=counts.volumeCount-counts.meshedVolumeCount;if(empty)add('EMPTY_MESH_VOLUMES','error','部分几何体没有生成四面体，不能只验收其余体。',empty);
  for(const [key,code,message] of [['invalidCount','INVALID_ELEMENTS','存在无法计算或非有限的单元。'],['invertedCount','INVERTED_ELEMENTS','存在反转四面体。'],['degenerateCount','DEGENERATE_ELEMENTS','存在退化四面体。']])if(counts[key])add(code,'error',message,counts[key]);
  if(quality?.version===2&&index){
    const expected={tetraCount:counts.tetraCount,finiteCount:finite,nonFiniteQualityCount:counts.tetraCount-finite,badCount:bad,invalidCount:counts.invalidCount,invertedCount:counts.invertedCount,degenerateCount:counts.degenerateCount};
    if(Object.entries(expected).some(([key,value])=>quality[key]!==value)||quality.threshold!==index.threshold||mesh.nodeCount!==index.positions.length/3)add('QUALITY_SUMMARY_INCONSISTENT','error','质量汇总与保存的数值索引不一致。');
    const close=(a,b)=>a===null||b===null?a===b:typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(a),Math.abs(b));
    const average=finite?(total.sum+total.compensation)/finite:null,averageMatches=close(quality.averageQuality,average)||quality.summation===undefined&&close(quality.averageQuality,finite?legacySum/finite:null);
    if(quality.summation!==undefined&&quality.summation!=='neumaier-v1'||!close(quality.minQuality,min)||!close(quality.maxQuality,max)||!averageMatches)add('QUALITY_SUMMARY_INCONSISTENT','error','质量汇总与保存的数值索引不一致。');
    if(!integer(quality.unsupportedElementCount)||quality.unsupportedElementCount||quality.status!=='complete')add('ELEMENT_COVERAGE_INCOMPLETE','error','四面体质量报告未覆盖全部体单元。');
    if(!counts.tetraCount)add('NO_TETRAHEDRA','error','没有可使用的四面体单元。');
  }
  const conformity=mesh?.conformity;
  if(conformity?.basis!=='shared-node-tags'||!Array.isArray(conformity.interfaces))add('CONFORMITY_EVIDENCE_MISSING','unknown','缺少共形接口节点核对报告。');
  else{
    const invalid=conformity.interfaces.filter(row=>!integer(row.nodeCount)||row.nodeCount===0||!integer(row.missingNodeReferences)||row.missingNodeReferences>0||!Array.isArray(row.volumeTags)||row.volumeTags.some(tag=>!volumes.has(tag))).length;
    if(!integer(conformity.interfaceCount)||!integer(conformity.embeddedSurfaceCount)||!integer(conformity.nonConformalCount)||conformity.nonConformalCount!==invalid||invalid||conformity.interfaceCount+conformity.embeddedSurfaceCount!==conformity.interfaces.length)add('NONCONFORMAL_INTERFACES','error','接口或内嵌面没有完整共享体单元节点。',Math.max(1,invalid));
    const expected=new Map((mesh.boundaryMapping?.surfaces||[]).filter(row=>row.adjacentSolidIds.length>1||row.embeddedSolidIds?.length).map(row=>[row.surfaceTag,{role:row.embeddedSolidIds?.length?'embedded':'interface',tags:new Set([...row.adjacentSolidIds,...(row.embeddedSolidIds||[])].map(id=>Number(id.slice(6))))}]));
    const seenSurfaces=new Set();let embedded=0;
    for(const row of conformity.interfaces){
      const wanted=expected.get(row.surfaceTag),tags=new Set(row.volumeTags||[]),owners=new Set([...tags].flatMap(tag=>[...(volumes.get(tag)?.owners||[])]));
      if(!wanted||seenSurfaces.has(row.surfaceTag)||wanted.role!==row.role||!sameSet(wanted.tags,tags)||tags.size!==row.volumeTags?.length||!Array.isArray(row.bodyIds)||!sameSet(owners,new Set(row.bodyIds)))add('CONFORMITY_COVERAGE_INCOMPLETE','error','共形报告与实际面邻接清单不一致，存在漏检或错误接口。');
      seenSurfaces.add(row.surfaceTag);if(row.role==='embedded')embedded++;
    }
    if(expected.size!==seenSurfaces.size||embedded!==conformity.embeddedSurfaceCount)add('CONFORMITY_COVERAGE_INCOMPLETE','error','共形报告未覆盖完整的接口或内嵌面。');
  }
  const boundary=mesh?.boundaryMapping;
  if(boundary?.version!==(discrete?2:1)||boundary.backend!==sourceFamily)add('BOUNDARY_EVIDENCE_MISSING','unknown','缺少 CAD Face 到网格面的来源证据。');
  else{
    if(!boundary.complete||boundary.sourceFaces.some(row=>row.state==='unresolved')||boundary.surfaces.some(row=>[...(row.adjacentSolidIds||[]),...(row.embeddedSolidIds||[])].some(id=>!volumes.has(Number(id.slice(6))))))add('BOUNDARY_MAPPING_INCOMPLETE','error','CAD 面来源或邻接体映射不完整。');
    const emptySurfaces=boundary.surfaces.filter(surface=>surface.area>0&&surface.elementCount===0).length;
    if(emptySurfaces)add('EMPTY_MESH_SURFACES','error','部分几何面没有生成约束面单元。',emptySurfaces);
    const coveredBodies=new Set([...volumes.values()].flatMap(volume=>[...volume.owners])),coveredSheets=new Set(boundary.surfaces.filter(surface=>surface.elementCount>0).flatMap(surface=>surface.sources.map(row=>row.bodyId)));
    for(const body of bodies.values()){
      if(body.kind==='solid'&&!coveredBodies.has(body.bodyId))add('BODY_COVERAGE_MISSING','error','完整工程中有 Body 没有体网格。');
      if(body.kind==='sheet'&&!coveredSheets.has(body.bodyId))add('SHEET_COVERAGE_MISSING','error','完整工程中有 Sheet 没有约束面网格。');
    }
    const removed=boundary.sourceFaces.filter(row=>row.state==='removed').length;if(removed)add('REMOVED_SOURCE_FACES','warning','修复移除了部分来源面，请复核关联属性。',removed);
    const exterior=boundary.surfaces.filter(surface=>surface.adjacentSolidIds?.length===1&&!surface.embeddedSolidIds?.length).reduce((sum,surface)=>sum+surface.elementCount,0);
    topology.expectedBoundaryFaceCount=exterior;
    if(exterior!==topology.boundaryFaceCount)add('TETRA_BOUNDARY_COVERAGE_INCONSISTENT','error','四面体外露三角面数量与完整外边界网格不一致，可能存在裂缝、重复面或漏体。');
  }
  if(counts.lowQualityCount)add('LOW_QUALITY_ELEMENTS',qualityPolicy==='strict'?'error':'warning',qualityPolicy==='strict'?'存在低于封存阈值的单元；严格验收未通过，结果仅供诊断。':'存在低于用户阈值的单元；这与反转/退化错误分开处理。',counts.lowQualityCount);
  const status=reasons.some(row=>row.severity==='error')?'blocked':reasons.some(row=>row.severity==='unknown')?'unverified':reasons.length?'warning':'accepted';
  return {version:1,policy:'tetra-preprocessing-v3',status,usable:status==='accepted'||status==='warning',counts,reasons,topology,spatial};
}
