import {isMeshJobActive,type MeshJobDescriptor,type MeshJobPayload,type MeshJobSummary,type MeshPreparationResult} from './mesh.ts';
import {MESH_QUERY_TIMEOUTS} from '../../shared/mesh-query-timeouts.mjs';
import type {MeshSizing} from '../../shared/mesh-sizing.mjs';
import {emptyMeshSizingDraft,type MeshSizingDraft} from './mesh-sizing-draft.ts';
import {meshSizingDraftFromTask} from './mesh-sizing-draft.ts';
import type {MeshStrategyRow,MeshStrategyRef} from '../../shared/mesh-strategy.mjs';
import {normalizeMeshOptimization,type MeshOptimization} from '../../shared/mesh-optimization.mjs';
import {parseMeshCatalog,unknownMeshCatalog,type MeshCatalogSnapshot} from './mesh-catalog.ts';
import {parseMeshRecoveryInfo,type MeshRecoveryRequest} from '../../shared/mesh-completion-recovery.mjs';
import {parseSurfaceSummary,type SurfaceTaskResult} from './surface-task.ts';
import {defaultTetraDraft,parseTetraDerivation,parseTetraSummary,type TetraDraft,type TetraAction} from './discrete-tetra.ts';
import type {DiscreteTetraSettings} from '../../shared/discrete-tetra-task.mjs';
import {parseOptimizationRecoveryInfo,parseOptimizationAttempt} from '../../shared/mesh-optimization-recovery.mjs';
import {OptimizationRecoveryJournal,type OptimizationAction,type RecoveryStorage} from './mesh-optimization-recovery.ts';

type MeshResponse={ok?:boolean;error?:string;code?:string;meshCatalog?:unknown;surfaceReconstruction?:{configured:boolean};discreteTetra?:{configured:boolean;derivation?:{supported:boolean}};surfaceSummary?:unknown;meshJob?:MeshJobDescriptor;jobs?:MeshJobSummary[];mesh?:MeshJobPayload['mesh'];preparation?:MeshPreparationResult['preparation'];downloadUrl?:string;derivedMaterialSource?:MeshJobPayload['derivedMaterialSource']};
export type MeshCompletionAction=MeshRecoveryRequest&{state:'submitting'|'uncertain'|'failed';error?:string};
export type MeshTaskSnapshot={optimizationActions:Record<string,OptimizationAction>;optimizationJournalError:string;documentId:string;jobs:MeshJobSummary[];catalog:MeshCatalogSnapshot;historyKnown:boolean;catalogRecoveryPending:boolean;catalogRecovered:boolean;catalogUncertain:boolean;completionActions:Record<string,MeshCompletionAction>;tetraActions:Record<string,TetraAction>;setupRoute:'cad'|'discrete';tetraDraft:TetraDraft;tetraAvailable:boolean;tetraDerivationAvailable:boolean;selectedTetraId:string|null;active:MeshJobSummary|undefined;loading:boolean;busy:boolean;cancelling:boolean;error:string;inspection:MeshPreparationResult|null;surfaceInspection?:SurfaceTaskResult|null;selectedSurfaceId?:string|null;surfaceAvailable?:boolean;selectedInspectionId:string|null;selectedJobId:string|null;sizingDraft:MeshSizingDraft;setupRepairMode:string;setupQualityThreshold:string;setupStrictQuality:boolean;setupOptimization?:MeshOptimization;strategyName:string;selectedStrategy:MeshStrategyRow|null};
type Options={documentId:string;apiRoot:string;fetchImpl?:typeof fetch;pollMs?:number;timeoutMs?:number;catalogPollMs?:number;recoveryStorage?:RecoveryStorage};
const initial=(documentId:string):MeshTaskSnapshot=>({optimizationActions:{},optimizationJournalError:'',documentId,jobs:[],catalog:unknownMeshCatalog(),historyKnown:false,catalogRecoveryPending:false,catalogRecovered:false,catalogUncertain:false,completionActions:{},tetraActions:{},setupRoute:'cad',tetraDraft:defaultTetraDraft(),tetraAvailable:false,tetraDerivationAvailable:false,selectedTetraId:null,active:undefined,loading:true,busy:false,cancelling:false,error:'',inspection:null,selectedInspectionId:null,selectedJobId:null,sizingDraft:emptyMeshSizingDraft(documentId),setupRepairMode:'conservative',setupQualityThreshold:'0.2',setupStrictQuality:false,strategyName:'',selectedStrategy:null});

