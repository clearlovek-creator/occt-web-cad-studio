"use client";
import type {ConstructionCoordinate,ConstructionFrame} from "../modeling/construction-frame";

export function ConstructionControls({coordinates,selectedId,frame,error,step,disabled,onCoordinate,onStep,onAlign}:{
  coordinates:(ConstructionCoordinate&{kind?:string})[];selectedId:string;frame:ConstructionFrame|null;error:string|null;step:number;disabled:boolean;
  onCoordinate:(id:string)=>void;onStep:(step:number)=>void;onAlign:()=>void;
}) {
  return <div className="construction-controls" aria-label="构造平面设置">
    <label><span>构造坐标系</span><select aria-label="构造坐标系" value={selectedId} disabled={disabled} onChange={event=>onCoordinate(event.target.value)} title="切换会取消当前绘制；参数窗口关闭后可切换。">
      {!coordinates.some(item=>item.id===selectedId)&&<option value={selectedId}>已删除 · {selectedId}</option>}
      {coordinates.map(item=><option key={item.id} value={item.id}>{item.name} · {item.kind==="face"?item.associationMode==="associative"?item.referenceState==="resolved"?"面关联":"引用失效":"面坐标快照":"XY"}</option>)}
    </select></label>
    <label><span>吸附</span><select aria-label="构造平面吸附步长" value={step} disabled={disabled} onChange={event=>onStep(Number(event.target.value))}>{[.1,.5,1,5,10].map(value=><option key={value} value={value}>{value} mm</option>)}</select></label>
    <button type="button" disabled={!frame} onClick={onAlign} title="沿本坐标系 Z 轴正视 XY 构造面；不修改工程">正视构造面</button>
    {error?<span className="construction-frame-warning" role="status">{error}</span>:frame?.legacyPlacement?<small title="为保留旧工程位置，拖拽位置会按内核原有 Y 轴偏移约定换算，尺寸仍以毫米计量。">旧式轴偏移 · 已匹配内核</small>:<small>局部 XY 底面 · 局部 Z 定高</small>}
  </div>;
}
