"use client";
import {useEffect,useId,useRef,useState} from 'react';
import {appearanceColor,appearanceDraft,captureAppearance,evaluateAppearance,opacityKeyPercent,type AppearanceBody,type AppearanceDraft} from './appearance-draft';

export function BodyAppearancePanel({body,materials,onSave}:{body:AppearanceBody;materials:string[];onSave:(bodyId:string,changes:Record<string,unknown>)=>Promise<boolean>}){
  const [baseline,setBaseline]=useState(()=>captureAppearance(body));
  const [draft,setDraft]=useState(()=>appearanceDraft(baseline));
  const [busy,setBusy]=useState(false),[state,setState]=useState<'idle'|'saved'|'failed'>('idle'),[failure,setFailure]=useState('');
  const pending=useRef(false),restoreFocus=useRef(false),formRef=useRef<HTMLFormElement>(null),statusRef=useRef<HTMLParagraphElement>(null),nameRef=useRef<HTMLInputElement>(null),id=useId();
  const evaluation=evaluateAppearance(baseline,draft),color=appearanceColor(draft.color)||appearanceColor(baseline.color)||'#7B91AA';
  const percent=Number(draft.opacityPercent),rangeValue=evaluation.errors.opacityPercent?baseline.opacity:percent/100;
  useEffect(()=>{if(busy||!restoreFocus.current)return;restoreFocus.current=false;if(document.activeElement===document.body)statusRef.current?.focus();},[busy,state]);
  const change=(field:keyof AppearanceDraft,value:string)=>{setDraft(current=>({...current,[field]:value}));setState('idle');setFailure('');};
  const status=busy?'正在保存几何设置…':state==='failed'?'保存未获确认，草稿已保留。':evaluation.dirty?'有未保存的更改':state==='saved'?'几何设置已保存。':'尚无更改';
  return <form ref={formRef} className="panel-section body-appearance-editor" onSubmit={async event=>{
    event.preventDefault();if(pending.current||!evaluation.valid||!evaluation.dirty)return;
    pending.current=true;restoreFocus.current=Boolean(formRef.current?.contains(document.activeElement));setBusy(true);setFailure('');
    try{
      if(await onSave(baseline.bodyId,evaluation.changes)){
        const next={...baseline,...evaluation.changes};setBaseline(next);setDraft(appearanceDraft(next));setState('saved');
      }else setState('failed');
    }catch(reason){setState('failed');setFailure(reason instanceof Error?reason.message:'请检查工程状态后重试。');}
    finally{pending.current=false;setBusy(false);}
  }}>
    <div className="appearance-context"><code>{baseline.bodyId}</code><span>几何外观</span></div>
    <p className="appearance-help">材料改变后，几何及其历史会移到对应材料组；保存前不会修改模型。</p>
    <fieldset className="appearance-fields" disabled={busy}>
      <label className="single-field appearance-field"><span>名称</span><input ref={nameRef} aria-label="Body 名称" value={draft.name} required aria-invalid={Boolean(evaluation.errors.name)} aria-describedby={evaluation.errors.name?id+'-name-error':undefined} onChange={event=>change('name',event.target.value)}/></label>
      {evaluation.errors.name&&<p id={id+'-name-error'} className="appearance-field-error">{evaluation.errors.name}</p>}
      <label className="single-field appearance-field"><span>材料</span><select aria-label="Body 材料" value={draft.material} onChange={event=>change('material',event.target.value)}><option value="">未指定材料</option>{[...new Set([...materials,...(draft.material?[draft.material]:[])])].map(item=><option key={item}>{item}</option>)}</select></label>
      <div className="single-field appearance-field"><span id={id+'-color-label'}>颜色</span><div className="appearance-color-fields"><input className="appearance-color-picker" type="color" aria-label="选择几何颜色" value={color} onChange={event=>change('color',event.target.value.toUpperCase())}/><input className="appearance-hex-input" aria-label="颜色 HEX" spellCheck={false} autoComplete="off" value={draft.color} maxLength={16} aria-invalid={Boolean(evaluation.errors.color)} aria-describedby={id+'-color-help'} onChange={event=>change('color',event.target.value)} onBlur={()=>{const normalized=appearanceColor(draft.color);if(normalized)setDraft(current=>({...current,color:normalized}));}}/></div></div>
      <p id={id+'-color-help'} className={evaluation.errors.color?'appearance-field-error':'appearance-help appearance-field-help'}>{evaluation.errors.color||'选中几何时，视口高亮会覆盖外观颜色。'}</p>
      <div className="single-field appearance-field"><span>不透明度</span><div className="appearance-opacity-fields"><input type="range" min="0.05" max="1" step="any" aria-label="不透明度" aria-valuetext={draft.opacityPercent+'% 不透明'} aria-describedby={id+'-opacity-help'} value={rangeValue} onChange={event=>change('opacityPercent',String(Math.round(Number(event.target.value)*10000)/100))} onKeyDown={event=>{const value=opacityKeyPercent(draft.opacityPercent,event.key,event.shiftKey);if(value!==null){event.preventDefault();change('opacityPercent',value);}}}/><div className="appearance-percent-input"><input type="number" min="5" max="100" step="any" inputMode="decimal" aria-label="不透明度百分比" value={draft.opacityPercent} aria-invalid={Boolean(evaluation.errors.opacityPercent)} aria-describedby={id+'-opacity-help'} onChange={event=>change('opacityPercent',event.target.value)}/><span aria-hidden="true">%</span></div></div></div>
      <p id={id+'-opacity-help'} className={evaluation.errors.opacityPercent?'appearance-field-error':'appearance-help appearance-field-help'}>{evaluation.errors.opacityPercent||'5%–100%，数值越小越透明；方向键调整 5%，Shift + 方向键调整 1%。'}</p>
      <div className="appearance-actions"><button className="primary-action" disabled={busy||!evaluation.valid||!evaluation.dirty}>{busy?'正在保存…':'保存几何设置'}</button><button className="appearance-reset" type="button" disabled={!evaluation.dirty||busy} title="仅重置表单，模型不会改变" onClick={()=>{setDraft(appearanceDraft(baseline));setState('idle');setFailure('');nameRef.current?.focus();}}>重置更改</button></div>
    </fieldset>
    <p ref={statusRef} tabIndex={-1} role={state==='failed'?'alert':'status'} className="appearance-save-status" data-state={state==='failed'?'failed':busy?'saving':evaluation.dirty?'dirty':state==='saved'?'saved':'clean'}>{status}{failure&&<span>{failure}</span>}</p>
  </form>;
}
