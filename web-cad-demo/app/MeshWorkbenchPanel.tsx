"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { API_ROOT } from "./api-config.ts";
import {assessMeshDisplaySource} from './model/mesh-display-source';
import {meshAdmitted,meshAdmissionLabel} from '../shared/mesh-admission.mjs';
import {MeshTopologySamples} from './MeshTopologySamples';
import {MeshSpatialSamples} from './MeshSpatialSamples';
import {meshJobStateLabel,type MeshJobPayload,type MeshQualitySelection,type MeshFaceSource,type MeshPreparationResult,type MeshDiagnosticTarget} from "./model/mesh";
import {MeshQualityPanel} from "./MeshQualityPanel";
import {MeshBoundaryPanel} from "./MeshBoundaryPanel";
import {MeshPreparationPanel} from "./MeshPreparationPanel";
import {MeshAdmissionPanel} from './MeshAdmissionPanel';
import {MeshSizingControls} from './MeshSizingControls';
import {MeshStrategyControls} from './MeshStrategyControls';
import {normalizeMeshStrategyOptions,meshStrategyOptionsEqual,type MeshStrategyOptions} from '../shared/mesh-strategy.mjs';
import {meshSizingDraftFromTask,meshSizingFromDraft} from './model/mesh-sizing-draft';
import type {ProjectMeshTasks} from "./model/use-project-mesh-jobs";
import {MeshCatalogNotice} from './MeshCatalogNotice';
import {MeshCompletionRecovery} from './MeshCompletionRecovery';
import {MeshSurfacePanel} from './MeshSurfacePanel';
import {MeshTetraPanel} from './MeshTetraPanel';
import {MeshOptimizationRelation} from './MeshOptimizationRecovery';
import {tetraDerivationLabel} from './model/discrete-tetra';


type Scope = "all" | "body" | "face";

type MeshWorkbenchPanelProps = {
  documentId?: string;
  revision?: number | null;
  geometry?: unknown;
  selectedBodyId?: string | null;
  selectedFaceId?: string | null;
  onMeshResult?: (payload: MeshJobPayload) => void;
  latestResult?: MeshJobPayload;
  tasks: ProjectMeshTasks;
  qualitySelection: MeshQualitySelection|null;
  onLocateQuality: (value:MeshQualitySelection|null)=>void;
  onLocateCadFace: (value:MeshFaceSource)=>void;
  preparationPreviewId:string|null;
  onPreparationPreview:(value:MeshPreparationResult|null)=>void;
  onLocateDiagnostic:(value:MeshDiagnosticTarget)=>void;
};

function scopeLabel(scope: Scope) {
  return scope === "all" ? "全部几何" : scope === "body" ? "当前 Body" : "当前 Face";
}

