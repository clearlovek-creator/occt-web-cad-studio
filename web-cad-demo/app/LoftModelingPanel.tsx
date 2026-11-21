"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {DirectModelResult} from './DirectModelingPanel';
import type {FeatureData} from './ModelMetadataPanels';
import {FeatureInputInspector} from './FeatureInputInspector';
import {FeatureReferenceRepair,failedSelectionTarget} from './FeatureReferenceRepair';
import {LoftHoleMapping} from './LoftHoleMapping';
import {useEditorCommands} from './modeling/CommandEditScope';
import type {ModelingCommandInput,ModelingCommandResponse} from './modeling/command-contract';
import {topologyIndex,validateSweepSourcePresentation,type InputPresentation,type FeatureRepairProposal} from './modeling/feature-input';
import {initialLoftSections,loftSectionInputs,loftVersionKind,loopMappingIssue,parseFaceBoundaries,type FaceBoundarySummary,type LoftSectionDraft} from './modeling/loft-loops';

export type LoftBodySummary={bodyId:string;name?:string;kind?:string;faceCount?:number;topologyRevision?:number};
type Model={revision:number;bodyMetadata?:LoftBodySummary[]};
type Result=DirectModelResult&ModelingCommandResponse&{bodyPresentations?:InputPresentation[];preview?:{state:string}};
export function LoftModelingPanel({model,bodyId,faceId,feature,onModel}:{model:Model|null;bodyId?:string|null;faceId?:string|null;feature?:FeatureData;onModel:(result:DirectModelResult)=>void}){
  const {execute,session}=useEditorCommands(),epoch=useRef(0),sourceView=useRef<HTMLDetailsElement>(null),previewView=useRef<HTMLElement>(null);
  const [initial]=useState(()=>{try{return {sections:initialLoftSections(feature),error:''};}catch(reason){return {sections:[],error:reason instanceof Error?reason.message:'放样记录不可编辑。'};}});
  const [sections,setSections]=useState<LoftSectionDraft[]>(initial.sections),[placement,setPlacement]=useState(feature?.stringParameters.loftPlacement||'actual'),[spacing,setSpacing]=useState(feature?.stringParameters['expr.sectionSpacing']||String(feature?.numberParameters.sectionSpacing??10)),[ruled,setRuled]=useState(feature?.stringParameters.loftRuled==='true');
  const [upgrading,setUpgrading]=useState(false),legacy=Boolean(feature&&loftVersionKind(feature)==='legacy'&&!upgrading);
  const [sourceBody,setSourceBody]=useState(bodyId||model?.bodyMetadata?.[0]?.bodyId||''),[source,setSource]=useState<InputPresentation|null>(null),[picked,setPicked]=useState(0);
  const [boundaryRead,setBoundaryRead]=useState<{source:InputPresentation;faceId:string;value:FaceBoundarySummary|null;error?:string}|null>(null),[seeds,setSeeds]=useState<string[]>([]),[loopId,setLoopId]=useState(''),[loopEdges,setLoopEdges]=useState<string[]>([]),[editingKey,setEditingKey]=useState<string|null>(null);
  const retainedSeeds=useRef<{bodyId:string;faceId:string;seeds:string[]}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[preview,setPreview]=useState<InputPresentation|null>(null),[verified,setVerified]=useState(false),[repair,setRepair]=useState<FeatureRepairProposal|null>(null);
  const selectedFace=source?.triangleFaceIds.find(id=>topologyIndex(id)===picked),bodies=model?.bodyMetadata||[];
  const changed=()=>{setPreview(null);setVerified(false);setError('');setNotice('');};
  const assertSnapshot=useCallback((response:ModelingCommandResponse)=>{const base=session?.getBaseline();if(base&&(session?.isStale()||response.documentId!==base.documentId||response.stateToken!==base.stateToken))throw Error('截面读取时工程状态已变化，请重新载入编辑窗口；未沿用旧面或孔编号。');},[session]);
  const readBoundary=useCallback(async(presentation:InputPresentation,selected:string)=>{
    const response=await execute<ModelingCommandResponse&{bodyId:string;selectionId:string;boundaryLoops:unknown}>({operation:'geometry.measure',inputs:{bodyId:presentation.bodyId,selectionType:'face',selectionId:selected}});assertSnapshot(response);
    if(response.bodyId!==presentation.bodyId||response.selectionId!==selected)throw Error('测量回复不是当前截面，未允许设置孔对应。');return parseFaceBoundaries(response.boundaryLoops,selected,presentation);
  },[execute,assertSnapshot]);
  useEffect(()=>()=>{epoch.current++;},[]);
  useEffect(()=>{if(source){const canvas=sourceView.current?.querySelector<HTMLElement>('[data-testid="feature-input-canvas"]');canvas?.scrollIntoView({block:'center'});canvas?.focus({preventScroll:true});}},[source]);
  useEffect(()=>{if(verified)previewView.current?.scrollIntoView({block:'center'});},[verified]);
  useEffect(()=>{
    let cancelled=false;if(!source||!selectedFace)return;
    void readBoundary(source,selectedFace).then(value=>{
      if(cancelled)return;setBoundaryRead({source,faceId:selectedFace,value});
      const retained=retainedSeeds.current,holes=value.loops.filter(loop=>loop.role==='inner');
      if(retained?.bodyId===source.bodyId&&retained.faceId===selectedFace){setSeeds([...retained.seeds]);retainedSeeds.current=null;}else setSeeds(holes.map(()=>''));
    }).catch(reason=>{if(!cancelled)setBoundaryRead({source,faceId:selectedFace,value:null,error:reason instanceof Error?reason.message:'无法读取截面边界。'});});
    return()=>{cancelled=true;};
  },[source,selectedFace,readBoundary]);
  const append=(selectedBody:string,selected:string,holeSeeds:string[],key?:string|null)=>{
    changed();const row:LoftSectionDraft={key:key||crypto.randomUUID(),bodyId:selectedBody,faceId:selected,holeCount:holeSeeds.length,...(holeSeeds.length?{holeEdgeIds:[...holeSeeds]}:{})};
    setSections(rows=>key?rows.map(old=>old.key===key?row:old):[...rows,row]);setEditingKey(null);setNotice(key?'截面及孔对应草稿已更新，尚未写入工程。':'截面已加入有序列表，尚未写入工程。');
  };
  const readSource=async()=>{
    if(!sourceBody)return;setBusy(true);setError('');const owner=++epoch.current;
    try{const result=await execute<InputPresentation&ModelingCommandResponse>({operation:'body.presentation',inputs:{bodyId:sourceBody}});assertSnapshot(result);const value=validateSweepSourcePresentation(result,sourceBody);if(owner===epoch.current){retainedSeeds.current=null;setSource(value);setPicked(0);setSeeds([]);setLoopEdges([]);setLoopId('');setEditingKey(null);}}
    catch(reason){if(owner===epoch.current)setError(reason instanceof Error?reason.message:'无法读取截面。');}finally{if(owner===epoch.current)setBusy(false);}
  };
  const inspectOrAdd=async(selectedBody:string,selected:string,row?:LoftSectionDraft)=>{
    if(!row&&sections.length>=32)return;setBusy(true);setError('');const owner=++epoch.current;
    try{
      const response=await execute<InputPresentation&ModelingCommandResponse>({operation:'body.presentation',inputs:{bodyId:selectedBody}});assertSnapshot(response);const presentation=validateSweepSourcePresentation(response,selectedBody),summary=await readBoundary(presentation,selected);if(owner!==epoch.current)return;
      const count=summary.loops.filter(loop=>loop.role==='inner').length,issue=loopMappingIssue(summary,Array.from({length:count},()=>''));
      if(count===0&&!row){if(issue)throw Error(issue);append(selectedBody,selected,[]);return;}
      retainedSeeds.current={bodyId:selectedBody,faceId:selected,seeds:row?.holeEdgeIds||Array.from({length:count},()=>'')};setEditingKey(row?.key||null);setSourceBody(selectedBody);setSource(presentation);setPicked(topologyIndex(selected));setSeeds([]);setLoopEdges([]);setLoopId('');setNotice('请高亮核对并设置孔对应，再更新或添加此截面。');
    }catch(reason){if(owner===epoch.current)setError(reason instanceof Error?reason.message:'无法读取截面。');}finally{if(owner===epoch.current)setBusy(false);}
  };
  const request=():ModelingCommandInput=>{
    if(legacy)return {operation:'feature.update',inputs:{featureId:feature!.id},parameters:{sectionSpacing:spacing}};
    const definition={sections:loftSectionInputs(sections),placement,ruled,...(placement==='z-spacing'?{sectionSpacing:spacing}:{})};return feature?{operation:'feature.update',inputs:{featureId:feature.id},parameters:{loftDefinition:definition}}:{operation:'detail.loft',inputs:{sections:definition.sections},parameters:{placement,ruled,...(placement==='z-spacing'?{sectionSpacing:spacing}:{})}};
  };
  const restoreSaved=(result:Result)=>{const saved=result.features.find(item=>item.id===feature?.id);if(saved&&loftVersionKind(saved)==='real'){setSections(initialLoftSections(saved));setPlacement(saved.stringParameters.loftPlacement);setRuled(saved.stringParameters.loftRuled==='true');setUpgrading(false);}};
  const run=async(isPreview:boolean)=>{
    if(!model)return;setBusy(true);setError('');setPreview(null);setVerified(false);const owner=++epoch.current;let pending:ModelingCommandInput|undefined;
    try{
      pending=request();const result=await execute<Result>({...pending,options:{preview:isPreview}});if(owner!==epoch.current)return;
      if(isPreview){const target=feature?.outputBodies[0]||result.bodyId;setPreview(result.bodyPresentations?.find(body=>body.bodyId===target)||(result.bodyId===target&&result.positions?.length?result as unknown as InputPresentation:null));setVerified(true);}
      else{restoreSaved(result);setSource(null);setPicked(0);setEditingKey(null);onModel(result);}
    }catch(reason){if(owner===epoch.current){const target=failedSelectionTarget(reason);if(target&&pending)setRepair({request:pending,...target});setError(reason instanceof Error?reason.message:'放样计算失败。');}}finally{if(owner===epoch.current)setBusy(false);}
  };
  let definitionIssue='';if(!legacy&&sections.length>=2)try{loftSectionInputs(sections);}catch(reason){definitionIssue=reason instanceof Error?reason.message:'截面定义待补充。';}
  const activeRead=boundaryRead?.source===source&&boundaryRead.faceId===selectedFace?boundaryRead:null,activeBoundary=activeRead?.value||null,loopReading=Boolean(source&&selectedFace&&!activeRead),mappingIssue=activeRead?.error||loopMappingIssue(activeBoundary,seeds),hasHoles=sections.some(row=>row.holeCount>0);
  if(repair)return <FeatureReferenceRepair proposal={repair} onCancel={()=>{setRepair(null);setError('');}} onCommitted={result=>{restoreSaved(result as Result);setRepair(null);setError('');setSource(null);setPreview(null);setVerified(false);onModel(result);}}/>;
  return <section className="panel-section loft-modeling" data-testid="loft-modeling-panel" aria-label="真实截面放样">
    <div className="section-heading compact"><div><span className="eyebrow">OCCT LOFT · {legacy?'LEGACY':hasHoles?'THROUGH-HOLE PROFILES':'REAL PROFILES'}</span><h2>{legacy?'旧版近似放样':'真实截面放样'}</h2></div><span className="feature-badge">{legacy?'v1':hasHoles?'v3 · 多孔':'v2'}</span></div>
    {initial.error?<p className="property-error" role="alert">{initial.error} 原定义保留，请核对工程版本。</p>:legacy?<>
      <p className="panel-copy" role="status">此特征使用旧版包围盒矩形近似。普通重算沿用旧近似定义；只有明确选择真实截面后才升级。</p>
      <label className="single-field"><span>旧版截面间距</span><input aria-label="旧版截面间距" value={spacing} disabled={busy} onChange={event=>{changed();setSpacing(event.target.value);}}/></label><button type="button" disabled={busy} onClick={()=>{changed();setUpgrading(true);}}>改为真实截面定义</button>
    </>:<fieldset className="loft-controls" disabled={busy}>
      <p className="panel-copy">按顺序添加真实平面截面。带孔面需明确排列孔对应；所有截面孔数相同，不会自动填孔或按位置猜配。</p>
      <div className="loft-source-row"><label className="single-field"><span>截面来源 Body</span><select aria-label="放样截面来源 Body" value={sourceBody} onChange={event=>{epoch.current++;setSourceBody(event.target.value);setSource(null);setPicked(0);setEditingKey(null);}}><option value="">选择 Body</option>{bodies.map(body=><option key={body.bodyId} value={body.bodyId}>{body.name||body.bodyId} · {body.bodyId}</option>)}</select></label><button type="button" disabled={!sourceBody} onClick={()=>void readSource()}>读取截面面</button></div>
      {source&&<details ref={sourceView} open className="loft-source-inspector"><summary>选择实际面 · {source.bodyId}</summary>
        <div className="loft-section-picker"><div className="loft-picker-view">
        <FeatureInputInspector presentation={source} kind="face" highlightedEdges={loopEdges} label="放样截面面选择视图；方向键切换候选" disabled={busy||Boolean(source.stats.truncated)} onSelect={index=>{changed();if(index!==picked){setPicked(index);setSeeds([]);setLoopEdges([]);setLoopId('');}}}/>
        <p className="panel-copy" role="status">{selectedFace?`已选：${selectedFace}`:'点击实际面或用方向键切换；中键旋转、右键平移。'}</p>
        </div><div className="loft-picker-controls">
        {selectedFace&&(activeRead?.error?<p className="property-error" role="alert">{activeRead.error}</p>:<LoftHoleMapping summary={activeBoundary} seeds={seeds} onChange={value=>{changed();setSeeds(value);}} highlighted={loopId} onHighlight={(id,edges)=>{setLoopId(id);setLoopEdges(edges);}} disabled={busy||loopReading}/>)}
        <button type="button" disabled={!selectedFace||loopReading||Boolean(mappingIssue)||Boolean(source.stats.truncated)||!editingKey&&sections.length>=32} onClick={()=>{if(selectedFace&&!mappingIssue)append(source.bodyId,selectedFace,seeds,editingKey);}}>{editingKey?'更新此截面及孔对应':'添加选中的截面面'}</button>
        </div></div>
        {editingKey&&<button type="button" onClick={()=>{setEditingKey(null);setNotice('已取消截面调整，列表中的原草稿保持不变。');}}>取消截面调整</button>}
        {source.stats.truncated&&<p className="property-error" role="alert">输入显示已截断，不能据此选面。</p>}
      </details>}
      {bodyId&&faceId&&<button type="button" disabled={sections.length>=32} onClick={()=>void inspectOrAdd(bodyId,faceId)}>添加视口当前选中面 · {faceId}</button>}
      <div className="loft-profile-shortcuts" aria-label="单面截面快捷添加">{bodies.filter(body=>body.kind==='sheet'&&body.faceCount===1&&Number.isInteger(body.topologyRevision)).map(body=><button type="button" key={body.bodyId} disabled={sections.length>=32} onClick={()=>void inspectOrAdd(body.bodyId,`face-${body.topologyRevision}-1`)}>{body.name||body.bodyId} · 添加唯一面</button>)}</div>
      <h3>有序截面 · {sections.length}/32</h3>{!sections.length&&<p className="panel-copy">还没有截面。添加至少两个截面后可预览。</p>}
      <ol className="loft-section-list" aria-label="有序放样截面">{sections.map((row,index)=><li key={row.key}><div className="loft-section-info"><strong>{index+1}. {bodies.find(body=>body.bodyId===row.bodyId)?.name||row.bodyId}</strong><small>{row.sectionId?`历史选面 · ${row.featureId} · ${row.sectionId}`:row.faceId}</small><span className="loft-hole-count">{row.holeCount?`${row.holeCount} 个贯通孔 · 对应顺序已保存`:'单环截面'}</span>
        {feature&&row.sectionId?<button type="button" aria-label={`查看 / 更换截面 ${index+1}`} onClick={()=>{try{changed();setRepair({request:request(),targetFeatureId:feature.id,targetSectionId:row.sectionId});}catch(reason){setError(reason instanceof Error?reason.message:'请先补齐截面定义。');}}}>查看 / 更换历史面{row.holeCount?'及孔对应':''}</button>:row.faceId&&<button type="button" aria-label={`调整截面 ${index+1} 孔对应`} onClick={()=>void inspectOrAdd(row.bodyId,row.faceId!,row)}>查看 / 调整孔对应</button>}
      </div><div className="loft-section-actions"><button type="button" aria-label={`截面 ${index+1} 上移`} disabled={index===0} onClick={()=>{changed();setSections(rows=>{const next=[...rows];[next[index],next[index-1]]=[next[index-1],next[index]];return next;});}}>↑</button><button type="button" aria-label={`截面 ${index+1} 下移`} disabled={index===sections.length-1} onClick={()=>{changed();setSections(rows=>{const next=[...rows];[next[index],next[index+1]]=[next[index+1],next[index]];return next;});}}>↓</button><button type="button" aria-label={`删除截面 ${index+1}`} onClick={()=>{changed();setSections(rows=>rows.filter(item=>item.key!==row.key));if(editingKey===row.key)setEditingKey(null);}}>×</button></div></li>)}</ol>
      {definitionIssue&&<p className="property-error" role="alert">{definitionIssue}</p>}
      <label className="single-field"><span>截面放置方式</span><select aria-label="放样截面放置方式" value={placement} onChange={event=>{changed();setPlacement(event.target.value);}}><option value="actual">保持实际空间位置</option><option value="z-spacing">按全局 Z 间距布置</option></select></label>
      {placement==='z-spacing'&&<label className="single-field"><span>Z 间距（mm 或表达式）</span><input aria-label="放样 Z 间距" value={spacing} onChange={event=>{changed();setSpacing(event.target.value);}}/></label>}
      <label className="check-field"><input type="checkbox" checked={ruled} onChange={event=>{changed();setRuled(event.target.checked);}}/>直纹连接（不做光顺逼近）</label>
    </fieldset>}
    {notice&&<p className="panel-copy" role="status">{notice}</p>}
    {verified&&<section ref={previewView} className="loft-result-preview" aria-label="放样只读预览"><p className="panel-copy">已验证放样，尚未写入工程。主视口和工程选择未改变。</p>{preview?<FeatureInputInspector presentation={preview}/>:<p className="panel-copy">结果已被下游消费或显示未载入，只验证重算，不展示其他 Body 冒充结果。</p>}<button type="button" disabled={busy} onClick={()=>{setPreview(null);setVerified(false);}}>关闭预览</button></section>}
    {error&&<p className="property-error" role="alert">{error}</p>}
    <div className="feature-input-actions"><button type="button" disabled={busy||!model||Boolean(initial.error)||Boolean(definitionIssue)||!legacy&&sections.length<2} onClick={()=>void run(true)}>预览放样</button><button type="button" className="primary-action" disabled={busy||!model||Boolean(initial.error)||Boolean(definitionIssue)||!legacy&&sections.length<2} onClick={()=>void run(false)}>{busy?'正在计算…':legacy?'仅修改旧版间距':feature?'保存放样定义':'创建放样'}</button></div>
  </section>;
}
