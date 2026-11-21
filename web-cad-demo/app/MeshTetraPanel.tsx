"use client";
import {useState} from 'react';
import type {ProjectMeshTasks} from './model/use-project-mesh-jobs';
import {tetraSettingsFromDraft,tetraDerivationLabel,tetraOptimizationMethodLabel,type TetraOptimizationMethod} from './model/discrete-tetra';
import {MeshOptimizationRecovery,MeshOptimizationRelation,MeshOptimizationPending} from './MeshOptimizationRecovery';

/** Same compact workbench controls as CAD meshing; this route never changes CAD. */
export function MeshTetraPanel({tasks,revision,disabled}:{tasks:ProjectMeshTasks;revision:number|null;disabled:boolean}){
  const [error,setError]=useState('');
  const job=tasks.jobs.find(row=>row.jobId===tasks.selectedTetraId),info=job?.derivation,summary=job?.discreteTetraSummary,action=job?tasks.tetraActions[job.jobId]:undefined;
  const draft=tasks.tetraDraft,locked=disabled||tasks.busy||Boolean(tasks.active)||!tasks.historyKnown||tasks.catalog.state!=='ready',available=tasks.tetraAvailable&&tasks.tetraDerivationAvailable;
  const run=async()=>{try{if(revision===null)throw Error('工程版本尚未读取。');const settings=tetraSettingsFromDraft(draft);setError('');await tasks.create({kind:'discrete-tetra',baseRevision:revision,discreteTetra:settings});}catch(reason){setError(reason instanceof Error?reason.message:'剖分设置无效。');}};
  return <div className="mesh-tetra-panel" data-testid="mesh-tetra-panel">
    <MeshOptimizationPending tasks={tasks} disabled={disabled}/>
    <p className="mesh-route-description">全部实体与开放面一起处理交叉，再生成共形四面体。保留 Body／Face 归属，不改工程几何，不自动改用另一算法。</p>
    {!available&&<p className="mesh-quality-warning" role="status">{tasks.historyKnown?'当前服务未提供完整的交叉修复与结果准备能力，不能启动此路线。':'任务记录与剖分能力尚未核对，不能启动新剖分；已保留的恢复请求仍可只读查询。'}</p>}
    <div className="mesh-tetra-fields">
      <label><span>目标网格尺寸 · mm</span><input type="number" aria-label="交叉修复目标网格尺寸" min="0.000001" max="1000000" step="any" value={draft.meshSize} disabled={locked} onChange={event=>tasks.setTetraDraft({...draft,meshSize:event.target.value})}/></label>
      <label><span>CAD 离散偏差 · mm</span><input type="number" aria-label="交叉修复离散偏差" min="0.000001" max="1000" step="any" value={draft.linearDeflection} disabled={locked} onChange={event=>tasks.setTetraDraft({...draft,linearDeflection:event.target.value})}/></label>
      <label><span>严格质量阈值 · minSICN</span><input type="number" aria-label="交叉修复质量阈值" min="0" max="1" step="0.05" value={draft.qualityThreshold} disabled={locked} onChange={event=>tasks.setTetraDraft({...draft,qualityThreshold:event.target.value})}/></label>
    </div>
    <label className="check-field"><input type="checkbox" checked={draft.optimization} disabled={locked} onChange={event=>tasks.setTetraDraft({...draft,optimization:event.target.checked})}/>网格后优化 · 3 轮（仅接纳不退化的候选）</label>
    {draft.optimization&&<div className="mesh-tetra-fields"><label><span>后优化方法</span><select aria-label="交叉修复后优化方法" value={draft.optimizationMethod} disabled={locked} onChange={event=>tasks.setTetraDraft({...draft,optimizationMethod:event.target.value as TetraOptimizationMethod})}>{(Object.entries(tetraOptimizationMethodLabel) as [TetraOptimizationMethod,string][]).map(([method,label])=><option key={method} value={method}>{label}{method==='netgen'?'（实验性）':''}</option>)}</select></label>{draft.optimizationMethod==='netgen'&&<p className="mesh-quality-warning" role="status">Netgen 仍存在已知原生异常。异常时保留检查点，不自动重试；可明确选择其他方法后创建新任务。</p>}</div>}
    <p className="mesh-quality-note">严格验收：不允许低于阈值的单元，不自动放宽质量。重叠区域材料冲突会阻止剖分；未指定材料会保留为空。</p>
    <details className="mesh-tetra-limits"><summary>当前验证范围与限制</summary><p>最多 6 个来源 Solid、4096 个离散三角面、128 个分区单元。至少需要一个真实封闭实体；内部、体外及跨界开放面保留面网格，不会被提升为实体。复杂工业脏几何仍需专项验证。结果准备需要至少 416 MiB 磁盘额度，不等于实际文件大小。</p><p>交叉修复不会直接把原始结果视为已验收网格；完成后还要重新核验归属、质量和显示／导出文件。</p></details>
    <button type="button" className="secondary-action mesh-tetra-create" disabled={locked||!available||revision===null} onClick={()=>void run()}>{tasks.active?'后台任务进行中':tasks.busy?'正在处理…':'联合剖分并准备结果（默认隐藏）'}</button>
    {error&&<p className="property-error" role="alert">{error}</p>}
    {job&&<section className="mesh-tetra-result" aria-label="交叉修复任务结果" data-job-id={job.jobId}>
      <div className="mesh-tetra-result-heading"><strong>{job.state==='complete'&&info?tetraDerivationLabel[info.state]:job.state==='failed'?job.optimizationAttempt?'检查点优化失败':'交叉修复剖分失败':job.state==='cancelled'?'任务已取消':job.state==='interrupted'?'任务已中断':job.optimizationAttempt?'检查点优化任务':'交叉修复任务'}</strong><small>来源 R{job.revision??'—'} · {job.jobId.slice(-8)}</small></div>
      <MeshOptimizationRelation job={job}/>
      {summary&&<dl><div><dt>全部 CAD 来源</dt><dd>{summary.bodyCount} Body / {summary.faceCount} Face</dd></div><div><dt>实体／分区</dt><dd>{summary.solidCount} Solid → {summary.cellCount} 个共形分区</dd></div><div><dt>节点／四面体</dt><dd>{summary.nodeCount} / {summary.tetraCount}</dd></div><div><dt>最小质量</dt><dd>{summary.quality.minimumSICN.toFixed(4)}</dd></div><div><dt>未指定材料</dt><dd>{summary.unassignedCellCount} 个分区</dd></div></dl>}
      {job.options?.discreteTetra?.optimization&&<p className="mesh-quality-note" data-testid="tetra-executed-optimization">本次优化设置：{tetraOptimizationMethodLabel[job.options.discreteTetra.optimization.method]} · {job.options.discreteTetra.optimization.iterations} 轮。修改上方参数只影响下一次任务。</p>}
      {job.freshness?.status!=='current'&&<p className="mesh-quality-warning" role="status">{job.freshness?.reason||'来源尚未核对。'} 不会在当前几何上显示或重新准备。</p>}
      {job.error&&<p className="property-error" role="alert">{job.error}</p>}
      {job.discreteFailureSummary?.code==='MESH_MATERIAL_CONFLICT'&&<p className="mesh-quality-warning">{job.discreteFailureSummary.conflictCellCount} 个重叠分区材料不一致，请先处理工程材料赋值。</p>}
      {job.discreteFailureSummary?.code==='MESH_QUALITY_REJECTED'&&<p className="mesh-quality-warning">{job.discreteFailureSummary.lowQualityCount} 个单元未达质量阈值；未切换到诊断模式或降低标准。</p>}
      {(action?.error||info?.error)&&<p className="property-error" role="alert">{action?.error||info?.error}</p>}
      <MeshOptimizationRecovery job={job} tasks={tasks} disabled={disabled}/>
      {job.state==='complete'&&<>
        <p className="mesh-quality-note">{info?.state==='ready'?'完整核验通过。网格显示仍由下方总开关和几何树 Body 按钮控制。':'原始剖分结果保留。准备显示与导出不会重新运行剖分；读取历史任务不会自动执行此操作。'}</p>
        <div className="mesh-tetra-actions">
          {action?.state==='uncertain'?<button type="button" disabled={tasks.busy} onClick={()=>void tasks.checkTetra(job.jobId)}>核对结果准备状态</button>:<>
            {info?.canStart&&<button type="button" disabled={locked||!available||job.freshness?.status!=='current'} onClick={()=>void tasks.prepareTetra(job.jobId)}>{info.state==='failed'||info.state==='cancelled'?'重新准备显示与导出':'准备显示与导出'}</button>}
            {['ready','unverified','invalid','complete'].includes(info?.state||'')&&<button type="button" disabled={tasks.busy||disabled} onClick={()=>void tasks.checkTetra(job.jobId)}>重新核验原结果</button>}
            {['ready','unverified','invalid'].includes(info?.state||'')&&<button type="button" disabled={tasks.busy||disabled||!tasks.historyKnown} onClick={()=>void tasks.discardTetra(job.jobId)}>清理派生文件</button>}
          </>}
        </div>
        {['ready','unverified','invalid'].includes(info?.state||'')&&<small className="mesh-muted">清理仅移除显示、质量与导出副本，保留原始剖分，可再准备；不删除工程几何。</small>}
      </>}
    </section>}
  </div>;
}
