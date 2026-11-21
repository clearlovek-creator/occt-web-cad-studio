"use client";
import {useCallback,useState} from 'react';
import {API_ROOT} from './api-config.ts';
import {assessMeshSource} from '../shared/mesh-source.mjs';
import {useMeshQuery} from './model/use-mesh-query';
import {parseSurfaceReport} from './model/surface-task';
import type {ProjectMeshTasks} from './model/use-project-mesh-jobs';
import type {MeshFaceSource} from './model/mesh';
import {MESH_QUERY_TIMEOUTS} from '../shared/mesh-query-timeouts.mjs';

type Props={tasks:ProjectMeshTasks;documentId:string;revision:number|null;geometry:unknown;busy:boolean;onLocate:(face:MeshFaceSource)=>void};
const format=(n:number)=>new Intl.NumberFormat('zh-CN',{maximumSignificantDigits:5}).format(n);
export function MeshSurfacePanel({tasks,documentId,revision,geometry,busy,onLocate}:Props){
  const [open,setOpen]=useState(Boolean(tasks.surfaceInspection)),[bodyId,setBodyId]=useState(''),[offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0);
  const result=tasks.surfaceInspection?.meshJob.documentId===documentId?tasks.surfaceInspection:null,job=result?.meshJob;
  const current=Boolean(job&&assessMeshSource(job.source,geometry,documentId).status==='current');
  const bodies=(geometry as {bodyMetadata?:{bodyId:string;name:string;visible?:boolean}[]})?.bodyMetadata||[];
  const parse=useCallback((value:unknown)=>parseSurfaceReport(value,job?.jobId||'',documentId),[job?.jobId,documentId]);
  const query=new URLSearchParams({bodyId,offset:String(offset),limit:'10'});
  const {data,loading,error}=useMeshQuery(`${API_ROOT}/mesh/jobs/${encodeURIComponent(job?.jobId||'none')}/surface-report?${query}`,open&&Boolean(result),`${refresh}:${current}`,parse,MESH_QUERY_TIMEOUTS.browserMs);
  const unavailable=tasks.surfaceAvailable!==true,blocked=busy||tasks.busy||Boolean(tasks.active)||!tasks.historyKnown||tasks.catalog.state!=='ready'||revision===null||unavailable;
  const summary=result?.surfaceSummary;
  return <details className="mesh-surface-panel" data-testid="mesh-surface-panel" open={open} onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}>
    <summary><strong>表面交叉重构</strong><span>全部几何 · 独立结果</span></summary>
    <div className="mesh-surface-content">
      <p className="mesh-surface-note">拆分相交三角面并保留 Body / Face / Solid 来源，不修改工程几何，不生成体网格。</p>
      <p className="mesh-surface-note">独立策略：CAD 离散 0.05 mm · 表面修复容差 1e-7 mm。上方体网格尺寸、质量和优化设置不用于此任务。</p>
      {unavailable&&<p className="mesh-surface-warning" role="status">{tasks.loading?'正在核对后台能力…':'当前后台未提供表面重构引擎；不会使用其他算法替代。刷新任务记录可重新核对。'}</p>}
      <button type="button" disabled={blocked} onClick={()=>{if(revision!==null)void tasks.create({kind:'surface-reconstruction',baseRevision:revision});}}>重构全部几何表面</button>
      {!summary?<p className="mesh-surface-empty">完成后在任务记录中查看表面报告；结果不加入普通网格显示。</p>:<>
        <div className="mesh-surface-heading"><strong>来源 R{job?.revision??'—'} · {summary.inputHadCrossings?'交叉已拆分':'未发现输入交叉'}</strong><span>仅表面 · 非体网格</span></div>
        <p className="mesh-surface-counts"><b>{summary.inputTriangles.toLocaleString()}</b> → <b>{summary.outputTriangles.toLocaleString()}</b> 个三角面<span>{summary.bodyCount} Body · {summary.faceCount} Face · {summary.solidCount} Solid</span></p>
        <p className="mesh-surface-note">离散支持面最大偏差 {format(summary.maxSourceDeviation)} mm；CAD 曲面的严格距离界未认证。{summary.estimateExceedsRequestedFaceCount>0?` ${summary.estimateExceedsRequestedFaceCount} 个来源面的估计偏差超出请求值，请复核。`:''}</p>
        {(!current||data&&!data.sourceCurrent)&&<p className="mesh-surface-warning" role="status">来源已过期或尚未核对：仅查看历史记录，不能定位到当前几何。</p>}
        <div className="mesh-surface-filters"><label><span>来源 Body</span><select aria-label="表面报告来源 Body" value={bodyId} onChange={event=>{setBodyId(event.target.value);setOffset(0);}}><option value="">全部 Body</option>{job?.source?.bodies.map(body=><option key={body.bodyId} value={body.bodyId}>{current?bodies.find(b=>b.bodyId===body.bodyId)?.name||body.bodyId:body.bodyId}</option>)}</select></label><button type="button" disabled={loading} onClick={()=>setRefresh(value=>value+1)}>重新读取报告</button></div>
        {loading&&<p role="status">正在核对完整来源并读取本页…</p>}{error&&<p className="property-error" role="alert">{error}</p>}
        {data&&<><div className="mesh-surface-table"><table aria-label="表面重构来源面"><thead><tr><th>CAD 来源面</th><th>三角面</th><th>体归属</th><th>定位</th></tr></thead><tbody>{data.faces.map(face=>{const visible=bodies.some(body=>body.bodyId===face.source.bodyId&&body.visible!==false),canLocate=current&&data.sourceCurrent;return <tr key={face.source.bodyId+face.source.cadFaceId}><td><strong>{current?bodies.find(body=>body.bodyId===face.source.bodyId)?.name||face.source.bodyId:face.source.bodyId}</strong><small>{face.source.cadFaceId}{face.estimateExceedsRequested?' · 估计偏差警告':''}</small></td><td>{face.inputTriangles} → {face.outputTriangles}<small>共享输出 {face.sharedOutputTriangles}</small></td><td title={face.solidIds.join(' / ')}>{face.solidIds.length?`${face.solidIds.length} Solid`:'自由 Sheet'}</td><td><button type="button" aria-label={`定位来源面 ${face.source.cadFaceId}`} disabled={!canLocate||!visible} title={!canLocate?'来源不再属于当前几何':!visible?'所属 Body 已隐藏':'选择并高亮原 CAD 面'} onClick={()=>onLocate(face.source)}>定位</button></td></tr>;})}</tbody></table></div>
          {data.total===0&&<p>该筛选下没有来源面。</p>}
          <div className="mesh-surface-pages"><span>共 {data.total} 面 · {data.total?data.offset+1:0}–{Math.min(data.total,data.offset+data.faces.length)}</span><button type="button" disabled={loading||offset===0} onClick={()=>setOffset(value=>Math.max(0,value-10))}>上一页</button><button type="button" disabled={loading||offset+10>=data.total} onClick={()=>setOffset(value=>value+10)}>下一页</button></div>
        </>}
      </>}
    </div>
  </details>;
}
