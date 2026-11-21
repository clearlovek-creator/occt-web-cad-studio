"use client";
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {API_ROOT} from './api-config';
import {SourceRestorationStore} from './model/source-restoration-store';
import {restorationStateLabel,type RestorationBinding,type RestorationProof,type SourceRestoration} from './model/source-restoration';

const stores=new Map<string,SourceRestorationStore>();
function storeFor(documentId:string){
  let store=stores.get(documentId);if(!store){store=new SourceRestorationStore(documentId,{apiRoot:API_ROOT,storage:()=>typeof window==='undefined'?null:window.localStorage,onUpdated:()=>window.dispatchEvent(new Event('cad:source-restoration-updated'))});stores.set(documentId,store);}
  for(const [key,value] of stores)if(stores.size>8&&key!==documentId&&!value.retained)stores.delete(key);return store;
}
function Proof({label,value}:{label:string;value:RestorationProof|{status:'missing'}|null}){
  return <div className="source-restore-proof"><strong>{label}</strong>{value?.status==='file'?<><span>{value.size.toLocaleString()} 字节</span><span>文件 SHA256</span><code>{value.sha256}</code><details><summary>原生来源指纹</summary><code>{value.fingerprint}</code><small>{value.algorithm}</small></details></>:<p>{value?.status==='missing'?'原文件缺失':'尚未完成内容校验'}</p>}</div>;
}
function RestorationDetail({value,disabled,onAction}:{value:SourceRestoration;disabled:boolean;onAction:(action:'commit'|'rollback'|'revalidate'|'abandon'|'review')=>void}){
  return <section className="source-restore-detail" aria-label="恢复操作详情">
    <div className={`source-audit-status ${value.blocking?'attention':value.state==='committed'?'verified':''}`} role="status"><strong>{restorationStateLabel(value.serviceBusy?value.phase:value.state)}</strong><span>{value.fileName}</span><code>{value.operationId}</code></div>
    {value.supersededBy&&<p className="panel-copy">此操作已被较新恢复接替，不能用它覆盖后续版本。<code>{value.supersededBy}</code></p>}
    <div className="source-restore-proofs"><Proof label="恢复前文件（准备时保留）" value={value.before}/><Proof label="原始候选文件" value={value.candidate}/></div>
    <details className="source-restore-projects"><summary>影响工程 · {value.projects.length} 个 · {value.referenceCount} 处历史引用</summary><p>包括已识别的当前、撤销、重做、事务恢复及保留快照；不会修改这些工程的建模历史。</p>{value.projects.length?<ul>{value.projects.map(id=><li key={id}><code>{id}</code></li>)}</ul>:<p>完成校验后列出工程归属。</p>}</details>
    {(value.requestError||value.errorCode)&&<p className="source-audit-error" role="alert">{value.requestError||'上一次文件操作需要核对，请先阅读状态与保留材料。'} <code>{value.requestErrorCode||value.errorCode}</code></p>}
    {value.recovery&&<p className="panel-copy">{value.recovery}</p>}
    {value.canCommit&&<p className="panel-copy">恢复只替换对应来源文件，不重新导入几何、不改变工程修订版。提交时将再次核对全部引用与现有文件。</p>}
    {value.canRollback&&<p className="source-attention">回退将{value.before?.status==='missing'?'重新恢复为文件缺失状态':'恢复准备时保留的旧文件，旧文件可能仍然损坏'}。候选和移出版本仍保留；这是文件恢复回退，不是几何 Undo。</p>}
    {value.canReview&&<p className="source-attention">当前来源事务未能安全确认，建模已阻断。重新核对不会用未知版本覆盖文件；请保留材料，必要时由管理员核对原始版本。</p>}
    <div className="source-audit-actions source-restore-actions">
      {value.canCommit&&<button type="button" disabled={disabled} onClick={()=>onAction('commit')}>恢复原始来源</button>}
      {value.canRollback&&<button type="button" disabled={disabled} onClick={()=>onAction('rollback')}>回退到恢复前</button>}
      {value.canRevalidate&&<button type="button" disabled={disabled} onClick={()=>onAction('revalidate')}>重新校验候选</button>}
      {value.canReview&&<button type="button" disabled={disabled} onClick={()=>onAction('review')}>重新核对事务</button>}
      {value.canAbandon&&<button type="button" disabled={disabled} onClick={()=>onAction('abandon')}>放弃，保留材料</button>}
    </div>
    {value.materials.length>0&&<details className="source-restore-materials"><summary>保留文件 · {value.materials.length} 份</summary><p>这些是恢复证据，不是新增几何来源。下载仅核对所保留文件当前内容，不将其认证为可重新导入的正确模型。</p><ul>{value.materials.map(item=><li key={item.role}>{item.available?<a href={`${API_ROOT}/source-restores/${value.operationId}/files/${item.role}`} download target="_blank" rel="noreferrer">下载 · {item.label}</a>:<span className="source-attention">材料缺失 · {item.label}</span>}</li>)}</ul></details>}
  </section>;
}

