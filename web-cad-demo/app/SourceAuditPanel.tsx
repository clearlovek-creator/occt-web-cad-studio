"use client";
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {API_ROOT} from './api-config';
import {activeSourceAudit,parseSourceAudit,sourceStatusLabel,type SourceAsset,type SourceAudit} from './model/source-audit';
import {SourceRestorePanel} from './SourceRestorePanel';
import type {RestorationBinding} from './model/source-restoration';
import {ImportedNamingUpgradePanel,type NamingUpgradeGeometry} from './ImportedNamingUpgradePanel';
import type {ModelingCommandResponse} from './modeling/command-contract';

const scopeLabel={current:'当前',undo:'撤销',redo:'重做',recovery:'事务恢复',quarantine:'隔离快照',retained:'保留快照'};
const phaseLabel=(audit:SourceAudit)=>({queued:'等待工程读取',running:audit.phase==='discovery'?'清点存储文件':audit.phase==='sources'?'核对 STEP 内容':'读取历史来源',stopping:'正在停止检查',complete:'检查完成',failed:'检查未完成',cancelled:'检查已取消'}[audit.state]||'状态待核对');

export function SourceAuditPanel({documentId,stateToken,initialView='audit',geometry=null,blocked=false,onModel=()=>{},onHistory=()=>{}}:{documentId:string;stateToken:string|null;initialView?:'audit'|'restores';geometry?:NamingUpgradeGeometry|null;blocked?:boolean;onModel?:(result:ModelingCommandResponse)=>void;onHistory?:(featureId?:string)=>void}){
  const [scope,setScope]=useState<'project'|'storage'>(initialView==='restores'?'storage':'project'),[view,setView]=useState<'audit'|'restores'|'upgrade'>(initialView),[binding,setBinding]=useState<RestorationBinding|null>(null),[operationId,setOperationId]=useState<string|null>(null);
  const owner=scope==='storage'?'@storage':documentId;
  return <section className="source-workbench" aria-label="工程来源管理"><div className="source-audit-scope-switch" role="group" aria-label="来源管理页面"><button type="button" aria-pressed={view==='audit'} onClick={()=>setView('audit')}>来源检查</button><button type="button" aria-pressed={view==='restores'} onClick={()=>{setBinding(null);setOperationId(null);setView('restores');}}>恢复记录</button><button type="button" aria-pressed={view==='upgrade'} onClick={()=>setView('upgrade')}>引用升级</button></div>
    {view==='upgrade'?<ImportedNamingUpgradePanel key={documentId} documentId={documentId} geometry={geometry} blocked={blocked} onModel={onModel} onSources={()=>setView('audit')} onHistory={onHistory}/>:null}
    {view==='audit'?<SourceAuditReport key={scope+':'+documentId} documentId={owner} stateToken={scope==='storage'?null:stateToken} storage={scope==='storage'} onScope={setScope} onRestore={value=>{setBinding(value);setOperationId(null);setView('restores');}} onRecord={id=>{setBinding(null);setOperationId(id);setView('restores');}}/>:view==='restores'?<><div className="source-audit-scope-switch" role="group" aria-label="恢复记录范围"><button type="button" aria-pressed={scope==='project'} onClick={()=>{setOperationId(null);setScope('project');}}>当前工程记录</button><button type="button" aria-pressed={scope==='storage'} onClick={()=>{setOperationId(null);setScope('storage');}}>全部工程记录</button></div><SourceRestorePanel key={owner} documentId={owner} binding={binding?.documentId===owner?binding:null} initialOperationId={operationId} onBack={()=>setView('audit')}/></>:null}
  </section>;
}
function SourceAuditReport({documentId,stateToken,storage,onScope,onRestore,onRecord}:{documentId:string;stateToken:string|null;storage:boolean;onScope:(scope:'project'|'storage')=>void;onRestore:(binding:RestorationBinding)=>void;onRecord:(id:string)=>void}){
  const [audit,setAudit]=useState<SourceAudit|null>(null),[loaded,setLoaded]=useState(false),[pending,setPending]=useState<string|null>(null),[error,setError]=useState('');
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[page,setPage]=useState(0),[now,setNow]=useState(0);
  const owner=useRef({alive:false,epoch:0,timer:undefined as ReturnType<typeof setTimeout>|undefined,controller:null as AbortController|null});
  const poll=useRef<()=>void>(()=>{});
  const request=useCallback(async(method:'GET'|'POST'|'DELETE')=>{
    const state=owner.current,epoch=++state.epoch;clearTimeout(state.timer);state.controller?.abort();const controller=new AbortController();state.controller=controller;
    const timeout=setTimeout(()=>controller.abort(),15000);let rejected=false;setPending(method);setError('');if(method==='POST'){setAudit(null);setPage(0);}
    try{
      const response=await fetch(storage?`${API_ROOT}/source-catalog`:`${API_ROOT}/documents/${encodeURIComponent(documentId)}/source-audit`,{method,signal:controller.signal});
      const text=await response.text();if(text.length>32*1024*1024)throw Error('来源检查报告超出显示预算，请保留原文件并检查工程规模。');
      let payload;try{payload=JSON.parse(text);}catch{throw Error(`来源检查服务响应无效（HTTP ${response.status}）。`);}
      if(!response.ok||payload?.ok!==true){rejected=true;throw Error(typeof payload?.error==='string'?payload.error:'来源检查请求失败。');}
      const result=parseSourceAudit(payload,documentId);
      if(!state.alive||epoch!==state.epoch)return;
      setAudit(result);setLoaded(true);setNow(Date.now());
      // Reopen and recovery only read the accepted task; never repeat POST/DELETE.
      state.timer=setTimeout(()=>poll.current(),activeSourceAudit(result)?750:5000);
    }catch(reason){if(state.alive&&epoch===state.epoch){setLoaded(true);setError(method==='GET'||rejected?(reason instanceof Error?reason.message:'来源报告读取失败。'):`${method==='POST'?'启动':'停止'}请求的结果未确认。请先“重查状态”，不会自动重发请求。`);}}
    finally{clearTimeout(timeout);if(state.alive&&epoch===state.epoch)setPending(null);}
  },[documentId,storage]);
  useEffect(()=>{poll.current=()=>void request('GET');},[request]);
  useEffect(()=>{const state=owner.current;state.alive=true;const epoch=++state.epoch;queueMicrotask(()=>{if(state.alive&&epoch===state.epoch)void request('GET');});return()=>{state.alive=false;state.epoch++;clearTimeout(state.timer);state.controller?.abort();};},[request]);
  const active=activeSourceAudit(audit);
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[active]);
  const stale=Boolean(audit&&(audit.stale||(audit.stateToken&&stateToken&&audit.stateToken!==stateToken)));
  const healthy=Boolean(audit?.integrityOK&&!stale&&!error&&!pending);
  const filtered=useMemo(()=>(audit?.assets||[]).filter(row=>(filter==='all'||filter==='attention'&&row.status!=='verified')&&row.fileName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())),[audit,filter,search]);
  const pages=Math.max(1,Math.ceil(filtered.length/50)),currentPage=Math.min(page,pages-1),rows=filtered.slice(currentPage*50,currentPage*50+50);
  const elapsed=audit?Math.max(0,Math.floor(((audit.finishedAt?Date.parse(audit.finishedAt):now)-Date.parse(audit.createdAt))/1000)):0;
  return <section className="panel-section source-audit-panel" data-testid="source-audit-panel" aria-label="工程来源检查">
    <div className="section-heading compact"><div><span className="eyebrow">STEP SOURCE INTEGRITY</span><h2>{storage?'存储来源清点':'来源完整性'}</h2></div><span className="feature-badge">只读</span></div>
    <div className="source-audit-scope-switch" role="group" aria-label="来源检查范围"><button type="button" aria-pressed={!storage} onClick={()=>onScope('project')}>当前工程</button><button type="button" aria-pressed={storage} onClick={()=>onScope('storage')}>全部工程与恢复区</button></div>
    <p className="panel-copy">{storage?'清点已保存工程、事务恢复区、隔离区与保留快照，列出来源归属。不会打开工程、执行恢复或清理文件。':'核对当前模型、撤销与重做检查点实际依赖的 STEP 文件。不重算几何，不修改绑定或清理文件。'}</p>
    <div className="source-audit-actions"><button type="button" disabled={!loaded||Boolean(pending)||active||Boolean(error)} onClick={()=>void request('POST')}>{audit?'重新检查':'开始检查'}</button><button type="button" disabled={Boolean(pending)} onClick={()=>void request('GET')}>重查状态</button>{active&&<button type="button" disabled={Boolean(pending)||audit?.state==='stopping'} onClick={()=>void request('DELETE')}>停止检查</button>}</div>
    <div className={`source-audit-status ${healthy?'verified':stale||error||audit&&!active&&!audit.integrityOK?'attention':''}`} role="status">
      <strong>{pending==='POST'?'正在启动检查…':!loaded?'正在读取检查记录…':error?'报告暂未核对':stale?'报告已过期，请重新检查':audit?healthy?storage?'已发现引用均已验证':'来源完整性已验证':phaseLabel(audit):storage?'暂无存储清点报告':'暂无当前工程检查报告'}</strong>
      {audit&&<span>{audit.phase==='discovery'?`已发现 ${audit.catalogEntries||0} 个条目 · 范围仍在清点`:`${audit.revision!==undefined?`R${audit.revision} · `:''}检查点 ${audit.completedCheckpoints} / ${audit.totalCheckpoints}`} · {elapsed}s{audit.state==='complete'&&!audit.coverageComplete?' · 历史覆盖不完整':''}</span>}
      {audit?.state==='complete'&&!audit.integrityOK&&!stale&&<p>未能证明所有来源与建模时一致，请检查下面的文件与诊断。</p>}
      {audit?.code&&<p>{audit.code==='SOURCE_INSPECTOR_UNAVAILABLE'?'只读来源检查组件不可用，请更新后台组件后重新检查。':audit.error} <code>{audit.code}</code></p>}
    </div>
    {error&&<p className="source-audit-error" role="alert">{error}</p>}
    {audit&&<>
      {audit.issues.length>0&&<details className="source-audit-issues"><summary>检查点诊断 · {audit.issues.length} 条{audit.issues.length===30?'（已达显示上限）':''}</summary>{audit.issues.map((issue,index)=><p key={index}><strong>{issue.checkpoint||'历史范围'}</strong><span>{issue.message}</span><code>{issue.code}</code></p>)}</details>}
      <div className="source-audit-filters"><label>查找来源<input aria-label="查找 STEP 来源" value={search} onChange={event=>{setSearch(event.target.value);setPage(0);}} placeholder="按文件名查找"/></label><label>范围<select aria-label="来源状态筛选" value={filter} onChange={event=>{setFilter(event.target.value);setPage(0);}}><option value="all">全部来源</option><option value="attention">仅需复核</option></select></label></div>
      <div className="source-audit-list" aria-label="STEP 来源文件">
        {!rows.length&&<p className="panel-copy">{audit.assets.length?'当前筛选没有来源。':active?'正在读取检查点依赖…':audit.coverageComplete?'本次范围内没有 STEP 来源依赖。':'没有可核对的来源记录；不能据此判断工程没有依赖。'}</p>}
        {rows.map(row=><SourceAssetRow key={row.assetId} row={row} storage={storage} canRestore={Boolean(audit.state==='complete'&&!stale&&!pending&&!error&&!row.retainedOnly&&['missing','changed'].includes(row.status)&&row.referenceCount>0)} onRestore={()=>onRestore({documentId,scope:storage?'storage':'current-undo-redo',auditJobId:audit.jobId,assetId:row.assetId,fileName:row.fileName})} onRecord={onRecord}/>)}
      </div>
      {pages>1&&<div className="source-audit-pages"><button type="button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage+1} / {pages} · {filtered.length} 个来源</span><button type="button" disabled={currentPage===pages-1} onClick={()=>setPage(currentPage+1)}>下一页</button></div>}
    </>}
    <p className="source-audit-scope">{storage?'范围包括本数据目录内可识别的工程、事务恢复区、隔离及保留快照，不读取外部数据目录。缺失、损坏或不支持的材料会降低覆盖完整性；未发现引用不等于可删除。':'范围仅含当前 / Undo / Redo，不含恢复区、隔离区或跨工程依赖。'}本报告不能作为安全清理依据。关闭窗口或切换范围不停止任务；报告使用限额缓存，缓存释放或后台重启后需重新检查。</p>
  </section>;
}

