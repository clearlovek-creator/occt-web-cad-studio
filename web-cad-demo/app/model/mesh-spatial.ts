import type {MeshJobPayload,MeshQualitySelection,MeshSpatialSample} from './mesh';

export function diagnosticCells(selection:MeshQualitySelection){return selection.spatial?[selection.cell,selection.spatial.peer]:[selection.cell];}
export function diagnosticCellsVisible(selection:MeshQualitySelection,visibleBodyIds:string[]){
  return diagnosticCells(selection).every(cell=>cell&&Array.isArray(cell.bodyIds)&&cell.bodyIds.some(id=>visibleBodyIds.includes(id)));
}
/** Shared adoption guard: no fake numerical quality is needed for a spatial cell. */
export function diagnosticSelectionProblem(selection:MeshQualitySelection):string{
  const cells=diagnosticCells(selection),source=selection.source;
  if(!Array.isArray(source?.bodies))return '单元归属身份不一致';
  const owners=new Map<string,(typeof source.bodies)[number]>();
  for(const body of source.bodies){if(!body||typeof body.bodyId!=='string'||owners.has(body.bodyId))return '来源 Body 清单不一致';owners.set(body.bodyId,body);}
  if(selection.spatial&&(!Number.isInteger(selection.spatial.sampleIndex)||selection.spatial.sampleIndex<0||selection.spatial.sampleIndex>=8||selection.topology||cells[0]?.elementId===cells[1]?.elementId))return '空间样例身份不一致';
  if(!selection.spatial&&!('quality' in (selection.cell||{})))return '缺少单元诊断类型';
  for(const cell of cells){
    if(!cell||cell.locatable!==true||!Array.isArray(cell.corners)||cell.corners.length!==12||!cell.corners.every(value=>Number.isFinite(value)&&Number.isFinite(Math.fround(value))))return '单元坐标不可用或超出视口范围';
    if(typeof cell.elementId!=='string'||!/^[1-9][0-9]*$/.test(cell.elementId)||!Array.isArray(cell.bodyIds)||!cell.bodyIds.length||cell.bodyIds.some(id=>typeof id!=='string')||new Set(cell.bodyIds).size!==cell.bodyIds.length||!Array.isArray(source?.bodies))return '单元归属身份不一致';
    for(const id of cell.bodyIds){
      const owner=owners.get(id),identity=cell.bodyIdentities?.[id];
      if(!owner||!identity||!/^[a-f0-9]{32}$/.test(identity.bodyIdentity)||!/^[a-f0-9]{32}$/.test(identity.topologyIdentity)||owner.bodyIdentity!==identity.bodyIdentity||owner.topologyIdentity!==identity.topologyIdentity)return '单元归属身份不一致';
    }
  }
  return '';
}
export function spatialSampleProblem(result:MeshJobPayload,sample:MeshSpatialSample):string{
  if(!sample||!Array.isArray(sample.elementIds)||sample.elementIds.length!==2||sample.elementIds.some(id=>typeof id!=='string'||id.length>80)||!Array.isArray(sample.elementIdsTruncated)||sample.elementIdsTruncated.length!==2||sample.elementIdsTruncated.some(value=>value!==false))return '单元编号截断或无法验证';
  if(!Array.isArray(sample.cells)||sample.cells.length!==2||sample.cells.some(cell=>!cell)||!Array.isArray(sample.ownersVerified)||sample.ownersVerified.length!==2||sample.ownersVerified.some(value=>value!==true))return '参与单元归属未验证';
  if(!Array.isArray(sample.volumeTags)||sample.volumeTags.length!==2||sample.volumeTags.some(tag=>!Number.isSafeInteger(tag)||tag<=0||tag>0xffffffff)||!Array.isArray(sample.corners)||sample.corners.length!==2)return '空间样例结构不一致';
  for(let i=0;i<2;i++){
    const cell=sample.cells[i]!;
    if(cell.elementId!==sample.elementIds[i]||cell.volumeTag!==sample.volumeTags[i]||!Array.isArray(sample.corners[i])||sample.corners[i].length!==12||!Array.isArray(cell.corners)||cell.corners.length!==12||cell.corners.some((n,j)=>n!==sample.corners[i][j]))return '空间样例坐标或编号不一致';
  }
  return diagnosticSelectionProblem({jobId:result.meshJob.jobId,documentId:result.meshJob.documentId,source:result.meshJob.source,cell:sample.cells[0]!,spatial:{sampleIndex:0,peer:sample.cells[1]!}});
}
export function spatialSampleSelection(result:MeshJobPayload,sample:MeshSpatialSample,sampleIndex:number):MeshQualitySelection|null{
  if(spatialSampleProblem(result,sample)||!Number.isInteger(sampleIndex)||sampleIndex<0||sampleIndex>=8)return null;
  return {jobId:result.meshJob.jobId,documentId:result.meshJob.documentId,source:result.meshJob.source,cell:sample.cells![0]!,spatial:{sampleIndex,peer:sample.cells![1]!}};
}
