"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { modelingTaskLabel, modelingTaskTerminal, modelingTaskExplanation } from '../../shared/modeling-task-status.mjs';
import {modelingTaskSourceDocument,type ModelingTaskObservation} from '../modeling/modeling-task-client';
import type { ModelingCommandResponse } from '../modeling/command-contract';
import { modelingController } from '../modeling/runtime';
import { WORKBENCH_TABS } from './ribbon-catalog';
import {startBackupDownload} from '../modeling/backup-download-action';
const labels = new Map<string, string>(WORKBENCH_TABS.flatMap(tab => tab.groups.flatMap(group => group.tools.map(tool => [tool.id, tool.label] as const))));
const operationLabel = (operation: string) => ({ 'project.create':'新建工程', 'project.save':'保存工程', 'project.open':'打开工程', 'step.import':'STEP 导入', 'project.batch': '批量建模', 'document.undo': '撤销', 'document.redo': '重做', 'document.create': '创建工程', 'body.update': 'Body 属性', 'body.delete': '删除 Body', 'feature.update': '编辑特征', 'variable.set': '编辑变量', 'material.set': '编辑材料', 'coordinate.set': '编辑坐标系' } as Record<string, string>)[operation] || labels.get(operation) || labels.get(operation.replace(/^detail\./, 'feature.')) || operation;
export function ModelingTaskStatus({ documentId, tasks, notice, onReconciled, importStatus }: {
    documentId: string;
    tasks: ModelingTaskObservation[];
    notice: string | null;
    onReconciled: (result: ModelingCommandResponse) => void;
    importStatus?:{taskId?:string;fileName:string}|null;
}) {
    const [selected, setSelected] = useState<{taskId:string;taskSetKey:string} | null>(null), [dismissed, setDismissed] = useState<Set<string>>(() => new Set()), [visible, setVisible] = useState<string | null>(null);
    const [feedback,setFeedback]=useState<{owner:string;message:string}|null>(null),[readingOwner,setReadingOwner]=useState<string|null>(null);
    const [discoveryNotice,setDiscoveryNotice]=useState<string|null>(null),[reconcileNotice,setReconcileNotice]=useState<string|null>(null);
    const reconciled=useRef(onReconciled),externalTerminals=useRef(new Map<string,string>());
    const workspaceOwner=useRef<string|null>(null),externalRefresh=useRef<{documentId:string;again:boolean;promise:Promise<void>}|null>(null);
    useLayoutEffect(()=>{workspaceOwner.current=documentId;return()=>{workspaceOwner.current=null;};},[documentId]);
    useEffect(()=>{reconciled.current=onReconciled;},[onReconciled]);
    useEffect(() => { void modelingController.refreshModelingTasks(documentId).catch(() => { }); }, [documentId]);
    useEffect(()=>{
        let live=true,running=false,timer:ReturnType<typeof setTimeout>;
        const discover=async()=>{
            clearTimeout(timer);
            if(!live||running)return;running=true;
            try{if(!document.hidden)await modelingController.discoverModelingTasks(documentId);if(live)setDiscoveryNotice(null);}
            catch{if(live)setDiscoveryNotice('任务列表暂不可读，后台操作可能仍在执行；未重复发送任何命令。');}
            finally{running=false;if(live)timer=setTimeout(()=>void discover(),2000);}
        };
        const focused=()=>{if(!document.hidden)void discover();};
        void discover();window.addEventListener('focus',focused);document.addEventListener('visibilitychange',focused);
        return()=>{live=false;clearTimeout(timer);window.removeEventListener('focus',focused);document.removeEventListener('visibilitychange',focused);};
    },[documentId]);
    useEffect(()=>{
        let needed=false;
        for(const item of tasks){
            const task=item.task;if(!item.external||task.documentId!==documentId||['project.create','project.open','project.save'].includes(task.operation))continue;
            const signature=`${task.phase}:${task.sequence}`,prior=externalTerminals.current.get(task.taskId);
            if(prior!==signature&&(['succeeded'].includes(task.phase)||['failed','cancelled'].includes(task.phase)&&task.restored===true))needed=true;
            externalTerminals.current.set(task.taskId,signature);
        }
        while(externalTerminals.current.size>256)externalTerminals.current.delete(externalTerminals.current.keys().next().value!);
        if(!needed)return;
        const pending=externalRefresh.current;if(pending?.documentId===documentId){pending.again=true;return;}
        const cycle={documentId,again:false,promise:Promise.resolve()};
        const work=(async()=>{do{
            cycle.again=false;const result=await modelingController.execute({operation:'document.view'});
            if(workspaceOwner.current!==documentId||result.documentId!==documentId||modelingController.getSnapshot().documentId!==documentId)return;
            if(modelingController.acceptsState(result)){reconciled.current(result);setReconcileNotice(null);}
        }while(cycle.again);})();
        cycle.promise=work.catch(()=>{if(workspaceOwner.current===documentId)setReconcileNotice('外部建模任务已返回，但当前工程显示尚未核对；请载入当前工程，不要重复执行。');}).finally(()=>{if(externalRefresh.current===cycle)externalRefresh.current=null;});externalRefresh.current=cycle;
    },[tasks,documentId]);
    const taskNotice=notice||discoveryNotice||reconcileNotice;
    const candidates = useMemo(() => { const priority = (item: ModelingTaskObservation) => ['reading','stopping'].includes(item.download?.phase||'')||['receiving','preparing', 'executing', 'stopping', 'rolling-back', 'committing'].includes(item.task.phase) ? 0 : item.task.phase === 'queued' ? 1 : item.task.phase === 'reserved' ? 2 : item.task.phase === 'unknown' ? 3 : 4; return tasks.filter(item => modelingTaskSourceDocument(item)===documentId && !dismissed.has(item.task.taskId) && (item.task.phase !== 'succeeded' || item.notice || item.projectOpen || item.projectCreate || item.task.operation==='project.save')).toSorted((a, b) => priority(a) - priority(b) || (priority(a) < 3 ? a.task.createdAt.localeCompare(b.task.createdAt) : b.task.createdAt.localeCompare(a.task.createdAt))); }, [tasks, documentId, dismissed]);
    const taskSetKey=candidates.map(item=>item.task.taskId).toSorted().join(',');
    const chosen=selected?.taskSetKey===taskSetKey?candidates.find(item=>item.task.taskId===selected.taskId):undefined,active=candidates.find(item=>!modelingTaskTerminal(item.task.phase)||['reading','stopping'].includes(item.download?.phase||''));
    const current = chosen&&(!active||!modelingTaskTerminal(chosen.task.phase)||['reading','stopping'].includes(chosen.download?.phase||''))?chosen:active||chosen||candidates[0], id = current?.task.taskId, phase = current?.task.phase;
    const feedbackOwner=`${documentId}:${id}:${phase}`,localNotice=feedback?.owner===feedbackOwner?feedback.message:null,reading=readingOwner===feedbackOwner;
    const setLocalNotice=(message:string|null)=>setFeedback(message?{owner:feedbackOwner,message}:null);
    const setReading=(value:boolean)=>setReadingOwner(value?feedbackOwner:null);
    const owner = useRef<{documentId:string;id:string|undefined}>({ documentId, id });
    useLayoutEffect(()=>{owner.current={documentId,id};return()=>{owner.current={documentId:'',id:undefined};};},[documentId,id]);
    useEffect(() => { if (!id)
        return; const timer = setTimeout(() => setVisible(id), phase === 'unknown' || phase === 'cancelled' ? 0 : 250); return () => clearTimeout(timer); }, [id, phase]);
    const isCurrent = () => owner.current.documentId === documentId && owner.current.id === id;
    const check = async () => { if (!id)
        return; setLocalNotice(null); try {
        await modelingController.checkModelingTask(id);
    }
    catch (reason) {
        if (isCurrent())
            setLocalNotice(reason instanceof Error ? reason.message : '任务状态读取未完成。');
    } };
    const reload = async () => { setReading(true); setLocalNotice(null); try {
        if(current?.projectOpen||current?.projectCreate){
            const result=await modelingController.openCompletedProjectTask(current.task.taskId);
            if(modelingController.getSnapshot().documentId!==result.documentId||!modelingController.acceptsState(result))throw Error('工程已变化，未显示旧模型。');
            onReconciled(result);return;
        }
        const result = await modelingController.execute({ operation: 'document.view' });
        if (!isCurrent() || result.documentId !== documentId || modelingController.getSnapshot().documentId !== documentId || !modelingController.acceptsState(result))
            throw Error('工程或版本已变化，未载入旧任务的模型。');
        onReconciled(result);
        setReconcileNotice(null);
    }
    catch (reason) {
        if (isCurrent())
            setLocalNotice(reason instanceof Error ? reason.message : '工程读取未完成。');
    }
    finally {
        if (isCurrent())
            setReading(false);
    } };
    if (!current) {
        if (!taskNotice)
            return null;
        return <section className="modeling-task-strip task-attention" aria-label="建模任务状态" data-testid="modeling-task-status"><div><strong>任务状态暂不可用</strong><p>{taskNotice}</p></div>{reconcileNotice&&<button type="button" disabled={reading} onClick={()=>void reload()}>{reading?'载入中':'载入当前工程'}</button>}<button type="button" onClick={() => void modelingController.refreshModelingTasks(documentId).catch(() => { })}>检查任务列表</button></section>;
    }
    if (visible !== id)
        return null;
    const task = current.task, pending = !modelingTaskTerminal(task.phase), message = localNotice || current.notice || taskNotice;
    const backup=current.backupReceipt?.projectBackup,download=current.download,downloading=['reading','stopping'].includes(download?.phase||'');
    const progressText=download?.totalBytes?download.totalBytes<1024*1024?`${download.receivedBytes.toLocaleString()} / ${download.totalBytes.toLocaleString()} 字节`:`${(download.receivedBytes/1024/1024).toFixed(2)} / ${(download.totalBytes/1024/1024).toFixed(2)} MiB`:'正在核对原保存回执';
    const fileName=backup?.fileName||current.projectOpen?.fileName||current.projectCreate?.name||(task.operation==='step.import'&&importStatus?.taskId===task.taskId?importStatus.fileName:null);
    const revision=task.revision??current.projectSave?.baseRevision;
    const downloadBackup=async()=>{setLocalNotice(null);try{const file=await modelingController.downloadProjectBackupTask(task.taskId);if(!isCurrent()||modelingController.getSnapshot().documentId!==documentId)return;startBackupDownload(file);}catch(reason){if(isCurrent())setLocalNotice(reason&&typeof reason==='object'&&'code' in reason&&reason.code==='PROJECT_BACKUP_DOWNLOAD_CANCELLED'?null:reason instanceof Error?reason.message:'原备份下载未完成；不会重新生成。');}};
    const explanation = modelingTaskExplanation(task);
    return <section className={`modeling-task-strip${task.phase === 'unknown' || message || download?.phase==='failed' ? ' task-attention' : ''}`} aria-label="建模任务状态" data-testid="modeling-task-status" data-task-id={task.taskId} data-phase={task.phase}>
    <div className="modeling-task-main"><div className="modeling-task-heading"><strong role="status" aria-live="polite">{downloading?download?.phase==='stopping'?'正在停止下载':download?.totalBytes&&download.receivedBytes===download.totalBytes?'正在校验备份':'正在读取备份':task.operation==='project.save'&&task.phase==='succeeded'?'备份已生成':modelingTaskLabel(task)}</strong><span title={fileName||undefined}>{operationLabel(task.operation)}{fileName?` · ${fileName}`:''}</span>{revision !== undefined && <small>R{revision}</small>}</div>{explanation && <p>{explanation}</p>}{downloading&&download&&<p>{progressText} · 停止下载不删除后台备份</p>}{download?.notice&&<p className={download.phase==='failed'?'modeling-task-notice':undefined}>{download.notice}</p>}{message && <p className="modeling-task-notice">{message}</p>}{notice && <p className="modeling-task-notice">{notice}</p>}{task.reportDurable === false && <p className="modeling-task-notice">阶段记录未确认落盘，请保留任务身份并核对工程。</p>}</div>
    <div className="modeling-task-actions">{pending && <button type="button" className="modeling-task-cancel" disabled={!task.cancellable || current.cancelPending || Boolean(current.notice)} title={task.cancellable ? '取消此项操作；等待真实停止与恢复完成。' : explanation || '当前阶段不能取消。'} onClick={() => { setLocalNotice(null); void modelingController.cancelModelingTask(task.taskId).catch(reason => {if(isCurrent())setLocalNotice(reason instanceof Error ? reason.message : '取消结果尚未确认。');}); }}>{current.cancelPending ? '发送取消中' : '取消操作'}</button>}{(message || task.phase === 'unknown') && <button type="button" disabled={current.checking} onClick={() => void check()}>{current.checking ? '检查中' : '检查状态'}</button>}{task.operation==='project.save'&&task.phase==='succeeded'&&!downloading&&<button type="button" onClick={()=>void downloadBackup()}>下载备份</button>}{downloading&&<button type="button" disabled={download?.phase==='stopping'} onClick={()=>{setLocalNotice(null);try{modelingController.cancelProjectBackupDownload(task.taskId);}catch(reason){if(isCurrent())setLocalNotice(reason instanceof Error?reason.message:'下载归属已变化，未发送停止。');}}}>{download?.phase==='stopping'?'正在停止':'停止下载'}</button>}{task.operation!=='project.save'&&(current.projectOpen||current.projectCreate?task.phase==='succeeded':task.phase === 'unknown' || task.phase === 'succeeded' && message) && <button type="button" disabled={reading||modelingController.hasWorkspaceTransfer()} onClick={() => void reload()}>{reading ? '载入中' : current.projectOpen||current.projectCreate?'打开目标工程':'载入当前工程'}</button>}{!pending&&!downloading && <button type="button" aria-label="收起任务状态提示" title="仅收起提示，不修改工程或任务记录。" onClick={() => setDismissed(old => new Set([...old, task.taskId]))}>收起</button>}</div>
    <details className="modeling-task-details"><summary>任务详情{candidates.length > 1 ? ` · ${candidates.length} 项` : ''}</summary><dl><dt>任务 ID</dt><dd>{task.taskId}</dd><dt>请求 ID</dt><dd>{task.requestKey}</dd><dt>操作</dt><dd>{task.operation}</dd>{current.projectCreate&&<><dt>原工程</dt><dd>{current.projectCreate.sourceDocumentId}</dd><dt>目标工程</dt><dd>{task.documentId}</dd></>}{backup&&<><dt>文件</dt><dd>{backup.fileName} · {backup.bytes.toLocaleString()} 字节</dd><dt>备份版本</dt><dd>R{current.backupReceipt?.revision} · S{current.backupReceipt?.stateSequence}</dd><dt>SHA256</dt><dd>{backup.sha256}</dd></>}{task.code && <><dt>状态码</dt><dd>{task.code}</dd></>}{task.error && <><dt>说明</dt><dd>{task.error}</dd></>}</dl>{candidates.length > 1 && <ul aria-label="当前工程任务">{candidates.map(item => <li key={item.task.taskId}><button type="button" data-task-option={item.task.taskId} title={item.task.taskId} disabled={Boolean(active)&&modelingTaskTerminal(item.task.phase)&&!['reading','stopping'].includes(item.download?.phase||'')} aria-pressed={item.task.taskId === task.taskId} onClick={() => setSelected({taskId:item.task.taskId,taskSetKey})}>{operationLabel(item.task.operation)} · {modelingTaskLabel(item.task)}{item.task.revision!==undefined?` · R${item.task.revision}`:''}{item.task.operation==='project.save'?` · ${new Date(item.task.createdAt).toLocaleString('zh-CN',{hour12:false})}`:''}</button></li>)}</ul>}</details>
  </section>;
}
