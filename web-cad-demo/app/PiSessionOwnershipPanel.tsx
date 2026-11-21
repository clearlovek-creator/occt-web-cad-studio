"use client";
import {useEffect,useRef,useState} from 'react';
import {API_ROOT} from './api-config';
import {PiSessionOwnershipClient} from './modeling/pi-session-ownership-client';
export function PiSessionOwnershipPanel({sessionId,documentId,disabled,onConnected,onClose}:{sessionId:string;documentId:string;disabled:boolean;onConnected:()=>void;onClose?:()=>void}){
  const [client]=useState(()=>new PiSessionOwnershipClient(API_ROOT,sessionId,documentId,{getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value),removeItem:key=>window.localStorage.removeItem(key)}));
  const [state,setState]=useState(()=>client.snapshot()),[confirmed,setConfirmed]=useState(false),[backupNotice,setBackupNotice]=useState<string|null>(null);
  const live=useRef(true);useEffect(()=>{live.current=true;const unsubscribe=client.subscribe(setState);return()=>{live.current=false;unsubscribe();};},[client]);
  const owner=state.ownership,busy=disabled||state.reading||state.submitting||state.repairing;
  const inspect=async()=>{setConfirmed(false);try{await client.inspect();}catch{/* The client retains a scoped, actionable error. */}};
  const adopt=async()=>{try{await client.adopt(confirmed);if(live.current)onConnected();}catch{/* Unknown writes expose only read-only recovery. */}};
  const repair=async()=>{try{await client.repairCache(confirmed,()=>live.current);if(live.current){setConfirmed(false);setBackupNotice('原异常记录已在此浏览器中完整备份。后台历史和归属未改写，请明确连接原会话。');}}catch{/* A failed backup or fresh proof never clears the original record. */}};
  const download=async(id:string)=>{try{const bytes=await client.exportBackup(id);if(!live.current)return;const url=URL.createObjectURL(new Blob([bytes],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=`pi-local-recovery-${documentId}-${id.slice(0,12)}.json`;link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);setBackupNotice('已启动本地恢复记录下载；请确认浏览器中确实保存了文件。此文件不包含原生对话历史。');}catch(error){if(live.current)setBackupNotice(error instanceof Error?error.message:'本地备份读取失败。');}};
  return <section className="pi-owner-recovery" aria-label="旧会话归属恢复" data-testid="pi-owner-recovery">
    <header><strong>{state.blocked?'本地恢复记录需要核对':'会话归属与恢复记录'}</strong><span>只读核对不启动 Pi · 原生历史保持不变</span>{onClose&&<button type="button" disabled={state.submitting||state.repairing} onClick={onClose}>返回对话</button>}</header>
    <p>核对不会启动大模型或改写历史。旧历史需要明确确认工程归属；异常本地标记只有在后台归属已确认且原记录完整备份后才能修复。</p>
    <dl><dt>当前工程</dt><dd>{documentId}</dd><dt>原会话</dt><dd>{sessionId}</dd></dl>
    <button type="button" disabled={busy} onClick={()=>void inspect()}>{state.reading?'正在核对原历史…':state.pending?'检查原确认结果':'只读核对历史'}</button>
    {owner?.state==='legacy'&&<>
      <p>{owner.fileCount} 个历史文件 · {owner.totalBytes?.toLocaleString()} 字节。下方仅显示有限的用户/助手文本，不包含工具与思考全文。</p>
      <div className="pi-owner-preview" aria-label="原历史只读片段">{owner.preview?.messages.map((message,index)=><article key={index}><strong>{message.role==='user'?'你':'Pi Agent'}</strong><p>{message.text}{message.truncated?'…':''}</p></article>)}</div>
      {(owner.preview?.limited||Boolean(owner.preview?.omittedMessages))&&<p>片段已缩略，原始完整历史不会被替换。</p>}
      {(!owner.preview?.messages.length||Boolean(owner.preview?.skippedLines))?<p className="pi-owner-warning">片段不足或存在无法解析的记录，请先离线核对原材料，当前不能确认。</p>:<label className="pi-owner-confirm"><input type="checkbox" checked={confirmed} disabled={busy||state.pending||state.blocked} onChange={event=>setConfirmed(event.target.checked)}/><span>我已核对，这份原历史属于工程 {documentId}</span></label>}
      <details><summary>核对摘要</summary><code>{owner.historyDigest}</code></details>
      <button type="button" className="pi-owner-commit" disabled={busy||state.pending||state.blocked||!confirmed||!owner.preview?.messages.length||Boolean(owner.preview?.skippedLines)} onClick={()=>void adopt()}>{state.submitting?'正在记录归属…':'确认归属并连接'}</button>
    </>}
    {owner?.state==='bound'&&!state.pending&&!state.blocked&&<><p>归属已确认。连接会恢复原生会话，不会重发旧提示。</p><button type="button" disabled={busy} onClick={onConnected}>连接已确认会话</button></>}
    {state.blocked&&<>
      <p className="pi-owner-warning" role="alert">本地恢复记录异常，已保留原字节，尚不能连接。先只读核对后台归属；未确认的历史不能通过清空标记绕过保护。</p>
      {owner?.state==='bound'&&<div className="pi-owner-local-repair">
        <strong>后台已确认：工程 {documentId}</strong><p>仅修复此浏览器的异常恢复标记。先重新核对同一后台归属，再保存完整原标记；不修改后台归属、几何或对话。</p>
        <details><summary>后台归属凭据</summary><code>{owner.ownerToken}</code><code>{owner.createdAt}</code></details>
        <label className="pi-owner-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/><span>我已核对这是当前工程的会话，同意先保留原记录再修复本地标记</span></label>
        <button type="button" className="pi-owner-commit" disabled={busy||!confirmed||Boolean(state.backupError)} onClick={()=>void repair()}>{state.repairing?'正在保留并核对…':'备份原记录并修复标记'}</button>
      </div>}
    </>}
    {state.backups.length>0&&<details className="pi-owner-local-backups"><summary>本地恢复备份 · {state.backups.length} 份</summary><p>仅含此浏览器原恢复标记及核对凭据，不是工程或原生对话备份。不会自动删除；下载文件可能包含本地数据，请妥善保存。</p>{state.backups.map(item=><div key={item.id}><span>{item.createdAt} · {item.characters.toLocaleString()} 字符</span><code>{item.id}</code><button type="button" disabled={busy} onClick={()=>void download(item.id)}>下载原恢复记录</button></div>)}</details>}
    {state.backupError&&<p className="pi-owner-warning" role="alert">{state.backupError}</p>}
    {backupNotice&&<p role="status">{backupNotice}</p>}
    {owner&&['absent','empty'].includes(owner.state)&&<p>当前没有待认领的旧历史，请重新核对会话身份；未自动创建或覆盖材料。</p>}
    {state.pending&&<p className="pi-owner-warning" role="status">归属结果尚待核对，只会检查原确认，不会重复提交。</p>}
    {state.error&&<p className="pi-owner-warning" role="alert">{state.error}</p>}
  </section>;
}
