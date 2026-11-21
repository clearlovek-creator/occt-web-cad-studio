import crypto from 'node:crypto';
import {validateCadDiscreteTetraResult,cadTetraMesh,cadTetraSurfaceRows,isConstrainedCadTetraResult} from './cad-discrete-tetra.mjs';
import {discreteTetraMetrics} from './discrete-tetra-protocol.mjs';
import {DISCRETE_MESH_FAMILY,DISCRETE_CONSTRAINED_MESH_FAMILY,validateDiscreteMeshFamily} from './discrete-mesh-family.mjs';
import {validateQualityIndex,queryMeshQuality} from './mesh-quality-query.mjs';
import {validateMeshBoundary} from './mesh-boundary-query.mjs';
import {assessMeshAdmission} from './mesh-admission.mjs';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted=values=>[...new Set(values)].sort(),faceKey=row=>row.bodyId+'/'+row.cadFaceId;
const subtract=(a,b)=>a.map((v,i)=>v-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const area=(nodes,points)=>Math.hypot(...cross(subtract(points[nodes[1]],points[nodes[0]]),subtract(points[nodes[2]],points[nodes[0]])))/2;
export const DISCRETE_SICN_ROUNDOFF_TOLERANCE=16*Number.EPSILON;
/** Only the independently coordinate-recomputed metric may use this projection.
 * SICN is mathematically bounded by one. Never apply this to saved/provider
 * metrics, low-quality cells or genuine out-of-range values. */
export function normalizeDiscreteSICN(value){
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1+DISCRETE_SICN_ROUNDOFF_TOLERANCE)throw Object.assign(Error('坐标重算的 SICN 超出可解释的舍入范围。'),{code:'MESH_DISCRETE_PROJECTION_INVALID'});
  return Math.min(1,value);
}
/** Derive ordinary mesh evidence from authenticated ORIGINAL materials. No
 * admission flag supplied by a native worker or a persisted projection counts.
 * Run in the existing bounded artifact worker, not in a request handler. */
