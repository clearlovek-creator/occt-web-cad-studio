import type {MeshJobPayload,MeshQualitySelection} from './model/mesh';
import {meshTopologyLabels,topologySampleProblem,topologySampleSelection} from './model/mesh-topology';

export function MeshTopologySamples({result,current,visibleBodyIds,bodyNames={},selection,onLocate}:{result:MeshJobPayload;current:boolean;visibleBodyIds:string[];bodyNames?:Record<string,string>;selection:MeshQualitySelection|null;onLocate:(selection:MeshQualitySelection|null)=>void}) {
  const report=result.mesh.admission?.topology;
  if(!report||report.version!==1||report.basis!=='tetra-corner-connectivity-v1')return null;
  const samples=Array.isArray(report.samples)?report.samples.slice(0,8).filter(sample=>sample&&typeof sample==='object'):[],incomplete=report.checkedTetraCount!==result.mesh.admission?.counts.tetraCount;
  const boundaryMismatch=report.expectedBoundaryFaceCount!==undefined&&report.expectedBoundaryFaceCount!==report.boundaryFaceCount;
  const hasIssues=report.duplicateTetraCount>0||report.nonManifoldFaceCount>0||report.inconsistentOrientationFaceCount>0||boundaryMismatch;
  const chosen=selection?.jobId===result.meshJob.jobId?selection.topology?.sampleIndex:undefined;
  return <details className="mesh-topology-samples" data-testid="mesh-topology-samples">
    <summary>连接拓扑 · {incomplete?'检查不完整':hasIssues?'有异常':`已检查 ${report.checkedTetraCount} 个四面体`}</summary>
    <dl className="mesh-topology-counts" aria-label="连接拓扑计数">
      <div><dt>重复单元</dt><dd>{report.duplicateTetraCount}</dd></div><div><dt>非流形面</dt><dd>{report.nonManifoldFaceCount}</dd></div><div><dt>方向冲突</dt><dd>{report.inconsistentOrientationFaceCount}</dd></div><div><dt>外露面 / 预期</dt><dd>{report.boundaryFaceCount} / {report.expectedBoundaryFaceCount??'—'}</dd></div>
    </dl>
    <p className="mesh-quality-note">最多 8 条样例，非完整问题清单。显示参与单元的角点外框；面异常另示角点三角面。</p>
    {!current&&<p className="mesh-quality-warning" role="status">来源几何已变化或无法验证，样例保留，定位已禁用。</p>}
    {samples.length>0?<ol className="mesh-topology-list" aria-label="连接异常样例">{samples.map((sample,index)=>{
      const reason=topologySampleProblem(result,sample),visible=Array.isArray(sample.cell?.bodyIds)&&sample.cell.bodyIds.some(id=>visibleBodyIds.includes(id));
      const disabledReason=!current?'来源已过期':reason||(!visible?'所属 Body 已隐藏':'');
      const owners=Array.isArray(sample.cell?.bodyIds)?sample.cell.bodyIds:[];
      return <li key={index} data-selected={chosen===index}><div><strong>{Object.hasOwn(meshTopologyLabels,sample.kind)?meshTopologyLabels[sample.kind]:'未知连接异常'}</strong><span>单元 {String(sample.elementId??'—').slice(0,80)}{sample.elementIdTruncated||String(sample.elementId??'').length>80?'…（编号截断）':''}</span><small>{owners.length?owners.slice(0,4).map(id=>current?bodyNames[id]||id:id).join(' / '):'所属 Body 未验证'}{owners.length>4?` 等 ${owners.length} 个 Body`:''}</small>{disabledReason&&<small>{disabledReason}</small>}</div><button type="button" aria-label={`定位连接样例 ${index+1}`} aria-pressed={chosen===index} disabled={Boolean(disabledReason)} title={disabledReason||'透视高亮此样例，不显示整份网格'} onClick={()=>{const value=topologySampleSelection(result,sample,index);if(value)onLocate(value);}}>定位</button></li>;
    })}</ol>:<p className="mesh-quality-note">{boundaryMismatch?'边界总量不一致，当前没有可靠的局部定位样例，请下载诊断网格核查。':incomplete?'部分无效角点未进入连接检查，请同时查看数值质量报告。':hasIssues?'未提供可验证的连接异常坐标，请下载诊断网格核查。':'未记录连接异常样例。'}</p>}
    {chosen!==undefined&&<button type="button" className="mesh-topology-clear" onClick={()=>onLocate(null)}>清除样例定位</button>}
  </details>;
}
