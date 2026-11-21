"use client";

import { useEffect, useRef, useState } from "react";
import type { DirectModelResult } from "./DirectModelingPanel";
import { FeatureInputInspector } from "./FeatureInputInspector";
import {LoftHoleMapping} from './LoftHoleMapping';
import {loopMappingIssue,parseFaceBoundaries,type FaceBoundarySummary} from './modeling/loft-loops';
import { useEditorCommands } from "./modeling/CommandEditScope";
import { ModelingCommandError, useModelingController } from "./modeling/modeling-controller";
import { modelingController } from "./modeling/runtime";
import { changeRepairSource, coordinateSelectionEdit, featureInputRequest, featureSelectionEdit, sweepInputSlots, validateReferenceInput, type CoordinateSelectionEdit, type FeatureInputResponse, type FeatureRepairProposal, type FeatureSelectionEdit, type InputPresentation, type ReferenceRepairTarget } from "./modeling/feature-input";
import type { ModelingCommandInput } from "./modeling/command-contract";

export function failedSelectionFeature(reason: unknown): string | null {
  return reason instanceof ModelingCommandError && ["FEATURE_SELECTION_UNRESOLVED", "FEATURE_SELECTION_UNVERIFIED"].includes(reason.code || "")
    && typeof reason.details?.featureId === "string" ? reason.details.featureId : null;
}

export function failedSelectionTarget(reason: unknown):ReferenceRepairTarget|null {
  const feature=failedSelectionFeature(reason);
  if(feature)return {targetFeatureId:feature};
  if(reason instanceof ModelingCommandError && reason.code==="LOFT_SECTION_UNRESOLVED" && typeof reason.details?.featureId==="string" && typeof reason.details?.sectionId==="string")
    return {targetFeatureId:reason.details.featureId,targetSectionId:reason.details.sectionId};
  if(reason instanceof ModelingCommandError && reason.code==="SWEEP_INPUT_UNRESOLVED" && typeof reason.details?.featureId==="string" && typeof reason.details?.sweepInputId==="string")return {targetFeatureId:reason.details.featureId,targetSweepInputId:reason.details.sweepInputId};
  return reason instanceof ModelingCommandError && reason.code==="COORDINATE_REFERENCE_UNRESOLVED" && typeof reason.details?.coordinateSystemId==="string"
    ? {targetCoordinateId:reason.details.coordinateSystemId}:null;
}

type RepairResult = DirectModelResult & {bodyPresentations?: InputPresentation[]};
type Verified = {request: ModelingCommandInput; result: RepairResult};

