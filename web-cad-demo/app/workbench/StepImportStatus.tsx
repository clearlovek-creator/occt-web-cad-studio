"use client";
import {useEffect,useState} from 'react';
import {activeStepImport,type StepImportStatus as ImportStatus,type StepImportPhase} from '../../shared/step-import-status.mjs';
import {modelingController} from '../modeling/runtime';
import type {ModelingCommandResponse} from '../modeling/command-contract';

const phases:[StepImportPhase,string][]=[['receiving','接收文件'],['queued','等待工程'],['preparing','核对基线'],['converting','转换几何'],['committing','保存提交']];
const label=(phase:StepImportPhase)=>phases.find(item=>item[0]===phase)?.[1]||({complete:'导入完成',failed:'导入未完成',interrupted:'导入已中断',unknown:'导入结果未确认'}[phase as 'complete'|'failed'|'interrupted'|'unknown']);

export function StepImportStatus({documentId,status,notice,stateToken,onReconciled}:{documentId:string;status:ImportStatus|null;notice:string|null;stateToken:string|null;onReconciled:(result:ModelingCommandResponse)=>void}){
  const current=status?.documentId===documentId?status:null;
  const requestId=current?.requestId,phase=current?.phase,createdAt=current?.createdAt;
  const [dismissed,setDismissed]=useState<string|null>(null),[reading,setReading]=useState(false),[localNotice,setLocalNotice]=useState<string|null>(null),[seconds,setSeconds]=useState(0),[retry,setRetry]=useState(0);
  useEffect(()=>{void modelingController.refreshStepImportStatus(undefined,documentId).catch(()=>{});},[documentId]);
  useEffect(()=>{
    if(!requestId||!phase||(!activeStepImport(phase)&&phase!=='unknown'))return;
    let alive=true,failures=0;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{await modelingController.refreshStepImportStatus(requestId,documentId);failures=0;}catch{failures++;}if(alive&&failures<6)timer=setTimeout(()=>void poll(),Math.min(10000,1000*2**failures));};
    timer=setTimeout(()=>void poll(),750);return()=>{alive=false;clearTimeout(timer);};
  },[requestId,phase,documentId,retry]);
  useEffect(()=>{if(!createdAt||!phase||!activeStepImport(phase))return;const tick=()=>setSeconds(Math.max(0,Math.floor((Date.now()-Date.parse(createdAt))/1000)));tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);},[phase,createdAt]);
  // Registered imports use the common task controls; this component remains
  // their completed statistics report, not a second progress authority.
  if(current&&(current.taskId&&current.phase!=='complete'||current.sequence===0&&current.phase==='receiving'))return null;
  if(!current)return notice?<section className="step-import-status" aria-label="STEP 导入记录"><div className="step-import-notice"><span>导入记录暂不可用：{notice}</span><button type="button" onClick={()=>void modelingController.refreshStepImportStatus(undefined,documentId).catch(()=>{})}>重查记录</button></div></section>:null;
  if(dismissed===current.requestId)return <div className="step-import-collapsed"><button type="button" onClick={()=>setDismissed(null)} title={current.fileName}>显示 STEP 导入报告 · {label(current.phase)}</button></div>;
  const active=activeStepImport(current.phase),report=current.report,warning=Boolean(report&&(report.invalidBodyCount||report.emptyRootCount||report.ambiguousSubshapeMetadata)),differentState=current.phase==='complete'&&current.stateToken&&stateToken!==current.stateToken;
  const reconcile=async()=>{setReading(true);setLocalNotice(null);try{const owner=documentId,result=await modelingController.execute<ModelingCommandResponse>({operation:'document.view'});if(modelingController.getSnapshot().documentId===owner){onReconciled(result);await modelingController.refreshStepImportStatus(current.requestId,owner);}}catch(error){setLocalNotice(error instanceof Error?error.message:'当前工程核对失败。');}finally{setReading(false);}};
  return <section className={`step-import-status ${active?'active':current.phase==='complete'?'complete':'attention'}`} data-testid="step-import-status" data-phase={current.phase} aria-label="STEP 导入任务">
    <div className="step-import-status-row"><div className="step-import-status-title"><strong role="status">{label(current.phase)}{warning?' · 有诊断提示':''}</strong><span title={current.fileName}>{current.fileName}</span></div><div className="step-import-status-actions">{active&&<small aria-label="已等待时间">{seconds}s</small>}{!active&&<button type="button" disabled={reading} onClick={()=>void reconcile()}>{reading?'正在核对…':'核对当前工程'}</button>}<button type="button" aria-label="隐藏 STEP 导入报告" title="仅隐藏报告，不取消导入" onClick={()=>setDismissed(current.requestId)}>×</button></div></div>
    {active&&<ol className="step-import-stages" aria-label="导入阶段">{phases.map(([phase,text],index)=><li key={phase} aria-current={current.phase===phase?'step':undefined} className={index<phases.findIndex(item=>item[0]===current.phase)?'past':''}><span aria-hidden="true">{index+1}</span>{text}</li>)}</ol>}
    {report&&<details className="step-import-report"><summary>导入报告 · {report.bodyCount??'—'} 个 Body · {report.modelLengthUnit||'单位待核对'}</summary><dl>{([['solidCount','实体'],['sheetCount','面体'],['wireCount','线体'],['otherCount','其他几何']] as const).map(([key,title])=><div key={key}><dt>{title}</dt><dd>{report[key]??'—'}</dd></div>)}</dl><p>来源单位：{report.sourceLengthUnits?.join('、')||'未报告'}；模型单位：{report.modelLengthUnit||'未报告'}。</p><p>{report.assemblyHierarchyRetained===false?'装配已展开为 Body，未保留可编辑装配层级。':''} 转换器处理：{report.translatorShapeProcessing||'未报告'}。</p>{warning&&<p className="step-import-warning">拓扑有效性异常 {report.invalidBodyCount||0}；空根 {report.emptyRootCount||0}；子形状元数据歧义 {report.ambiguousSubshapeMetadata||0}。请先诊断几何，导入成功不等于可直接剖分。</p>}<small>请求 {current.requestId}{current.revision!==undefined?` · 提交 R${current.revision}`:''}</small></details>}
    {current.error&&<p className="step-import-warning">{current.error}{current.unchanged?' 原工程保持导入前状态。':''}</p>}
    {current.recovered&&current.phase==='complete'&&<p>已从后台接受的工程事务中核对导入结果；没有重新导入文件。</p>}
    {differentState&&<p>报告对应的提交状态与当前视图不同，请核对当前工程；不会重新上传或重放导入。</p>}
    {(notice||localNotice)&&<div className="step-import-notice"><span>{localNotice||notice}</span><button type="button" onClick={()=>{setRetry(value=>value+1);void modelingController.refreshStepImportStatus(current.requestId,documentId).catch(()=>{});}}>重查记录</button></div>}
    {current.reportDurable===false&&<p className="step-import-warning">报告落盘未确认，请保留命令结果并核对工程。</p>}
  </section>;
}
