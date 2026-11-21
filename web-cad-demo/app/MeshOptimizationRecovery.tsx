"use client";
import type {MeshJobDescriptor} from './model/mesh';
import type {ProjectMeshTasks} from './model/use-project-mesh-jobs';

/** The same provenance label is used in task history and its selected detail. */
export function MeshOptimizationRelation({job}:{job:MeshJobDescriptor}){
  return job.optimizationAttempt?<small className="mesh-optimization-relation" title={`来源任务 ${job.optimizationAttempt.originHandle}`}>优化尝试 · 来源 {job.optimizationAttempt.originHandle.slice(-8)}</small>:null;
}

export function MeshOptimizationRecovery({job,tasks,disabled}:{job:MeshJobDescriptor;tasks:ProjectMeshTasks;disabled:boolean}){
  const action=tasks.optimizationActions[job.jobId],info=job.optimizationRecovery,uncertain=action?.state==='uncertain'||Boolean(tasks.optimizationJournalError);
  const parent=job.optimizationAttempt&&tasks.jobs.find(row=>row.jobId===job.optimizationAttempt!.originHandle);
  if(!info&&!action&&!parent)return null;
  return <div className="mesh-optimization-recovery" aria-label="检查点优化恢复">
    {info&&<p className="mesh-quality-note">原任务保留，仅继续优化。创建独立尝试，不重新剖分、不放宽质量标准；成功后需手动准备显示与导出，网格默认隐藏。</p>}
    {(action?.error||tasks.optimizationJournalError)&&<p className="mesh-quality-warning" role="status">{tasks.optimizationJournalError||action?.error}</p>}
    <div className="mesh-tetra-actions">
      {uncertain?<button type="button" disabled={tasks.busy||disabled} onClick={()=>void tasks.checkOptimizationRecovery(job.jobId)}>核对优化恢复状态</button>:action?.state==='accepted'&&action.attemptJobId?<button type="button" disabled={tasks.busy||disabled||!tasks.historyKnown||!tasks.jobs.some(row=>row.jobId===action.attemptJobId)} onClick={()=>void tasks.select(action.attemptJobId!)}>查看优化尝试</button>:info&&<button type="button" className="mesh-optimization-start" disabled={disabled||tasks.busy||Boolean(tasks.active)||!tasks.historyKnown||!info.canStart||job.freshness?.status!=='current'} onClick={()=>void tasks.resumeOptimization(job.jobId)}>{action?.state==='submitting'?'正在登记优化尝试…':'从检查点继续优化'}</button>}
      {parent&&<button type="button" disabled={disabled||tasks.busy||!tasks.historyKnown} onClick={()=>void tasks.select(parent.jobId)}>查看来源任务</button>}
    </div>
  </div>;
}

/** A pending request is still visible if its source is absent from a list.
 * List absence never grants permission to submit it again. */
export function MeshOptimizationPending({tasks,disabled}:{tasks:ProjectMeshTasks;disabled:boolean}){
  const pending=Object.entries(tasks.optimizationActions).filter(([id,action])=>['submitting','uncertain'].includes(action.state)&&!tasks.jobs.some(row=>row.jobId===id));
  if(!pending.length&&!tasks.optimizationJournalError)return null;
  return <section className="mesh-optimization-pending" aria-label="待核对的优化请求">
    <strong>优化请求待核对</strong>
    <p className="mesh-quality-warning" role="status">{tasks.optimizationJournalError||'恢复回复尚未确认，原请求身份已保留。这里只核对任务记录，不会再次提交。'}</p>
    {pending.map(([id])=><div className="mesh-optimization-pending-row" key={id}><small title={id}>来源 {id.slice(-8)}</small><button type="button" disabled={tasks.busy||disabled} onClick={()=>void tasks.checkOptimizationRecovery(id)}>核对优化恢复状态</button></div>)}
  </section>;
}
