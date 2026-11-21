"use client";
import {useEffect,useState} from "react";
import {assessMeshSource} from "../shared/mesh-source.mjs";
import type {MeshDiagnosticIssue,MeshDiagnosticStage,MeshDiagnosticTarget,MeshPreparationResult} from "./model/mesh";

const issueNames:Record<string,string>={SMALL_EDGE:"小边（可能为设计特征）",SMALL_FACE:"小面（可能为设计特征）",SLIVER_FACE:"狭长面",OPEN_BOUNDARY:"开放边界",NON_MANIFOLD_EDGE:"非流形连接",HIGH_TOLERANCE:"容差偏大",NON_POSITIVE_VOLUME:"实体方向或体积异常",SELF_INTERSECTION:"自交／内部交叉",SELF_INTERSECTION_CHECK_FAILED:"自交检查未完成",EDGE_MEASUREMENT_FAILED:"边测量失败",FACE_MEASUREMENT_FAILED:"面测量失败"};
const preparationErrors:Record<string,string>={
  MESH_NO_CLOSED_VOLUME:"当前工程没有闭合实体，无法生成四面体网格；基础面可与实体一起作为边界或嵌入约束。",
  MESH_REPAIR_DIAGNOSTIC_FAILED:"修复后仍存在阻断性几何问题，请查看前后对照和诊断明细。",
  MESH_REPAIR_FAILED:"几何修复后仍无效，未发布可用快照。",
  MESH_PARTITION_FAILED:"联合分块失败，请检查交叉或退化几何。",
  MESH_PARTITION_DIAGNOSTIC_FAILED:"联合分块后仍有阻断性几何问题，未发布可用快照。",
  MESH_UNSUPPORTED_FREE_TOPOLOGY:"工程含独立线框、点或复合体内的游离边/点；当前四面体流程尚不支持这些约束，已停止准备，没有静默遗漏几何。",
};
const format=(value:number|null|undefined)=>typeof value==="number"&&Number.isFinite(value)?Number(value.toPrecision(5)).toString():"—";
const metric=(stage:MeshDiagnosticStage|undefined,key:keyof MeshDiagnosticStage)=>stage?String(stage[key]??"—"):"—";

