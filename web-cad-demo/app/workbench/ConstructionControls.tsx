"use client";
import {useEffect,useId,useRef,useState} from "react";
import {CONSTRUCTION_AXES,CONSTRUCTION_PLANES,type ConstructionCoordinate,type ConstructionFrame,type ConstructionPlane} from "../modeling/construction-frame";

const STEPS = [.1,.5,1,5,10,20,50];
export function ConstructionControls({coordinates,selectedId,plane,frame,error,gridStep,snapStep,geometrySnap,disabled,onCoordinate,onPlane,onGridStep,onSnapStep,onGeometrySnap,onAlign}:{
  coordinates:(ConstructionCoordinate&{kind?:string})[];selectedId:string;plane:ConstructionPlane;frame:ConstructionFrame|null;error:string|null;gridStep:number;snapStep:number|null;geometrySnap:boolean;disabled:boolean;
  onCoordinate:(id:string)=>void;onPlane:(plane:ConstructionPlane)=>void;onGridStep:(step:number)=>void;onSnapStep:(step:number|null)=>void;onGeometrySnap:(enabled:boolean)=>void;onAlign:()=>void;
}) {
  const [open,setOpen]=useState(false);
  const popoverRef=useRef<HTMLDivElement>(null);
  const triggerRef=useRef<HTMLButtonElement>(null);
  const popupId=useId();
  const coordinateName=coordinates.find(item=>item.id===selectedId)?.name ?? selectedId;

  useEffect(()=>{
    if(!open)return;
    const dismiss=(event:PointerEvent)=>{
      if(!popoverRef.current?.contains(event.target as Node))setOpen(false);
    };
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=="Escape"||event.defaultPrevented||event.isComposing||(event.target instanceof Element&&event.target.closest("dialog[open]")))return;
      event.preventDefault();
      if(event.repeat)return;
      setOpen(false);
      triggerRef.current?.focus({preventScroll:true});
    };
    document.addEventListener("pointerdown",dismiss);
    document.addEventListener("keydown",escape,true);
    return ()=>{
      document.removeEventListener("pointerdown",dismiss);
      document.removeEventListener("keydown",escape,true);
    };
  },[open]);

  return <div className="construction-popover" ref={popoverRef} onBlur={event=>{
    if(event.relatedTarget instanceof Node&&!event.currentTarget.contains(event.relatedTarget))setOpen(false);
  }}>
    <button type="button" ref={triggerRef} className="construction-trigger" aria-label="构造设置" aria-expanded={open} aria-controls={open?popupId:undefined} title={error ?? `${coordinateName} · ${plane}`} onClick={()=>setOpen(value=>!value)}>
      构造 <span className="construction-summary"><span className="construction-coordinate-name">{coordinateName}</span>{plane}</span>
      {error&&<strong className="construction-frame-warning" aria-hidden="true">!</strong>}
      <i aria-hidden="true" />
    </button>
    {open&&<div id={popupId} className="construction-controls" role="group" aria-label="构造平面设置">
    <label><span>构造坐标系</span><select aria-label="构造坐标系" value={selectedId} disabled={disabled} onChange={event=>onCoordinate(event.target.value)} title="切换会取消当前绘制；参数窗口关闭后可切换。">
      {!coordinates.some(item=>item.id===selectedId)&&<option value={selectedId}>已删除 · {selectedId}</option>}
      {coordinates.map(item=><option key={item.id} value={item.id}>{item.name}{item.kind==="face"?" · "+(item.associationMode==="associative"?item.referenceState==="resolved"?"面关联":"引用失效":"面坐标快照"):""}</option>)}
    </select></label>
    <label><span>平面</span><select aria-label="构造平面" value={plane} disabled={disabled} onChange={event=>onPlane(event.target.value as ConstructionPlane)}>{CONSTRUCTION_PLANES.map(value=><option key={value}>{value}</option>)}</select></label>
    <label><span>网格</span><select aria-label="构造平面网格间距" value={gridStep} disabled={disabled} onChange={event=>onGridStep(Number(event.target.value))}>{STEPS.map(value=><option key={value} value={value}>{value} mm</option>)}</select></label>
    <label><span>吸附</span><select aria-label="构造平面吸附步长" value={snapStep ?? "grid"} disabled={disabled} onChange={event=>onSnapStep(event.target.value==="grid"?null:Number(event.target.value))}><option value="grid">随网格</option>{STEPS.map(value=><option key={value} value={value}>{value} mm</option>)}</select></label>
    <div className="construction-actions">
      <button type="button" aria-pressed={geometrySnap} disabled={disabled} onClick={()=>onGeometrySnap(!geometrySnap)} title="捕捉构造面上的可见端点和边中点；更改会取消当前绘制">几何吸附</button>
      <button type="button" disabled={!frame} onClick={()=>{onAlign();setOpen(false);triggerRef.current?.focus({preventScroll:true});}} title={`从局部 ${CONSTRUCTION_AXES[plane][2]} 方向正视 ${plane} 构造面`}>正视构造面</button>
    </div>
    {error?<p className="construction-error" role="status">{error}</p>:frame?.legacyPlacement?<small title="拖拽位置按内核原有 Y 轴偏移约定换算，尺寸仍以毫米计量。">旧式轴偏移</small>:null}
    </div>}
  </div>;
}
