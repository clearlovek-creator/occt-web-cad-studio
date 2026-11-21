"use client";
import {useEffect,useRef,useState} from "react";
import {useEditorCommands} from "./modeling/CommandEditScope";
import type {ModelingCommandInput,ModelingCommandResponse} from "./modeling/command-contract";
import type {DirectModelResult} from "./DirectModelingPanel";
import type {FeatureData} from "./ModelMetadataPanels";
import type {LoftBodySummary} from "./LoftModelingPanel";
import {FeatureInputInspector} from "./FeatureInputInspector";
import {FeatureReferenceRepair,failedSelectionTarget} from "./FeatureReferenceRepair";
import {sweepInputSlots,topologyIndex,validateSweepSourcePresentation,type FeatureRepairProposal,type InputPresentation} from "./modeling/feature-input";

type Profile={bodyId:string;faceId:string};
type Path={bodyId:string;edgeIds:string[]};
type Result=DirectModelResult&ModelingCommandResponse&{bodyPresentations?:InputPresentation[]};
function savedReference(feature:FeatureData|undefined,key:string):{bodyId?:string;featureId?:string;edges?:unknown[]}{try{return JSON.parse(feature?.stringParameters[key]||"{}");}catch{return {};}}

export function SweepModelingPanel({kind,model,bodyId,faceId,feature,onModel,onBusyChange}:{kind:"sweep"|"pipe";model:{revision:number;bodyMetadata?:LoftBodySummary[]}|null;bodyId?:string|null;faceId?:string|null;feature?:FeatureData;onModel:(result:DirectModelResult)=>void;onBusyChange?:(busy:boolean)=>void}){
  const commands=useEditorCommands(),epoch=useRef(0),sourceView=useRef<HTMLDetailsElement>(null),previewView=useRef<HTMLElement>(null);
  const curved=feature?.stringParameters.sweepVersion==="2";
  const [method,setMethod]=useState(curved?"model":"vector"),[vector,setVector]=useState({pathX:feature?.stringParameters["expr.pathX"]||String(feature?.numberParameters.pathX??0),pathY:feature?.stringParameters["expr.pathY"]||String(feature?.numberParameters.pathY??0),pathZ:feature?.stringParameters["expr.pathZ"]||String(feature?.numberParameters.pathZ??50)});
  const [placement,setPlacement]=useState(feature?.stringParameters.sweepPlacement||"actual"),[frame,setFrame]=useState(feature?.stringParameters.sweepFrame||"corrected-frenet"),[reverse,setReverse]=useState(feature?.stringParameters.sweepReverse==="true");
  const [profile,setProfile]=useState<Profile|null>(null),[path,setPath]=useState<Path|null>(null);
  const bodies=(model?.bodyMetadata||[]).filter(body=>!feature?.outputBodies.includes(body.bodyId));
  const [role,setRole]=useState<"face"|"edge">("face"),[sourceBody,setSourceBody]=useState(bodyId&&!feature?bodyId:bodies[0]?.bodyId||"");
  const [source,setSource]=useState<InputPresentation|null>(null),[picked,setPicked]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [preview,setPreview]=useState<InputPresentation|null>(null),[verified,setVerified]=useState(false);
  const [repair,setRepair]=useState<FeatureRepairProposal|null>(null);
  useEffect(()=>()=>{epoch.current++;},[]);
  useEffect(()=>{if(source){const canvas=sourceView.current?.querySelector<HTMLElement>('[data-testid="feature-input-canvas"]');canvas?.scrollIntoView({block:"center"});canvas?.focus({preventScroll:true});}},[source]);
  useEffect(()=>{if(verified)previewView.current?.scrollIntoView({block:"center"});},[verified]);
  const changed=()=>{setVerified(false);setPreview(null);setError("");};
  const oldProfile=savedReference(feature,"sweepProfile"),oldPath=savedReference(feature,"sweepPath");
  const hasProfile=Boolean(profile||curved),hasPath=Boolean(path?.edgeIds.length||curved&&!path);
  const request=():ModelingCommandInput=>{
    if(method==="vector")return feature?{operation:"feature.update",inputs:{featureId:feature.id},parameters:vector}:{operation:`detail.${kind}`,inputs:{bodyId:bodyId||"",faceId:faceId||""},parameters:vector};
    const definition={placement,frame,reverse,...(profile?{profile}:{}),...(path?{path}:{})};
    if(feature)return {operation:"feature.update",inputs:{featureId:feature.id},parameters:{sweepDefinition:definition}};
    return {operation:`detail.${kind}`,inputs:{bodyId:profile?.bodyId||"",faceId:profile?.faceId||"",pathBodyId:path?.bodyId||"",pathEdgeIds:path?.edgeIds||[]},parameters:{placement,frame,reverse}};
  };
  const read=async()=>{
    const owner=++epoch.current;setBusy(true);onBusyChange?.(true);setError("");setSource(null);setPicked(0);
    try{const result=await commands.execute<InputPresentation&ModelingCommandResponse>({operation:"body.presentation",inputs:{bodyId:sourceBody}});const presentation=validateSweepSourcePresentation(result,sourceBody);if(owner===epoch.current){setSource(presentation);sourceView.current?.setAttribute("open","");}}
    catch(reason){if(owner===epoch.current)setError(reason instanceof Error?reason.message:"读取来源失败");}
    finally{if(owner===epoch.current){setBusy(false);onBusyChange?.(false);}}
  };
  const run=async(isPreview:boolean)=>{
    const owner=++epoch.current;setBusy(true);onBusyChange?.(true);setError("");setVerified(false);setPreview(null);
    const pending=request();
    try{const result=await commands.execute<Result>({...pending,options:{preview:isPreview}});if(owner!==epoch.current)return;
      if(isPreview){const target=feature?.outputBodies[0]||result.bodyId;setPreview(result.bodyPresentations?.find(body=>body.bodyId===target)||(result.bodyId===target&&result.positions?.length?result:null));setVerified(true);}
      else{setSource(null);setPicked(0);setProfile(null);setPath(null);onModel(result);}
    }catch(reason){if(owner===epoch.current){const target=failedSelectionTarget(reason);if(target)setRepair({request:pending,...target});setError(reason instanceof Error?reason.message:"扫掠失败");}}
    finally{if(owner===epoch.current){setBusy(false);onBusyChange?.(false);}}
  };
  const adopt=()=>{if(!source||!picked)return;changed();if(role==="face"){const faceId=source.triangleFaceIds.find(id=>topologyIndex(id)===picked);if(faceId)setProfile({bodyId:source.bodyId,faceId});}
    else{const edgeId=source.edges.find(edge=>topologyIndex(edge.edgeId)===picked)?.edgeId;if(!edgeId)return;setPath(previous=>{const same=previous?.bodyId===source.bodyId,edges=same?previous.edgeIds:[];return {bodyId:source.bodyId,edgeIds:edges.includes(edgeId)?edges:[...edges,edgeId]};});}
  };
  const ready=method==="vector"?Boolean(feature||faceId):hasProfile&&hasPath;
  if(repair)return <FeatureReferenceRepair proposal={repair} onCancel={()=>{setRepair(null);setError("");}} onCommitted={result=>{setRepair(null);setError("");setProfile(null);setPath(null);setSource(null);setPreview(null);setVerified(false);onModel(result);}}/>;
  return <section className="panel-section loft-modeling sweep-modeling" data-testid="sweep-modeling-panel" aria-label="扫掠路径定义">
    <h2>{kind==="pipe"?"管道":"扫掠"}</h2>
    <p className="panel-copy">保留截面与路径来源，生成新的独立 Body。模型路径使用真实 OCCT 曲线，不以折线或包围盒代替。</p>
    <fieldset className="loft-controls" disabled={busy}>
      <label className="single-field"><span>路径定义</span><select aria-label="扫掠路径方式" value={method} onChange={event=>{changed();setSource(null);setPicked(0);setMethod(event.target.value);}}><option value="vector" disabled={Boolean(curved)}>直线向量{feature&&!curved?"（已有定义）":""}</option><option value="model">选择模型中的曲线路径</option></select></label>
      {method==="vector"?<><p className="property-target">{bodyId||feature?.stringParameters.sourceBody} / {faceId||feature?.stringParameters.faceId||"请在视口拾取一个面"}</p><div className="compact-fields">{(["pathX","pathY","pathZ"] as const).map(key=><label key={key}><span>路径 {key.slice(-1)}</span><input aria-label={`扫掠路径 ${key.slice(-1)}`} value={vector[key]} onChange={event=>{changed();setVector({...vector,[key]:event.target.value});}}/></label>)}</div></>:<>
        <h3>1 · 截面与路径</h3>
        <div className="sweep-input-summary"><p><strong>截面</strong><span>{profile?`${profile.bodyId} / ${profile.faceId}`:curved?`${oldProfile.bodyId} · 已保存的历史面` :"尚未指定平面 Face"}</span></p><p><strong>路径</strong><span>{path?`${path.bodyId} · ${path.edgeIds.length} 条有序边`:curved?`${oldPath.bodyId} · ${oldPath.edges?.length||0} 条历史边`:"尚未指定路径 Edge"}</span></p></div>
        {curved&&<div className="loft-profile-shortcuts" aria-label="扫掠历史输入">{sweepInputSlots(feature).filter(slot=>slot.kind==="face"?!profile:!path).map(slot=><button key={slot.inputId} type="button" onClick={()=>{changed();setRepair({request:request(),targetFeatureId:feature!.id,targetSweepInputId:slot.inputId});}}>查看 / 更换历史{slot.label}</button>)}</div>}
        {!feature&&bodyId&&faceId&&<button type="button" className="secondary-action" onClick={()=>{changed();setProfile({bodyId,faceId});}}>采用当前选中面作为截面</button>}
        <div className="loft-source-row"><label className="single-field"><span>输入来源</span><select aria-label="扫掠来源 Body" value={sourceBody} onChange={event=>{setSourceBody(event.target.value);setSource(null);setPicked(0);}}><option value="">选择 Body</option>{bodies.map(body=><option key={body.bodyId} value={body.bodyId}>{body.name||body.bodyId} · {body.bodyId}</option>)}</select></label><button type="button" disabled={!sourceBody} onClick={()=>void read()}>读取来源</button></div>
        <label className="single-field"><span>拾取用途</span><select aria-label="扫掠拾取用途" value={role} onChange={event=>{setRole(event.target.value as "face"|"edge");setPicked(0);}}><option value="face">选择平面截面</option><option value="edge">按顺序选择路径边</option></select></label>
        {source&&<details ref={sourceView} open className="loft-source-inspector"><summary>来源视图 · {source.bodyId} · {role==="face"?"面":"边"}拾取</summary><FeatureInputInspector presentation={source} kind={role} initialIndex={0} disabled={busy} onSelect={setPicked} label={role==="face"?"扫掠截面选择视图；方向键切换":"扫掠路径边选择视图；方向键切换"}/><p className="panel-copy">{picked?`已选 ${role} ${picked}`:"点击几何或聚焦视图后用方向键选择"}</p><button type="button" disabled={!picked||source.stats.truncated||role==="edge"&&(path?.edgeIds.length||0)>=32} onClick={adopt}>{role==="face"?"采用为截面":"追加路径边"}</button></details>}
        {path&&<ol className="loft-section-list" aria-label="有序扫掠路径">{path.edgeIds.map((edge,index)=><li key={edge}><div className="loft-section-info"><strong>{index+1} · {edge}</strong><small>{path.bodyId}</small></div><div className="loft-section-actions"><button type="button" aria-label={`路径边 ${index+1} 上移`} disabled={!index} onClick={()=>{changed();setPath(current=>{if(!current)return current;const ids=[...current.edgeIds];[ids[index],ids[index-1]]=[ids[index-1],ids[index]];return {...current,edgeIds:ids};});}}>↑</button><button type="button" aria-label={`删除路径边 ${index+1}`} onClick={()=>{changed();setPath(current=>current?{...current,edgeIds:current.edgeIds.filter(id=>id!==edge)}:null);}}>×</button></div></li>)}</ol>}
        <h3>2 · 放置与方向</h3>
        <label className="single-field"><span>截面放置</span><select aria-label="扫掠截面放置" value={placement} onChange={event=>{changed();setPlacement(event.target.value);}}><option value="actual">保持实际位置（必须位于起点法平面）</option><option value="align-start">截面副本对齐路径起点（源面不变）</option></select></label>
        <label className="single-field"><span>移动标架</span><select aria-label="扫掠移动标架" value={frame} onChange={event=>{changed();setFrame(event.target.value);}}><option value="corrected-frenet">修正 Frenet（默认）</option><option value="frenet">Frenet</option></select></label>
        <label className="check-field"><input type="checkbox" checked={reverse} onChange={event=>{changed();setReverse(event.target.checked);}}/>反向路径</label>
        <p className="panel-copy">路径需连续且相切（G1），最多 32 条边；不支持尖角过渡、间隙或分叉。结果执行内核有效性及自交检查，建议先预览形态。修改已保存定义时，未重新选取的输入保留其历史引用。</p>
      </>}
    </fieldset>
    {verified&&<section ref={previewView} className="loft-result-preview" aria-label="扫掠只读预览"><p className="panel-copy">重算预览通过，尚未提交；源几何与主视口选择保持不变。</p>{preview?<FeatureInputInspector presentation={preview}/>:<p className="panel-copy">结果被下游消费或未载入，只报告验证结果，不显示替代 Body。</p>}<button type="button" disabled={busy} onClick={()=>{setVerified(false);setPreview(null);}}>关闭预览</button></section>}
    {error&&<p className="property-error" role="alert">{error}</p>}
    <div className="feature-input-actions"><button type="button" disabled={busy||!model||!ready} onClick={()=>void run(true)}>预览几何</button><button type="button" className="primary-action" disabled={busy||!model||!ready} onClick={()=>void run(false)}>{busy?"正在计算…":feature?"保存扫掠定义":"创建几何"}</button></div>
  </section>;
}