export function adaptDiscreteTetraMesh({snapshot,result,checkpoint,targetDocumentId,jobId,spatialLimits}){
  if(!/^mesh-[a-f0-9-]{36}$/.test(jobId||''))throw Object.assign(Error('离散网格适配任务身份无效。'),{code:'MESH_DISCRETE_PROJECTION_INVALID'});
  validateCadDiscreteTetraResult(result,snapshot,{checkpoint});
  if(targetDocumentId!==undefined&&(!/^[A-Za-z0-9_-]{1,64}$/.test(targetDocumentId)||![2,4].includes(result.version)))throw Object.assign(Error('恢复网格的目标工程身份无效。'),{code:'MESH_DISCRETE_PROJECTION_INVALID'});
  const source=structuredClone(snapshot.cad.source),output=cadTetraMesh(result),partition=result.partition,constrained=isConstrainedCadTetraResult(result),family=constrained?DISCRETE_CONSTRAINED_MESH_FAMILY:DISCRETE_MESH_FAMILY,boundaries=cadTetraSurfaceRows(result);
  if(targetDocumentId!==undefined)source.documentId=targetDocumentId;
  const provenance={version:1,sourceSnapshotSha256:hash(snapshot),partitionSha256:hash(partition),nativeResultSha256:hash(output)};
  const sourceSolids=partition.sourceSolids.map((row,sourceSolidIndex)=>({sourceSolidIndex,bodyId:row.bodyId,solidId:row.solidId}));
  const owners=partition.cells.map(cell=>sorted(cell.sourceSolidIndexes.map(i=>sourceSolids[i].bodyId)));
  const anchors=new Map(),sourceFaces=new Map();
  for(const face of snapshot.cad.bundle.inventory.faces){
    const body=source.bodies.find(row=>row.bodyId===face.bodyId),anchor={bodyId:body.bodyId,cadFaceId:face.faceId,bodyIdentity:body.bodyIdentity,topologyIdentity:body.topologyIdentity,topologyRevision:body.topologyRevision};
    anchors.set(faceKey(anchor),anchor);sourceFaces.set(faceKey(anchor),{source:anchor,state:'unresolved',surfaceTags:[]});
  }
  const surfaces=boundaries.map((boundary,index)=>{
    const sources=new Map();for(const triangle of boundary.sourceTriangleIds){const row=partition.sources[triangle],anchor=anchors.get(row.bodyId+'/'+row.faceId);if(!anchor)throw Object.assign(Error('分区边界缺少原始 CAD 面身份。'),{code:'MESH_DISCRETE_PROJECTION_INVALID'});sources.set(faceKey(anchor),anchor);}
    const surfaceTag=index+1,values=[...sources.values()].sort((a,b)=>faceKey(a).localeCompare(faceKey(b)));
    for(const anchor of values){const face=sourceFaces.get(faceKey(anchor));face.state='mapped';face.surfaceTags.push(surfaceTag);}
    return {surfaceTag,meshFaceId:'mesh-face-'+surfaceTag,area:boundary.triangles.reduce((sum,nodes)=>sum+area(nodes,output.points),0),elementCount:boundary.triangles.length,sources:values,adjacentSolidIds:boundary.cellUses.map(use=>'solid-'+(use.cellIndex+1)),embeddedSolidIds:constrained&&boundary.constraint.kind==='embedded'?boundary.constraint.cellIndexes.map(i=>'solid-'+(i+1)):[]};
  });
  const removed=new Set(partition.surfaceReport.removedDegenerateInputTriangles);
  for(const face of snapshot.cad.bundle.inventory.faces){const record=sourceFaces.get(face.bodyId+'/'+face.faceId);if(record.surfaceTags.length)continue;const ids=face.uses.flatMap(use=>Array.from({length:use.triangleCount},(_,i)=>use.triangleStart+i));if(ids.length&&ids.every(i=>removed.has(i)))record.state='removed';}
  const boundaryMapping={version:2,backend:family,repairMode:'discrete-partition',provenance:structuredClone(provenance),complete:[...sourceFaces.values()].every(face=>face.state!=='unresolved')&&surfaces.every(surface=>surface.sources.length>0),sourceFaces:[...sourceFaces.values()],surfaces};
  const sourceSheetFaces=constrained?snapshot.cad.bundle.inventory.faces.filter(f=>f.uses.some(use=>use.solidId==='')).map(f=>({bodyId:f.bodyId,cadFaceId:f.faceId})):[],sheetKeys=new Set(sourceSheetFaces.map(f=>f.bodyId+'/'+f.cadFaceId));
  const assignments=[],groups=[];
  for(let cellIndex=0;cellIndex<partition.cells.length;cellIndex++)for(const bodyId of owners[cellIndex]){
    const sourceSolidIds=partition.cells[cellIndex].sourceSolidIndexes.filter(i=>sourceSolids[i].bodyId===bodyId).map(i=>sourceSolids[i].solidId).sort(),volumeTag=cellIndex+1;
    assignments.push({volumeTag,partitionCellIndex:cellIndex,bodyId,sourceSolidIds});
    const faces=surfaces.filter(surface=>surface.adjacentSolidIds.includes('solid-'+volumeTag)&&surface.sources.some(row=>row.bodyId===bodyId)).map(surface=>({groupId:'mesh-face-'+surface.surfaceTag+'/owner/'+bodyId,kind:'face',meshFaceId:surface.meshFaceId,bodyId,cadFaceIds:surface.sources.filter(row=>row.bodyId===bodyId).map(row=>row.cadFaceId),wireKey:'wire-2-'+surface.surfaceTag}));
    groups.push({groupId:'solid-'+volumeTag+'/owner/'+bodyId,kind:'solid',solidId:'solid-'+volumeTag,partitionCellIndex:cellIndex,bodyId,sourceSolidIds,wireKey:'wire-3-'+volumeTag,faces});
  }
  if(constrained)for(const surface of surfaces)for(const bodyId of sorted(surface.sources.filter(s=>sheetKeys.has(s.bodyId+'/'+s.cadFaceId)).map(s=>s.bodyId)))groups.push({groupId:surface.meshFaceId+'/owner/'+bodyId,kind:'face',meshFaceId:surface.meshFaceId,bodyId,cadFaceIds:sorted(surface.sources.filter(s=>s.bodyId===bodyId&&sheetKeys.has(s.bodyId+'/'+s.cadFaceId)).map(s=>s.cadFaceId)),wireKey:'wire-2-'+surface.surfaceTag});
  const index={version:1,requestId:jobId,qualityName:'minSICN',threshold:snapshot.settings.quality.threshold,positions:output.points.flat(),cells:[]};
  // Boundary element IDs come first in MSH. Volume IDs are unique globally and
  // remain identical in the quality index, export and locatable diagnostics.
  const surfaceElementCount=constrained?output.report.surfaceTriangleCount:output.report.boundaryTriangleCount;
  let elementId=surfaceElementCount,normalizedCount=0,maxExcess=0;
  for(const cell of output.cells)for(const corners of cell.tetrahedra){
    const metrics=discreteTetraMetrics(...corners.map(n=>output.points[n])),quality=normalizeDiscreteSICN(metrics.quality);if(quality!==metrics.quality){normalizedCount++;maxExcess=Math.max(maxExcess,metrics.quality-quality);}index.cells.push({elementId:String(++elementId),elementType:4,order:1,volumeTag:cell.cellIndex+1,corners:[...corners],bodyIds:[...owners[cell.cellIndex]],quality,minJacobian:metrics.volume*6,maxJacobian:metrics.volume*6});
  }
  validateQualityIndex(index,{jobId,source});
  const summary=queryMeshQuality(index,{jobId,source},{issue:'all',limit:1}).quality;
  const interfaces=boundaries.flatMap((boundary,i)=>{const embedded=constrained&&boundary.constraint.kind==='embedded',cells=embedded?boundary.constraint.cellIndexes:boundary.cellUses.map(u=>u.cellIndex);return embedded||cells.length>1?[{surfaceTag:i+1,role:embedded?'embedded':'interface',nodeCount:new Set(boundary.triangles.flat()).size,missingNodeReferences:0,volumeTags:cells.map(c=>c+1),bodyIds:sorted(cells.flatMap(c=>owners[c]))}]:[];});
  const mesh={dimension:3,nodeCount:output.points.length,elementCount:output.report.tetraCount+surfaceElementCount,qualityDiagnostics:true,
    quality:{...summary,version:2,status:'complete',unsupportedElementCount:0,summation:'neumaier-v1',...(normalizedCount?{roundoffNormalization:{version:1,basis:'coordinate-SICN-unit-bound-v1',normalizedCount,maxExcess,tolerance:DISCRETE_SICN_ROUNDOFF_TOLERANCE}}:{})},
    sourceInventory:{version:2,basis:family,provenance:structuredClone(provenance),sourceSolids,cells:partition.cells.map((cell,cellIndex)=>({cellIndex,sourceSolidIndexes:[...cell.sourceSolidIndexes],bodyIds:[...owners[cellIndex]]})),surfaceCount:surfaces.length,sourceFaceKeys:[...sourceFaces.keys()].sort(),...(constrained?{sourceSheetFaces}: {})},
    render:{kind:'wire',dimension:3,positions:[],groups,ownership:{mode:family,provenance:structuredClone(provenance),assignments,unmappedBodyIds:[],unassignedVolumeTags:[]}},boundaryMapping,
    conformity:{basis:'shared-node-tags',interfaceCount:interfaces.filter(r=>r.role==='interface').length,embeddedSurfaceCount:interfaces.filter(r=>r.role==='embedded').length,nonConformalCount:0,interfaces},
    materialMapping:structuredClone(result.cellMaterials),approximation:structuredClone(snapshot.cad.bundle.policy)};
  validateDiscreteMeshFamily(mesh,source);validateMeshBoundary(boundaryMapping,source,{sourceFamily:family});
  mesh.admission=assessMeshAdmission(mesh,index,source,{sourceFamily:family,qualityPolicy:'strict',qualityThreshold:index.threshold,spatialLimits});
  if(snapshot.settings.quality.mode!=='strict'){
    mesh.admission={...mesh.admission,status:'blocked',usable:false,reasons:[...mesh.admission.reasons,{code:'DISCRETE_DIAGNOSTIC_ONLY',severity:'error',count:1,message:'该任务明确为诊断模式，不能作为普通可用网格发布。'}]};
  }
  return {version:1,basis:family,jobId,source,provenance,mesh,index,defaultVisible:false,normalMeshAdmitted:mesh.admission.usable};
}
