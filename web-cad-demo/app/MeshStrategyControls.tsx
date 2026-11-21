"use client";
import {useState} from 'react';
import type {MeshStrategyRow,MeshStrategyOptions} from '../shared/mesh-strategy.mjs';
import type {MeshStrategyClient,MeshStrategyClientState} from './model/mesh-strategy-client';
type Props={client:MeshStrategyClient;state:MeshStrategyClientState;selected:MeshStrategyRow|null;name:string;modified:boolean;disabled:boolean;readOptions:()=>MeshStrategyOptions;onName:(name:string)=>void;onLoad:(row:MeshStrategyRow)=>void;onTemporary:()=>void;onSaved:(row:MeshStrategyRow)=>void};
export function MeshStrategyControls({client,state,selected,name,modified,disabled,readOptions,onName,onLoad,onTemporary,onSaved}:Props){
  const [error,setError]=useState('');const current=state.library.strategies.find(row=>row.strategyId===selected?.strategyId),obsolete=Boolean(selected&&(!current||current.definitionHash!==selected.definitionHash)),writeDisabled=disabled||state.busy||Boolean(state.pending)||!state.token;
  const action=async(kind:'create'|'update'|'rename'|'delete')=>{setError('');try{const row=kind==='create'?await client.create(name,readOptions()):selected?kind==='delete'?await client.delete(selected):await client.updateStrategy(selected,name,kind==='update'?readOptions():undefined):undefined;if(row)onSaved(row);}catch(reason){setError(reason instanceof Error?reason.message:'方案设置无效。');}};
  return <details className="mesh-strategy-controls" data-testid="mesh-strategy-controls">
    <summary>工程方案 <span>{selected?`${selected.name} · V${selected.revision}${modified?' · 临时修改':''}`:'临时参数'}{state.loading?' · 读取中':''}</span></summary>
    <fieldset disabled={disabled||state.busy}>
      <label className="single-field"><span>载入方案</span><select aria-label="工程网格方案" value={selected?.strategyId||''} onChange={event=>{setError('');const row=state.library.strategies.find(row=>row.strategyId===event.target.value);if(row)onLoad(row);else onTemporary();}}><option value="">临时参数（不绑定方案）</option>{selected&&!current&&<option value={selected.strategyId} disabled>已删除 · {selected.name}</option>}{state.library.strategies.map(row=><option key={row.strategyId} value={row.strategyId}>{row.name} · V{row.revision}{row.state==='stale'?' · 目标需重选':''}</option>)}</select></label>
      <div className="mesh-strategy-read-actions"><button type="button" disabled={state.loading} onClick={()=>void client.refresh(true)}>刷新方案清单</button>{obsolete&&current&&<button type="button" onClick={()=>onLoad(current)}>载入方案新版本</button>}</div>
      {!state.library.strategies.length&&!state.loading&&<p className="mesh-strategy-copy">工程还没有网格方案。设置下方参数后，可命名保存。</p>}
      {obsolete&&<p className="mesh-strategy-warning" role="status">{current?'方案定义已变化，当前草稿保留。请载入新版本，或明确切换为临时参数。':'原方案已删除，当前草稿保留。选择临时参数或其他方案后才能剖分。'}</p>}
      {selected&&!obsolete&&modified&&<p className="mesh-strategy-warning" role="status">剖分设置有未保存修改。更新方案后使用工程方案，或按当前临时参数剖分。</p>}
      {current?.state==='stale'&&<p className="mesh-strategy-warning">方案的几何目标已变化；原引用保留，请在尺寸规则中重新选择。</p>}
      <label className="single-field"><span>方案名称</span><input aria-label="网格方案名称" maxLength={80} placeholder="例如：基板精细网格" value={name} onChange={event=>{setError('');onName(event.target.value);}}/></label>
      <div className="mesh-strategy-write-actions"><button type="button" disabled={writeDisabled||!name.trim()||state.library.strategies.length>=32} onClick={()=>void action('create')}>保存为新方案</button><button type="button" disabled={writeDisabled||!selected||obsolete||!name.trim()} onClick={()=>void action('update')}>更新方案</button><button type="button" disabled={writeDisabled||!selected||obsolete||!name.trim()} onClick={()=>void action('rename')}>仅重命名</button><button type="button" disabled={writeDisabled||!selected||obsolete} onClick={()=>void action('delete')}>删除方案</button></div>
      <p className="mesh-strategy-copy">方案随工程保存/打开，可撤销；选择方案只载入设置，不启动剖分。旧版本或旧几何引用不会自动替换。</p>
    </fieldset>
    {(error||state.error)&&<p className="property-error" role="alert">{error||state.error}</p>}
    {state.pending&&<button type="button" className="mesh-strategy-check" disabled={state.busy} onClick={()=>void client.checkPending()}>只读核对原方案任务</button>}
    {state.notice&&<p className="mesh-strategy-notice" role="status">{state.notice}</p>}
  </details>;
}
