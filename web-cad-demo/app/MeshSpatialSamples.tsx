import type {MeshJobPayload,MeshQualitySelection} from './model/mesh';
import {diagnosticCellsVisible,spatialSampleProblem,spatialSampleSelection} from './model/mesh-spatial';

export function MeshSpatialSamples({result,current,visibleBodyIds,bodyNames={},selection,onLocate}:{result:MeshJobPayload;current:boolean;visibleBodyIds:string[];bodyNames?:Record<string,string>;selection:MeshQualitySelection|null;onLocate:(value:MeshQualitySelection|null)=>void}){
  const report=result.mesh.admission?.spatial;
  if(!report||report.version!==1||report.basis!=='linear-tetra-positive-volume-sat-v1')return null;
  const samples=Array.isArray(report.samples)?report.samples.slice(0,8).filter(sample=>sample&&typeof sample==='object'):[],chosen=selection?.jobId===result.meshJob.jobId?selection.spatial?.sampleIndex:undefined;
  return <details className="mesh-topology-samples mesh-spatial-samples" data-testid="mesh-spatial-samples">
    <summary>空间重叠 · {report.overlapPairCount>0?`${report.overlapPairCount} 对异常`:report.status==='partial'?'检查范围不完整':'未发现线性单元重叠'}</summary>
    <dl className="mesh-topology-counts" aria-label="空间检查计数"><div><dt>已检查线性单元</dt><dd>{report.checkedTetraCount}</dd></div><div><dt>重叠单元对</dt><dd>{report.overlapPairCount}</dd></div><div><dt>未检查高阶单元</dt><dd>{report.skippedHighOrderCount}</dd></div><div><dt>无效角点几何</dt><dd>{report.invalidGeometryCount}</dd></div></dl>
    <p className="mesh-quality-note">最多 8 对样例。A 为红色、B 为黄色；同时透视显示两者角点外框，不显示整份未通过的网格。</p>
    {report.status==='partial'&&<p className="mesh-quality-warning">仅覆盖有效线性四面体，不能据此证明高阶曲边单元无相交。</p>}
    {!current&&<p className="mesh-quality-warning" role="status">来源已变化，历史样例保留，双单元定位已禁用。</p>}
    {samples.length?<ol className="mesh-topology-list" aria-label="空间重叠样例">{samples.map((sample,index)=>{
      const problem=spatialSampleProblem(result,sample),value=problem?null:spatialSampleSelection(result,sample,index),visible=value&&diagnosticCellsVisible(value,visibleBodyIds),reason=!current?'来源已过期':problem||(!visible?'部分所属 Body 已隐藏':'');
      return <li key={index} data-selected={chosen===index}><div><strong>重叠单元对 {index+1}</strong>{[0,1].map(slot=>{const owners=!problem?sample.cells![slot]!.bodyIds:[];return <span key={slot}><b>{slot===0?'A':'B'}</b> · {String(sample.elementIds?.[slot]??'—').slice(0,80)}{sample.elementIdsTruncated?.[slot]?'…（编号截断）':''}<small> · {owners.slice(0,4).map(id=>current?bodyNames[id]||id:id).join(' / ')||'归属未验证'}{owners.length>4?` 等 ${owners.length} 个 Body`:''}</small></span>;})}{reason&&<small>{reason}</small>}</div><button type="button" aria-label={`定位重叠样例 ${index+1}`} aria-pressed={chosen===index} disabled={Boolean(reason)} title={reason||'同时聚焦两个参与单元'} onClick={()=>{if(value)onLocate(value);}}>定位两者</button></li>;
    })}</ol>:<p className="mesh-quality-note">{report.overlapPairCount?'未提供可靠的双单元样例，请下载诊断网格核查。':'未记录空间重叠样例；接触共形与高阶空间检查另行判断。'}</p>}
    {chosen!==undefined&&<button type="button" className="mesh-topology-clear" onClick={()=>onLocate(null)}>清除重叠定位</button>}
  </details>;
}
