"use client";
import {useState} from "react";
import {API_ROOT} from "./api-config.ts";
import type {MeshJobPayload,MeshQualityPage,MeshQualitySelection,MeshQualityCell} from "./model/mesh";
import {useMeshQuery} from './model/use-mesh-query';
import {MESH_QUERY_TIMEOUTS} from '../shared/mesh-query-timeouts.mjs';

function qualityResponse(value:unknown):MeshQualityPage{
  const page=value as MeshQualityPage;
  if(!page.quality||!Array.isArray(page.cells)||!Number.isSafeInteger(page.total)||page.total<0)throw Error('质量报告响应结构无效，未采用结果。');
  return page;
}

function cellStatus(cell:MeshQualityCell,threshold:number) {
  const labels=[cell.invalid?"无法计算":"",cell.inverted?"反转":"",cell.degenerate?"退化":""].filter(Boolean);
  return labels.length?labels.join(" / "):(cell.quality??1)<threshold?"低质量":"正常";
}

export function MeshQualityPanel({result,current,bodyNames,visibleBodyIds,selection,onLocate}:{result:MeshJobPayload;current:boolean;bodyNames:Record<string,string>;visibleBodyIds:string[];selection:MeshQualitySelection|null;onLocate:(value:MeshQualitySelection|null)=>void}) {
  const [open,setOpen]=useState(false),[threshold,setThreshold]=useState(String(result.mesh.quality?.threshold??.2));
  const [appliedThreshold,setAppliedThreshold]=useState(Number(threshold)),[bodyId,setBodyId]=useState(""),[issue,setIssue]=useState("bad"),[offset,setOffset]=useState(0);
  const [validationError,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const available=Boolean(result.mesh.qualityDiagnostics);
  const query=new URLSearchParams({threshold:String(appliedThreshold),bodyId,issue,offset:String(offset),limit:'10'});
  const {data:page,loading,error:requestError}=useMeshQuery(`${API_ROOT}/mesh/jobs/${encodeURIComponent(result.meshJob.jobId)}/quality?${query}`,open&&available,String(refresh),qualityResponse,MESH_QUERY_TIMEOUTS.browserMs);
  const error=validationError||requestError;
  const summary=page?.quality||(!open||!available?result.mesh.quality:undefined);
  // A native summary can be the very evidence rejected by admission. Do not
  // show "0 problems" beside an independently detected inverted element.
  const headerCounts=open&&page?page.quality:result.mesh.admission?.counts||summary;
  const format=(value:number|null|undefined)=>typeof value==="number"&&Number.isFinite(value)?value.toFixed(3):"—";
  const canLocate=(ids:string[])=>current&&ids.some(id=>visibleBodyIds.includes(id));
  const chosen=selection?.jobId===result.meshJob.jobId?selection.cell.elementId:null;
  const apply=()=>{const number=Number(threshold);if(!threshold.trim()||!Number.isFinite(number)||number<0||number>1){setError("阈值必须在 0 到 1 之间。");return;}setError('');setAppliedThreshold(number);setOffset(0);setRefresh(value=>value+1);};
  const histogram=summary?.histogram||[],maxBin=Math.max(1,...histogram.map(bin=>bin.count));
  return <details className="mesh-quality-panel" onToggle={event=>{if(event.target!==event.currentTarget)return;setOpen(event.currentTarget.open);if(event.currentTarget.open){setError('');setRefresh(value=>value+1);}}}>
    <summary>数值质量检查{headerCounts?` · 问题 ${headerCounts.badCount} / ${headerCounts.tetraCount}`:""}</summary>
    <div className="mesh-quality-content">
      <p className="mesh-quality-note">minSICN 为形状质量指标；反转按最小 Jacobian 判断，退化与反转分开计数。阈值仅筛选已有结果，不重新剖分。</p>
      {!available&&<p role="status">此旧结果未保存单元明细，重新剖分后可筛选和定位。</p>}
      {available&&<>
        <div className="mesh-quality-filters">
          <label><span>结果 Body</span><select aria-label="质量结果 Body" value={bodyId} onChange={event=>{setBodyId(event.target.value);setOffset(0);}}><option value="">全部 Body</option>{(result.meshJob.source?.bodies||[]).filter(body=>body.kind==="solid").map(body=><option key={body.bodyId} value={body.bodyId}>{current?bodyNames[body.bodyId]||body.bodyId:body.bodyId}</option>)}</select></label>
          <label><span>问题类型</span><select aria-label="质量问题类型" value={issue} onChange={event=>{setIssue(event.target.value);setOffset(0);}}><option value="bad">所有问题</option><option value="inverted">反转</option><option value="degenerate">退化</option><option value="invalid">无法计算</option><option value="all">全部单元</option></select></label>
          <label><span>质量阈值</span><input aria-label="质量筛选阈值" type="number" min="0" max="1" step="0.05" value={threshold} onChange={event=>setThreshold(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")apply();}}/></label>
          <button type="button" onClick={apply} disabled={loading}>查询已有结果</button>
        </div>
        {summary&&<>
          <dl className="mesh-quality-stats" aria-label="质量统计"><div><dt>最小 / 平均</dt><dd>{format(summary.minQuality)} / {format(summary.averageQuality)}</dd></div><div><dt>反转 / 退化</dt><dd>{summary.invertedCount} / {summary.degenerateCount??0}</dd></div><div><dt>无法计算</dt><dd>{summary.invalidCount??0}</dd></div></dl>
          <details className="mesh-quality-distribution"><summary>质量分布 · {summary.finiteCount??summary.tetraCount} 个有限值</summary><table aria-label="四面体质量分布"><thead><tr><th>区间</th><th>数量分布</th><th>单元</th></tr></thead><tbody>{histogram.map((bin,index)=><tr key={index}><th>{bin.lower.toFixed(1)}–{bin.upper.toFixed(1)}{bin.includeUpper?"]":")"}</th><td><meter min="0" max={maxBin} value={bin.count} aria-label={`${bin.lower} 到 ${bin.upper}，${bin.count} 个单元`}/></td><td>{bin.count}</td></tr>)}</tbody></table></details>
        </>}
        {Boolean(result.mesh.quality?.unsupportedElementCount)&&<p className="mesh-quality-warning">另有 {result.mesh.quality?.unsupportedElementCount} 个非四面体单元，未纳入本报告；不能据此认定整个网格合格。</p>}
        {Boolean(summary?.outOfRangeCount)&&<p className="mesh-quality-warning">有 {summary?.outOfRangeCount} 个质量值超出归一化范围，需核查，未计入分布区间。</p>}
        {Boolean((summary?.invertedCount??0)+(summary?.degenerateCount??0)+(summary?.invalidCount??0))&&<p className="mesh-quality-warning">存在反转、退化或无法计算的单元，需修正后再使用。来源有效不代表质量合格。</p>}
        {!current&&<p className="mesh-quality-warning" role="status">来源几何已变化或无法验证。历史报告可查看，定位已禁用。</p>}
        {page?.cells.some(cell=>cell.order>1)&&<p className="mesh-quality-note">高阶单元定位显示四个角点的外框；质量和 Jacobian 按完整高阶单元计算。</p>}
        <div className="mesh-quality-list-heading"><strong>{issue==='all'?'单元明细':'问题单元'} · {page?.total??"—"}</strong>{selection&&<button type="button" onClick={()=>onLocate(null)}>清除单元定位</button>}</div>
        {loading&&<p role="status">正在载入质量数据…</p>}
        {error&&<p className="property-error" role="alert">{error}</p>}
        {!loading&&!error&&page&&<>
          {!page.cells.length?<p className="mesh-quality-note">当前筛选没有匹配的四面体单元；这不代表所有网格检查均已通过。</p>:<div className="mesh-quality-table-scroll"><table aria-label={issue==='all'?'网格单元明细':'网格问题单元'}><thead><tr><th>单元 / 状态</th><th>质量</th><th>归属 Body</th><th>定位</th></tr></thead><tbody>{page.cells.map(cell=><tr key={cell.elementId} aria-selected={chosen===cell.elementId}>
            <td><strong>{cell.elementId}</strong><small>{cellStatus(cell,appliedThreshold)} · {cell.order} 阶</small></td><td>{format(cell.quality)}</td><td title={cell.bodyIds.join(" / ")}>{cell.bodyIds.map(id=>current?bodyNames[id]||id:id).join(" / ")}</td><td><button type="button" aria-label={`定位单元 ${cell.elementId}`} disabled={!cell.locatable||!canLocate(cell.bodyIds)} title={!current?"来源已过期":!canLocate(cell.bodyIds)?"所属 Body 已隐藏":!cell.locatable?"坐标不可用":"聚焦此单元，不改变几何显示"} onClick={()=>onLocate({jobId:result.meshJob.jobId,documentId:result.meshJob.documentId,source:result.meshJob.source,cell,threshold:appliedThreshold})}>定位</button></td>
          </tr>)}</tbody></table></div>}
          <div className="mesh-quality-pagination"><button type="button" disabled={offset===0} onClick={()=>setOffset(value=>Math.max(0,value-10))}>上一页</button><span>{page.total?offset+1:0}–{Math.min(offset+10,page.total)} / {page.total}</span><button type="button" disabled={offset+10>=page.total} onClick={()=>setOffset(value=>value+10)}>下一页</button></div>
        </>}
      </>}
    </div>
  </details>;
}
