import type {MeshJobPayload,MeshQualitySelection,MeshTopologyKind,MeshTopologySample} from './mesh';
export const meshTopologyLabels:Record<MeshTopologyKind,string>={'duplicate-tetra':'重复四面体','face-orientation':'公共面方向冲突','non-manifold-face':'非流形公共面'};

/** Reuse the certified cell coordinates and owner identities from admission.
 * Never turn a node ordinal, truncated ID or stale report into a viewport pick. */
export function topologySampleProblem(result:MeshJobPayload,sample:MeshTopologySample):string {
  if(!sample||!Object.hasOwn(meshTopologyLabels,sample.kind))return '样例类型无法验证';
  if(sample.elementIdTruncated||typeof sample.elementId!=='string'||sample.elementId.length>80)return '编号过长或无效，仅供诊断下载核查';
  const cell=sample.cell,source=result.meshJob.source;
  if(!cell||cell.locatable!==true||!Array.isArray(cell.corners)||cell.corners.length!==12||!cell.corners.every(Number.isFinite))return '样例坐标不可用';
  if(!cell.corners.every(value=>Number.isFinite(Math.fround(value))))return '样例坐标超出视口范围';
  if(cell.elementId!==sample.elementId||!/^[1-9][0-9]*$/.test(cell.elementId)||!Array.isArray(cell.bodyIds)||!cell.bodyIds.length)return '样例单元身份不一致';
  if(!source||!Array.isArray(source.bodies)||cell.bodyIds.some(id=>{const body=source.bodies.find(body=>body&&body.bodyId===id),identity=cell.bodyIdentities?.[id];return !body||!identity||!/^[a-f0-9]{32}$/.test(identity.bodyIdentity)||!/^[a-f0-9]{32}$/.test(identity.topologyIdentity)||body.bodyIdentity!==identity.bodyIdentity||body.topologyIdentity!==identity.topologyIdentity;}))return '样例归属身份无法验证';
  const corners=sample.cellNodeIndexes,nodes=sample.nodeIndexes,expected=sample.kind==='duplicate-tetra'?4:3;
  if(!Array.isArray(corners)||corners.length!==4||new Set(corners).size!==4||!corners.every(node=>Number.isSafeInteger(node)&&node>=0)||!Array.isArray(nodes)||nodes.length!==expected||new Set(nodes).size!==expected||nodes.some(node=>!Number.isSafeInteger(node)||node<0||!corners.includes(node)))return '公共面与参与单元的连接不一致';
  return '';
}

export function topologySampleSelection(result:MeshJobPayload,sample:MeshTopologySample,sampleIndex:number):MeshQualitySelection|null {
  if(topologySampleProblem(result,sample)||!Number.isSafeInteger(sampleIndex)||sampleIndex<0||sampleIndex>=8)return null;
  return {jobId:result.meshJob.jobId,documentId:result.meshJob.documentId,source:result.meshJob.source,cell:sample.cell!,threshold:result.mesh.quality?.threshold,
    topology:{kind:sample.kind,sampleIndex,...(sample.kind==='duplicate-tetra'?{}:{faceCornerSlots:sample.nodeIndexes.map(node=>sample.cellNodeIndexes.indexOf(node))})}};
}
