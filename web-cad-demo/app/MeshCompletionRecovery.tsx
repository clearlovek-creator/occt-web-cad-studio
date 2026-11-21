"use client";
import {useEffect,useRef} from 'react';
import type {MeshJobSummary} from './model/mesh';
import type {MeshCompletionAction} from './model/project-mesh-task-store';

export function MeshCompletionRecovery({job,action,disabled,onRecover,onCheck}:{job:MeshJobSummary;action?:MeshCompletionAction;disabled:boolean;onRecover:()=>void;onCheck:()=>void}){
  const root=useRef<HTMLElement>(null),returnFocus=useRef(false);
  const state=action?.state||job.completionRecovery?.state;
  useEffect(()=>{if(state==='complete'&&returnFocus.current){returnFocus.current=false;if(document.activeElement===document.body)root.current?.focus();}},[state]);
  if(!state)return null;
  const title={available:'原结果待恢复',submitting:'正在提交恢复',checking:'正在核对原结果',uncertain:'恢复回复未确认',failed:'恢复未完成',complete:'原结果已恢复'}[state];
  const error=job.completionRecovery?.error||action?.error;
  return <section ref={root} tabIndex={-1} className="mesh-completion-recovery" data-state={state} aria-label="网格结果恢复">
    <div role="status" aria-live="polite"><h4>{title}</h4><p>{state==='complete'?'未重新剖分，结果默认隐藏；可通过“查看结果”核对。':state==='uncertain'?'先只读核对后台状态；不会自动重复提交恢复命令。':'仅重新校验并保存这份原结果，不启动新的剖分。'}</p>{error&&state==='failed'&&<p className="mesh-completion-recovery-error">{error}</p>}</div>
    {state!=='complete'&&<button type="button" disabled={disabled||state==='submitting'||state==='checking'} onClick={event=>{returnFocus.current=event.detail===0;(state==='uncertain'?onCheck:onRecover)();}}>{state==='uncertain'?'核对恢复状态':state==='checking'?'正在核对…':state==='submitting'?'正在提交…':state==='failed'?'重新校验原结果':'恢复原结果'}</button>}
  </section>;
}
