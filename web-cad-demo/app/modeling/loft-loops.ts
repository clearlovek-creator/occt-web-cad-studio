export type BoundaryLoop={loopId:string;role:'outer'|'inner';closed:boolean;length:number|null;edgeIds:string[]};
export type FaceBoundarySummary={version:1;faceId:string;complete:boolean;planar:boolean;valid:boolean;loops:BoundaryLoop[]};
type Presentation={topologyRevision:number;edges:{edgeId:string}[];triangleFaceIds:string[]};
export type LoftSectionDraft={key:string;sectionId?:string;bodyId:string;faceId?:string;featureId?:string;holeCount:number;holeEdgeIds?:string[]};
type Feature={stringParameters:Record<string,string>};
export function loftVersionKind(feature?:Feature):'legacy'|'real'|'unsupported'{const version=feature?.stringParameters.loftVersion;return version===undefined?'legacy':['2','3'].includes(version)?'real':'unsupported';}
export function parseFaceBoundaries(value:unknown,faceId:string,presentation:Presentation):FaceBoundarySummary{
  const item=value as FaceBoundarySummary,edges=new Set(presentation.edges.map(edge=>edge.edgeId));
  const fail=()=>{throw Error('截面边界信息不完整或不属于当前显示，不能设置孔对应，请重新读取。');};
  if(!item||item.version!==1||item.faceId!==faceId||!presentation.triangleFaceIds.includes(faceId)||typeof item.complete!=='boolean'||typeof item.planar!=='boolean'||typeof item.valid!=='boolean'||!Array.isArray(item.loops)||item.loops.length>65)return fail();
  const ids=new Set(),used=new Set();let count=0;
  for(const loop of item.loops){
    if(!loop||!/^loop-[1-9]\d*$/.test(loop.loopId)||ids.has(loop.loopId)||!['outer','inner'].includes(loop.role)||typeof loop.closed!=='boolean'||!(loop.length===null||typeof loop.length==='number'&&Number.isFinite(loop.length)&&loop.length>=0)||!Array.isArray(loop.edgeIds)||!loop.edgeIds.length||loop.edgeIds.some(edge=>typeof edge!=='string'||!edges.has(edge)||used.has(edge))||new Set(loop.edgeIds).size!==loop.edgeIds.length)return fail();
    ids.add(loop.loopId);loop.edgeIds.forEach(edge=>used.add(edge));count+=loop.edgeIds.length;
  }
  if(count>4096||item.loops.filter(loop=>loop.role==='outer').length!==1)return fail();return item;
}
export function loopMappingIssue(summary:FaceBoundarySummary|null,seeds:string[],expectedCount?:number):string|null{
  if(!summary)return '请先读取所选截面的边界。';
  if(!summary.complete)return '边界信息已截断，不能据此创建或修复放样。';
  if(!summary.valid||!summary.planar||summary.loops.some(loop=>!loop.closed))return '放样只接受有效平面面及闭合边界；当前面不能用作截面。';
  const holes=summary.loops.filter(loop=>loop.role==='inner');
  if(holes.length>16)return '每个截面最多支持 16 个贯通孔。';
  if(expectedCount!==undefined&&holes.length!==expectedCount)return `本截面需保留 ${expectedCount} 个孔，所选面有 ${holes.length} 个；请选择孔数一致的历史面。`;
  if(seeds.length!==holes.length)return '请逐个明确设置孔对应；不会按位置自动匹配。';
  const selected=seeds.map(seed=>holes.find(loop=>loop.edgeIds.includes(seed))?.loopId);
  if(selected.some(id=>!id)||new Set(selected).size!==holes.length)return '请为每个孔选择不同的内环，不得遗漏或重复。';return null;
}
export function initialLoftSections(feature?:Feature):LoftSectionDraft[]{
  if(!feature||loftVersionKind(feature)==='legacy')return [];
  if(loftVersionKind(feature)==='unsupported')throw Error('该放样定义版本尚不支持，不能按旧近似打开。');
  let rows;try{rows=JSON.parse(feature.stringParameters.loftSections);}catch{throw Error('放样截面记录损坏，未用空定义替代。');}
  if(!Array.isArray(rows)||rows.length<2||rows.length>32)throw Error('放样截面记录数量无效，未用空定义替代。');
  const result:LoftSectionDraft[]=rows.map(row=>{
    if(!row||typeof row.sectionId!=='string'||!row.sectionId||typeof row.bodyId!=='string'||!row.bodyId||typeof row.featureId!=='string'||!row.featureId)throw Error('放样截面身份无效。');
    const holes=row.holeSelectors;
    if(holes!==undefined&&(!Array.isArray(holes)||!holes.length||holes.length>16||holes.some(token=>typeof token!=='string'||token.length>65536)))throw Error('放样孔对应记录无效。');
    return {key:row.sectionId,sectionId:row.sectionId,bodyId:row.bodyId,featureId:row.featureId,holeCount:holes?.length||0};
  });
  if(new Set(result.map(row=>row.sectionId)).size!==result.length||result.some(row=>row.holeCount!==result[0].holeCount)||feature.stringParameters.loftVersion==='3'&&!result[0].holeCount||feature.stringParameters.loftVersion==='2'&&result[0].holeCount)throw Error('放样截面孔数或版本不一致，不能静默填孔。');return result;
}
export function loftSectionInputs(sections:LoftSectionDraft[]){
  if(sections.length<2||sections.length>32)throw Error('请添加 2–32 个有序截面。');
  if(sections.some(row=>row.holeCount!==sections[0].holeCount))throw Error('各截面孔数必须一致；请检查截面及孔对应。');
  return sections.map(row=>{
    if(row.sectionId)return {sectionId:row.sectionId};
    if(!row.faceId||row.holeCount>0&&(!row.holeEdgeIds||row.holeEdgeIds.length!==row.holeCount||row.holeEdgeIds.some(edge=>!edge)||new Set(row.holeEdgeIds).size!==row.holeCount))throw Error('新截面缺少明确的面或孔对应。');
    return {bodyId:row.bodyId,faceId:row.faceId,...(row.holeCount?{holeEdgeIds:row.holeEdgeIds}: {})};
  });
}