export function FeatureReferenceRepair({ proposal, onCancel, onCommitted }: {
  proposal: FeatureRepairProposal;
  onCancel: () => void;
  onCommitted: (result: DirectModelResult) => void;
}) {
  const {execute, session} = useEditorCommands();
  const current = useModelingController(modelingController);
  const [context, setContext] = useState(proposal);
  const [input, setInput] = useState<FeatureInputResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [holeSeeds,setHoleSeeds]=useState<string[]>([]),[highlightedLoop,setHighlightedLoop]=useState(''),[loopEdges,setLoopEdges]=useState<string[]>([]);
  const [verified, setVerified] = useState<Verified | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [reading, setReading] = useState(true);
  const busy = working || reading;
  const [reload, setReload] = useState(0);
  const [owner] = useState(() => ({documentId:proposal.documentId || session?.getBaseline().documentId || current.documentId,stateToken:proposal.stateToken || session?.getBaseline().stateToken || current.stateToken}));
  const mounted = useRef(true);
  const panelRef=useRef<HTMLElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(()=>{if((context.targetSectionId || context.targetSweepInputId) && (input || verified)){
    const canvas=panelRef.current?.querySelector<HTMLElement>('[data-testid="feature-input-canvas"]');
    canvas?.scrollIntoView({block:"center"});if(!verified)canvas?.focus({preventScroll:true});
  }},[context.targetSectionId,context.targetSweepInputId,input,verified]);
  const stale = owner.documentId !== current.documentId || owner.stateToken !== current.stateToken || Boolean(session?.isStale());
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(()=>{
      const live=modelingController.getSnapshot();
      if(live.documentId!==owner.documentId || live.stateToken!==owner.stateToken)throw new Error("本次修复所属工程状态已变化，请重新载入；不会在其他工程中重放旧修改。");
      return execute<FeatureInputResponse>(featureInputRequest(context));
    })
      .then(response => {
        if (cancelled) return;
        validateReferenceInput(response, owner.documentId, context);
        if (response.stateToken !== owner.stateToken) throw new Error("历史输入所属工程已变化，请重新载入编辑窗口。");
        setInput(response); setSelectedIndex(response.inputPreview.resolvedIndex);
        setHoleSeeds((response.inputPreview.selectedHoleIndexes||[]).map(index=>index?`edge-0-${index}`:''));setHighlightedLoop('');setLoopEdges([]);
      }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取历史输入。"); })
      .finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; };
  }, [context, execute, reload, owner]);

  const prepareRead = () => {setReading(true);setInput(null);setVerified(null);setSelectedIndex(0);setHoleSeeds([]);setLoopEdges([]);setHighlightedLoop('');setError(null);};

  const validate = async () => {
    if (!input || stale || busy || !selectedIndex) return;
    setWorking(true); setError(null);
    try {
      let parameters={...context.request.parameters};
      if(context.targetCoordinateId){
        const edit=coordinateSelectionEdit(input,selectedIndex);
        const previous=Array.isArray(parameters.coordinateSelectionEdits)?parameters.coordinateSelectionEdits as CoordinateSelectionEdit[]:[];
        parameters={...parameters,coordinateSelectionEdits:[...previous.filter(item=>item.coordinateSystemId!==edit.coordinateSystemId),edit]};
      }else{
        if(context.targetSectionId&&input.inputPreview.faceBoundaries&&loopIssue)throw Error(loopIssue);
        const edit=featureSelectionEdit(input,selectedIndex,context.targetSectionId&&input.inputPreview.faceBoundaries?holeSeeds.map(seed=>Number(seed.slice(seed.lastIndexOf('-')+1))):undefined);
        const previous=Array.isArray(parameters.selectionEdits)?parameters.selectionEdits as FeatureSelectionEdit[]:[];
        parameters={...parameters,selectionEdits:[...previous.filter(item=>item.featureId!==edit.featureId || item.sectionId!==edit.sectionId || item.sweepInputId!==edit.sweepInputId),edit]};
      }
      const request = {...context.request, parameters};
      try {
        const result = await execute<RepairResult>({...request, options: {...request.options, preview: true}});
        if (mounted.current) setVerified({request, result});
      } catch (reason) {
        const next = failedSelectionTarget(reason);
        if (next && (next.targetFeatureId !== context.targetFeatureId || next.targetCoordinateId !== context.targetCoordinateId || next.targetSectionId !== context.targetSectionId || next.targetSweepInputId !== context.targetSweepInputId)) {
          // Carry accepted explicit choices forward, but do not commit any of them.
          if (mounted.current) {prepareRead();setContext({request, ...next});}
        } else throw reason;
      }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "重算验证失败，未修改工程。"); }
    finally { if (mounted.current) setWorking(false); }
  };
  const commit = async () => {
    if (!verified || stale || busy) return;
    setWorking(true); setError(null);
    try { const result = await execute<DirectModelResult>(verified.request); if (mounted.current) onCommitted(result); }
    catch (reason) { if (mounted.current) { setVerified(null); setError(reason instanceof Error ? reason.message : "提交失败，未接受部分修复。"); } }
    finally { if (mounted.current) setWorking(false); }
  };
  const preview = input?.inputPreview;
  let boundaries:FaceBoundarySummary|null=null,boundaryError='';
  if(context.targetSectionId&&preview?.faceBoundaries&&selectedIndex){
    try{const selected=`face-0-${selectedIndex}`,raw=preview.faceBoundaries.faces.find(value=>(value as {faceId?:string})?.faceId===selected);boundaries=parseFaceBoundaries(raw,selected,preview.presentation);}catch(reason){boundaryError=reason instanceof Error?reason.message:'历史边界未完整读取。';}
  }
  const loopIssue=context.targetSectionId&&preview?.faceBoundaries?boundaryError||loopMappingIssue(boundaries,holeSeeds,preview.requiredHoleCount??0):null;
  const parameterEntries=Object.entries(context.request.parameters || {}).filter(([key])=>!["selectionEdits","coordinateSelectionEdits"].includes(key));
  const savedParameters=verified?.request.parameters || context.request.parameters;
  const savedSelections=[...(Array.isArray(savedParameters?.selectionEdits)?savedParameters.selectionEdits:[]),...(Array.isArray(savedParameters?.coordinateSelectionEdits)?savedParameters.coordinateSelectionEdits:[])];
  const model=current.model as {features?:Array<{id:string;type:string;state:string;outputBodies:string[];stringParameters?:Record<string,string>}>;coordinateSystems?:Array<{id:string;referenceFeatureId?:string;referenceBodyId?:string}>}|null;
  const coordinate=model?.coordinateSystems?.find(item=>item.id===context.targetCoordinateId);
  let sectionSource:{featureId?:string;bodyId?:string}|undefined;
  if(context.targetSectionId)try{sectionSource=JSON.parse(model?.features?.find(feature=>feature.id===context.targetFeatureId)?.stringParameters?.loftSections||"[]").find((section:{sectionId:string})=>section.sectionId===context.targetSectionId);}catch{/* Invalid persisted sections are reported by the native inspector. */}
  const sweepSource=sweepInputSlots(model?.features?.find(feature=>feature.id===context.targetFeatureId)).find(slot=>slot.inputId===context.targetSweepInputId);
  const canChangeSource=Boolean(context.targetCoordinateId || context.targetSectionId || context.targetSweepInputId);
  const sourceValue=canChangeSource?`${context.sourceFeatureId || preview?.sourceFeatureId || coordinate?.referenceFeatureId || sectionSource?.featureId || sweepSource?.featureId || ""}:${context.sourceBodyId || preview?.sourceBodyId || coordinate?.referenceBodyId || sectionSource?.bodyId || sweepSource?.bodyId || ""}`:"";
  const sources=(model?.features || []).flatMap(feature=>{
    const edited=context.request.inputs?.featureId===feature.id;
    const disabled=(Boolean(context.targetSectionId || context.targetSweepInputId) && feature.id===context.targetFeatureId) || (feature.state==="suppressed" && !(edited && context.request.operation==="feature.restore"))
      || (edited && ["feature.suppress","feature.delete"].includes(context.request.operation));
    return (feature.outputBodies || []).map(bodyId=>({key:`${feature.id}:${bodyId}`,label:`${feature.type} · ${feature.id} · ${bodyId}`,disabled}));
  });
  const presentations = Array.isArray(verified?.result.bodyPresentations) ? verified.result.bodyPresentations as InputPresentation[] : [];
  const resultBodyId=context.targetSectionId || context.targetSweepInputId?model?.features?.find(feature=>feature.id===context.targetFeatureId)?.outputBodies[0]:preview?.sourceBodyId;
  const resultPresentation = verified && resultBodyId ? presentations.find(item => item.bodyId === resultBodyId)
    || (verified.result.bodyId === resultBodyId && verified.result.positions?.length ? verified.result as unknown as InputPresentation : null) : null;
  return <section ref={panelRef} className="feature-input-inspector" aria-label="历史输入引用修复" data-testid="feature-reference-repair" data-stale={stale}>
    <div className="feature-input-heading"><strong>{verified ? "重算预览通过 · 尚未提交" : context.targetSweepInputId?`曲线扫掠${context.targetSweepInputId==="profile"?"截面":"路径边"}历史来源 · 临时视图`: context.targetSectionId ? "放样截面历史来源 · 临时视图" : context.targetCoordinateId ? "坐标系历史来源 · 临时视图" : "特征执行前输入 · 临时视图"}</strong><span>{context.targetCoordinateId || context.targetFeatureId}{context.targetSectionId || context.targetSweepInputId?` · ${context.targetSectionId || context.targetSweepInputId}`:""}</span></div>
    <p className="panel-copy">{verified ? "全部特征已验证。提交后，本次修改与引用重选一次生效、一次撤销。" : "请在下面的历史输入中重选；不会替换主视口，也不会修改当前工程。"}</p>
    <p className="feature-input-proposal">待提交：{context.request.operation === "variable.set" ? `变量 ${context.request.parameters?.name} = ${context.request.parameters?.expression}` : context.request.operation === "coordinate.set" ? `坐标系 ${context.request.parameters?.name || context.request.parameters?.id}` : `${context.request.operation} · ${context.request.inputs?.featureId || ""}`}</p>
    {parameterEntries.length>0 && <details className="feature-input-changes"><summary>查看待提交参数（{parameterEntries.length}）</summary><dl>{parameterEntries.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{Array.isArray(value)?value.join(", "):typeof value==="object"?JSON.stringify(value):String(value)}</dd></div>)}</dl></details>}
    {Array.isArray(savedSelections) && savedSelections.length>0 && <p className="panel-copy" role="status">已暂存 {savedSelections.length} 项引用；整组修改尚未提交。</p>}
    {canChangeSource && !verified && <label className="single-field feature-coordinate-source"><span>{context.targetSweepInputId?`${sweepSource?.label||context.targetSweepInputId}`:context.targetSectionId?`截面 ${context.targetSectionId}`:`坐标系 ${context.targetCoordinateId}`} 的历史来源</span><select aria-label={context.targetSweepInputId?"曲线扫掠输入历史来源":context.targetSectionId?"放样截面历史来源":"坐标系历史来源"} value={sourceValue} disabled={busy || stale} onChange={event=>{const [sourceFeatureId,sourceBodyId]=event.target.value.split(":");prepareRead();setContext(changeRepairSource(context,sourceFeatureId,sourceBodyId));}}>
      {!sources.some(source=>source.key===sourceValue) && <option value={sourceValue} disabled>原来源已不可用，请重新选择</option>}
      {sources.map(source=><option key={source.key} value={source.key} disabled={source.disabled}>{source.label}{source.disabled?" · 修改后不可用":""}</option>)}
    </select><small>按本次草稿显示历史输出，选取后统一验证。{context.targetSweepInputId && context.targetSweepInputId!=="profile"?"路径边共享同一来源；换源会清除本特征暂存的路径选择，须逐边复核。":""}</small></label>}
    {preview && (canChangeSource ? <details className="feature-input-changes"><summary>来源与依赖说明 · {preview.sourceBodyId} / {preview.sourceFeatureId}</summary><p className="feature-input-source">显示来源特征刚执行后的真实输出，不采用最终 Body 替代。更换来源后仍检查完整依赖和循环。<br/>原引用：{preview.selectionState === "resolved" ? `已定位${preview.kind==="face"?"面":"边"} ${preview.resolvedIndex}` : "未能唯一定位，请显式选择新输入"}</p></details> : <p className="feature-input-source">{preview.sourceBodyId} → {preview.sourceFeatureId} → {preview.featureType}<br/>原引用：{preview.selectionState === "resolved" ? `已定位 ${preview.kind === "face" ? "面" : "边"} ${preview.resolvedIndex}` : "未能唯一定位，请显式选择新输入"}</p>)}
    {busy && <p role="status">{input ? "正在验证完整重算…" : "正在重建历史输入…"}</p>}
    {preview && !verified && <>
      <div className={context.targetSectionId?'loft-section-picker':undefined}><div className={context.targetSectionId?'loft-picker-view':undefined}>
      <FeatureInputInspector presentation={preview.presentation} kind={preview.kind} highlightedEdges={loopEdges} initialIndex={preview.resolvedIndex} disabled={busy || stale || preview.presentation.stats.truncated} onSelect={index=>{if(index!==selectedIndex){setSelectedIndex(index);setHoleSeeds(index===preview.resolvedIndex?(preview.selectedHoleIndexes||[]).map(edge=>edge?`edge-0-${edge}`:''):Array.from({length:preview.requiredHoleCount||0},()=>''));setHighlightedLoop('');setLoopEdges([]);}}}/>
      <div className="feature-input-readout" role="status">{selectedIndex ? `已选择${preview.kind === "face" ? "面" : "边"} ${selectedIndex}` : `点击选择${preview.kind === "face" ? "面" : "边"}`}<small>中键旋转 · 右键平移 · 滚轮缩放</small></div>
      </div>
      {context.targetSectionId&&preview.faceBoundaries&&selectedIndex>0&&(boundaryError?<p className="property-error" role="alert">{boundaryError}</p>:<LoftHoleMapping summary={boundaries} seeds={holeSeeds} expectedCount={preview.requiredHoleCount??0} highlighted={highlightedLoop} onChange={setHoleSeeds} onHighlight={(id,edges)=>{setHighlightedLoop(id);setLoopEdges(edges);}} disabled={busy||stale||preview.presentation.stats.truncated}/>)}
      </div>
      {preview.presentation.stats.truncated && <p className="property-error" role="alert">历史显示已截断，禁止据此重选。请简化输入或提高显示预算后重试。</p>}
    </>}
    {verified && (resultPresentation ? <><FeatureInputInspector presentation={resultPresentation}/><p className="panel-copy">重算结果：{resultPresentation.bodyId}；工程共 {verified.result.bodyCount} 个 Body。其余 Body 未在此临时视图中显示。</p></> : <p className="panel-copy">工程共 {verified.result.bodyCount} 个 Body。此{context.targetSectionId?"放样结果":"输入体"}已被下游消费或完整显示未载入，当前仅验证重算，不展示替代 Body。</p>)}
    {stale && <p className="property-error" role="alert">工程已变化，临时输入与重算预览均已过期；请使用窗口顶部的重新载入。</p>}
    {error && <p className="property-error" role="alert">{error}</p>}
    <div className="feature-input-actions">
      <button type="button" disabled={busy} onClick={onCancel}>取消修复，保留参数草稿</button>
      {!verified && <button type="button" disabled={busy || stale} onClick={() => {prepareRead();setReload(value => value + 1);}}>重新读取输入</button>}
      {verified && <button type="button" disabled={busy || stale} onClick={() => {setVerified(null);setError(null);}}>重新选择</button>}
      <button type="button" className="primary-action" disabled={busy || stale || (!verified && (!selectedIndex || !preview || preview.presentation.stats.truncated || Boolean(loopIssue)))} onClick={() => void (verified ? commit() : validate())}>{verified ? "提交参数与引用修复" : "使用此引用并验证重算"}</button>
    </div>
  </section>;
}
