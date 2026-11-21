"use client";
import {useState} from "react";
import {API_ROOT} from "./api-config";
import type {MeshBoundary,MeshFaceSource,MeshJobPayload} from "./model/mesh";
import {useMeshQuery} from './model/use-mesh-query';
import {MESH_QUERY_TIMEOUTS} from '../shared/mesh-query-timeouts.mjs';

function boundaryResponse(value:unknown):MeshBoundary{
  const boundary=(value as {boundary?:MeshBoundary})?.boundary;
  if(!boundary||!Array.isArray(boundary.sourceFaces)||!Array.isArray(boundary.surfaces))throw Error('面来源响应结构无效，未采用结果。');
  return boundary;
}

export function MeshBoundaryPanel({result,current,bodyNames,visibleBodyIds,selectedBodyId,selectedFaceId,onLocate}:{result:MeshJobPayload;current:boolean;bodyNames:Record<string,string>;visibleBodyIds:string[];selectedBodyId?:string|null;selectedFaceId?:string|null;onLocate:(source:MeshFaceSource)=>void}) {
  const [open,setOpen]=useState(false),[bodyId,setBodyId]=useState(""),[refresh,setRefresh]=useState(0),[page,setPage]=useState(0);
  const available=Boolean(result.mesh.boundaryMapping);
  const {data,loading,error}=useMeshQuery(`${API_ROOT}/mesh/jobs/${encodeURIComponent(result.meshJob.jobId)}/boundary?${new URLSearchParams({bodyId})}`,open&&available,`${current}:${refresh}`,boundaryResponse,MESH_QUERY_TIMEOUTS.browserMs);
  const faces=data?.sourceFaces||[],surfaceIndex=new Map(data?.surfaces.map(surface=>[surface.surfaceTag,surface]));
  const selected=faces.find(face=>face.source.bodyId===selectedBodyId&&face.source.cadFaceId===selectedFaceId);
  const labels={mapped:"已对应",removed:"已移除",unresolved:"待核对"};
  return <details className="mesh-quality-panel mesh-boundary-panel" onToggle={event=>{if(event.target!==event.currentTarget)return;setOpen(event.currentTarget.open);if(event.currentTarget.open)setRefresh(value=>value+1);}}>
    <summary>面来源与属性{available?` · ${result.mesh.boundaryMapping!.sourceFaces.length} 个 CAD 面`:" · 旧结果不含来源"}</summary>
    <div className="mesh-quality-content">
      <p className="mesh-quality-note">修复和共形分块仅在临时快照中进行，不修改工程。一个 CAD 面可对应多个网格面，共享界面也可来自多个 CAD 面；网格面编号不是 CAD 面编号。</p>
      {!available?<p role="status">重新剖分后可检查 CAD 面来源；旧结果不能按面序号猜测关联。</p>:<>
        <div className="mesh-quality-filters"><label><span>来源 Body</span><select aria-label="面来源 Body" value={bodyId} onChange={event=>{setBodyId(event.target.value);setPage(0);}}><option value="">全部 Body</option>{result.meshJob.source?.bodies.map(body=><option key={body.bodyId} value={body.bodyId}>{current?bodyNames[body.bodyId]||body.bodyId:body.bodyId}</option>)}</select></label><button type="button" disabled={loading} onClick={()=>setRefresh(value=>value+1)}>刷新面属性</button></div>
        {!current&&<p className="mesh-quality-warning" role="status">当前几何与来源不一致：仅查看历史来源，不关联当前属性，也不定位当前几何。</p>}
        {data&&!data.complete&&<p className="mesh-quality-warning">全局存在未解析的面来源，相关边界属性不能视为已完整传递，请核对或修复后重新剖分。</p>}
        {data?.propertyStatus==='unavailable'&&<p className="mesh-quality-warning">当前属性服务不可用，未推断属性关联。</p>}
        {selected&&<p className="mesh-quality-note" aria-label="当前 CAD 面网格来源">当前选择 {selected.source.cadFaceId} → {selected.surfaceTags.length} 个网格面 · {labels[selected.state]}</p>}
        {loading&&<p role="status">正在读取面来源和属性…</p>}{error&&<p className="property-error" role="alert">{error}</p>}
        {!loading&&!error&&data&&<>
          <p className="mesh-quality-note">{faces.length} 个来源面 · {data.surfaces.length} 个网格面 · 属性{data.propertyStatus==='current'?'按当前工程解析':'未关联'}</p>
          <div className="mesh-quality-table-scroll"><table aria-label="CAD 面与网格面对应"><thead><tr><th>CAD 来源／属性</th><th>网格面</th><th>检查</th></tr></thead><tbody>{faces.slice(page*10,page*10+10).map(face=><tr key={`${face.source.bodyId}/${face.source.cadFaceId}`} aria-selected={face.source.bodyId===selectedBodyId&&face.source.cadFaceId===selectedFaceId}>
            <td><strong>{current?bodyNames[face.source.bodyId]||face.source.bodyId:face.source.bodyId}</strong><small>{face.source.cadFaceId} · {labels[face.state]}</small>{face.properties?.map(property=><details key={property.instanceId} className="mesh-boundary-property"><summary>{property.name} · {property.typeName}</summary><dl>{Object.entries(property.value||{}).map(([name,value])=><div key={name}><dt>{name}</dt><dd>{typeof value==='object'?JSON.stringify(value):String(value)}</dd></div>)}</dl></details>)}{!face.properties?.length&&data.propertyStatus==='current'&&<small>无面属性实例</small>}</td>
            <td>{face.surfaceTags.length}<small>{face.surfaceTags.map(tag=>`#${tag}`).join(', ')||'—'}</small><small>{face.surfaceTags.reduce((sum,tag)=>sum+(surfaceIndex.get(tag)?.elementCount||0),0)} 个面单元</small></td>
            <td><button type="button" aria-label={`定位 CAD 面 ${face.source.bodyId} ${face.source.cadFaceId}`} disabled={!current||face.state!=='mapped'||!visibleBodyIds.includes(face.source.bodyId)} onClick={()=>onLocate(face.source)}>定位</button></td>
          </tr>)}</tbody></table></div>
          {!faces.length&&<p className="mesh-quality-note">此筛选没有来源面。</p>}
          <div className="mesh-quality-pagination"><button type="button" disabled={page===0||loading} onClick={()=>setPage(value=>value-1)}>上一页面</button><span>{faces.length?`${page*10+1}–${Math.min(page*10+10,faces.length)} / ${faces.length}`:'0 / 0'}</span><button type="button" disabled={(page+1)*10>=faces.length||loading} onClick={()=>setPage(value=>value+1)}>下一页面</button></div>
          {Boolean(data.unresolvedProperties?.length)&&<details><summary>待核对面属性 · {data.unresolvedProperties!.length}</summary>{data.unresolvedProperties!.map(property=><p key={property.instanceId} className="mesh-quality-warning">{property.name}：{property.reason||property.state}</p>)}</details>}
          {data.surfaces.some(surface=>!surface.sources.length)&&<details><summary>未解析网格面 · {data.surfaces.filter(surface=>!surface.sources.length).length}</summary>{data.surfaces.filter(surface=>!surface.sources.length).map(surface=><p key={surface.meshFaceId} className="mesh-quality-warning">{surface.meshFaceId} · 面积 {surface.area.toPrecision(5)} mm² · {surface.elementCount} 个面单元；未自动指定 CAD 来源。</p>)}</details>}
        </>}
      </>}
    </div>
  </details>;
}
