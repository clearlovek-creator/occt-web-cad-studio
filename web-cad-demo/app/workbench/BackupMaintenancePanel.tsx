"use client";
import {useEffect,useState} from 'react';
import type {BackupMaintenanceRecord} from '../../shared/project-backup-maintenance.mjs';
import type {BackupMaintenanceModel} from './useBackupMaintenance';
const states:Record<BackupMaintenanceRecord['state'],string>={reviewed:'已核对 · 尚未执行',prepared:'已准备 · 待显式处理',isolated:'材料已隔离 · 待显式处理',completed:'维护已完成'};
const bytes=(size:number)=>`${size.toLocaleString('zh-CN')} 字节`;
export function BackupMaintenancePanel({model,busy,onChanged}:{model:BackupMaintenanceModel;busy:boolean;onChanged:()=>Promise<void>}){
  const record=model.selected,[now,setNow]=useState(Date.now);
  useEffect(()=>{if(!record||record.state!=='reviewed')return;const timer=setTimeout(()=>setNow(Date.now()),Math.max(0,Math.min(2147483647,Date.parse(record.expiresAt)-Date.now()+1)));return()=>clearTimeout(timer);},[record]);
  const expired=record?.state==='reviewed'&&(record.expired||now>=Date.parse(record.expiresAt)),blocked=busy||model.loading||Boolean(model.pending)||Boolean(record?.running);
  return <section className="backup-maintenance" data-testid="backup-maintenance" data-maintenance-state={record?.state||'empty'}>
    <div className="backup-list-heading"><strong>异常材料维护清单</strong><button type="button" disabled={model.loading||Boolean(model.pending)} onClick={()=>{model.clearError();void model.refresh();}}>刷新原清单</button></div>
    <p className="panel-copy">刷新只读取状态，不会清理或继续执行。清单只管理备份材料，不包含工程几何、属性与建模历史。</p>
    {model.pending==='preview'&&<p className="backup-notice" role="status">正在核对材料并生成清单，尚未删除任何文件…</p>}
    {model.unreadable>0&&<p className="backup-storage-warning">有 {model.unreadable} 项维护记录无法读取，已保留，不能自动处理。</p>}
    <div className="maintenance-record-list" aria-label="维护清单记录">{model.records.map(item=><button type="button" key={item.reviewId} data-review-id={item.reviewId} aria-pressed={record?.reviewId===item.reviewId} disabled={Boolean(model.pending)} onClick={()=>model.select(item.reviewId)}><strong>{states[item.state]}{item.running?' · 正在处理':''}</strong><span>{new Date(item.createdAt).toLocaleString('zh-CN')} · {item.entryId}</span></button>)}</div>
    {!record&&!model.loading&&<p className="panel-copy">{model.records.length?'请从上方选择一份维护清单。仅查看不会执行或继续清理。':'暂无维护清单。请从“备份文件”中选择“核对异常材料”；无法确认归属的材料不提供清理。'}</p>}
    {record&&<article className="maintenance-proof" data-selected-review={record.reviewId}>
      <strong>{states[record.state]}{expired?' · 已过期':''}</strong>
      <p className="maintenance-entry">{record.entryId}</p>
      {(record.state==='prepared'||record.state==='isolated')&&<p className="backup-storage-warning">上次维护未完成，原清单和剩余材料已保留。仅查看不会继续清理；再次执行会先核对剩余材料。</p>}
      {record.running&&<p className="panel-copy" role="status">后台正在处理这份清单。请刷新核对，不要重复提交。</p>}
      <div className="maintenance-file-list">{record.files.map(file=><div key={file.name}><strong>{file.name==='receipt.json'?'原始回执':'备份材料'}</strong><span>{file.name} · {bytes(file.bytes)}</span></div>)}</div>
      {!record.files.length&&<p className="panel-copy">核对时为空目录；仅处理该受管目录。</p>}
      <details><summary>摘要、范围与清单标识</summary><dl><dt>清单 ID</dt><dd>{record.reviewId}</dd><dt>核对摘要</dt><dd>{record.snapshotDigest}</dd><dt>有效期</dt><dd>{new Date(record.expiresAt).toLocaleString('zh-CN')}</dd>{record.files.map(file=><div className="maintenance-file-digest" key={file.name}><dt>{file.name==='receipt.json'?'回执摘要':'材料摘要'}</dt><dd>{file.sha256}</dd></div>)}</dl></details>
      {record.state==='completed'?<p className="backup-notice">{record.outcome==='already-absent'?'已核对：原清单材料已不存在。':'原清单中的异常材料已清理。'}</p>:<><p className="panel-copy">此操作会永久清理上述备份材料，执行前仍会核对同一文件。不会删除当前模型。</p><button type="button" className="maintenance-commit" disabled={blocked||expired} onClick={()=>void model.execute(record).then(onChanged)}>{model.pending==='commit'?'正在核对并清理…':record.state==='reviewed'?'按此清单清理材料':'继续核对此清单并清理'}</button></>}
      {expired&&<p className="backup-storage-warning">清单已过期。可仅清除旧记录，再从原条目生成新清单；不会自动重新核对或执行。</p>}
      {['reviewed','completed'].includes(record.state)&&<button type="button" disabled={blocked} onClick={()=>void model.discard(record)}>仅清除清单记录</button>}
    </article>}
    {model.loading&&<p className="panel-copy" role="status">正在读取维护清单…</p>}{model.notice&&<p className="backup-notice" role="status">{model.notice}</p>}{model.error&&<p className="exchange-message" role="alert">{model.error}</p>}
  </section>;
}