export function MeshPreparationPanel({result,geometry,documentId,previewJobId,onPreview,onLocate,onMesh,busy}:{result:MeshPreparationResult;geometry:unknown;documentId:string;previewJobId:string|null;onPreview:(value:MeshPreparationResult|null)=>void;onLocate:(value:MeshDiagnosticTarget)=>void;onMesh:()=>void;busy:boolean}) {
  const [bodyId,setBodyId]=useState(""),[details,setDetails]=useState(false),[expanded,setExpanded]=useState(result.meshJob.kind==="preparation"),[page,setPage]=useState(0);
  const report=result.preparation.diagnostics,current=assessMeshSource(result.meshJob.source,geometry,documentId).status==="current";
  const bodies=report.bodies.filter(body=>!bodyId||body.bodyId===bodyId),showing=previewJobId===result.meshJob.jobId;
  const uncheckedBodies=Math.max(0,(result.meshJob.source?.bodies.length??report.bodies.length)-report.bodies.length);
  const visibleBodies=new Set(((geometry as {bodyMetadata?:{bodyId:string;visible?:boolean}[]})?.bodyMetadata||[]).filter(body=>body.visible!==false).map(body=>body.bodyId));
  useEffect(()=>()=>onPreview(null),[onPreview]);
  const canReuse=current&&result.meshJob.kind==="preparation"&&result.meshJob.state==="complete"&&report.status==="ready";
  const issueItem=(issue:MeshDiagnosticIssue,index:number)=><li key={`${issue.code}-${issue.index}-${index}`} data-severity={issue.severity}>
    <div><strong>{issueNames[issue.code]||issue.code.replace('BREP_','OCCT · ')}</strong><small>{issue.kind} #{issue.index}{issue.value!==undefined?` · ${format(issue.value)}`:''}</small></div>
    {issue.target&&<button type="button" disabled={!current||!visibleBodies.has(issue.target.bodyId)} title={!current?"来源已变化，不能定位":!visibleBodies.has(issue.target.bodyId)?"请先在几何树显示此 Body":"定位工程中的原始几何"} onClick={()=>{onPreview(null);onLocate(issue.target!);}}>定位原几何</button>}
  </li>;
  return <details className="mesh-preparation-panel" aria-label="几何诊断与修复预览" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary>几何诊断与修复预览 · {report.bodies.length} 个 Body · {report.status==='ready'?'快照可用':'需处理'}</summary>
    <div className="mesh-quality-content">
    <div className="mesh-preparation-heading"><strong>{report.status==="ready"?"几何快照已准备":"几何准备被阻止"}</strong><small>来源 R{result.meshJob.revision??"—"} · {result.meshJob.jobId.slice(-8)}</small></div>
    <p className="mesh-quality-note">修复和分块只发生在独立快照，不修改工程。小特征警告不是删除建议；开放 Sheet 边界也不等于错误。</p>
    <p className="mesh-quality-note">深入自交检查用于输入与修复后 Body；联合分块结果另做拓扑校验。未执行或未完成的检查不会标作通过。</p>
    {result.meshJob.state==="failed"&&<p className="mesh-quality-warning" role="status">任务失败：{preparationErrors[report.errorCode||result.meshJob.errorCode||'']||result.meshJob.error||report.error}</p>}
    {uncheckedBodies>0&&<p className="mesh-quality-warning">准备过程已中止，另有 {uncheckedBodies} 个 Body 尚未检查，不能将它们视为通过。</p>}
    {!current&&<p className="mesh-quality-warning" role="status">来源已变化或无法验证。可查看历史报告，不能预览、定位或复用。</p>}
    <div className="mesh-preparation-settings"><span>{{strict:"仅检查（仍共形分块）",conservative:"保守修复",aggressive:"强力修复"}[report.repairMode]||report.repairMode}</span><span>容差 {format(report.tolerance)} mm</span><span>{report.deepCheck?"包含深入自交检查":"未执行深入自交检查"}</span></div>
    <div className="mesh-job-actions">
      {result.preparation.preview&&<button type="button" disabled={!current} onClick={()=>onPreview(showing?null:result)}>{showing?"退出修复预览":"预览修复快照（只读）"}</button>}
      {result.meshJob.kind==="preparation"&&<button type="button" disabled={!canReuse||busy} onClick={onMesh}>使用此快照剖分</button>}
    </div>
    {result.preparation.preview?.stats.truncated&&<p className="mesh-quality-warning">预览显示数据已截断；剖分仍使用完整 BREP，不能用预览判断全部细节。</p>}
    <div className="mesh-quality-filters"><label><span>诊断 Body</span><select aria-label="诊断 Body" value={bodyId} onChange={event=>{setBodyId(event.target.value);setPage(0);}}><option value="">全部 Body</option>{report.bodies.map(body=><option key={body.bodyId} value={body.bodyId}>{body.name||body.bodyId}</option>)}</select></label><button type="button" aria-expanded={details} onClick={()=>setDetails(value=>!value)}>{details?"收起诊断明细":"展开诊断明细"}</button></div>
    {bodies.slice(page*5,page*5+5).map(body=><div key={body.bodyId} className="mesh-preparation-body"><strong>{body.name||body.bodyId}</strong><table aria-label={`${body.name||body.bodyId} 修复前后对照`}><thead><tr><th>检查项</th><th>原始几何</th><th>修复快照</th></tr></thead><tbody>
      {([['拓扑有效','valid'],['实体 / 面','solidCount'],['错误','errorCount'],['警告','warningCount'],['小边','smallEdgeCount'],['狭长面','sliverFaceCount'],['开放边','openBoundaryEdgeCount']] as const).map(([label,key])=><tr key={key}><th>{label}</th><td>{key==='valid'?(body.before.valid?'是':'否'):key==='solidCount'?`${body.before.solidCount} / ${body.before.faceCount}`:metric(body.before,key)}</td><td>{key==='valid'?(body.afterRepair?body.afterRepair.valid?'是':'否':'未完成'):key==='solidCount'&&body.afterRepair?`${body.afterRepair.solidCount} / ${body.afterRepair.faceCount}`:metric(body.afterRepair,key)}</td></tr>)}
      <tr><th>最大容差 / mm</th><td>{format(body.before.maxTolerance)}</td><td>{format(body.afterRepair?.maxTolerance)}</td></tr><tr><th>有符号体积 / mm³</th><td>{format(body.before.signedVolumeSum)}</td><td>{format(body.afterRepair?.signedVolumeSum)}</td></tr>
    </tbody></table>
    {details&&<>{([['原始问题',body.before],['修复后问题',body.afterRepair]] as const).map(([label,stage])=>stage&&<details key={label} open><summary>{label} · {stage.issueCount}</summary><p className="mesh-quality-note">小边阈值 {format(stage.smallFeatureThreshold)} mm；自交检查：{stage.selfIntersectionCheck==='complete'?'已执行':stage.selfIntersectionCheck==='failed'?'未完成':'未执行'}。</p>{!stage.issues.length&&<p className="mesh-quality-note">本次检查未发现问题；不代表任意工业几何均可剖分。</p>}<ul className="mesh-diagnostic-issues">{stage.issues.map(issueItem)}</ul>{stage.issuesTruncated&&<p className="mesh-quality-warning">仅显示前 {stage.issues.length} 项，汇总保留完整问题数。</p>}</details>)}</>}
    </div>)}
    {bodies.length>5&&<div className="mesh-quality-pagination"><button type="button" disabled={page===0} onClick={()=>setPage(value=>value-1)}>上一组 Body</button><span>{page*5+1}–{Math.min(page*5+5,bodies.length)} / {bodies.length}</span><button type="button" disabled={(page+1)*5>=bodies.length} onClick={()=>setPage(value=>value+1)}>下一组 Body</button></div>}
    {report.afterPartition&&<><p className="mesh-quality-note">联合分块后：{report.afterPartition.solidCount} 个实体、{report.afterPartition.faceCount} 个面；{report.afterPartition.errorCount} 个错误、{report.afterPartition.warningCount} 个警告。重叠区域合并计量，体积总和可能减少，不代表自动删除工程几何。</p>
      {details&&<details open><summary>联合分块检查 · {report.afterPartition.issueCount}</summary><p className="mesh-quality-note">此处属于修复快照拓扑，不直接映射为可编辑的工程选择。未额外执行深入自交检查。</p><ul className="mesh-diagnostic-issues">{report.afterPartition.issues.map(issueItem)}</ul>{report.afterPartition.issuesTruncated&&<p className="mesh-quality-warning">联合分块问题仅显示前 {report.afterPartition.issues.length} 项，汇总保留完整数量。</p>}</details>}
    </>}
    </div>
  </details>;
}
