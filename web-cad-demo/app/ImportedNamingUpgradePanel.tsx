"use client";
import {useEffect,useRef,useState} from 'react';
import {API_ROOT} from './api-config';
import {modelingController} from './modeling/runtime';
import {useModelingController} from './modeling/modeling-controller';
import {createRequestId,type ModelingCommandInput,type ModelingCommandResponse} from './modeling/command-contract';
import {namingUpgradeAdvice,namingUpgradeArchivePolicy,namingUpgradeOutcomeUnknown,parseNamingUpgradeReceipt,parseNamingUpgradeUndo,sameNamingUpgradeState,type ImportedFeatureSummary,type NamingUpgradeReceipt,type NamingUpgradeStamp} from './model/imported-naming-upgrade';

export type NamingUpgradeGeometry={revision:number;stateToken?:string;stateSequence?:number;features?:ImportedFeatureSummary[]};
type Attempt={owner:NamingUpgradeStamp;input:ModelingCommandInput;kind:'upgrade'|'undo'};
type Failure={code?:string;message:string;unknown:boolean;featureId?:string};

export function ImportedNamingUpgradePanel({documentId,geometry,blocked,onModel,onSources,onHistory}:{documentId:string;geometry:NamingUpgradeGeometry|null;blocked:boolean;onModel:(result:ModelingCommandResponse)=>void;onSources:()=>void;onHistory:(featureId?:string)=>void}){
  const current=useModelingController(modelingController);
  const [capability,setCapability]=useState<'loading'|'available'|'unavailable'|'error'>('loading'),[capabilityEpoch,setCapabilityEpoch]=useState(0);
  const [archivePolicy,setArchivePolicy]=useState<ReturnType<typeof namingUpgradeArchivePolicy>>('unsupported');
  const [proof,setProof]=useState<NamingUpgradeReceipt|null>(null),[receipt,setReceipt]=useState<(NamingUpgradeReceipt&{undone?:boolean})|null>(null);
  const [pending,setPending]=useState<string|null>(null),[failure,setFailure]=useState<Failure|null>(null),[attempt,setAttempt]=useState<Attempt|null>(null);
  const life=useRef({alive:false,epoch:0,pending:false});
  useEffect(()=>{const value=life.current;value.alive=true;return()=>{value.alive=false;value.epoch++;};},[]);
  useEffect(()=>{
    const controller=new AbortController();let active=true;const timer=setTimeout(()=>controller.abort(),10000);
    void fetch(`${API_ROOT}/health`,{signal:controller.signal}).then(async response=>{const text=await response.text();if(text.length>1024*1024)throw Error('后台能力报告超限');const policy=response.ok?namingUpgradeArchivePolicy(JSON.parse(text)):'unsupported';if(active){setArchivePolicy(policy);setCapability(policy!=='unsupported'?'available':'unavailable');}}).catch(()=>{if(active){setArchivePolicy('unsupported');setCapability('error');}}).finally(()=>clearTimeout(timer));
    return()=>{active=false;clearTimeout(timer);controller.abort();};
  },[capabilityEpoch]);
  const imports=(geometry?.features||[]).filter(feature=>feature.type==='import.step'),legacy=imports.filter(feature=>feature.numberParameters?.importNamingVersion===undefined);
  const unsupported=imports.some(feature=>feature.numberParameters?.importNamingVersion!==undefined&&feature.numberParameters.importNamingVersion!==1);
  const visible:NamingUpgradeStamp|null=geometry?.stateToken?{documentId,revision:geometry.revision,stateToken:geometry.stateToken,stateSequence:geometry.stateSequence}:null;
  const synchronized=Boolean(visible&&sameNamingUpgradeState(visible,current)),stale=Boolean(proof&&(!visible||!sameNamingUpgradeState(proof.stamp,current)||!sameNamingUpgradeState(proof.stamp,visible)));
  const busy=Boolean(pending)||current.busy,available=capability==='available'&&synchronized&&!busy&&!blocked;
  const currentReceipt=Boolean(receipt&&sameNamingUpgradeState(receipt.stamp,current)&&visible&&sameNamingUpgradeState(receipt.stamp,visible));
  const canCommit=Boolean(available&&proof&&!stale&&proof.report.sourceCount>0&&!failure&&!attempt);
  const run=async(action:'preview'|'commit'|'recover'|'read'|'undo')=>{
    if(life.current.pending||modelingController.getSnapshot().busy||blocked)return;
    const snapshot=modelingController.getSnapshot();
    if(snapshot.documentId!==documentId)return;
    let owner=visible,input:ModelingCommandInput;
    if(action==='recover'){
      if(!attempt||attempt.owner.documentId!==documentId)return;owner=attempt.owner;input=attempt.input;
    }else if(action==='read')input={operation:'document.view'};
    else if(action==='undo'){
      if(!currentReceipt||!receipt||receipt.undone||!receipt.report.changed)return;owner=receipt.stamp;input={operation:'document.undo',baseRevision:owner.revision,baseStateToken:owner.stateToken,options:{idempotencyKey:createRequestId('naming-upgrade-undo')}};
    }else{
      if(!visible||!sameNamingUpgradeState(visible,snapshot)||capability!=='available')return;
      if(action==='commit'&&(!canCommit||!proof||!sameNamingUpgradeState(proof.stamp,snapshot)))return;
      input={operation:action==='preview'?'document.naming.preview':'document.naming.upgrade',baseRevision:visible.revision,baseStateToken:visible.stateToken,...(action==='commit'?{options:{idempotencyKey:createRequestId('naming-upgrade')}}:{})};
    }
    if(!owner&&action!=='read')return;
    const epoch=++life.current.epoch;life.current.pending=true;setPending(action);if(action!=='read')setFailure(null);
    if(action==='preview'){setProof(null);setReceipt(null);}
    if(action==='commit'||action==='undo')setAttempt({owner:owner!,input,kind:action==='undo'?'undo':'upgrade'});
    try{
      const result=await modelingController.execute(input);
      if(action!=='preview'&&modelingController.getSnapshot().documentId===documentId&&modelingController.acceptsState(result))onModel(result);
      if(!life.current.alive||epoch!==life.current.epoch)return;
      if(action==='read')return;
      if(action==='undo'||action==='recover'&&attempt?.kind==='undo'){const stamp=parseNamingUpgradeUndo(result,owner!);setReceipt(previous=>previous?{...previous,stamp,undone:true}:null);setProof(null);setAttempt(null);return;}
      const received=parseNamingUpgradeReceipt(result,owner!,action==='preview');
      if(action==='preview'){
        if(!sameNamingUpgradeState(owner!,modelingController.getSnapshot()))throw Object.assign(Error('验证期间工程已变化，请核对工程后重新验证。'),{code:'PROJECT_STATE_CONFLICT'});
        setProof(received);
      }else{setReceipt(received);setProof(null);setAttempt(null);}
    }catch(reason){
      if(life.current.alive&&epoch===life.current.epoch){
        const error=reason as {code?:string;message?:string;details?:Record<string,unknown>},mutation=['commit','recover','undo'].includes(action),unknown=action==='read'&&Boolean(attempt)||mutation&&namingUpgradeOutcomeUnknown(error.code);
        const source=error.details?.archiveSourceFeatureId,featureId=typeof source==='string'&&geometry?.features?.some(feature=>feature.id===source)?source:undefined;
        setFailure({code:error.code,message:String(error.message||'请求未完成').slice(0,2000),unknown,featureId});
        if(!unknown&&action!=='read')setAttempt(null);
      }
    }finally{life.current.pending=false;if(life.current.alive&&epoch===life.current.epoch)setPending(null);}
  };
  const advice=namingUpgradeAdvice(failure?.code),verified=proof&&!stale&&!failure;
  const failureFeatureId=failure?.featureId&&geometry?.features?.some(feature=>feature.id===failure.featureId)?failure.featureId:undefined;
  const report=(receipt||proof)?.report;
  const reportRows:(readonly [string,number])[]=report?[['旧导入来源',report.sourceCount],['历史输出',report.historicalOutputCount],['持久引用',report.referenceCount],['验证 Body',report.bodyCount],...(report.archivedSourceCount>0?([['归档来源',report.archivedSourceCount],['归档输出证据',report.archivedProofCount],['归档引用检查',report.archivedReferenceCount]] as const):[])]:[];
  const stateLabel=pending?pending==='preview'?'正在验证历史与当前几何…':pending==='read'?'正在核对工程…':pending==='undo'?'正在撤销升级…':'正在提交并再次完整验证…':failure?.unknown?'执行结果尚未确认':failure?advice.title:blocked?'来源恢复待处理':stale?'验证已过期':receipt?.undone?'升级已撤销':receipt?currentReceipt?'引用升级已完成':'上次升级回执（非当前状态）':verified?'验证通过，可以升级':!geometry?'请先载入工程':!synchronized?'显示与工程状态待同步':unsupported?'导入命名版本需要检查':!imports.length?'本工程没有 STEP 导入':!legacy.length?'当前导入无需升级':'尚未验证旧导入引用';
  return <section className="panel-section naming-upgrade-panel" data-testid="naming-upgrade-panel" aria-label="旧工程引用升级" aria-busy={Boolean(pending)}>
    <div className="section-heading compact"><div><span className="eyebrow">IMPORTED TOPOLOGY</span><h2>旧工程引用升级</h2></div><span className="feature-badge">工程维护</span></div>
    <p className="panel-copy">为旧 STEP 导入及后续特征建立稳定的面、边引用。先验证，提交前会再次完整核对。</p>
    <div className="naming-upgrade-status" data-state={failure||blocked||stale||unsupported?'attention':verified||currentReceipt?'verified':'idle'} role="status"><strong>{stateLabel}</strong><span>{visible?`当前工程 R${visible.revision}`:'当前工程未载入'} · {legacy.length} 个旧导入 / {imports.length} 个导入</span>{stale&&<p>旧报告保留供查看，不能用于当前工程。请重新验证。</p>}{unsupported&&<p>当前内核不支持工程中的命名版本，请使用兼容版本核对，不会降级重写。</p>}{!unsupported&&!legacy.length&&imports.length>0&&!receipt&&<p>导入已采用当前命名版本；这不等于所有复杂拓扑变化都已通过验证。</p>}</div>
    <ul className="naming-upgrade-invariants"><li>不改变当前几何、位置和显示</li><li>保留 Body / 面 / 边身份及现有属性关联</li><li>整体提交，可一次撤销；缺少证据时拒绝</li></ul>
    <p className="naming-upgrade-capability"><span>{capability==='loading'?'正在检查实际内核能力…':capability==='available'?'后台支持精确历史验证':capability==='unavailable'?'当前后台未声明支持此升级':'后台能力暂未核对'}</span>{['error','unavailable'].includes(capability)&&<button type="button" disabled={busy} onClick={()=>{setCapability('loading');setCapabilityEpoch(value=>value+1);}}>重新检查后台</button>}</p>
    {(proof||receipt)&&<div className="naming-upgrade-report" aria-label="引用升级验证报告"><strong>{receipt?'执行回执':'验证报告'}{(stale||receipt&&!currentReceipt)&&!receipt?.undone?' · 历史记录':''}</strong><dl>{reportRows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p>验证时几何完全一致 · 拓扑身份保持</p>{Boolean(report?.archivedSourceCount)&&<p>归档证据已逐项验证并保留原记录；不会提前恢复几何或激活孤立属性。</p>}<small>{receipt?'回执':'验证基线'} R{(receipt||proof)!.stamp.revision} · 状态 {(receipt||proof)!.stamp.stateToken.slice(0,8)}…</small></div>}
    {failure&&<div className="naming-upgrade-failure" role="alert"><strong>{failure.unknown?'请先核对，勿发起新的升级请求':advice.title}</strong><p>{failure.unknown?'请求可能已经提交。核对工程不会修改模型；按原请求恢复会使用同一去重键，已提交时取回原回执，未提交时只在原工程状态仍一致时继续。':advice.text}</p><details><summary>技术诊断</summary><code>{failure.code||'UNCONFIRMED_RESULT'}</code><p>{failure.message}</p></details></div>}
    <div className="naming-upgrade-actions"><button type="button" disabled={!available||!legacy.length||Boolean(attempt)} onClick={()=>void run('preview')}>{pending==='preview'?'正在验证…':proof?'重新验证':'验证升级'}</button><button type="button" className="naming-upgrade-commit" disabled={!canCommit} onClick={()=>void run('commit')}>升级引用</button><button type="button" disabled={busy||blocked} onClick={()=>void run('read')}>核对工程</button>{currentReceipt&&receipt?.report.changed&&!receipt.undone&&<button type="button" disabled={busy||blocked} onClick={()=>void run('undo')}>撤销本次升级</button>}{attempt&&failure?.unknown&&<button type="button" disabled={busy||blocked} onClick={()=>void run('recover')}>按原请求恢复</button>}</div>
    <div className="naming-upgrade-links"><button type="button" disabled={Boolean(pending)} onClick={onSources}>检查 STEP 来源</button><button type="button" disabled={Boolean(pending)} onClick={()=>onHistory(failureFeatureId)}>{failureFeatureId?'检查归档来源特征':'查看特征历史'}</button></div>
    <details className="naming-upgrade-scope"><summary>范围与限制</summary><p>仅升级具有认证来源与持久选择证据的旧导入。不会恢复已经孤立的属性，也不会猜测缺失的历史选择。</p><p>{archivePolicy==='exact-recertification-v1'?'支持精确再认证归档记录：原所有权、生成定义和完整输出必须全部吻合，原证明一并保留。验证不会恢复被抑制特征；任一归档无法证明时整次升级拒绝，不查找旧参数或猜测替代对象。':archivePolicy==='none'?'此后台不支持归档拓扑恢复记录的升级；原记录保持不变。':'归档再认证能力尚未确认，请先检查实际后台。'}</p><p>关闭窗口不取消已发送的升级，也不会自动重发。几何或工程属性变化会使旧验证失效。</p></details>
  </section>;
}