/** Workspace-owned state. React subscribes; dialog mounts do not own jobs. */
export class ProjectMeshTaskStore {
  private state:MeshTaskSnapshot;
  private listeners=new Set<()=>void>();
  private requests=new Set<AbortController>();
  private pending=new Set<symbol>();
  private cancellations=new Set<symbol>();
  private generation=0;
  private running=false;
  private updateVersion=0;
  private reconciledVersion=-1;
  private selectionVersion=0;
  private follow:string|null=null;
  private automaticSelection=true;
  private errorSource:string|null=null;
  private errorJobId:string|null=null;
  private uncertainCancel:string|null=null;
  private refreshing:Promise<void>|null=null;
  private recovering:Promise<void>|null=null;
  private completionWork=new Map<string,Promise<void>>();
  private tetraWork=new Map<string,Promise<void>>();
  private optimizationWork=new Map<string,Promise<void>>();
  private optimizationJournal:OptimizationRecoveryJournal;
  private prepareFollow:{jobId:string;intent:number}|null=null;
  private selectedPayload:MeshJobPayload|null=null;
  private poll:ReturnType<typeof setTimeout>|undefined;
  private onResult:((value:MeshJobPayload)=>void)|undefined;
  private fetcher:typeof fetch;
  private options:Options;
  constructor(options:Options){this.options=options;this.state=initial(options.documentId);this.optimizationJournal=new OptimizationRecoveryJournal(options.documentId,options.recoveryStorage);this.fetcher=options.fetchImpl||((input,init)=>fetch(input,init));}
  getSnapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  setOnResult(callback:(value:MeshJobPayload)=>void){this.onResult=callback;}
  setSetupRoute=(value:'cad'|'discrete')=>{if(this.running)this.update({setupRoute:value});};
  setTetraDraft=(value:TetraDraft)=>{if(this.running)this.update({tetraDraft:{...value}});};
  setSizingDraft=(draft:MeshSizingDraft)=>{if(!this.running)return;if(draft.documentId!==this.options.documentId)throw Error('尺寸草稿不属于当前工程。');this.update({sizingDraft:structuredClone(draft)});};
  setSetupRepairMode=(value:string)=>{if(this.running)this.update({setupRepairMode:value});};
  setSetupQualityThreshold=(value:string)=>{if(this.running)this.update({setupQualityThreshold:value});};
  setSetupStrictQuality=(value:boolean)=>{if(this.running)this.update({setupStrictQuality:value});};
  setSetupOptimization=(value:MeshOptimization|undefined)=>{if(this.running)this.update({setupOptimization:normalizeMeshOptimization(value)});};
  setStrategyName=(value:string)=>{if(this.running)this.update({strategyName:value});};
  setSelectedStrategy=(row:MeshStrategyRow|null)=>{if(this.running)this.update({selectedStrategy:row?structuredClone(row):null});};
  loadStrategy=(row:MeshStrategyRow,geometry:unknown)=>{if(this.running)this.update({selectedStrategy:structuredClone(row),strategyName:row.name,setupRepairMode:row.options.repairMode,setupQualityThreshold:String(row.options.qualityThreshold),setupStrictQuality:row.options.qualityPolicy==='strict',setupOptimization:normalizeMeshOptimization(row.options.optimization),sizingDraft:row.options.sizing?meshSizingDraftFromTask(this.options.documentId,row.options.sizing,geometry):emptyMeshSizingDraft(this.options.documentId)});};
  private current(generation:number){return this.running&&generation===this.generation;}
  private update(patch:Partial<MeshTaskSnapshot>){const next={...this.state,...patch};next.active=next.jobs.find(isMeshJobActive);next.busy=this.pending.size>0;next.cancelling=this.cancellations.size>0;this.state=next;for(const listener of this.listeners)listener();}
  start=()=>{
    if(this.running)return this.stop;
    this.running=true;this.generation++;this.updateVersion=0;this.reconciledVersion=-1;this.selectionVersion++;this.follow=null;this.prepareFollow=null;this.selectedPayload=null;this.automaticSelection=true;this.errorSource=null;this.errorJobId=null;this.uncertainCancel=null;this.refreshing=null;this.pending.clear();this.cancellations.clear();const state=initial(this.options.documentId);try{state.optimizationActions=this.optimizationJournal.read();}catch(error){state.optimizationJournalError=error instanceof Error?error.message:'恢复记录读取失败。';}this.update(state);void this.refresh();
    return this.stop;
  };
  stop=()=>{
    this.running=false;this.generation++;clearTimeout(this.poll);this.poll=undefined;this.refreshing=null;this.recovering=null;
    for(const controller of this.requests)controller.abort();this.requests.clear();this.pending.clear();this.cancellations.clear();this.completionWork.clear();this.tetraWork.clear();this.optimizationWork.clear();this.prepareFollow=null;this.selectedPayload=null;
  };
  private begin(cancel=false,clearError=true){const token=Symbol();this.pending.add(token);if(cancel)this.cancellations.add(token);if(clearError){this.errorSource=null;this.errorJobId=null;this.uncertainCancel=null;}this.update(clearError?{error:''}:{});return token;}
  private end(token:symbol,generation:number){if(!this.current(generation))return;this.pending.delete(token);this.cancellations.delete(token);this.update({});}
  private job(value:MeshJobDescriptor|undefined,id?:string):MeshJobDescriptor {
    if(!value||value.documentId!==this.options.documentId||typeof value.jobId!=='string'||!value.jobId||id&&value.jobId!==id||!['preparing','queued','running','cancelling','complete','failed','cancelled','interrupted'].includes(value.state))throw Error('网格任务不属于当前工程或响应身份无效，未采用结果。');
    if(value.kind==='discrete-tetra')value={...value,derivation:parseTetraDerivation(value.derivation),...(value.discreteTetraSummary?{discreteTetraSummary:parseTetraSummary(value.discreteTetraSummary)}:{})};
    if(value.optimizationRecovery!==undefined){if(value.kind!=='discrete-tetra'||!['failed','cancelled','interrupted'].includes(value.state))throw Error('优化恢复状态与任务阶段不一致。');value={...value,optimizationRecovery:parseOptimizationRecoveryInfo(value.optimizationRecovery)};}
    if(value.optimizationAttempt!==undefined){if(value.kind!=='discrete-tetra')throw Error('优化尝试关联类型无效。');value={...value,optimizationAttempt:parseOptimizationAttempt(value.optimizationAttempt)};}
    if(value.completionRecovery!==undefined){const info=parseMeshRecoveryInfo(value.completionRecovery);if(info.state==='complete'?value.state!=='complete':value.state!=='failed'||value.errorCode!=='MESH_COMPLETION_UNCOMMITTED')throw Error('恢复状态与网格任务阶段不一致。');return {...value,completionRecovery:info};}
    return value;
  }
  private async request(pathname:string,body?:unknown,heavy=false){
    const controller=new AbortController();this.requests.add(controller);let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;controller.abort();},this.options.timeoutMs??(heavy?MESH_QUERY_TIMEOUTS.browserMs:MESH_QUERY_TIMEOUTS.controlMs));
    try{
      const response=await this.fetcher(this.options.apiRoot+pathname,{signal:controller.signal,...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
      let payload:MeshResponse;try{payload=JSON.parse(await response.text());}catch{throw Error(`网格服务响应无效（HTTP ${response.status}），请检查后台。`);}
      if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.ok!=='boolean')throw Error('网格服务响应不符合协议，未采用结果。');
      if(!response.ok||!payload.ok)throw Object.assign(Error(payload.error||'网格请求失败。'),{payload});
      return payload;
    }catch(reason){if(timedOut)throw Error('网格请求超时，请检查任务记录后重新读取。');throw reason;}finally{clearTimeout(timeout);this.requests.delete(controller);}
  }
  private async load(jobId:string,intent:number,manual=false){
    const generation=this.generation;if(!this.current(generation)||intent!==this.selectionVersion)return;
    const token=this.begin(false,manual);
    try{
      const payload=await this.request('/mesh/jobs/'+encodeURIComponent(jobId),undefined,true);
      if(!this.current(generation)||intent!==this.selectionVersion)return;
      const job=this.job(payload.meshJob,jobId);
      if(job.kind==='discrete-tetra'){
        this.update({setupRoute:'discrete',selectedTetraId:jobId,jobs:this.state.jobs.map(item=>item.jobId===jobId?{...item,...job}:item)});
        if(!payload.mesh){this.update({selectedJobId:null});return;}
        if(job.derivation?.state!=='ready'||job.normalMeshAdmitted!==true||!payload.derivedMaterialSource)throw Error('派生结果尚未完整核验，不采用为可显示网格。');
      }else if(job.kind!=='surface-reconstruction')this.update({setupRoute:'cad',selectedTetraId:null});
      if(job.kind==='surface-reconstruction'){
        if(job.state!=='complete'||payload.mesh||payload.preparation)throw Error(job.error||'表面重构尚未完成。');
        const surfaceSummary=parseSurfaceSummary(payload.surfaceSummary);this.update({surfaceInspection:{ok:true,meshJob:job,surfaceSummary},selectedSurfaceId:jobId});return;
      }
      if(payload.preparation&&!isMeshJobActive(job)){
        this.update({inspection:payload as MeshPreparationResult,selectedInspectionId:jobId});
        if(!payload.mesh)return;
      }
      if(!payload.mesh||job.state!=='complete')throw Error(job.error||'任务尚未产生有效网格。');
      this.selectedPayload={...payload as MeshJobPayload,meshJob:{...job,visible:false,requestedVisible:false}};this.onResult?.(this.selectedPayload);
      if(this.current(generation)&&intent===this.selectionVersion)this.update({selectedJobId:jobId});
    }catch(reason){
      if(this.current(generation)&&intent===this.selectionVersion){
        const failed=(reason as {payload?:MeshResponse})?.payload?.meshJob;
        const patch:Partial<MeshTaskSnapshot>={error:reason instanceof Error?reason.message:'读取网格失败。'};
        this.errorSource='result';this.errorJobId=jobId;
        if(failed&&failed.documentId===this.options.documentId&&failed.jobId===jobId)patch.jobs=this.state.jobs.map(job=>job.jobId===jobId?{...job,...failed}:job);
        this.update(patch);
      }
    }finally{this.end(token,generation);}
  }
  select=async(jobId:string)=>{if(!this.running)return;this.follow=null;this.prepareFollow=null;this.automaticSelection=false;await this.load(jobId,++this.selectionVersion,true);};
  private async waitCatalog(generation:number,catalog:MeshCatalogSnapshot){
    const deadline=performance.now()+(this.options.timeoutMs??MESH_QUERY_TIMEOUTS.browserMs);
    while(this.current(generation)){
      this.update({catalog,historyKnown:false});if(!this.current(generation)||catalog.state!=='recovering')return catalog;
      if(performance.now()>=deadline)throw Error('网格历史仍在读取，观察已超时。可核对读取状态；不会自动重复发起恢复。');
      const controller=new AbortController();this.requests.add(controller);
      await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,this.options.catalogPollMs??1000);controller.signal.addEventListener('abort',finish,{once:true});});
      this.requests.delete(controller);if(!this.current(generation))return catalog;
      catalog=parseMeshCatalog((await this.request('/mesh/catalog')).meshCatalog);
    }
    return catalog;
  }
  recoverCatalog=():Promise<void>=>{
    if(!this.running)return Promise.resolve();if(this.recovering)return this.recovering;
    const generation=this.generation;
    const work=async()=>{
      await this.refreshing;if(!this.current(generation))return;
      const failed=this.state.catalog,checkOnly=this.state.catalogUncertain||failed.state==='recovering';
      if(!checkOnly&&(!failed.canRetry||failed.state!=='unavailable'||!failed.attemptId))return;
      const token=this.begin(false,false);this.update({catalogRecoveryPending:true,catalogRecovered:false,historyKnown:false});
      try{
        let payload:MeshResponse;
        if(checkOnly)payload=await this.request('/mesh/catalog');
        else try{payload=await this.request('/mesh/catalog/recover',{failedAttemptId:failed.attemptId});}
        catch{payload=await this.request('/mesh/catalog');} // Lost replies are observed, never reposted.
        if(!this.current(generation))return;
        const catalog=parseMeshCatalog(payload.meshCatalog);this.update({catalog,catalogUncertain:false});await this.refresh();if(this.current(generation)&&this.state.catalog.state==='ready'&&this.state.historyKnown)this.update({catalogRecovered:true});
      }catch(reason){if(this.current(generation)){this.errorSource='catalog';this.update({catalogUncertain:true,error:reason instanceof Error?reason.message:'重新读取回复未确认，请核对读取状态。'});}}
      finally{if(this.current(generation))this.update({catalogRecoveryPending:false});this.end(token,generation);}
    };
    const pending=work().finally(()=>{if(this.recovering===pending)this.recovering=null;});this.recovering=pending;return pending;
  };
  private reconcileCompletionActions(jobs:MeshJobSummary[]){
    const actions={...this.state.completionActions};
    for(const [id,action]of Object.entries(actions))if(action.state!=='submitting'){
      const job=jobs.find(job=>job.jobId===id),info=job?.completionRecovery;
      if(action.state==='failed'){if(info?.failedStateToken===action.failedStateToken&&['checking','complete'].includes(info.state))delete actions[id];continue;}
      if(info&&info.failedStateToken===action.failedStateToken&&(info.requestId===action.requestId||info.state==='complete'))delete actions[id];
      else actions[id]={...action,state:'failed',error:job?'尚未观察到已完成的恢复；原结果仍保留，可明确重新尝试。':'原任务已不存在，未重新执行恢复。'};
    }
    return actions;
  }
  checkCompletionRecovery=async(jobId:string)=>{if(!this.running||!this.state.jobs.some(job=>job.jobId===jobId))return;const generation=this.generation,token=this.begin(false,false);try{await this.refresh();}finally{this.end(token,generation);}};
  recoverCompletion=(jobId:string):Promise<void>=>{
    if(!this.running)return Promise.resolve();const existing=this.completionWork.get(jobId);if(existing)return existing;
    if(this.state.completionActions[jobId]?.state==='uncertain')return this.checkCompletionRecovery(jobId);
    const generation=this.generation;
    const work=async()=>{
      await this.refreshing;if(!this.current(generation)||!this.state.historyKnown||this.state.catalog.state!=='ready')return;
      const previous=this.state.jobs.find(job=>job.jobId===jobId),info=previous?.completionRecovery;
      if(!info||info.state==='checking'||info.state==='complete'){await this.refresh();return;}
      const request={requestId:crypto.randomUUID(),failedStateToken:info.failedStateToken},token=this.begin(false,false);
      this.update({completionActions:{...this.state.completionActions,[jobId]:{...request,state:'submitting'}}});
      try{
        const payload=await this.request('/mesh/jobs/'+encodeURIComponent(jobId)+'/recover-completion',request);if(!this.current(generation))return;
        const job=this.job(payload.meshJob,jobId),fresh=job.completionRecovery;
        if(!fresh||fresh.failedStateToken!==request.failedStateToken||fresh.state!=='complete'&&fresh.requestId!==request.requestId)throw Error('恢复回复未匹配原操作。');
        const actions={...this.state.completionActions};delete actions[jobId];this.updateVersion++;this.update({completionActions:actions,jobs:this.state.jobs.map(item=>item.jobId===jobId?{...item,...job}:item)});await this.refresh();
      }catch(reason){if(this.current(generation)){
        const confirmed=Boolean((reason as {payload?:MeshResponse})?.payload);
        this.update({completionActions:{...this.state.completionActions,[jobId]:{...request,state:confirmed?'failed':'uncertain',error:confirmed?'恢复未被确认执行，请核对任务记录后再尝试。':'恢复回复未确认；请核对状态，不会自动重复提交。'}}});
        await this.refresh();
      }}finally{this.end(token,generation);}
    };
    const pending=work().finally(()=>{if(this.completionWork.get(jobId)===pending)this.completionWork.delete(jobId);});this.completionWork.set(jobId,pending);return pending;
  };
  private reconcileTetraActions(jobs:MeshJobSummary[]){
    const actions={...this.state.tetraActions};
    for(const [id,action]of Object.entries(actions)){
      if(action.state==='submitting')continue;
      const job=jobs.find(job=>job.jobId===id),info=job?.derivation;
      if(info?.sourceToken!==action.sourceToken)continue;
      if(action.operation==='derive'&&(info.state==='ready'||info.requestId===action.requestId))delete actions[id];
      else if(action.operation==='discard'&&info.canStart&&!['ready','unverified','invalid','working'].includes(info.state))delete actions[id];
    }
    return actions;
  }
  checkTetra=async(jobId:string)=>{
    if(!this.running)return;const generation=this.generation,intent=this.selectionVersion,token=this.begin(false,false);
    try{await this.refresh();if(!this.current(generation))return;const job=this.state.jobs.find(job=>job.jobId===jobId);if(job?.state==='complete')await this.load(jobId,intent,true);}
    finally{this.end(token,generation);}
  };
  prepareTetra=(jobId:string)=>this.tetraAction(jobId,'derive');
  discardTetra=(jobId:string)=>this.tetraAction(jobId,'discard');
  private tetraAction(jobId:string,operation:'derive'|'discard'):Promise<void>{
    if(!this.running)return Promise.resolve();const existing=this.tetraWork.get(jobId);if(existing)return existing;
    if(this.state.tetraActions[jobId]?.state==='uncertain')return this.checkTetra(jobId);
    const generation=this.generation,intent=this.selectionVersion;
    const work=async()=>{
      await this.refreshing;if(!this.current(generation)||intent!==this.selectionVersion||!this.state.historyKnown)return;
      const job=this.state.jobs.find(job=>job.jobId===jobId),info=job?.derivation;
      if(job?.kind!=='discrete-tetra'||job.state!=='complete'||!info?.sourceToken||operation==='derive'&&(!info.canStart||job.freshness?.status!=='current'))return;
      const request={requestId:crypto.randomUUID(),sourceToken:info.sourceToken},token=this.begin(false,false);
      if(operation==='discard'&&this.selectedPayload?.meshJob.jobId===jobId){const hidden={...this.selectedPayload,mesh:{...this.selectedPayload.mesh,render:undefined,admission:undefined},meshJob:{...this.selectedPayload.meshJob,admission:null,normalMeshAdmitted:false,visible:false,requestedVisible:false}};this.selectedPayload=null;this.onResult?.(hidden);this.update({selectedJobId:null});}
      this.update({tetraActions:{...this.state.tetraActions,[jobId]:{...request,operation,state:'submitting'}}});
      try{
        const payload=await this.request('/mesh/jobs/'+encodeURIComponent(jobId)+(operation==='derive'?'/derive':'/derive-discard'),request,true);
        if(!this.current(generation))return;
        const accepted=this.job(payload.meshJob,jobId),derivation=accepted.derivation;
        if(derivation?.sourceToken!==request.sourceToken||operation==='derive'&&derivation.requestId!==request.requestId)throw Error('结果准备回复与原操作不一致，请只读核对。');
        const actions={...this.state.tetraActions};delete actions[jobId];this.updateVersion++;this.update({tetraActions:actions,jobs:this.state.jobs.map(item=>item.jobId===jobId?{...item,...accepted}:item)});await this.refresh();
      }catch(reason){if(this.current(generation)){
        const confirmed=Boolean((reason as {payload?:MeshResponse})?.payload);
        this.update({tetraActions:{...this.state.tetraActions,[jobId]:{...request,operation,state:confirmed?'failed':'uncertain',error:confirmed?(reason instanceof Error?reason.message:'操作未被执行。'):'操作回复未确认；只核对原任务，不会自动重复提交。'}}});await this.refresh();
      }}finally{this.end(token,generation);}
    };
    const pending=work().finally(()=>{if(this.tetraWork.get(jobId)===pending)this.tetraWork.delete(jobId);});this.tetraWork.set(jobId,pending);return pending;
  }
  private reconcileOptimizationActions(jobs:MeshJobSummary[]){
    const actions={...this.state.optimizationActions};let changed=false;
    for(const [origin,action]of Object.entries(actions)){
      const matches=jobs.filter(job=>job.optimizationAttempt?.originHandle===origin&&job.optimizationAttempt.requestId===action.requestId);
      if(matches.length>1)throw Error('恢复身份对应多个任务，未猜测采用结果。');const job=matches[0];if(!job)continue;
      const link=job.optimizationAttempt!;if(link.failedStateToken!==action.failedStateToken||link.checkpointToken!==action.checkpointToken)throw Error('优化尝试与原恢复请求不一致。');
      if(action.state!=='accepted'||action.attemptJobId!==job.jobId){actions[origin]={...action,state:'accepted',attemptJobId:job.jobId,error:undefined};changed=true;}
    }
    if(changed)try{this.optimizationJournal.save(actions);}catch(error){this.update({optimizationJournalError:error instanceof Error?error.message:'恢复记录尚未保存。'});}
    return actions;
  }
  checkOptimizationRecovery=async(origin:string)=>{
    if(!this.running||!this.state.jobs.some(job=>job.jobId===origin)&&!this.state.optimizationActions[origin])return;const generation=this.generation,token=this.begin(false,false);
    try{const saved=this.optimizationJournal.read(),merged={...this.state.optimizationActions};for(const [id,action]of Object.entries(saved)){const current=merged[id];if(!current||current.requestId!==action.requestId||current.failedStateToken!==action.failedStateToken||current.checkpointToken!==action.checkpointToken)merged[id]=action;}this.update({optimizationActions:merged,optimizationJournalError:''});await this.refresh();if(this.current(generation)){this.optimizationJournal.save(this.state.optimizationActions);this.update({optimizationJournalError:''});}}
    catch(error){if(this.current(generation))this.update({optimizationJournalError:error instanceof Error?error.message:'恢复记录暂时无法核对。'});}
    finally{this.end(token,generation);}
  };
  resumeOptimization=(origin:string):Promise<void>=>{
    if(!this.running)return Promise.resolve();const existing=this.optimizationWork.get(origin);if(existing)return existing;
    const previous=this.state.optimizationActions[origin];if(previous?.state==='uncertain'||this.state.optimizationJournalError)return this.checkOptimizationRecovery(origin);if(previous?.state==='accepted'&&previous.attemptJobId)return this.select(previous.attemptJobId);
    const generation=this.generation,intent=this.selectionVersion;
    const work=async()=>{
      await this.refreshing;if(!this.current(generation)||intent!==this.selectionVersion||!this.state.historyKnown||this.state.active||this.state.busy)return;
      const source=this.state.jobs.find(job=>job.jobId===origin),info=source?.optimizationRecovery;
      if(source?.kind!=='discrete-tetra'||!info?.canStart||source.freshness?.status!=='current')return;
      const request={requestId:crypto.randomUUID(),failedStateToken:info.failedStateToken,checkpointToken:info.checkpointToken},token=this.begin(false,false),actions={...this.state.optimizationActions,[origin]:{...request,state:'submitting' as const}};
      try{
        this.optimizationJournal.save(actions);this.update({optimizationActions:actions});
        const payload=await this.request('/mesh/jobs/'+encodeURIComponent(origin)+'/resume-optimization',request,true);if(!this.current(generation))return;
        const accepted=this.job(payload.meshJob),link=accepted.optimizationAttempt;
        if(!link||link.originHandle!==origin||link.requestId!==request.requestId||link.failedStateToken!==request.failedStateToken||link.checkpointToken!==request.checkpointToken)throw Error('优化恢复回复与原请求不一致，请只读核对。');
        const next={...this.state.optimizationActions,[origin]:{...request,state:'accepted' as const,attemptJobId:accepted.jobId}};
        try{this.optimizationJournal.save(next);}catch(error){this.update({optimizationJournalError:error instanceof Error?error.message:'恢复记录仍需核对。'});}
        this.updateVersion++;this.update({optimizationActions:next,jobs:[accepted,...this.state.jobs.filter(job=>job.jobId!==accepted.jobId)]});
        if(intent===this.selectionVersion){this.follow=accepted.jobId;this.automaticSelection=true;this.prepareFollow=null;this.update({setupRoute:'discrete',selectedTetraId:accepted.jobId,selectedJobId:null});}
        await this.refresh();
      }catch(error){if(this.current(generation)){
        if(this.state.optimizationActions[origin]?.state==='accepted'){await this.refresh();return;}
        const code=(error as {payload?:MeshResponse})?.payload?.code,known=typeof code==='string'&&['MESH_OPTIMIZATION_RECOVERY_REQUEST_INVALID','MESH_OPTIMIZATION_RECOVERY_CONFLICT','MESH_OPTIMIZATION_RECOVERY_UNAVAILABLE','MESH_OPTIMIZATION_RECOVERY_RESOURCE_CHANGED','MESH_SOURCE_STALE','MESH_JOB_ALREADY_RUNNING','MESH_TASK_CAPACITY','MESH_STORAGE_TASK_RESERVATION','MESH_STORAGE_CAPACITY','MESH_STORAGE_FREE_SPACE','MESH_OPTIMIZATION_RECOVERY_LIMIT'].includes(code);
        const submitted=Boolean(this.state.optimizationActions[origin]?.requestId===request.requestId),state=known||!submitted?'failed' as const:'uncertain' as const;
        const action={...request,state,error:state==='uncertain'?'恢复回复未确认；只核对原请求，不会重复提交。':error instanceof Error?error.message:'恢复请求未被接受。'},next={...this.state.optimizationActions,[origin]:action};
        if(known)try{this.optimizationJournal.save(next);}catch(storageError){this.update({optimizationJournalError:storageError instanceof Error?storageError.message:'恢复记录仍需核对。'});}
        else if(!submitted){let saved={};try{saved=this.optimizationJournal.read();}catch{}this.update({optimizationActions:{...this.state.optimizationActions,...saved},optimizationJournalError:action.error});await this.refresh();return;}
        this.update({optimizationActions:next});await this.refresh();
      }}finally{this.end(token,generation);}
    };
    const pending=work().finally(()=>{if(this.optimizationWork.get(origin)===pending)this.optimizationWork.delete(origin);});this.optimizationWork.set(origin,pending);return pending;
  };
  refresh=():Promise<void>=>{
    if(!this.running)return Promise.resolve();if(this.refreshing)return this.refreshing;
    const generation=this.generation;this.update({loading:true});
    const work=async()=>{
      try{
        for(;;){
          const version=this.updateVersion,intent=this.selectionVersion;
          let payload:MeshResponse;
          try{payload=await this.request('/documents/'+encodeURIComponent(this.options.documentId)+'/mesh/jobs');}
          catch(reason){
            const status=(reason as {payload?:MeshResponse})?.payload?.meshCatalog;
            if(status!==undefined){let catalog=parseMeshCatalog(status);if(!this.current(generation))return;this.update({catalog,historyKnown:false});if(catalog.state==='recovering'){catalog=await this.waitCatalog(generation,catalog);if(!this.current(generation))return;if(catalog.state==='ready')continue;}}
            throw reason;
          }
          if(!this.current(generation))return;
          if(version!==this.updateVersion)continue;
          if(!Array.isArray(payload.jobs))throw Error('网格任务列表响应无效，未替换当前记录。');
          payload.jobs=payload.jobs.map(job=>this.job(job) as MeshJobSummary);
          const catalog=payload.meshCatalog===undefined?{state:'ready' as const,attemptId:null,stored:payload.jobs.length,canRetry:false}:parseMeshCatalog(payload.meshCatalog);
          if(catalog.state!=='ready'||catalog.stored===null||catalog.stored<payload.jobs.length)throw Error('网格历史尚未完整就绪，未采用部分记录。');
          const list=payload.jobs;this.reconciledVersion=version;const cancelResolved=this.errorSource==='cancel'&&this.uncertainCancel&&list.some(job=>job.jobId===this.uncertainCancel&&!isMeshJobActive(job));const recoveredError=this.errorSource==='result'&&this.errorJobId&&list.some(job=>job.jobId===this.errorJobId&&job.state==='complete'&&job.completionRecovery?.state==='complete');const clearError=this.errorSource==='list'||this.errorSource==='catalog'||Boolean(cancelResolved)||Boolean(recoveredError);if(clearError){this.errorSource=null;this.errorJobId=null;this.uncertainCancel=null;}this.update({jobs:list,completionActions:this.reconcileCompletionActions(list),tetraActions:this.reconcileTetraActions(list),optimizationActions:this.reconcileOptimizationActions(list),catalog,historyKnown:true,catalogUncertain:false,surfaceAvailable:payload.surfaceReconstruction?.configured===true,tetraAvailable:payload.discreteTetra?.configured===true,tetraDerivationAvailable:payload.discreteTetra?.derivation?.supported===true,...(clearError?{error:''}:{})});
          const prepare=this.prepareFollow;
          if(prepare&&prepare.intent===this.selectionVersion){const target=list.find(job=>job.jobId===prepare.jobId);if(target?.state==='complete'||target&&['failed','cancelled','interrupted'].includes(target.state)){this.prepareFollow=null;if(target.state==='complete'&&target.derivation?.canStart&&target.freshness?.status==='current')void this.prepareTetra(target.jobId);}}
          const ready=list.find(job=>job.jobId===this.state.selectedTetraId&&job.kind==='discrete-tetra'&&job.derivation?.state==='ready');
          if(ready&&ready.jobId!==this.state.selectedJobId&&intent===this.selectionVersion)await this.load(ready.jobId,intent);
          if(intent!==this.selectionVersion||!this.automaticSelection)return;
          const active=list.find(isMeshJobActive);if(active&&!this.follow)this.follow=active.jobId;
          const report=!this.state.selectedJobId&&!this.state.selectedInspectionId&&!this.follow?list.find(job=>job.preparationSummary?.reportAvailable&&!isMeshJobActive(job)):null;
          const completed=list.find(job=>(job.state==='complete'||job.state==='failed'&&job.preparationSummary?.reportAvailable)&&job.jobId===this.follow)
            ||(!this.follow&&!this.state.selectedJobId&&!this.state.selectedTetraId&&!this.state.selectedSurfaceId&&!this.state.selectedInspectionId?list.find(job=>job.state==='complete'&&job.kind!=='preparation'):null);
          if(completed&&completed.jobId!==(completed.kind==='surface-reconstruction'?this.state.selectedSurfaceId:completed.kind==='discrete-tetra'?this.state.selectedTetraId:completed.kind==='preparation'||completed.state==='failed'?this.state.selectedInspectionId:this.state.selectedJobId))await this.load(completed.jobId,intent);
          if(!this.current(generation))return;
          if(version!==this.updateVersion)continue;
          if(intent!==this.selectionVersion)return;
          if(report&&report.jobId!==this.state.selectedInspectionId)await this.load(report.jobId,intent);
          if(!this.current(generation))return;
          if(version!==this.updateVersion)continue;
          if(intent!==this.selectionVersion)return;
          const followed=list.find(job=>job.jobId===this.follow);
          if(followed&&['failed','interrupted'].includes(followed.state)){this.errorSource='result';this.errorJobId=followed.jobId;this.update({error:followed.error||'本次网格任务未完成，请检查任务记录；未自动重试。'});}
          if(!followed||!isMeshJobActive(followed))this.follow=null;
          return;
        }
      }catch(reason){if(this.current(generation)){this.errorSource='list';const confirmed=(reason as {payload?:MeshResponse})?.payload?.meshCatalog!==undefined;const message=reason instanceof Error&&/[\u4e00-\u9fff]/.test(reason.message)?reason.message:'网格任务状态暂时无法读取，保留上次记录；请只读核对恢复状态。';this.update({historyKnown:false,catalogUncertain:this.state.catalog.state==='recovering'||(this.state.catalogRecoveryPending&&!this.state.historyKnown&&!confirmed),error:message});}}
      finally{if(this.current(generation)){this.refreshing=null;this.update({loading:false});clearTimeout(this.poll);if(this.state.active||this.state.jobs.some(job=>job.completionRecovery?.state==='checking'))this.poll=setTimeout(()=>void this.refresh(),this.options.pollMs??1200);}}
    };
    this.refreshing=work();return this.refreshing;
  };
  create=async(options:({baseRevision:number|null;kind?:'mesh'|'preparation';deepCheck?:boolean;preparationJobId?:string}&({strategyRef:MeshStrategyRef;repairMode?:never;qualityThreshold?:never;qualityPolicy?:never;sizing?:never;optimization?:never}|{strategyRef?:never;repairMode:string;qualityThreshold:number;qualityPolicy?:'warning'|'strict';sizing?:MeshSizing;optimization?:MeshOptimization}))|{kind:'surface-reconstruction';baseRevision:number}|{kind:'discrete-tetra';baseRevision:number;discreteTetra:DiscreteTetraSettings})=>{
    if(!this.running)return;const generation=this.generation,token=this.begin(),intent=++this.selectionVersion;
    try{
      const payload=await this.request('/documents/'+encodeURIComponent(this.options.documentId)+'/mesh/jobs',{...options,background:true,...(options.kind==='surface-reconstruction'||options.kind==='discrete-tetra'?{}:{selection:null})});if(!this.current(generation))return;
      const job=this.job(payload.meshJob);this.updateVersion++;
      const selected:Partial<MeshTaskSnapshot>={};
      if(intent===this.selectionVersion){
        this.follow=job.jobId;this.automaticSelection=true;
        if(options.kind==='discrete-tetra'){
          this.prepareFollow={jobId:job.jobId,intent};
          // Follow the accepted identity before polling: terminal failures must
          // expose their own checkpoint, not leave an older successful detail.
          Object.assign(selected,{setupRoute:'discrete',selectedTetraId:job.jobId,selectedJobId:null});
        }
      }
      this.update({jobs:[job,...this.state.jobs.filter(item=>item.jobId!==job.jobId)],...selected});await this.refresh();if(this.current(generation)&&this.reconciledVersion<this.updateVersion)await this.refresh();
    }catch(reason){if(this.current(generation)){this.errorSource='create';const detail=reason instanceof Error?reason.message:'创建网格任务失败。';const confirmed=Boolean((reason as {payload?:MeshResponse})?.payload);this.update({error:confirmed?detail:'创建任务回复未确认；请刷新任务记录核对，不要重复提交。\n'+detail});await this.refresh();}}
    finally{this.end(token,generation);}
  };
  cancel=async(jobId:string)=>{
    if(!this.running)return;const generation=this.generation,token=this.begin(true);
    if(this.prepareFollow?.jobId===jobId)this.prepareFollow=null;
    try{
      const payload=await this.request('/mesh/jobs/'+encodeURIComponent(jobId)+'/cancel',{});if(!this.current(generation))return;
      const job=this.job(payload.meshJob,jobId);this.updateVersion++;this.update({jobs:this.state.jobs.map(item=>item.jobId===jobId?{...item,...job}:item)});await this.refresh();if(this.current(generation)&&this.reconciledVersion<this.updateVersion)await this.refresh();
    }catch(reason){if(this.current(generation)){this.errorSource='cancel';const detail=reason instanceof Error?reason.message:'取消失败。';const confirmed=Boolean((reason as {payload?:MeshResponse})?.payload);this.uncertainCancel=confirmed?null:jobId;this.update({error:confirmed?detail:'取消回复未确认，任务可能仍在执行；请刷新任务记录核对。\n'+detail});}}
    finally{this.end(token,generation);}
  };
}
