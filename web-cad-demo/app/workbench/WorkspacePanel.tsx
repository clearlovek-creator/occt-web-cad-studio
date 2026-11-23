"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {modelingController} from "../modeling/runtime";
import type {WorkspaceMetadata} from "../modeling/modeling-controller";
import {ProjectLoadStatus} from './ProjectLoadStatus';
import {documentLoadLabel} from '../modeling/document-load';
export function WorkspacePanel({current,onRequestRestore,onRestore,onChanged}:{current:WorkspaceMetadata|null;onRequestRestore:(restore:()=>Promise<void>)=>Promise<void>;onRestore:(id:string)=>Promise<void>;onChanged:()=>void}) {
  const [projects,setProjects]=useState<WorkspaceMetadata[]>([]),[name,setName]=useState(current?.name || ""),[search,setSearch]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const edited=useRef(false);
  const errorRef=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{if(error)errorRef.current?.scrollIntoView({block:'nearest'});},[error]);
  const [restoringId,setRestoringId]=useState<string|null>(null);
  useEffect(()=>{if(!edited.current && current?.name)setName(current.name);},[current?.name]);
  useEffect(()=>{const protect=(event:BeforeUnloadEvent)=>{if(busy || edited.current){event.preventDefault();event.returnValue="";}};window.addEventListener("beforeunload",protect);return()=>window.removeEventListener("beforeunload",protect);},[busy]);
  const request=useRef({sequence:0});
  const load=useCallback(()=>{const ticket=++request.current.sequence;return modelingController.listWorkspaces(search).then(items=>{if(ticket===request.current.sequence)setProjects(items);}).catch(reason=>{if(ticket===request.current.sequence)setError(reason.message);});},[search]);
  useEffect(()=>{const owner=request.current,timer=setTimeout(()=>void load(),150);return()=>{clearTimeout(timer);owner.sequence++;};},[load]);
  const rename=async()=>{setBusy(true);setError(null);try{const saved=await modelingController.renameWorkspace(name);setName(saved.name);edited.current=false;onChanged();await load();}catch(reason){setError(reason instanceof Error ? reason.message : "重命名失败");}finally{setBusy(false);}};
  const restore=async(id:string)=>{setBusy(true);setRestoringId(id);setError(null);try{await onRestore(id);}catch(reason){setError('无法打开该工程，当前工程保持不变。请核对恢复记录或打开有效备份。'+(reason instanceof Error ? reason.message : "恢复失败"));await load();}finally{setBusy(false);setRestoringId(null);}};
  const visible=projects.filter(item=>`${item.name} ${item.documentId}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="workspace-manager panel-section" data-testid="workspace-manager">
    <p className="panel-copy">工程操作成功后会记录后台恢复快照。下载工程包是独立备份；“备份包已生成”不等同于文件已经写入你的磁盘。</p>
    <form onSubmit={event=>{event.preventDefault();void rename();}}><label className="single-field"><span>当前工程名称</span><input value={name} onChange={event=>{edited.current=true;setName(event.target.value);}} maxLength={120} disabled={busy}/></label><button className="primary-action" type="submit" disabled={busy || !name.trim()}>保存工程名称</button></form>
    <div className="workspace-list-heading"><strong>可恢复工程</strong><button type="button" onClick={()=>void load()} disabled={busy}>刷新列表</button></div>
    <p className="panel-copy">最多显示 200 项；搜索会查询全部工程，可查找更早的工作区。</p>
    <p className="panel-copy">未载入的工程只检查恢复文件，打开时才由内核读取几何；损坏工程不会用空模型替代。</p>
    {restoringId&&<ProjectLoadStatus documentId={restoringId} active={busy}/>}
    <label className="single-field"><span>查找工程</span><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="工程名称或 ID"/></label>
    <div className="workspace-list">{visible.length ? visible.map(item=><div key={item.documentId} data-workspace-id={item.documentId} className={`workspace-list-row${item.documentId===current?.documentId ? " current" : ""}`}><div><strong>{item.name}</strong><small>{item.documentId}</small><small>{new Date(item.updatedAt).toLocaleString("zh-CN")} · {item.recoverable ? item.hasChangesSinceExport ? "有尚未生成备份的更改" : "备份包已生成" : "恢复快照不可用"}</small>{item.load&&<small>{documentLoadLabel(item.load)}</small>}{item.recoveryWarning&&<small className="workspace-recovery-warning">{item.recoveryWarning}</small>}{item.recoveryError&&<small className="workspace-recovery-error">{item.recoveryError}</small>}</div><button type="button" disabled={busy || !item.recoverable || item.documentId===current?.documentId} onClick={()=>void onRequestRestore(()=>restore(item.documentId))}>{item.documentId===current?.documentId ? "当前" : "恢复"}</button></div>) : <p className="panel-copy">暂无匹配的可恢复工程。</p>}</div>
    {error && <p ref={errorRef} className="exchange-message" role="alert">{error}</p>}
  </section>;
}
