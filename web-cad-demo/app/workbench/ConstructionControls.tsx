"use client";
import {CONSTRUCTION_AXES,CONSTRUCTION_PLANES,type ConstructionCoordinate,type ConstructionFrame,type ConstructionPlane} from "../modeling/construction-frame";

const STEPS = [.1,.5,1,5,10,20,50];
export function ConstructionControls({coordinates,selectedId,plane,frame,error,gridStep,snapStep,geometrySnap,disabled,onCoordinate,onPlane,onGridStep,onSnapStep,onGeometrySnap,onAlign}:{
  coordinates:(ConstructionCoordinate&{kind?:string})[];selectedId:string;plane:ConstructionPlane;frame:ConstructionFrame|null;error:string|null;gridStep:number;snapStep:number|null;geometrySnap:boolean;disabled:boolean;
  onCoordinate:(id:string)=>void;onPlane:(plane:ConstructionPlane)=>void;onGridStep:(step:number)=>void;onSnapStep:(step:number|null)=>void;onGeometrySnap:(enabled:boolean)=>void;onAlign:()=>void;
}) {
  return <div className="construction-controls" aria-label="构造平面设置">
    <label><span>构造坐标系</span><select aria-label="构造坐标系" value={selectedId} disabled={disabled} onChange={event=>onCoordinate(event.target.value)} title="切换会取消当前绘制；参数窗口关闭后可切换。">
      {!coordinates.some(item=>item.id===selectedId)&&<option value={selectedId}>已删除 · {selectedId}</option>}
      {coordinates.map(item=><option key={item.id} value={item.id}>{item.name}{item.kind==="face"?" · "+(item.associationMode==="associative"?item.referenceState==="resolved"?"面关联":"引用失效":"面坐标快照"):""}</option>)}
    </select></label>
    <label><span>平面</span><select aria-label="构造平面" value={plane} disabled={disabled} onChange={event=>onPlane(event.target.value as ConstructionPlane)}>{CONSTRUCTION_PLANES.map(value=><option key={value}>{value}</option>)}</select></label>
    <label><span>网格</span><select aria-label="构造平面网格间距" value={gridStep} disabled={disabled} onChange={event=>onGridStep(Number(event.target.value))}>{STEPS.map(value=><option key={value} value={value}>{value} mm</option>)}</select></label>
    <label><span>吸附</span><select aria-label="构造平面吸附步长" value={snapStep ?? "grid"} disabled={disabled} onChange={event=>onSnapStep(event.target.value==="grid"?null:Number(event.target.value))}><option value="grid">随网格</option>{STEPS.map(value=><option key={value} value={value}>{value} mm</option>)}</select></label>
    <button type="button" aria-pressed={geometrySnap} disabled={disabled} onClick={()=>onGeometrySnap(!geometrySnap)} title="捕捉构造面上的可见端点和边中点；更改会取消当前绘制">几何吸附</button>
    <button type="button" disabled={!frame} onClick={onAlign} title={`从局部 ${CONSTRUCTION_AXES[plane][2]} 方向正视 ${plane} 构造面`}>正视构造面</button>
    {error?<span className="construction-frame-warning" role="status">{error}</span>:frame?.legacyPlacement?<small title="拖拽位置按内核原有 Y 轴偏移约定换算，尺寸仍以毫米计量。">旧式轴偏移</small>:null}
  </div>;
}
