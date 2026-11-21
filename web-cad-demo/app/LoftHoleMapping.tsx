"use client";
import {loopMappingIssue,type FaceBoundarySummary} from './modeling/loft-loops';

export function LoftHoleMapping({summary,seeds,onChange,onHighlight,highlighted,expectedCount,disabled}:{summary:FaceBoundarySummary|null;seeds:string[];onChange:(seeds:string[])=>void;onHighlight:(loopId:string,edges:string[])=>void;highlighted?:string;expectedCount?:number;disabled?:boolean}){
  if(!summary)return <p className="panel-copy" role="status">正在读取所选面的真实边界…</p>;
  const holes=summary.loops.filter(loop=>loop.role==='inner'),issue=loopMappingIssue(summary,seeds,expectedCount),invalid=!summary.complete||!summary.valid||!summary.planar||summary.loops.some(loop=>!loop.closed)||holes.length>16||expectedCount!==undefined&&holes.length!==expectedCount;
  return <section className="loft-hole-mapping" data-testid="loft-hole-mapping" aria-label="截面孔对应">
    <div className="loft-hole-heading"><strong>{holes.length?`贯通孔对应 · ${holes.length} 个`:'单环截面 · 无贯通孔'}</strong><small>仅本截面内环编号，不是永久标识</small></div>
    {issue&&<p className={invalid?'property-error':'panel-copy'} role={invalid?'alert':'status'}>{issue}</p>}
    {!invalid&&holes.length>0&&<><p className="panel-copy">孔 1、孔 2…在所有截面中应对应同一通道。先高亮核对，再逐项选择；不会自动猜配。</p>
      <div className="loft-loop-candidates">{holes.map((loop,index)=><button type="button" key={loop.loopId} aria-pressed={highlighted===loop.loopId} onClick={()=>onHighlight(loop.loopId,loop.edgeIds)} disabled={disabled}>高亮内环 {index+1}<small>{loop.length===null?'长度待核对':`${Number(loop.length.toPrecision(6))} mm`} · {loop.edgeIds.length} 条边</small></button>)}</div>
      <ol className="loft-hole-slots">{holes.map((_loop,index)=><li key={index}><label><span>孔 {index+1}</span><select aria-label={`孔 ${index+1} 对应内环`} disabled={disabled} value={holes.find(loop=>loop.edgeIds.includes(seeds[index]))?.loopId||''} onChange={event=>{const next=Array.from({length:holes.length},(_,slot)=>seeds[slot]||'');next[index]=holes.find(loop=>loop.loopId===event.target.value)?.edgeIds[0]||'';onChange(next);}}><option value="">请选择内环</option>{holes.map((loop,loopIndex)=><option key={loop.loopId} value={loop.loopId} disabled={seeds.some((seed,slot)=>slot!==index&&loop.edgeIds.includes(seed))}>内环 {loopIndex+1} · {loop.edgeIds.length} 条边</option>)}</select></label></li>)}</ol>
    </>}
  </section>;
}