export function MeshWorkbenchPanel({
  documentId = "default",
  revision = null,
  geometry,
  selectedBodyId = null,
  selectedFaceId = null,
  onMeshResult,
  latestResult,
  tasks,
  qualitySelection,onLocateQuality,onLocateCadFace,preparationPreviewId,onPreparationPreview,onLocateDiagnostic,
}: MeshWorkbenchPanelProps) {
  const repairMode=tasks.setupRepairMode,setRepairMode=tasks.setSetupRepairMode;
  const qualityThreshold=tasks.setupQualityThreshold,setQualityThreshold=tasks.setSetupQualityThreshold;
  const currentSizingDraft=tasks.sizingDraft;
  const [busy, setBusy] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("all");
  const historyFilterId = useId();
  const visibleJobs = historyFilter === "all" ? tasks.jobs : tasks.jobs.filter(job => job.state === historyFilter);
  const [createdResult, setResult] = useState<MeshJobPayload | null>(null);
  const candidate = latestResult || createdResult;
  const result = candidate?.meshJob.documentId === documentId&&(!tasks.selectedTetraId||tasks.selectedJobId===candidate.meshJob.jobId) ? candidate : null;
  const freshness = result ? assessMeshDisplaySource(result, geometry, documentId) : null;
  const diagnosticBodies=(geometry as {bodyMetadata?:{bodyId:string;name:string;visible?:boolean}[]})?.bodyMetadata||[];
  const diagnosticProps={current:freshness?.status==='current',visibleBodyIds:diagnosticBodies.filter(body=>body.visible!==false).map(body=>body.bodyId),bodyNames:Object.fromEntries(diagnosticBodies.map(body=>[body.bodyId,body.name])),selection:qualitySelection,onLocate:onLocateQuality};
  const requestedVisible = result?.meshJob.requestedVisible ?? result?.meshJob.visible ?? false;
  const catalogReady=tasks.catalog.state==='ready'&&tasks.historyKnown;
  const historyRef=useRef<HTMLDetailsElement>(null),recoveryFocus=useRef(false);
  useEffect(()=>{recoveryFocus.current=false;},[documentId]);
  useEffect(()=>{
    if(!recoveryFocus.current||tasks.catalogRecoveryPending||tasks.loading)return;
    recoveryFocus.current=false;if(!catalogReady)return;
    if(document.activeElement===document.body&&historyRef.current){historyRef.current.open=true;historyRef.current.querySelector('summary')?.focus();}
  },[catalogReady,tasks.catalogRecoveryPending,tasks.loading]);
  const ownerRef = useRef<string|null>(documentId);
  useLayoutEffect(()=>{ownerRef.current=documentId;return()=>{ownerRef.current=null;};},[documentId]);
  const [error, setError] = useState("");
  const [deepCheck,setDeepCheck]=useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [legacyAction, setLegacyAction] = useState("repair");
  const [legacyInputPath, setLegacyInputPath] = useState("");
  const [fileResult, setFileResult] = useState<{ outputPath?: string; quality?: MeshJobPayload["mesh"]["quality"]; message: string } | null>(null);
  const readOptions=():MeshStrategyOptions=>{if(!qualityThreshold.trim())throw Error('请填写质量阈值。');const sizing=meshSizingFromDraft(currentSizingDraft,documentId,geometry);return normalizeMeshStrategyOptions({repairMode,qualityThreshold:Number(qualityThreshold),...(tasks.setupStrictQuality?{qualityPolicy:'strict'}:{}),...(sizing?{sizing}:{}),...(tasks.setupOptimization?{optimization:tasks.setupOptimization}:{})});};
  let strategyModified=false;try{strategyModified=Boolean(tasks.selectedStrategy&&!meshStrategyOptionsEqual(readOptions(),tasks.selectedStrategy.options));}catch{strategyModified=Boolean(tasks.selectedStrategy);}
  const strategyObsolete=Boolean(tasks.selectedStrategy&&!tasks.strategyState.library.strategies.some(row=>row.strategyId===tasks.selectedStrategy!.strategyId&&row.definitionHash===tasks.selectedStrategy!.definitionHash));
  const runFileTool = async () => {
    setBusy(true); setError(""); setFileResult(null);
    try {
      const response = await fetch(`${API_ROOT}/mesh/${legacyAction}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputPath: legacyInputPath.trim(), repairMode, qualityThreshold: Number(qualityThreshold), resolveIntersections: legacyAction === "intersections" }) });
      const payload = await response.json() as { ok: boolean; error?: string; outputPath?: string; quality?: MeshJobPayload["mesh"]["quality"] };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "文件级网格操作失败");
      setFileResult({ outputPath: payload.outputPath, quality: payload.quality, message: legacyAction === "repair" ? "几何修复完成" : legacyAction === "intersections" ? "交叉处理完成" : "质量分析完成" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "文件级工具失败"); } finally { setBusy(false); }
  };

  const createMesh = async (preparationJobId?:string,snapshotMode?:string) => {
    if (!qualityThreshold.trim() || !Number.isFinite(Number(qualityThreshold)) || Number(qualityThreshold)<0 || Number(qualityThreshold)>1) { setError("质量阈值必须为 0 到 1 之间的数值。"); return; }
    try{if(tasks.strategyState.pending)throw Error('方案修改结果尚未确认，请先只读核对原任务。');if(strategyObsolete)throw Error('所选方案已变化或删除，请载入新版本或切换为临时参数。');const options=readOptions();setError("");
    const selected=tasks.selectedStrategy,reference=selected&&!strategyModified&&!preparationJobId?{strategyId:selected.strategyId,revision:selected.revision,definitionHash:selected.definitionHash}:undefined;
    await tasks.create({baseRevision:revision,...(reference?{strategyRef:reference}:{...options,...(snapshotMode?{repairMode:snapshotMode}:{})}),...(preparationJobId?{preparationJobId}:{})});
    }catch(reason){setError(reason instanceof Error?reason.message:'网格尺寸设置无效。');}
  };

  const setVisible = async (visible: boolean) => {
    if (!result) return;
    const owner = documentId;
    setBusy(true);
    setError("");
    if (!visible) {
      const hidden = {...result,meshJob:{...result.meshJob,visible:false,requestedVisible:false}};
      setResult(hidden); onMeshResult?.(hidden);
    }
    try {
      const response = await fetch(API_ROOT + "/mesh/jobs/" + encodeURIComponent(result.meshJob.jobId) + "/visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible }),
      });
      const payload = await response.json() as { ok?: boolean; meshJob?: MeshJobPayload["meshJob"]; error?: string };
      if (!response.ok || !payload.ok || !payload.meshJob) throw new Error(payload.error || "网格显示状态更新失败");
      if (ownerRef.current !== owner) return;
      const next = { ...result, meshJob: payload.meshJob };
      setResult(next);
      onMeshResult?.(next);
    } catch (reason) {
      if (ownerRef.current === owner) setError(reason instanceof Error ? reason.message : "网格显示状态更新失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-section mesh-workbench" data-testid="mesh-workbench-panel">
      <div className="section-heading compact">
        <div>
          <span className="eyebrow">MESH WORKBENCH</span>
          <h2>网格剖分</h2>
          <small>所有几何统一共形剖分，结果默认隐藏，按 Body 控制显示。</small>
        </div>
        <span className="feature-badge amber">Gmsh</span>
      </div>

      <div className="mesh-selection-note">
        <span>当前版本</span><strong>R{revision ?? "—"}</strong>
        <span>任务范围</span><strong>全部几何 · 共形</strong>
        {(selectedBodyId || selectedFaceId) && <span>当前选择 {selectedFaceId || selectedBodyId}（不限制剖分范围）</span>}
      </div>
      <MeshCatalogNotice catalog={tasks.catalog} pending={tasks.catalogRecoveryPending} loading={tasks.loading} uncertain={tasks.catalogUncertain} error={tasks.error} onRecover={()=>{recoveryFocus.current=Boolean(document.activeElement?.closest('[data-testid="mesh-catalog-notice"]'));void tasks.recoverCatalog();}}/>

      <fieldset className="mesh-route-choice"><legend>剖分路线</legend><label><input type="radio" name="mesh-route" checked={tasks.setupRoute==='cad'} onChange={()=>tasks.setSetupRoute('cad')}/>CAD 网格</label><label><input type="radio" name="mesh-route" checked={tasks.setupRoute==='discrete'} onChange={()=>tasks.setSetupRoute('discrete')}/>交叉修复四面体</label></fieldset>
      {tasks.setupRoute==='discrete'?<MeshTetraPanel tasks={tasks} revision={revision} disabled={busy}/>:<>
      <MeshStrategyControls client={tasks.strategies} state={tasks.strategyState} selected={tasks.selectedStrategy} name={tasks.strategyName} modified={strategyModified} disabled={busy||tasks.busy||Boolean(tasks.active)} readOptions={readOptions} onName={tasks.setStrategyName} onLoad={row=>tasks.loadStrategy(row,geometry)} onTemporary={()=>tasks.setSelectedStrategy(null)} onSaved={tasks.setSelectedStrategy}/>
      <label className="single-field"><span>脏几何处理</span>
        <select value={repairMode} onChange={(event) => setRepairMode(event.target.value)}>
          <option value="conservative">保守修复</option>
          <option value="aggressive">强力修复</option>
          <option value="strict">仅检查</option>
        </select>
      </label>
      <label className="single-field"><span>质量阈值</span>
        <input type="number" min="0" max="1" step="0.05" value={qualityThreshold} onChange={(event) => setQualityThreshold(event.target.value)} />
      </label>
      <label className="check-field"><input type="checkbox" checked={tasks.setupStrictQuality} disabled={busy||tasks.busy||Boolean(tasks.active)} onChange={event=>tasks.setSetupStrictQuality(event.target.checked)} aria-describedby="mesh-quality-policy-note"/>低于阈值时阻止验收</label>
      <p id="mesh-quality-policy-note" className="mesh-quality-note">{tasks.setupStrictQuality?'严格验收：低质量结果仅供诊断，不能正常显示或下载。':'警告模式：低质量结果仍可使用，需自行复核。反转、退化等错误始终阻止使用。'}</p>
      <MeshSizingControls key={documentId} draft={currentSizingDraft} geometry={geometry} bodyId={selectedBodyId} faceId={selectedFaceId} disabled={busy||tasks.busy||Boolean(tasks.active)||tasks.strategyState.busy} onChange={tasks.setSizingDraft}/>
      <label className="check-field"><input type="checkbox" checked={Boolean(tasks.setupOptimization)} disabled={busy||tasks.busy||Boolean(tasks.active)} onChange={event=>tasks.setSetupOptimization(event.target.checked?{version:1,method:'netgen',iterations:5}:undefined)} aria-describedby="mesh-optimization-note"/>生成后执行 Netgen 优化（{tasks.setupOptimization?.iterations??5} 轮）</label>
      <p id="mesh-optimization-note" className="mesh-quality-note">可增加计算量，不保证更优。结果展示实际前后质量，仍按本次规则验收；不自动重剖或放宽阈值。</p>

      <button className="secondary-action" disabled={!catalogReady||busy || tasks.busy || Boolean(tasks.active)||tasks.strategyState.busy||Boolean(tasks.strategyState.pending)} onClick={() => void createMesh()}>
        {tasks.active ? "剖分任务进行中" : tasks.busy || busy ? "处理中…" : tasks.selectedStrategy&&!strategyModified&&!strategyObsolete?'按工程方案剖分（结果默认隐藏）':tasks.selectedStrategy&&strategyModified?'按临时修改剖分（结果默认隐藏）':"开始剖分（结果默认隐藏）"}
      </button>
      <label className="check-field"><input type="checkbox" checked={deepCheck} onChange={event=>setDeepCheck(event.target.checked)}/>深入自交检查（预览时较慢）</label>
      <button type="button" className="secondary-action" disabled={!catalogReady||busy||tasks.busy||Boolean(tasks.active)} onClick={()=>void tasks.create({kind:"preparation",baseRevision:revision,repairMode,qualityThreshold:.2,deepCheck})}>诊断并预览修复</button>
      </>}
      {(error || (!tasks.catalogUncertain&&['ready','unknown'].includes(tasks.catalog.state)&&tasks.error)) && <p className="property-error" role="alert" data-testid="mesh-current-error">{error || tasks.error}</p>}
      <MeshSurfacePanel key={`${documentId}:${tasks.selectedSurfaceId||'none'}`} tasks={tasks} documentId={documentId} revision={revision} geometry={geometry} busy={busy} onLocate={onLocateCadFace}/>

      {tasks.active && <div className="mesh-task-progress" role="status" aria-label="网格任务状态">
        <div><strong>{tasks.active.optimizationAttempt?'检查点优化 · ':tasks.active.kind==='surface-reconstruction'?'表面重构 · ':tasks.active.kind==='preparation'?'诊断与预览 · ':tasks.active.kind==='discrete-tetra'?'交叉修复 · ':''}{tasks.active.derivation?.state==='working'?'准备显示与导出':tasks.active.optimizationAttempt&&tasks.active.state==='preparing'?'准备检查点':tasks.active.state==='running'&&tasks.active.discreteStage==='optimizing'?'优化中':tasks.active.kind==='surface-reconstruction'&&tasks.active.state==='running'?'重构中':meshJobStateLabel[tasks.active.state]}</strong><span>来源 R{tasks.active.revision ?? "—"} · {tasks.active.jobId.slice(-8)}</span></div>
        {tasks.active.optimizationAttempt&&<p>正在从原检查点继续优化，不重新剖分。原任务保留；本次尝试可独立取消，成功后需手动准备显示与导出。</p>}
        {(!tasks.active.optimizationAttempt||tasks.active.state==='cancelling')&&<p>{tasks.active.state === "preparing" ? "正在导出几何快照；取消会在导出结束后生效，不会中断几何内核。" : tasks.active.state === "cancelling" ? "正在确认工作进程退出，确认后才会标记为已取消。" : tasks.active.kind==='surface-reconstruction' ? tasks.active.state==='queued'?"等待独立表面重构进程，工程仍可继续建模。":"后台正在拆分表面交叉；可关闭窗口，完成后查看独立报告，不产生体网格。" : tasks.active.state === "queued" ? "正在等待独立剖分进程，工程仍可继续建模。" : "后台正在联合剖分，可关闭此窗口；完成后结果默认隐藏。"}</p>}
        <button type="button" className="secondary-action" disabled={tasks.cancelling || tasks.active.state === "cancelling"} onClick={() => void tasks.cancel(tasks.active!.jobId)}>{tasks.active.derivation?.state==='working'?'取消结果准备':tasks.active.optimizationAttempt?'取消优化':tasks.active.kind==='surface-reconstruction'?'取消表面重构':'取消剖分'}</button>
      </div>}
      <details className="mesh-task-history" ref={historyRef}>
        <summary>任务记录 · {catalogReady?tasks.jobs.length:tasks.catalog.state==='recovering'?'读取中':tasks.catalog.state==='unavailable'?'暂不可读':'未读取'}{catalogReady&&tasks.loading ? " · 载入中" : ""}</summary>
        {tasks.catalogRecovered&&catalogReady&&<p className="mesh-catalog-success" role="status">网格历史已重新读取，当前工程 {tasks.jobs.length} 条记录；未重新剖分。</p>}
        <div className="mesh-history-filter">
          {tasks.jobs.length > 0 && <><label htmlFor={historyFilterId}>任务状态</label><select id={historyFilterId} value={historyFilter} onChange={event => setHistoryFilter(event.target.value)}>
            <option value="all">全部</option>
            {Object.entries(meshJobStateLabel).map(([state,label]) => <option key={state} value={state}>{label}</option>)}
          </select></>}
          {['ready','unknown'].includes(tasks.catalog.state)&&<button type="button" className="mesh-refresh-tasks" disabled={tasks.loading || tasks.busy} onClick={() => void tasks.refresh()}>刷新任务记录</button>}
        </div>
        {!tasks.jobs.length && !tasks.loading && catalogReady&&<p>当前工程还没有剖分任务。</p>}
        {!catalogReady&&tasks.jobs.length>0&&<p>以下为上次读取记录，当前尚未重新核对。</p>}
        {tasks.jobs.length > 0 && visibleJobs.length === 0 && <p role="status">没有符合当前状态的网格任务。</p>}
        <ul>{visibleJobs.map(job => <li key={job.jobId} data-state={job.state} data-job-id={job.jobId} data-has-recovery={Boolean(job.completionRecovery||tasks.completionActions[job.jobId])||undefined} data-has-optimization={Boolean(job.optimizationAttempt)||undefined}>
          <div>
            <strong>{job.optimizationAttempt?'检查点优化 · ':job.kind==='surface-reconstruction'?'表面重构 · ':job.kind==='preparation'?'诊断预览 · ':job.kind==='discrete-tetra'?'交叉修复四面体 · ':''}{job.optimizationAttempt&&job.state==='running'?'优化中':job.optimizationAttempt&&job.state==='preparing'?'准备检查点':job.kind==='surface-reconstruction'&&job.state==='running'?'重构中':meshJobStateLabel[job.state]} · 来源 R{job.revision ?? "—"}</strong>
            {job.kind==='surface-reconstruction'?<small>仅表面 · 非体网格{job.surfaceSummary?` · ${job.surfaceSummary.inputTriangles} → ${job.surfaceSummary.outputTriangles} 三角面`:''}</small>:job.kind==='discrete-tetra'?<small>{job.state==='complete'&&job.derivation?tetraDerivationLabel[job.derivation.state]:job.optimizationRecovery?'检查点已保留 · 未发布可用网格':job.optimizationAttempt?'仅优化，不重新剖分':'未发布可用网格'}{job.discreteTetraSummary?` · ${job.discreteTetraSummary.tetraCount} 个四面体`:''}</small>:job.state==='complete'&&job.kind!=='preparation'&&<small>{meshAdmissionLabel(job.admission)}</small>}
            <small>{job.createdAt ? new Date(job.createdAt).toLocaleString("zh-CN",{hour12:false}) : "时间未知"} · {job.jobId.slice(-8)}</small>
            {job.kind!=='surface-reconstruction'&&job.kind!=='discrete-tetra'&&job.options&&<small>{{conservative:"保守修复",aggressive:"强力修复",strict:"仅检查"}[job.options.repairMode||'']||job.options.repairMode}{job.kind==='preparation'?` · ${job.options.deepCheck?'深入检查':'基础检查'}`:` · 质量阈值 ${job.options.qualityThreshold}`}</small>}
            {job.error&&<p>{job.error}</p>}
          </div>
          <MeshOptimizationRelation job={job}/>
          <MeshCompletionRecovery job={job} action={tasks.completionActions[job.jobId]} disabled={tasks.busy||busy||(!catalogReady&&tasks.completionActions[job.jobId]?.state!=='uncertain')} onRecover={()=>void tasks.recoverCompletion(job.jobId)} onCheck={()=>void tasks.checkCompletionRecovery(job.jobId)}/>
          {job.kind==='discrete-tetra'?<button type="button" className="mesh-load-result" disabled={!catalogReady||tasks.busy||busy||tasks.selectedTetraId===job.jobId&&tasks.setupRoute==='discrete'} onClick={()=>void tasks.select(job.jobId)}>{tasks.selectedTetraId===job.jobId&&tasks.setupRoute==='discrete'?'当前交叉修复任务':'查看交叉修复任务'}</button>:job.kind==='surface-reconstruction'&&job.state==='complete'?<button type="button" className="mesh-load-result" disabled={!catalogReady||tasks.busy||busy||tasks.selectedSurfaceId===job.jobId} onClick={()=>void tasks.select(job.jobId)}>{tasks.selectedSurfaceId===job.jobId?'当前表面报告':'查看表面报告'}</button>:(job.kind==='preparation'||job.state==='failed')&&job.preparationSummary?.reportAvailable?<button type="button" className="mesh-load-result" disabled={!catalogReady||tasks.busy||busy||tasks.selectedInspectionId===job.jobId} onClick={()=>void tasks.select(job.jobId)}>{tasks.selectedInspectionId===job.jobId?'当前诊断':'查看诊断'}</button>:job.state === "complete" && <button type="button" className="mesh-load-result" disabled={!catalogReady||tasks.busy || busy || result?.meshJob.jobId === job.jobId} onClick={() => void tasks.select(job.jobId)}>{result?.meshJob.jobId === job.jobId ? "当前结果" : "查看结果"}</button>}
          {job.options?.sizing&&<button type="button" className="mesh-load-result mesh-sizing-reuse" disabled={!catalogReady||tasks.busy||busy||Boolean(tasks.active)} onClick={()=>{try{tasks.setSizingDraft(meshSizingDraftFromTask(documentId,job.options!.sizing!,geometry));setError('');}catch(reason){setError(reason instanceof Error?reason.message:'历史尺寸设置不可用。');}}}>复用尺寸设置</button>}
        </li>)}</ul>
      </details>
      {tasks.inspection&&<MeshPreparationPanel key={tasks.inspection.meshJob.jobId} result={tasks.inspection} geometry={geometry} documentId={documentId} previewJobId={preparationPreviewId} onPreview={onPreparationPreview} onLocate={onLocateDiagnostic} busy={busy||tasks.busy||Boolean(tasks.active)} onMesh={()=>void createMesh(tasks.inspection!.meshJob.jobId,tasks.inspection!.meshJob.options?.repairMode)}/>}

      {result && (
        <div className="mesh-job-card" data-job-id={result.meshJob.jobId}>
          <div className="mesh-job-title"><strong>{scopeLabel(result.meshJob.selection.kind)}</strong><span>来源 R{result.meshJob.revision ?? "—"} · 当前 R{revision ?? "—"}</span></div>
          <p className="mesh-quality-note" data-testid="mesh-executed-quality-policy">本次验收：{result.meshJob.kind==='discrete-tetra'||result.mesh.acceptance?.qualityPolicy==='strict'?'严格验收':'低质量仅警告'} · minSICN 阈值 {result.mesh.acceptance?.qualityThreshold??result.mesh.quality?.threshold??'未知'}。修改参数只影响下一次任务。</p>
          {result.mesh.optimization&&<div className="mesh-optimization-result" data-testid="mesh-optimization-result"><strong>Netgen 后优化 · {result.mesh.optimization.iterations} 轮</strong><dl><div><dt>最小质量</dt><dd>{result.mesh.optimization.before.minQuality.toFixed(4)} → {result.mesh.optimization.after.minQuality.toFixed(4)}</dd></div><div><dt>阈值以下等问题</dt><dd>{result.mesh.optimization.before.badCount} → {result.mesh.optimization.after.badCount}</dd></div><div><dt>四面体数</dt><dd>{result.mesh.optimization.before.tetraCount} → {result.mesh.optimization.after.tetraCount}</dd></div></dl><p>优化报告不代替验收；前后单元编号与数量可能变化。</p></div>}
          {result.meshJob.options?.strategySnapshot&&<p className="mesh-sizing-result">执行方案 {result.meshJob.options.strategySnapshot.name} · V{result.meshJob.options.strategySnapshot.revision}（任务保留原定义）</p>}
          {result.meshJob.options?.sizing&&<p className="mesh-sizing-result">目标尺寸 {result.meshJob.options.sizing.globalSize} mm · {result.meshJob.options.sizing.rules.length} 条局部规则{result.mesh.sizing?' · 来源映射已核对':''}</p>}
          <div className={`mesh-validity ${freshness?.status}`} role="status" aria-label="网格有效性" data-status={freshness?.status}>
            <strong>{freshness?.status === "current" ? "来源有效" : freshness?.status === "stale" ? "已过期" : "无法验证"}</strong>
            <span>{freshness?.reason}</span>
          </div>
          <div className="mesh-job-stats">
            <span>节点 <b>{result.mesh.nodeCount}</b></span>
            <span>单元 <b>{result.mesh.elementCount}</b></span>
            <span>质量 <b>{result.mesh.quality?.minQuality?.toFixed(3) ?? "—"}</b></span>
          </div>
          <MeshAdmissionPanel report={result.mesh.admission}>
            <MeshTopologySamples result={result} {...diagnosticProps}/>
            <MeshSpatialSamples result={result} {...diagnosticProps}/>
          </MeshAdmissionPanel>
          <div className="mesh-job-actions">
            <button type="button" className="secondary-action" disabled={busy || tasks.busy || ((!meshAdmitted(result.mesh.admission)||freshness?.status !== "current") && !requestedVisible)} onClick={() => void setVisible(!requestedVisible)}>
              {requestedVisible ? "隐藏网格" : "显示网格"}
            </button>
            {result.mesh.outputPath && <a className="mesh-download" href={API_ROOT + "/mesh/outputs/" + encodeURIComponent(result.mesh.outputPath.split(/[\\/]/).pop() || "")+(meshAdmitted(result.mesh.admission)?'':'?diagnostic=1')}>{meshAdmitted(result.mesh.admission)?'下载 .msh':'下载诊断 .msh'}</a>}
            {result.meshJob.kind==='discrete-tetra'&&result.downloadUrl===`/api/mesh/outputs/${result.meshJob.jobId}.msh`&&meshAdmitted(result.mesh.admission)&&freshness?.status==='current'&&<a className="mesh-download" href={API_ROOT+`/mesh/outputs/${encodeURIComponent(result.meshJob.jobId)}.msh`}>下载 .msh</a>}
          </div>
          {!meshAdmitted(result.mesh.admission)&&<p className="mesh-quality-warning">结果仅供诊断，不作为已验收网格显示。可查看验收详情和质量报告，修正问题后重新剖分。</p>}
          {(!requestedVisible || freshness?.status !== "current") && <small className="mesh-muted">{freshness?.status === "current" ? "网格已生成但当前不渲染" : "旧结果保留用于检查，不在当前几何上渲染；下载文件仍对应来源版本。"}</small>}
          <MeshQualityPanel key={result.meshJob.jobId} result={result} current={freshness?.status==="current"} bodyNames={Object.fromEntries(((geometry as {bodyMetadata?:{bodyId:string;name:string}[]})?.bodyMetadata||[]).map(body=>[body.bodyId,body.name]))} visibleBodyIds={((geometry as {bodyMetadata?:{bodyId:string;visible?:boolean}[]})?.bodyMetadata||[]).filter(body=>body.visible!==false).map(body=>body.bodyId)} selection={qualitySelection} onLocate={onLocateQuality}/>
          <MeshBoundaryPanel key={`boundary-${result.meshJob.jobId}`} result={result} current={freshness?.status==="current"} bodyNames={Object.fromEntries(((geometry as {bodyMetadata?:{bodyId:string;name:string}[]})?.bodyMetadata||[]).map(body=>[body.bodyId,body.name]))} visibleBodyIds={((geometry as {bodyMetadata?:{bodyId:string;visible?:boolean}[]})?.bodyMetadata||[]).filter(body=>body.visible!==false).map(body=>body.bodyId)} selectedBodyId={selectedBodyId} selectedFaceId={selectedFaceId} onLocate={onLocateCadFace}/>
        </div>
      )}

      <button type="button" className="mesh-advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>
        {showAdvanced ? "收起文件级工具" : "展开文件级工具"}
      </button>
      {showAdvanced && (
        <div className="mesh-advanced">
          <label className="single-field"><span>操作</span><select value={legacyAction} onChange={(event) => setLegacyAction(event.target.value)}><option value="repair">几何修复</option><option value="intersections">交叉处理</option><option value="quality">质量分析</option></select></label>
          <label className="single-field"><span>输入文件</span><input value={legacyInputPath} onChange={(event) => setLegacyInputPath(event.target.value)} placeholder="服务器可访问的 STEP/STL/MSH 路径" /></label>
          <p className="panel-copy">文件级工具处理独立文件，不会替换或修改当前工程几何。</p>
          <button type="button" className="secondary-action" disabled={!legacyInputPath.trim() || busy} onClick={() => void runFileTool()}>{busy ? "处理中…" : "运行文件级工具"}</button>
          {fileResult && <div className="mesh-file-result" role="status"><strong>{fileResult.message}</strong>{fileResult.outputPath && <p>{fileResult.outputPath}</p>}{fileResult.quality && <p>最小质量 {fileResult.quality.minQuality?.toFixed(3)} · 低质量单元 {fileResult.quality.badCount} · 反转单元 {fileResult.quality.invertedCount}</p>}</div>}
        </div>
      )}
    </section>
  );
}