function sourceAdvice(status:string):string{
  switch(status){
    case 'unreferenced': return '本次清点未发现引用，不代表已证明可以删除；文件保持原样。';
    case 'legacy-unverified': return '旧记录缺少建模时的指纹，不会补造认证证据。';
    case 'missing': return '请恢复原始 STEP 文件；不要用同名的其他文件替换。';
    case 'changed': return '当前文件不匹配至少一个历史引用。请保留文件并恢复对应原始来源，或显式重新导入。';
    default: return '来源未通过读取或证据校验，原文件与绑定保持不变。';
  }
}

function SourceAssetRow({row,storage,canRestore,onRestore,onRecord}:{row:SourceAsset;storage:boolean;canRestore:boolean;onRestore:()=>void;onRecord:(id:string)=>void}){
  const projects=row.projects||[];
  const archivalOnly=storage&&row.referenceCount>0&&!row.currentReferences&&!row.undoReferences&&!row.redoReferences;
  return <details className="source-audit-asset" data-source-status={row.status}>
    <summary>
      <span className="source-audit-name" title={row.fileName}>{row.fileName}</span>
      <span className={row.status==='verified'?'source-verified':'source-attention'}>{sourceStatusLabel(row.status)}</span>
    </summary>
    <div className="source-audit-asset-details">
      {row.retainedOnly&&<p><strong>恢复材料 · {row.materialLabel||'保留文件'}</strong><br/>不是建模输入，不作为可安全清理证明。{row.operationId&&<code>{row.operationId}</code>}</p>}
      <p>当前 {row.currentReferences} · 撤销 {row.undoReferences} · 重做 {row.redoReferences} · 共 {row.referenceCount} 处引用</p>
      {storage&&<>
        <p>事务恢复 {row.recoveryReferences||0} · 隔离 {row.quarantineReferences||0} · 保留 {row.retainedReferences||0} · 关联 {row.projectCount||0} 个工程（已识别）</p>
        {projects.length>0&&<p>工程 ID{(row.projectCount||0)>projects.length?'（前 20 项）':''}：{projects.map(id=><code key={id} className="source-audit-project-id">{id}</code>)}</p>}
        {archivalOnly&&<p>仅在恢复或保留材料中发现引用，不等同于当前活动几何依赖。</p>}
      </>}
      {row.bytes!==undefined&&<p>{row.bytes.toLocaleString()} 字节</p>}
      {row.sha256&&<p className="source-audit-hash">当前文件 SHA256 <code>{row.sha256}</code></p>}
      {row.code&&<code>{row.code}</code>}
      <ul>{row.references.map((ref,index)=><li key={index}>
        <span>{scopeLabel[ref.scope]} · <code>{ref.featureId}</code> · {sourceStatusLabel(ref.status)}</span>
        <small>{storage?`${ref.documentId||'归属待核对'} · `:''}{ref.checkpoint} · 特征状态 {ref.featureState}</small>
      </li>)}</ul>
      {row.referenceCount>row.references.length&&<small>明细仅展示前 {row.references.length} 条；上方数量包含全部已检查引用。</small>}
      {row.status!=='verified'&&<p className="source-attention">{sourceAdvice(row.status)}</p>}
      {canRestore&&<div className="source-audit-actions"><button type="button" onClick={onRestore}>选择原始文件恢复</button></div>}
      {row.retainedOnly&&row.operationId&&<div className="source-audit-actions"><button type="button" onClick={()=>onRecord(row.operationId!)}>查看所属恢复记录</button></div>}
    </div>
  </details>;
}
