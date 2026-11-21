"use client";
import {useState} from 'react';
import {meshSizingTargetCurrent,MESH_SIZING_LIMITS} from '../shared/mesh-sizing.mjs';
import {captureSizingTarget,updateSizingTarget,type MeshSizingDraft} from './model/mesh-sizing-draft';
type Props={draft:MeshSizingDraft;geometry:unknown;bodyId?:string|null;faceId?:string|null;disabled:boolean;onChange:(draft:MeshSizingDraft)=>void};
export function MeshSizingControls({draft,geometry,bodyId,faceId,disabled,onChange}:Props){
  const [error,setError]=useState('');
  const capture=(kind:'body'|'face',id:string|null=null)=>{try{if(kind==='face'&&!faceId)throw Error('请先选择一个几何面。');const selected=captureSizingTarget(geometry,bodyId,kind==='face'?faceId:null);onChange(updateSizingTarget(draft,id,selected,'size-'+crypto.randomUUID()));setError('');}catch(reason){setError(reason instanceof Error?reason.message:'目标不可用。');}};
  const change=(value:MeshSizingDraft)=>{setError('');onChange(value);};
  return <details className="mesh-sizing-control" data-testid="mesh-sizing-controls">
    <summary>网格尺寸 <span>{draft.enabled?`全局 ${draft.globalSize||'待填写'} mm · ${draft.rules.length} 条局部规则`:'自动'}</span></summary>
    <fieldset disabled={disabled}>
      <label className="mesh-sizing-enable"><input type="checkbox" checked={draft.enabled} onChange={event=>change({...draft,enabled:event.target.checked})}/>使用自定义网格尺寸</label>
      {draft.enabled&&<>
        <label className="single-field"><span>全局目标（mm）</span><input aria-label="全局网格尺寸 mm" type="number" min={MESH_SIZING_LIMITS.minSize} max={MESH_SIZING_LIMITS.maxSize} step="any" placeholder="例如 2" value={draft.globalSize} onChange={event=>change({...draft,globalSize:event.target.value})}/></label>
        <p className="mesh-sizing-help">目标尺寸控制单元密度，不是质量阈值。局部尺寸须不大于全局值；共享界面取更细规则，仍对全部几何共形剖分。</p>
        <div className="mesh-sizing-add"><button type="button" disabled={!bodyId||draft.rules.length>=MESH_SIZING_LIMITS.maxRules} onClick={()=>capture('body')}>添加当前 Body</button><button type="button" disabled={!bodyId||!faceId||draft.rules.length>=MESH_SIZING_LIMITS.maxRules} onClick={()=>capture('face')}>添加当前 Face</button></div>
        {!draft.rules.length&&<p className="mesh-sizing-help">尚无局部规则。先在视口或几何树选择目标，再添加。</p>}
        <ul>{draft.rules.map((rule,index)=>{const current=meshSizingTargetCurrent(rule.target,geometry);return <li key={rule.id} data-current={current}>
          <div className="mesh-sizing-target"><strong>{rule.name} · {rule.target.kind==='face'?'面':'体'}</strong><small>{rule.target.cadFaceId||rule.target.bodyId} · R{rule.target.topologyRevision}</small></div>
          {!current&&<p role="alert">几何已变化；请重选目标，不会自动套用到新几何。</p>}
          <label><span>局部目标（mm）</span><input aria-label={`局部网格尺寸 ${index+1} mm`} type="number" min={MESH_SIZING_LIMITS.minSize} max={Number(draft.globalSize)||MESH_SIZING_LIMITS.maxSize} step="any" value={rule.size} onChange={event=>change({...draft,rules:draft.rules.map(item=>item.id===rule.id?{...item,size:event.target.value}:item)})}/></label>
          <button type="button" aria-label={`删除局部尺寸规则 ${index+1}`} onClick={()=>change({...draft,rules:draft.rules.filter(item=>item.id!==rule.id)})}>删除</button>
          <label className="mesh-sizing-transition"><span>平滑过渡宽度（mm，可留空）</span><input aria-label={`局部尺寸过渡宽度 ${index+1} mm`} type="number" min={MESH_SIZING_LIMITS.minSize} max={MESH_SIZING_LIMITS.maxSize} step="any" placeholder="不启用" value={rule.transitionDistance||''} onChange={event=>change({...draft,rules:draft.rules.map(item=>item.id===rule.id?{...item,transitionDistance:event.target.value}:item)})}/></label>
          {!current&&<button type="button" className="mesh-sizing-reselect" disabled={!bodyId||rule.target.kind==='face'&&!faceId} onClick={()=>capture(rule.target.kind,rule.id)}>使用当前{rule.target.kind==='face'?'面':'体'}重新绑定</button>}
        </li>;})}</ul>
        <p className="mesh-sizing-help">更小尺寸可能显著增加单元数。加密不保证极薄层质量达标；完成后仍须查看验收和质量报告。</p>
        {draft.rules.some(rule=>Boolean(rule.transitionDistance?.trim()))&&<p className="mesh-sizing-help">过渡宽度在来源面附近逐渐恢复全局尺寸，也会加密相邻 Body。基于采样距离，不保证最差单元质量改善。</p>}
      </>}
      {error&&<p className="property-error" role="alert">{error}</p>}
    </fieldset>
  </details>;
}