export function SourceRestorePanel({documentId,binding,initialOperationId,onBack}:{documentId:string;binding:RestorationBinding|null;initialOperationId?:string|null;onBack:()=>void}){
  const [store]=useState(()=>storeFor(documentId)),state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getServerSnapshot),[file,setFile]=useState<File|null>(null),heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>store.start(),[store]);
  useEffect(()=>{if(initialOperationId)store.select(initialOperationId);},[initialOperationId,store]);
  useEffect(()=>{heading.current?.focus();},[]);
  useEffect(()=>{if(state.selected?.blocking)window.dispatchEvent(new Event('cad:source-restoration-updated'));},[state.selected?.blocking,state.selected?.updatedAt]);
  const pending=Boolean(state.writePending||state.awaitingRead||state.health?.active),unconfirmed=Boolean(state.unknownAction);
  return <section className="panel-section source-audit-panel source-restore-panel" data-testid="source-restore-panel" aria-label="来源恢复与记录">
    <div className="section-heading compact"><div><span className="eyebrow">SOURCE RECOVERY · RETAINED VERSIONS</span><h2 tabIndex={-1} ref={heading}>{binding?'恢复原始来源':'来源恢复记录'}</h2></div><button type="button" className="source-restore-back" onClick={onBack}>返回来源检查</button></div>
    <p className="panel-copy">只恢复与原导入指纹一致的 STEP。所有旧版本保留，不清理文件；关闭窗口不停止已接受的后台操作。</p>
    {state.health?.blocked&&<div className="source-audit-status attention" role="alert"><strong>来源事务待复核，建模暂时阻断</strong><span>{state.health.diagnostic?.error}</span>{state.health.diagnostic?.operationId&&<button type="button" className="source-restore-back" onClick={()=>store.select(state.health!.diagnostic!.operationId!)}>查看阻断记录</button>}</div>}
    {binding&&<form className="source-restore-upload" onSubmit={event=>{event.preventDefault();if(file)void store.prepare(file,binding);}}>
      <strong>目标来源 · {binding.fileName}</strong><small>目标由检查报告确定，不能在此修改文件路径。共享工程会在完整校验后列出。</small>
      <label>选择原始 STEP<input type="file" accept=".step,.stp" aria-label="选择原始 STEP 文件" disabled={pending||unconfirmed} onChange={event=>setFile(event.target.files?.[0]||null)}/></label>
      <button type="submit" disabled={!file||pending||unconfirmed||Boolean(state.health?.blocked)}>上传并校验原始文件</button>
    </form>}
    <div className="source-audit-actions source-restore-status-actions"><button type="button" disabled={state.loading&&state.loadingDetail} onClick={()=>void store.refresh()}>重查恢复状态</button><span>{state.writePending?restorationStateLabel(state.writePending):state.health?.active?'后台正在处理来源任务':'只读查询，不自动重发写请求'}</span></div>
    {state.notice&&<div className={`source-restore-notice ${unconfirmed?'attention':''}`} role="status"><p>{state.notice}</p>{unconfirmed&&state.selected&&!state.selected.serviceBusy&&<button type="button" onClick={()=>store.acknowledge()}>我已核对当前状态</button>}</div>}
    {[state.error,state.listError,state.detailError].filter(Boolean).map((error,index)=><p key={index} className="source-audit-error" role="alert">{error}</p>)}
    <details className="source-restore-history" open><summary>恢复历史 · {state.total} 条{state.loading?' · 正在读取':''}</summary>
      <ul>{state.items.map(item=><li key={item.operationId}><button type="button" aria-pressed={state.selectedId===item.operationId} onClick={()=>store.select(item.operationId)}><strong>{item.fileName}</strong><span>{restorationStateLabel(item.state)}</span><small>{new Date(item.createdAt).toLocaleString()} · {item.operationId.slice(-8)}</small></button></li>)}</ul>
      {!state.items.length&&<p className="panel-copy">{state.loaded?'当前范围暂无恢复记录。':'正在读取已有记录…'}</p>}
      {state.total>20&&<div className="source-audit-pages"><button type="button" disabled={state.offset===0||state.loading} onClick={()=>store.page(Math.max(0,state.offset-20))}>上一页</button><span>{Math.floor(state.offset/20)+1} / {Math.ceil(state.total/20)}</span><button type="button" disabled={state.offset+20>=state.total||state.loading} onClick={()=>store.page(state.offset+20)}>下一页</button></div>}
    </details>
    {state.selected?<RestorationDetail value={state.selected} disabled={pending||unconfirmed} onAction={action=>void store.action(action)}/>:state.selectedId?<div className="source-audit-status" role="status"><strong>{state.loadingDetail?'正在查询原操作…':'原操作待核对'}</strong><code>{state.selectedId}</code><span>以此 ID 查询；不会重新上传或执行。</span></div>:<p className="panel-copy">从历史中选择一项查看，或返回来源检查选择缺失/变化的来源。</p>}
  </section>;
}
