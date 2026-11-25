"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {ProjectBackupCatalog,ProjectBackupEntry} from '../../shared/project-backup-catalog.mjs';
import {modelingController} from '../modeling/runtime';
import {startBackupDownload} from '../modeling/backup-download-action';
import {useBackupMaintenance} from './useBackupMaintenance';
import {BackupMaintenancePanel} from './BackupMaintenancePanel';
import {WorkbenchDialog} from './WorkbenchDialog';

const label:Record<ProjectBackupEntry['state'],string>={available:'已发布 · 下载时校验',generating:'正在生成 · 尚未发布',retained:'未完成发布 · 材料保留',unavailable:'材料异常 · 暂不可用'};
const size=(bytes:number)=>bytes<1024*1024?`${bytes.toLocaleString('zh-CN')} 字节`:`${(bytes/1024/1024).toFixed(1)} MiB`;
export function ProjectBackupPanel({documentId,busy}:{documentId:string;busy:boolean}){
  const maintenance=useBackupMaintenance(documentId),[view,setView]=useState<'files'|'maintenance'>('files');
  const [catalog,setCatalog]=useState<ProjectBackupCatalog|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [action,setAction]=useState<{taskId:string;kind:'download'|'delete';received:number;total:number;stopping?:boolean}|null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<ProjectBackupEntry | null>(null);
  const owner=useRef({alive:true,sequence:0,abort:null as AbortController|null,downloadId:null as string|null});
  const load=useCallback(async(after?:string)=>{
    const current=owner.current,ticket=++current.sequence;current.abort?.abort();const abort=new AbortController();current.abort=abort;setLoading(true);setError(null);
    try{const page=await modelingController.listProjectBackups({after,signal:abort.signal});if(current.alive&&current.sequence===ticket&&page.documentId===documentId)setCatalog(previous=>after&&previous?.snapshot===page.snapshot?{...page,entries:[...previous.entries,...page.entries]}:page);}
    catch(reason){if(current.alive&&current.sequence===ticket&&!abort.signal.aborted)setError(reason instanceof Error?reason.message:'备份目录暂不可读。');}
    finally{if(current.alive&&current.sequence===ticket)setLoading(false);}
  },[documentId]);
  useEffect(()=>{const current=owner.current;current.alive=true;const timer=setTimeout(()=>void load(),0);return()=>{clearTimeout(timer);current.alive=false;current.sequence++;current.abort?.abort();if(current.downloadId)try{modelingController.cancelProjectBackupDownload(current.downloadId);}catch{/* A completed read may already have released ownership. */}};},[load]);
  const download=async(entry:ProjectBackupEntry)=>{
    const current=owner.current;current.downloadId=entry.taskId;setError(null);setNotice(null);setAction({taskId:entry.taskId,kind:'download',received:0,total:entry.receipt?.projectBackup.bytes||0});
    try{const file=await modelingController.downloadStoredProjectBackup(entry.taskId,(received,total)=>{if(current.alive)setAction(value=>value?{...value,received,total}:value);});if(current.alive){startBackupDownload(file,file.name);setNotice('已校验原备份并启动浏览器下载，请检查本地下载结果。');}}
    catch(reason){if(current.alive){if(reason&&typeof reason==='object'&&'code' in reason&&reason.code==='PROJECT_BACKUP_DOWNLOAD_CANCELLED')setNotice('已停止下载，后台备份仍保留。');else setError(reason instanceof Error?reason.message:'备份读取失败。');}}
    finally{current.downloadId=null;if(current.alive)setAction(null);}
  };
  const remove=async(entry:ProjectBackupEntry)=>{
    const current=owner.current;setError(null);setNotice(null);setAction({taskId:entry.taskId,kind:'delete',received:0,total:0});let outcome:string|null=null;
    try{await modelingController.deleteProjectBackup(entry.taskId);if(current.alive)setNotice('已删除该备份文件；工程几何、属性和建模历史未删除。');}
    catch(reason){outcome=reason instanceof Error?reason.message:'删除结果尚未确认，请刷新目录核对。';}
    finally{if(current.alive){setAction(null);await load();if(current.alive&&outcome)setError(outcome);}}
  };
  const blocked=busy||loading||Boolean(action);
  const confirmRemoval = () => {
    if (blocked || !deleteCandidate?.receipt) return;
    setDeleteCandidate(null);
    const current = catalog?.entries.find(entry => entry.taskId === deleteCandidate.taskId);
    if (modelingController.getSnapshot().documentId !== documentId || !current?.canDelete ||
        current.receipt?.projectBackup.sha256 !== deleteCandidate.receipt.projectBackup.sha256) {
      setError('备份状态已变化，请刷新列表并重新选择。');
      return;
    }
    void remove(current);
  };
  const inspect=(entry:ProjectBackupEntry)=>{setView('maintenance');void maintenance.prepare(entry.entryId);};
  return <section className="project-backups panel-section" data-testid="project-backup-manager" aria-busy={loading}>
    <div className="backup-view-switch" aria-label="备份管理视图"><button type="button" aria-pressed={view==='files'} disabled={Boolean(maintenance.pending)} onClick={()=>setView('files')}>备份文件</button><button type="button" aria-pressed={view==='maintenance'} disabled={Boolean(action)} onClick={()=>setView('maintenance')}>维护清单{maintenance.records.some(record=>record.state==='prepared'||record.state==='isolated')?' · 待处理':''}</button></div>
    {view==='maintenance'?<BackupMaintenancePanel model={maintenance} busy={busy} onChanged={()=>load()}/>:<>
    <p className="panel-copy">当前工程的独立备份文件。清理任务记录不会删除这里的备份；下载旧备份不会替换当前模型。</p>
    <div className="backup-list-heading"><strong>{catalog?`${catalog.total} 个备份条目`:'备份目录'}</strong><button type="button" disabled={loading||Boolean(action)} onClick={()=>void load()}>刷新列表</button></div>
    {catalog?.storage.retainedMaterial&&<p className="backup-storage-warning">存储中有未完成或异常材料，均已保留，不会自动清理。{catalog.storage.unattributedEntries>0?`其中 ${catalog.storage.unattributedEntries} 项无法确认工程归属。`:''}</p>}
    <div className="backup-list" aria-label="当前工程备份">{catalog?.entries.map(entry=>{const receipt=entry.receipt,backup=receipt?.projectBackup,reading=action?.taskId===entry.taskId&&action.kind==='download';return <article key={entry.entryId} data-backup-id={entry.entryId} data-backup-state={entry.state} className={`backup-list-row${entry.state==='unavailable'||entry.state==='retained'?' backup-retained':''}`}>
      <strong>{backup?.fileName||(entry.state==='generating'?'正在生成的备份':'保留的备份材料')}</strong>
      {receipt&&backup&&<p className="backup-checkpoint">R{receipt.revision} · {new Date(backup.createdAt).toLocaleString('zh-CN')} · {size(backup.bytes)}</p>}
      <p className="backup-state">{label[entry.state]}{entry.busy&&entry.state!=='generating'?' · 正在使用':''}</p>
      <div className="backup-actions"><button type="button" disabled={blocked||!entry.canDownload} onClick={()=>void download(entry)}>下载备份</button><button type="button" className="backup-delete" disabled={blocked||!entry.canDelete||!receipt} onClick={()=>setDeleteCandidate(entry)}>{action?.taskId===entry.taskId&&action.kind==='delete'?'正在删除…':'删除备份文件'}</button></div>
      {(entry.state==='unavailable'||entry.state==='retained')&&<button type="button" className="backup-inspect" disabled={blocked||Boolean(maintenance.pending)||entry.busy} onClick={()=>inspect(entry)}>核对异常材料</button>}
      {reading&&<div className="backup-read-status"><span>{action.stopping?'正在停止读取…':`已读取 ${size(action.received)} / ${size(action.total)}`}</span><button type="button" disabled={action.stopping} onClick={()=>{try{modelingController.cancelProjectBackupDownload(entry.taskId);setAction(value=>value?{...value,stopping:true}:value);}catch(reason){setError(reason instanceof Error?reason.message:'下载状态已变化。');}}}>停止下载</button></div>}
      <details><summary>文件与回执详情</summary><dl><dt>保存任务</dt><dd>{entry.taskId}</dd>{backup&&<><dt>SHA256</dt><dd>{backup.sha256}</dd><dt>校验说明</dt><dd>目录未读取完整文件；下载和删除前会核验原文件长度及摘要。</dd></>}</dl>{entry.state==='available'&&<button type="button" className="backup-inspect" disabled={blocked||Boolean(maintenance.pending)||entry.busy} onClick={()=>inspect(entry)}>核对材料（不删除）</button>}</details>
    </article>;})}</div>
    {loading&&<p className="panel-copy" role="status">正在读取备份目录…</p>}
    {catalog&&!loading&&!catalog.entries.length&&<p className="panel-copy">当前工程暂无可识别的备份。请使用“保存工程”生成备份。</p>}
    {catalog?.nextCursor&&<button type="button" className="backup-more" disabled={blocked} onClick={()=>void load(catalog.nextCursor!)}>加载更早的备份</button>}
    <p className="panel-copy">“删除备份文件”仅删除后台这一份文件，不删除当前工程；异常材料须先核对清单，再显式清理。此处不自动生成备份。</p>
    {notice&&<p className="backup-notice" role="status">{notice}</p>}{error&&<p className="exchange-message" role="alert">{error}</p>}
    {deleteCandidate?.receipt && <WorkbenchDialog title="删除备份文件" onCancel={() => setDeleteCandidate(null)} actions={<>
      <button type="button" data-initial-focus onClick={() => setDeleteCandidate(null)}>取消</button>
      <button type="button" className="feature-delete-confirm" disabled={blocked} onClick={confirmRemoval}>确认删除文件</button>
    </>}>
      <p><strong>{deleteCandidate.receipt.projectBackup.fileName}</strong></p>
      <p>R{deleteCandidate.receipt.revision} · {new Date(deleteCandidate.receipt.projectBackup.createdAt).toLocaleString('zh-CN')}</p>
      <p>此操作会永久删除后台的这一份备份，原工程和建模历史仍可继续使用。</p>
    </WorkbenchDialog>}
    </>}
  </section>;
}
