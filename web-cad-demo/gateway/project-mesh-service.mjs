import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {captureMeshSource,assessMeshSource,qualifyMeshGroups} from "../shared/mesh-source.mjs";
import {handleMeshRoute} from "./mesh-routes.mjs";
import {MeshJobStore,isActiveMeshJob} from "./mesh-job-store.mjs";
import {MeshQualityQueryPool} from './mesh-quality-pool.mjs';
import {validateMeshBoundary,queryMeshBoundary} from "./mesh-boundary-query.mjs";
import {validatePreparation,preparationSummary} from "./mesh-preparation-report.mjs";
import {meshAdmitted} from '../shared/mesh-admission.mjs';
import {captureMeshInventory} from './mesh-admission.mjs';
import {readMeshRenderChunk} from './mesh-render-store.mjs';
import {MeshArtifactPool} from './mesh-artifact-pool.mjs';
import {MeshComputeGate} from './mesh-compute-gate.mjs';
import {meshCachePolicy} from './mesh-cache-capacity.mjs';
import {normalizeMeshSizing,validateMeshSizingSource,resolveMeshSizing,validateMeshSizingReport} from '../shared/mesh-sizing.mjs';
import {normalizeMeshStrategyRef} from '../shared/mesh-strategy.mjs';
import {normalizeMeshQualityPolicy} from '../shared/mesh-quality-policy.mjs';
import {normalizeMeshOptimization,validateMeshOptimizationReport} from '../shared/mesh-optimization.mjs';
import {validateMeshResourceProof} from './mesh-resource-proof.mjs';
import {childExit} from './child-exit.mjs';
import {meshCatalogLimits} from './mesh-catalog.mjs';
import {parseMeshRecoveryRequest} from '../shared/mesh-completion-recovery.mjs';
import {SURFACE_TASK_KIND,normalizeSurfaceTaskSettings} from '../shared/discrete-surface-task.mjs';
import {captureProjectDiscreteSource} from './discrete-surface-source.mjs';
import {validateSurfaceResourceProof,surfaceExecutionInput,surfaceTaskResult,validateSurfaceTaskResult} from './discrete-surface-task-result.mjs';
import {discreteMemoryPolicy,meshMemoryPolicy} from './native-resource-policy.mjs';
import {normalizeSurfaceReportQuery} from './discrete-surface-report.mjs';
import {DISCRETE_TETRA_TASK_KIND,normalizeDiscreteTetraSettings} from '../shared/discrete-tetra-task.mjs';
import {captureProjectDiscreteTetraSource,captureProjectConstrainedTetraSource,isConstrainedCadTetraSource} from './cad-discrete-tetra.mjs';
import {captureCadMeshMaterials} from './cad-mesh-materials.mjs';
import {validateTetraResources,isConstrainedTetraJob,CONSTRAINED_TETRA_TASK_FAMILY} from './discrete-tetra-task-result.mjs';
import {discreteMeshSourceToken,parseDiscreteMeshDerivation,DERIVED_MESH_RESERVATION_BYTES} from './discrete-mesh-registration.mjs';
import {DISCRETE_MESH_FAMILY,DISCRETE_CONSTRAINED_MESH_FAMILY} from './discrete-mesh-family.mjs';
import {surfaceArtifactIO} from './surface-artifact-io.mjs';
import {TETRA_CHECKPOINT_RESERVATION_BYTES} from './discrete-tetra-checkpoint.mjs';
import {parseOptimizationRecoveryRequest,optimizationRecoverable,optimizationRecordHash,MAX_OPTIMIZATION_ATTEMPTS} from './mesh-optimization-recovery.mjs';
import {meshAgentSummary,meshAgentPageQuery} from '../shared/mesh-agent-summary.mjs';

const documentRoute=/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/mesh\/jobs$/;
const scopedJobRoute=/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/mesh\/jobs\/([A-Za-z0-9_-]{1,120})(?:\/(cancel|recover-completion|resume-optimization))?$/;
const jobRoute=/^\/api\/mesh\/jobs\/([A-Za-z0-9_-]{1,120})(?:\/(visibility|cancel|quality|boundary|render|recover-completion|resume-optimization|surface-report|derive|derive-discard))?$/;
export function isProjectMeshRoute(method,pathname) {
  return pathname==='/api/mesh/catalog'&&method==='GET'||pathname==='/api/mesh/catalog/recover'&&method==='POST'
    ||documentRoute.test(pathname)&&["GET","POST"].includes(method)
    ||jobRoute.test(pathname)&&["GET","POST","DELETE"].includes(method)
    ||scopedJobRoute.test(pathname)&&["GET","POST"].includes(method);
}
const failure=(status,code,error,extra={})=>({status,payload:{ok:false,protocolVersion:1,code,error,...extra}});

export class ProjectMeshService {
  constructor({dataDir,command,serializeDocument,worker,workerFactory,maxConcurrent=1,getPropertySchema,getMeshStrategy,artifactPool,storageBudget,cacheLimits={},maxStoredJobs=2000,maxJobsPerDocument=Math.min(500,maxStoredJobs),catalogLimits={},surfaceWorkerFactory,getCapabilities,surfaceMemoryLimitBytes=2*1024**3,maxSurfacePreparing=2,discreteTetraWorkerFactory,discreteTetraMemoryLimitBytes=2*1024**3}) {
    Object.assign(this,{dataDir,command,serializeDocument,worker,getPropertySchema,getMeshStrategy,storageBudget});this.admitting=new Set();this.activeRequests=new Set();this.optimizationSourcePins=new Map();
    this.workerFactory=workerFactory||(typeof worker?.fork==="function"?()=>worker.fork():null);
    if(surfaceWorkerFactory!=null&&typeof surfaceWorkerFactory!=='function')throw Error('Invalid surface worker factory');
    if(!Number.isSafeInteger(maxSurfacePreparing)||maxSurfacePreparing<1||maxSurfacePreparing>4)throw Error('Invalid surface source admission limit');
    Object.assign(this,{surfaceWorkerFactory,getCapabilities,maxSurfacePreparing});this.surfacePreparing=new Set();
    if(surfaceWorkerFactory)this.surfaceMemoryLimitBytes=discreteMemoryPolicy({DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:String(surfaceMemoryLimitBytes)}).limitBytes;
    if(discreteTetraWorkerFactory!=null&&typeof discreteTetraWorkerFactory!=='function')throw Error('Invalid discrete tetra worker factory');
    this.discreteTetraWorkerFactory=discreteTetraWorkerFactory;
    if(discreteTetraWorkerFactory){this.surfaceMemoryLimitBytes=discreteMemoryPolicy({DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:String(surfaceMemoryLimitBytes)}).limitBytes;this.discreteTetraMemoryLimitBytes=meshMemoryPolicy({MESH_WORKER_MEMORY_LIMIT_BYTES:String(discreteTetraMemoryLimitBytes)}).limitBytes;}
    this.maxConcurrent=Math.max(1,Math.min(4,Math.floor(maxConcurrent)));
    this.store=new MeshJobStore(dataDir);this.queue=[];this.running=0;this.closed=false;this.stopObservations=new Set();this.recoveryTasks=new Set();this.derivationTasks=new Set();
    this.computeGate=new MeshComputeGate();
    this.cachePolicy=meshCachePolicy(dataDir,cacheLimits);
    if(!Number.isSafeInteger(maxStoredJobs)||maxStoredJobs<1||maxStoredJobs>10000||!Number.isSafeInteger(maxJobsPerDocument)||maxJobsPerDocument<1||maxJobsPerDocument>maxStoredJobs)throw Error('Invalid mesh task retention capacity');this.maxStoredJobs=maxStoredJobs;this.maxJobsPerDocument=maxJobsPerDocument;
    this.qualityQueries=new MeshQualityQueryPool({computeGate:this.computeGate,cachePolicy:this.cachePolicy});
    this.artifacts=artifactPool||new MeshArtifactPool({dataDir,computeGate:this.computeGate});
    this.renderProofs=new Map();
    this.jobs=new Map();this.catalog={state:'recovering',limits:meshCatalogLimits(catalogLimits)};
    this.ready=this.beginCatalogRecovery();
  }
  beginCatalogRecovery(previousAttemptId){
    const attemptId=crypto.randomUUID();this.catalog={state:'recovering',attemptId,previousAttemptId,limits:this.catalog.limits};
    return this.artifacts.execute({operation:'recover-catalog',catalogLimits:this.catalog.limits}).then(async result=>{
      if(this.closed)return;
      if(!result||!Array.isArray(result.jobs)||!result.stats)throw Object.assign(Error('网格历史线程没有返回完整目录。'),{code:'MESH_CATALOG_UNAVAILABLE'});
      const recovered=new Map(result.jobs.map(job=>[job.jobId,job]));
      if(recovered.size!==result.jobs.length)throw Object.assign(Error('网格历史任务身份重复。'),{code:'MESH_CATALOG_ID_CONFLICT'});
      for(const job of recovered.values()){if(job.meshSummary)job.meshSummary={...job.meshSummary,admission:null};if(job.completionReceipt)job.persistence={basis:'completion-receipt-v1',metadataSynchronized:false};}
      let cleanupFailures=0;
      for(const job of recovered.values())if(!job.errorCode?.startsWith('MESH_METADATA_')){
        for(const file of Object.values(this.sourcePaths(job)))try{await fs.promises.rm(file,{force:true});}catch{cleanupFailures++;}
        if(this.closed)return;
      }
      this.jobs=recovered;this.catalog={...this.catalog,state:'ready',stats:{...result.stats,cleanupFailures}};
    }).catch(error=>{this.catalog={...this.catalog,state:this.closed?'stopped':'unavailable',code:error.code?.startsWith('MESH_CATALOG_')?error.code:'MESH_CATALOG_UNAVAILABLE'};});
  }
  catalogStatus(){const assetPending=this.assets&&this.catalog.state==='ready'&&this.assets.phase!=='ready',state=this.closed?'stopped':assetPending?this.assets.phase==='unavailable'?'unavailable':'recovering':this.catalog.state;return {version:1,state,attemptId:assetPending?this.assets.attemptId:this.catalog.attemptId,canRetry:state==='unavailable',stored:state==='ready'?this.jobs.size+(this.assets?.count()||0):null,...(state==='unavailable'?{code:assetPending?'MESH_ASSET_REGISTRY_UNAVAILABLE':this.catalog.code}:{}),limits:this.catalog.limits,...(this.catalog.stats?{stats:this.catalog.stats}:{})};}
  catalogResponse(status=200){return {status,payload:{ok:true,protocolVersion:1,meshCatalog:this.catalogStatus()}};}
  retryCatalog(input){
    if(this.closed)return failure(503,'MESH_SERVICE_STOPPING','网格服务正在停止。',{meshCatalog:this.catalogStatus()});
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof input.failedAttemptId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.failedAttemptId))return failure(400,'MESH_CATALOG_REQUEST_INVALID','重新读取必须指定准确的失败记录，不能修改恢复额度。');
    if(this.assets&&this.catalog.state==='ready'){
      if(this.assets.previousAttemptId===input.failedAttemptId&&['recovering','ready'].includes(this.assets.phase))return this.catalogResponse(this.assets.phase==='recovering'?202:200);
      if(this.assets.phase==='unavailable'){if(this.assets.attemptId!==input.failedAttemptId)return failure(409,'MESH_CATALOG_ATTEMPT_CHANGED','恢复状态已变化，未开始另一轮读取。',{meshCatalog:this.catalogStatus()});this.assets.start(input.failedAttemptId);return this.catalogResponse(202);}
    }
    if(this.catalog.previousAttemptId===input.failedAttemptId&&this.catalog.state==='recovering')return this.catalogResponse(202);
    if(this.catalog.previousAttemptId===input.failedAttemptId&&this.catalog.state==='ready')return this.catalogResponse();
    if(this.catalog.state!=='unavailable')return failure(409,'MESH_CATALOG_NOT_RETRYABLE','当前历史无需重新恢复；没有重扫或中断现有任务。',{meshCatalog:this.catalogStatus()});
    if(this.catalog.attemptId!==input.failedAttemptId)return failure(409,'MESH_CATALOG_ATTEMPT_CHANGED','恢复状态已变化，请核对当前结果；没有发起第二次恢复。',{meshCatalog:this.catalogStatus()});
    this.ready=this.beginCatalogRecovery(input.failedAttemptId);return this.catalogResponse(202);
  }
  async catalogAccess(){await this.ready;if(this.closed)return failure(503,'MESH_SERVICE_STOPPING','网格服务正在停止。');if(this.catalog.state!=='ready')return failure(503,this.catalog.code||'MESH_CATALOG_UNAVAILABLE','网格历史未完整恢复，原结果保留；未返回空历史或开始新剖分。',{meshCatalog:this.catalogStatus()});if(this.assets)try{await this.assets.access();}catch(error){return failure(503,error.code,error.message,{meshCatalog:this.catalogStatus()});}return null;}
  async withAssetAccess(documentId,action){
    if(this.assets&&documentId&&(this.assets.fences.has(documentId)||this.assets.projectBusy(documentId)))return failure(409,'PROJECT_MESH_SNAPSHOT_BUSY','工程文件事务正在使用此网格基线，请结束后重试。');
    const entry={documentId};this.activeRequests.add(entry);try{return await action();}finally{this.activeRequests.delete(entry);}
  }
  storedCount(){return this.jobs.size+(this.assets?.count()||0)+(this.assets?.pendingCount()||0);}
  documentStoredCount(id){return [...this.jobs.values()].filter(job=>job.documentId===id).length+(this.assets?.count(id)||0);}
  live(documentId) {return this.serializeDocument(documentId,()=>this.command("document.summary",{documentId}));}
  ownedChildren(){return new Set([...(this.worker?.children||[]),...[...this.jobs.values()].flatMap(job=>[...(job.client?.children||[])])]);}
  resourceStatus(){const clients=new Set([this.worker,...[...this.jobs.values()].map(job=>job.client)].filter(Boolean));return [...clients].filter(client=>typeof client.resourceStatus==='function').map(client=>client.resourceStatus());}
  surfaceStatus(){return {configured:Boolean(this.surfaceWorkerFactory),state:this.surfaceWorkerFactory?'configured':'not-configured',memoryLimitBytes:this.surfaceMemoryLimitBytes??null,preparing:this.surfacePreparing.size,maxPreparing:this.maxSurfacePreparing,normalMeshAdmitted:false,tetrahedralReady:false};}
  discreteTetraStatus(){return {configured:Boolean(this.discreteTetraWorkerFactory),normalMeshAdmitted:false,automaticReplay:false,defaultQualityMode:'strict',materialPolicy:'require-consistent',derivation:{supported:Boolean(this.storageBudget),explicit:true,defaultVisible:false,minimumReservationBytes:DERIVED_MESH_RESERVATION_BYTES}};}
  retirementStatus(){return {uncertainJobs:[...this.jobs.values()].filter(job=>job.stopUnconfirmed).length,observations:this.stopObservations.size,closed:this.closed};}
  observeWorkerStop(job){
    if(job.stopObservation||!Array.isArray(job.stopChildren))return;
    const observation=Promise.all(job.stopChildren.map(childExit)).then(()=>{if(this.jobs.get(job.jobId)===job&&job.stopUnconfirmed)return this.reconcileWorkerStops();});
    job.stopObservation=observation;this.stopObservations.add(observation);
    observation.then(()=>this.stopObservations.delete(observation),error=>{this.stopObservations.delete(observation);job.stopObservationError=error;console.error('[mesh] Late-exit observation failed:',error.message);});
  }
  reconcileWorkerStops(){
    if(this.reconcilingStops)return this.reconcilingStops;
    const work=(async()=>{for(const job of this.jobs.values()){
      if(!job.stopUnconfirmed||!Array.isArray(job.stopChildren)||job.stopChildren.some(child=>child.exitCode==null&&child.signalCode==null))continue;
      job.stopUnconfirmed=false;job.stopping=null;job.client=null;job.snapshot=null;job.terminationReason||='shutdown';await this.finishTermination(job,{reconcile:true});delete job.stopChildren;
    }this.pump();})();this.reconcilingStops=work;return work.finally(()=>{if(this.reconcilingStops===work)this.reconcilingStops=null;});
  }
  async safeLive(documentId) {try{return await this.live(documentId);}catch{return null;}}
  descriptor(job,view) {
    let freshness=assessMeshSource(job.source,view,job.documentId);
    if(job.kind===DISCRETE_TETRA_TASK_KIND&&freshness.status==='current')try{if(captureCadMeshMaterials(view).sha256!==job.materialSourceSha256)freshness={status:'stale',reason:'材料赋值或使用中的材料定义已变化，结果保持隐藏。',changedBodyIds:[]};}catch{freshness={status:'unverified',reason:'当前工程材料无法完整核对，结果保持隐藏。',changedBodyIds:[]};}
    const completionRecovery=this.completionRecoveryInfo(job),summary=job.kind===DISCRETE_TETRA_TASK_KIND?job.derivedMeshSummary:job.meshSummary;
    return {jobId:job.jobId,documentId:job.documentId,revision:job.source?.revision??null,selection:{kind:"all"},
      kind:job.kind||"mesh",preparationJobId:job.preparationJobId,preparationSummary:job.preparationSummary,
      source:job.source,freshness,state:job.state,admission:summary?.admission||null,visible:job.visible&&job.state==="complete"&&freshness.status==="current"&&meshAdmitted(summary?.admission),
      requestedVisible:Boolean(job.visible),createdAt:job.createdAt,startedAt:job.startedAt,finishedAt:job.finishedAt,
      ...(job.kind===SURFACE_TASK_KIND?{surfaceSummary:job.surfaceSummary||null,normalMeshAdmitted:false,tetrahedralReady:false}:{}),
      ...(job.kind===DISCRETE_TETRA_TASK_KIND?{discreteStage:job.discreteStage,discreteTetraSummary:job.discreteTetraSummary||null,discreteFailureSummary:job.discreteFailureSummary||null,...(job.artifact?.checkpoint?{checkpoint:{recorded:true,normalMeshAdmitted:false,automaticReplay:false}}:{}),normalMeshAdmitted:meshAdmitted(summary?.admission),derivation:this.derivationInfo(job)}:{}),
      recovered:Boolean(job.recovered),options:job.options,processResources:job.processResources,bodyTopologyRevisions:job.source
        ?Object.fromEntries(job.source.bodies.map(body=>[body.bodyId,body.topologyRevision])):null,
      ...(completionRecovery?{completionRecovery}:{}),...(job.optimizationRecovery?{optimizationAttempt:{...job.optimizationRecovery}}:{}),...(this.optimizationRecoveryInfo(job)?{optimizationRecovery:this.optimizationRecoveryInfo(job)}:{}),...(job.persistence?{persistence:job.persistence}:{}),...(job.error?{error:job.error,errorCode:job.errorCode}:{})};
  }
  derivationInfo(job){
    const sourceToken=discreteMeshSourceToken(job),attempt=job.derivationAttempt;
    const state=attempt?.state==='working'?'working':job.derivedReadError?'invalid':job.derivedRegistration?'ready':job.derivedMeshPresent?'unverified':attempt?.state||'available';
    return {version:1,state,sourceToken,canStart:Boolean(sourceToken&&job.state==='complete'&&job.options?.discreteTetra?.quality?.mode==='strict'&&state!=='working'&&!job.derivedMeshPresent&&!job.deleting&&!job.discardingDerived),...(attempt?{requestId:attempt.requestId}:{}),...(job.derivedReadError?{code:job.derivedReadError.code,error:job.derivedReadError.message}:attempt?.code?{code:attempt.code,error:attempt.error}:{}),defaultVisible:false};
  }
  async requestDerivation(job,input){
    let request;try{request=parseDiscreteMeshDerivation(input);}catch(error){return failure(400,error.code,error.message);}
    if(this.closed||!this.storageBudget)return failure(503,'MESH_DERIVATION_UNAVAILABLE','派生服务正在停止或尚未配置磁盘准入。');
    if(job.kind!==DISCRETE_TETRA_TASK_KIND||job.state!=='complete'||job.options?.discreteTetra?.quality?.mode!=='strict'||request.sourceToken!==discreteMeshSourceToken(job))return failure(409,'MESH_DERIVATION_SOURCE_CONFLICT','只能为来源未变化的已完成严格离散任务生成普通网格。');
    const existing=job.derivationAttempts?.get(request.requestId);
    if(existing){if(existing.sourceToken!==request.sourceToken)return failure(409,'MESH_DERIVATION_SOURCE_CONFLICT','同一操作身份不能绑定不同来源。');return {status:existing.state==='working'?202:200,payload:{ok:true,meshJob:this.descriptor(job,await this.safeLive(job.documentId))}};}
    if(job.derivationAttempt?.state==='working'||job.deleting||job.discardingDerived)return failure(409,'MESH_DERIVATION_BUSY','原派生操作或清理尚未结束，没有开始第二次写入。');
    if(this.derivationTasks.size>=32||(job.derivationAttempts?.size||0)>=32)return failure(429,'MESH_DERIVATION_LIMIT','派生操作名额或本任务尝试记录已达上限。');
    const view=await this.safeLive(job.documentId);
    if(this.closed||this.jobs.get(job.jobId)!==job||job.deleting||job.discardingDerived||job.derivationAttempt?.state==='working')return failure(409,'MESH_DERIVATION_BUSY','任务在准入期间已变化，请核对原操作。');
    if(this.derivationTasks.size>=32||(job.derivationAttempts?.size||0)>=32)return failure(429,'MESH_DERIVATION_LIMIT','派生名额在来源核对期间已满。');
    if(this.descriptor(job,view).freshness.status!=='current')return failure(409,'MESH_SOURCE_STALE','当前几何或材料与原剖分不一致，未生成新的派生材料。');
    const attempt={...request,state:'working',controller:new AbortController()};job.derivationAttempt=attempt;job.derivationAttempts||=new Map();job.derivationAttempts.set(request.requestId,attempt);
    const work=this.performDerivation(job,attempt);job.derivationPromise=work;this.derivationTasks.add(work);work.finally(()=>{this.derivationTasks.delete(work);if(job.derivationPromise===work)delete job.derivationPromise;}).catch(()=>{});
    return {status:202,payload:{ok:true,meshJob:this.descriptor(job,view)}};
  }
  async performDerivation(job,attempt){
    let lease;const assertOwned=()=>{if(this.closed||attempt.controller.signal.aborted||this.jobs.get(job.jobId)!==job||job.state!=='complete'||job.deleting||job.discardingDerived||job.derivationAttempt!==attempt||discreteMeshSourceToken(job)!==attempt.sourceToken)throw Object.assign(Error('派生操作已取消、停止或来源发生变化。'),{code:'MESH_DERIVATION_CANCELLED'});};
    try{
      assertOwned();
      if(!fs.existsSync(this.store.derivedDirectory(job))){
        lease=await this.storageBudget.reserve('derive-'+job.jobId);assertOwned();
        if(lease.bytes<DERIVED_MESH_RESERVATION_BYTES)throw Object.assign(Error('当前磁盘预留不足以保存完整派生文件，未开始写入。'),{code:'MESH_STORAGE_CAPACITY'});
        await this.artifacts.execute({operation:'derive-tetra-mesh',job,signal:attempt.controller.signal,beforePublish:async()=>{assertOwned();await lease.verify();assertOwned();const view=await this.safeLive(job.documentId);assertOwned();if(this.descriptor(job,view).freshness.status!=='current')throw Object.assign(Error('派生期间几何或材料已变化，未发布过期结果。'),{code:'MESH_SOURCE_STALE'});}});
      }
      assertOwned();await this.readResult(job,{signal:attempt.controller.signal});assertOwned();if(!job.derivedRegistration)throw Object.assign(Error('派生网格没有完整可认证的登记。'),{code:'MESH_DERIVED_ARTIFACT_INVALID'});
      attempt.state='complete';job.visible=false;
    }catch(error){attempt.state=attempt.controller.signal.aborted||this.closed||job.deleting||job.discardingDerived?'cancelled':'failed';attempt.code=error.code||'MESH_DERIVATION_FAILED';attempt.error=error.message;job.visible=false;}
    finally{lease?.release();}
  }
  acceptDerivedRead(job,result,stamp){
    if(!result.derivedMeshRegistration)return result;
    const {derivedCertificate,...clean}=result;
    job.derivedMeshPresent=true;job.derivedRegistration=result.derivedMeshRegistration;job.derivedMeshSummary=result.derivedMeshRegistration.summary;delete job.derivedReadError;
    this.renderProofs.set(job.jobId,{stamp,usable:meshAdmitted(job.derivedMeshSummary.admission),verifiedAt:performance.now(),derivedCertificate});
    if(clean.mesh?.render?.groups)clean.mesh={...clean.mesh,render:{...clean.mesh.render,groups:qualifyMeshGroups(clean.mesh.render.groups,job.source)}};
    return clean;
  }
  async discardDerivation(job,input){
    let request;try{request=parseDiscreteMeshDerivation(input);}catch(error){return failure(400,error.code,error.message);}
    if(job.kind!==DISCRETE_TETRA_TASK_KIND||job.state!=='complete'||request.sourceToken!==discreteMeshSourceToken(job))return failure(409,'MESH_DERIVATION_SOURCE_CONFLICT','清理必须绑定原始已完成任务，不删除原剖分。');
    if(job.deleting||job.discardingDerived)return failure(409,'MESH_DERIVATION_BUSY','该任务正在清理。');job.discardingDerived=true;job.visible=false;let lease;
    try{job.derivationAttempt?.controller?.abort();await this.artifacts.cancelJob(job.jobId);await job.derivationPromise;lease=await this.computeGate.acquire({kind:'artifact'});if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','原任务已删除。');this.store.removeDerived(job);job.derivedMeshPresent=false;delete job.derivedRegistration;delete job.derivedMeshSummary;delete job.derivedReadError;delete job.derivationAttempt;this.renderProofs.delete(job.jobId);return {status:200,payload:{ok:true,meshJob:this.descriptor(job,await this.safeLive(job.documentId))}};}catch(error){return this.artifactFailure(error);}finally{lease?.release();job.discardingDerived=false;}
  }
  completionRecoveryInfo(job) {
    const attempt=job.recoveryAttempt||job.state==='complete'&&job.completionRecoveryReceipt&&{...job.completionRecoveryReceipt,state:'complete'};
    if(attempt)return {version:1,state:attempt.state,requestId:attempt.requestId,failedStateToken:attempt.failedStateToken,...(attempt.code?{code:attempt.code,error:attempt.error}:{})};
    if(job.state==='failed'&&job.errorCode==='MESH_COMPLETION_UNCOMMITTED'&&job.artifact?.result&&job.source&&/^[a-f0-9]{64}$/.test(job.metadataProof?.sha256))return {version:1,state:'available',failedStateToken:job.metadataProof.sha256};
    return null;
  }
  persist(job) {job.metadataProof=this.store.save(job);if(job.persistence)job.persistence.metadataSynchronized=true;}
  optimizationRecoveryInfo(job,{failedStateToken=job.metadataProof?.sha256}={}){
    if(!optimizationRecoverable(job)||!/^[a-f0-9]{64}$/.test(failedStateToken||''))return null;
    return {version:1,state:'available',failedStateToken,checkpointToken:job.artifact.checkpoint.sha256,canStart:Boolean(this.discreteTetraWorkerFactory?.checkpointSupported&&(!isConstrainedTetraJob(job)||this.discreteTetraWorkerFactory.constrainedSupported)),automaticReplay:false,newAttempt:true};
  }
  async resumeOptimization(origin,input,{assetRef}={}){
    let request;try{request=parseOptimizationRecoveryRequest(input);}catch(error){return failure(400,error.code,error.message);}
    const handle=assetRef?.assetId||origin.jobId,documentId=assetRef?.documentId||origin.documentId;
    const previous=[...this.jobs.values()].find(job=>job.documentId===documentId&&job.optimizationRecovery?.originHandle===handle&&job.optimizationRecovery.requestId===request.requestId);
    if(previous){const recovery=previous.optimizationRecovery;if(recovery.failedStateToken!==request.failedStateToken||recovery.checkpointToken!==request.checkpointToken)return failure(409,'MESH_OPTIMIZATION_RECOVERY_CONFLICT','同一恢复身份不能绑定不同失败记录或检查点。');return {status:isActiveMeshJob(previous)?202:200,payload:{ok:true,meshJob:this.descriptor(previous,await this.safeLive(documentId))}};}
    const token=assetRef?this.assets.registry.token(assetRef):origin.metadataProof?.sha256;
    if(!optimizationRecoverable(origin)||token!==request.failedStateToken||origin.artifact.checkpoint.sha256!==request.checkpointToken||assetRef&&this.assets.registry.state(assetRef).recovery?.state==='complete')return failure(409,'MESH_OPTIMIZATION_RECOVERY_CONFLICT','原失败状态或检查点已变化，不能作为新的恢复来源。');
    if(this.closed||!this.discreteTetraWorkerFactory?.checkpointSupported||isConstrainedTetraJob(origin)&&!this.discreteTetraWorkerFactory.constrainedSupported)return failure(503,'MESH_OPTIMIZATION_RECOVERY_UNAVAILABLE','当前后台没有匹配原来源类型的独立优化能力，未重新生成网格。');
    if(this.discreteTetraMemoryLimitBytes!==origin.options.nativeMemoryLimitBytes||this.surfaceMemoryLimitBytes!==origin.options.nativeSurfaceMemoryLimitBytes)return failure(409,'MESH_OPTIMIZATION_RECOVERY_RESOURCE_CHANGED','当前资源保护与原生成证明不匹配，未修改原设置或重新生成网格。');
    if([...this.jobs.values()].some(job=>job.documentId===documentId&&isActiveMeshJob(job)))return failure(409,'MESH_JOB_ALREADY_RUNNING','当前工程已有网格任务，未开始第二次优化。');
    if(this.storedCount()>=this.maxStoredJobs||this.documentStoredCount(documentId)>=this.maxJobsPerDocument)return failure(409,'MESH_TASK_CAPACITY','网格任务记录已达容量上限，未删除原任务。');
    const checkpointJobId=origin.optimizationRecovery?.checkpointJobId||origin.jobId;
    if([...this.jobs.values()].filter(job=>job.documentId===documentId&&job.optimizationRecovery?.checkpointJobId===checkpointJobId).length>=MAX_OPTIMIZATION_ATTEMPTS)return failure(429,'MESH_OPTIMIZATION_RECOVERY_LIMIT','该检查点的恢复尝试已达上限；原始诊断保留。');
    const view=await this.safeLive(documentId),fresh=assetRef?this.assets.fresh(assetRef,view):this.descriptor(origin,view).freshness;
    if(fresh.status!=='current')return failure(409,'MESH_SOURCE_STALE','几何或使用中的材料已变化，不能恢复原检查点。');
    const record=this.store.record(origin),recovery={version:1,...request,originKind:assetRef?'asset':'native',originHandle:handle,originJobId:origin.jobId,originDocumentId:origin.documentId,checkpointJobId,originRecordSha256:optimizationRecordHash(record)};
    const job={jobId:'mesh-'+crypto.randomUUID(),documentId,kind:DISCRETE_TETRA_TASK_KIND,state:'preparing',discreteStage:'capturing-source',visible:false,createdAt:new Date().toISOString(),source:{...structuredClone(origin.source),documentId},materialSourceSha256:origin.materialSourceSha256,options:structuredClone(origin.options),optimizationRecovery:recovery,controller:new AbortController()};delete job.options.storageReservationBytes;
    const current=()=>{if(assetRef){if(this.assets.registry.get(handle)!==assetRef||this.assets.registry.token(assetRef)!==request.failedStateToken)throw Object.assign(Error('原工程资产状态已变化。'),{code:'MESH_OPTIMIZATION_RECOVERY_CONFLICT'});}else if(this.jobs.get(handle)!==origin||origin.metadataProof?.sha256!==request.failedStateToken||optimizationRecordHash(this.store.record(origin))!==recovery.originRecordSha256)throw Object.assign(Error('原失败记录已变化。'),{code:'MESH_OPTIMIZATION_RECOVERY_CONFLICT'});};
    this.optimizationSourcePins.set(handle,(this.optimizationSourcePins.get(handle)||0)+1);
    const release=()=>{const count=this.optimizationSourcePins.get(handle)||0;if(count<=1)this.optimizationSourcePins.delete(handle);else this.optimizationSourcePins.set(handle,count-1);};
    try{const reply=await this.registerJob(job,documentId,true,async()=>{
      current();const captured=await this.artifacts.execute({operation:assetRef?'asset-capture-tetra-recovery':'capture-tetra-recovery',job,result:assetRef?{ref:this.assets.registry.workerRef(assetRef)}:{originJob:{jobId:origin.jobId,documentId:origin.documentId}},signal:job.controller.signal,beforePublish:async()=>{current();await this.verifyTetraCheckpointPublication(job);current();}});
      job.artifact=captured.artifact;job.processResources=validateTetraResources(job.options,captured.processResources);this.persist(job);if(job.terminationReason)return this.finishTermination(job);
      job.state='queued';job.discreteStage='queued';this.persist(job);this.queue.push(job);this.pump();
    });if(job.preparation)job.preparation.finally(release).catch(()=>{});else release();return reply;}catch(error){release();return this.artifactFailure(error);}
  }
  recoverCompletion(job,input) {
    let request;try{request=parseMeshRecoveryRequest(input);}catch{return failure(400,'MESH_COMPLETION_RECOVERY_INVALID_REQUEST','恢复必须绑定原失败状态和本次操作身份，不能附带建模参数。');}
    const info=this.completionRecoveryInfo(job);
    if(job.state==='complete'&&info?.state==='complete'&&info.failedStateToken===request.failedStateToken)return {status:200,payload:{ok:true,meshJob:this.descriptor(job,null)}};
    const existing=job.recoveryAttempts?.get(request.requestId);
    if(existing){if(existing.failedStateToken!==request.failedStateToken)return failure(409,'MESH_COMPLETION_RECOVERY_CONFLICT','同一恢复身份不能绑定不同失败记录。');return existing.state==='failed'?failure(409,existing.code,existing.error,{meshJob:this.descriptor(job,null)}):{status:existing.state==='checking'?202:200,payload:{ok:true,meshJob:this.descriptor(job,null)}};}
    if(job.recoveryAttempt?.state==='checking')return failure(409,'MESH_COMPLETION_RECOVERY_BUSY','原网格正在重新核对，没有开始第二次恢复。',{meshJob:this.descriptor(job,null)});
    if(this.closed||this.recoveryTasks.size>=32)return failure(this.closed?503:429,'MESH_COMPLETION_RECOVERY_BUSY','恢复服务正在停止或处理名额已满，未开始新的检查。');
    if(job.state!=='failed'||job.errorCode!=='MESH_COMPLETION_UNCOMMITTED'||!info||info.failedStateToken!==request.failedStateToken||job.stopUnconfirmed||job.client)return failure(409,'MESH_COMPLETION_RECOVERY_CONFLICT','任务不是原始可恢复失败，或进程尚未核验退出；未执行恢复。');
    job.recoveryAttempts||=new Map();if(job.recoveryAttempts.size>=32)return failure(429,'MESH_COMPLETION_RECOVERY_LIMIT','本任务的恢复尝试记录已达上限，原材料保留；请联系维护。');
    const attempt={...request,state:'checking'};job.recoveryAttempt=attempt;job.recoveryAttempts.set(request.requestId,attempt);
    const work=this.performCompletionRecovery(job,attempt);this.recoveryTasks.add(work);work.finally(()=>this.recoveryTasks.delete(work)).catch(()=>{});
    return {status:202,payload:{ok:true,meshJob:this.descriptor(job,null)}};
  }
  async performCompletionRecovery(job,attempt) {
    try{
      const retained=this.store.readCompletionRecovery(job,attempt.failedStateToken);
      this.artifacts.admissionMemo?.dropJob(job.jobId);
      const result=await this.artifacts.execute({operation:'read',job:retained.value});
      if(this.closed||this.jobs.get(job.jobId)!==job||job.recoveryAttempt!==attempt)throw Object.assign(Error(),{code:'MESH_COMPLETION_RECOVERY_STOPPED'});
      this.store.readCompletionRecovery(job,attempt.failedStateToken);
      const complete={...retained.value,state:'complete',finishedAt:new Date().toISOString()};delete complete.error;delete complete.errorCode;
      if(result.mesh)complete.meshSummary={dimension:result.mesh.dimension,nodeCount:result.mesh.nodeCount,elementCount:result.mesh.elementCount,quality:result.mesh.quality,admission:result.mesh.admission};
      if(result.surfaceSummary)complete.surfaceSummary=result.surfaceSummary;
      if(result.discreteTetraSummary){complete.discreteTetraSummary=result.discreteTetraSummary;complete.discreteStage='complete';}
      const recovery={requestId:attempt.requestId,failedStateToken:attempt.failedStateToken},additionalBytes=this.store.completionWriteBytes(complete,{recovery});
      if(this.storageBudget)await this.storageBudget.verifyPublication(additionalBytes);
      if(this.closed||this.jobs.get(job.jobId)!==job||job.recoveryAttempt!==attempt)throw Object.assign(Error(),{code:'MESH_COMPLETION_RECOVERY_STOPPED'});
      this.store.readCompletionRecovery(job,attempt.failedStateToken);
      const persistence=this.store.commitCompletion(complete,{recovery});
      Object.assign(job,complete,{visible:false,completionRecoveryReceipt:recovery,persistence:{basis:persistence.basis,metadataSynchronized:persistence.metadataSynchronized}});delete job.error;delete job.errorCode;
      attempt.state='complete';this.renderProofs.delete(job.jobId);
    }catch(error){
      const known=['MESH_COMPLETION_RECOVERY_CONFLICT','MESH_COMPLETION_RECOVERY_STOPPED','MESH_ARTIFACT_BUSY','MESH_ARTIFACT_TIMEOUT','MESH_ARTIFACT_CANCELLED','MESH_ARTIFACT_LIMIT','MESH_STORAGE_CAPACITY','MESH_STORAGE_FREE_SPACE','MESH_STORAGE_UNAVAILABLE'];
      attempt.state='failed';attempt.code=error.code==='MESH_ARTIFACT_INVALID'?'MESH_COMPLETION_RECOVERY_INVALID_RESULT':known.includes(error.code)?error.code:'MESH_COMPLETION_RECOVERY_FAILED';attempt.error=error.code==='MESH_COMPLETION_RECOVERY_CONFLICT'?'原失败记录已变化，未覆盖现有记录。':error.code==='MESH_COMPLETION_RECOVERY_STOPPED'?'服务已停止，未发布迟到的恢复结果。':error.code==='MESH_ARTIFACT_INVALID'?'原结果文件缺失或内容校验不通过，未发布；材料已保留。':['MESH_STORAGE_CAPACITY','MESH_STORAGE_FREE_SPACE'].includes(error.code)?'存储空间不足以保存完成记录；原结果保留，没有重新剖分。':'原结果尚未完成重新校验或保存，材料保留；没有重新剖分。';
    }
  }
  async verifyCompletionBudget(job) {
    if(!job.storageLease)return;
    let additionalBytes;
    try{additionalBytes=this.store.completionWriteBytes({...job,state:'complete',finishedAt:new Date().toISOString()});}
    catch{throw Object.assign(Error('网格已生成，但完成记录无法核对；原结果保留，未作为成功发布。'),{code:'MESH_COMPLETION_UNCOMMITTED',status:503});}
    try{await job.storageLease.verify({additionalBytes});}catch(error){if(job.kind===DISCRETE_TETRA_TASK_KIND&&job.artifact?.result)throw Object.assign(Error('网格材料已保留，但完成记录的磁盘准入未通过；请释放空间后明确恢复，未自动重新剖分。'),{code:'MESH_COMPLETION_UNCOMMITTED',status:503,cause:error});throw error;}
  }
  commitCompletion(job) {
    let persistence;
    try{persistence=this.store.commitCompletion(job);}
    catch{throw Object.assign(Error('网格已生成，但完成凭据未能保存；原结果已保留，未作为成功发布，也不会自动重新剖分。'),{code:'MESH_COMPLETION_UNCOMMITTED',status:503});}
    job.persistence={basis:persistence.basis,metadataSynchronized:persistence.metadataSynchronized};
    if(!persistence.metadataSynchronized)try{console.warn('[mesh] Durable completion retained; mutable metadata update unavailable: '+JSON.stringify(persistence.diagnostic));}catch{/* Auxiliary logging cannot replace a durable mesh result. */}
  }
  sourcePaths(job) {
    const directory=path.join(this.dataDir,"mesh-sources");
    const sourcePath=path.join(directory,job.documentId+"-"+job.jobId+".brep");
    return {sourcePath,manifestPath:sourcePath+".manifest.json"};
  }
  cleanupSources(job) {
    const {sourcePath,manifestPath}=this.sourcePaths(job);
    for(const file of [sourcePath,manifestPath])try{fs.rmSync(file,{force:true});}catch(error){console.error("[mesh] Source cleanup failed:",error.message);}
  }
  removeOutput(job) {for(const file of [this.store.output(job),this.store.qualityOutput(job),this.store.renderOutput(job)])try{fs.rmSync(file,{force:true});}catch(error){console.error("[mesh] Output cleanup failed:",error.message);}}
  renderStamp(job){return JSON.stringify([job.source,job.artifact?.result,job.artifact?.quality,job.artifact?.mesh,job.artifact?.render,job.artifact?.discreteSource,job.artifact?.partition,job.artifact?.discreteFailure,job.artifact?.checkpoint,job.materialSourceSha256,...(job.optimizationRecovery?[job.optimizationRecovery,job.artifact.optimizationOrigin]:[])]);}
  async readResult(job,{signal}={}) {
    const stamp=this.renderStamp(job),state=job.state;
    try{let result=await this.artifacts.execute({operation:'read',job,signal});if(this.jobs.get(job.jobId)!==job)throw Object.assign(Error('网格任务已删除。'),{code:'MESH_JOB_NOT_FOUND'});if(stamp!==this.renderStamp(job)||state!==job.state||job.deleting||job.discardingDerived)throw Object.assign(Error('网格材料或任务状态在校验期间变化，请重新读取。'),{code:'MESH_ARTIFACT_CHANGED'});if(result.derivedMeshRegistration)result=this.acceptDerivedRead(job,result,stamp);else if(result.mesh){job.meshSummary={...job.meshSummary,admission:result.mesh.admission};this.renderProofs.set(job.jobId,{stamp,usable:meshAdmitted(result.mesh.admission),verifiedAt:performance.now()});}else if(job.kind===DISCRETE_TETRA_TASK_KIND){job.derivedMeshPresent=false;delete job.derivedRegistration;delete job.derivedMeshSummary;this.renderProofs.delete(job.jobId);}return result;}
    catch(error) {
      if(this.jobs.get(job.jobId)!==job)throw Object.assign(Error('网格任务已删除。'),{code:'MESH_JOB_NOT_FOUND'});
      if(error.code==='MESH_DERIVED_ARTIFACT_INVALID'){job.derivedReadError=error;job.visible=false;delete job.derivedRegistration;delete job.derivedMeshSummary;this.renderProofs.delete(job.jobId);}
      if(error.code==='MESH_ARTIFACT_INVALID'&&this.jobs.get(job.jobId)===job){job.state="failed";job.visible=false;job.errorCode=error.code;job.error=error.message;this.renderProofs.delete(job.jobId);this.persist(job);}throw error;
    }
  }
  artifactFailure(error){const io=surfaceArtifactIO(error,{kind:DISCRETE_TETRA_TASK_KIND});if(io)return failure(503,io.code,io.error);return failure(error.code==='MESH_JOB_NOT_FOUND'?404:['MESH_ARTIFACT_INVALID','MESH_DERIVED_ARTIFACT_INVALID','MESH_SOURCE_STALE'].includes(error.code)?409:error.code==='MESH_ARTIFACT_CANCELLED'?499:503,error.code||'MESH_ARTIFACT_WORKER_FAILED',error.message);}
  async sealResult(job,result){const sealed=await this.artifacts.execute({operation:'seal',job,result});return sealed;}
  async outputAccess(filename,diagnostic=false,options={}){const id=filename.replace(/\.msh$/,''),documentId=this.jobs.get(id)?.documentId||this.assets?.registry.get(id)?.documentId;return this.withAssetAccess(documentId,()=>this.outputAccessRequest(filename,diagnostic,options));}
  async outputAccessRequest(filename,diagnostic=false,{signal}={}){
    const catalogError=await this.catalogAccess();if(catalogError)return catalogError;
    const assetId=filename.replace(/\.msh$/,''),asset=this.assets?.registry.get(assetId);
    if(asset)try{const access=await this.assets.outputAccess(asset,{signal,diagnostic});return {...access,...(access.status===200?{assetOutput:true}:{})};}catch(error){return this.artifactFailure(error);}
    if(this.assets?.registry.entries.has(assetId))return failure(404,'MESH_JOB_NOT_FOUND','该恢复资产已经删除。');
    const job=[...this.jobs.values()].find(value=>path.basename(this.store.output(value))===filename);
    if(!job)return {status:200,filename,headers:{'X-CAD-Mesh-Admission':'file-tool'}};
    if(job.kind===DISCRETE_TETRA_TASK_KIND&&!fs.existsSync(this.store.derivedDirectory(job)))return failure(409,'MESH_DISCRETE_ADMISSION_REQUIRED','请先明确生成并验收派生网格，再下载 MSH。');
    if(job.kind===SURFACE_TASK_KIND)return failure(409,'SURFACE_RESULT_NOT_VOLUME','表面交叉重构不是体网格，不能作为 MSH 下载。');
    if(job.state!=='complete')return failure(409,'MESH_OUTPUT_NOT_READY','任务没有可校验的网格文件。');
    try{
      const result=await this.readResult(job,{signal}),admission=result.mesh?.admission;
      if(job.state!=='complete')return failure(409,'MESH_OUTPUT_NOT_READY','任务已不可用。');
      if(!meshAdmitted(admission)&&!diagnostic)return failure(409,'MESH_ADMISSION_REQUIRED','此网格未通过工程验收；如需排查，请明确下载诊断文件。',{admission});
      if(job.kind===DISCRETE_TETRA_TASK_KIND){const view=await this.safeLive(job.documentId);if(this.jobs.get(job.jobId)!==job||job.state!=='complete'||job.deleting||job.discardingDerived)return failure(409,'MESH_OUTPUT_NOT_READY','派生网格正在变化或已删除。');if(this.descriptor(job,view).freshness.status!=='current')return failure(409,'MESH_SOURCE_STALE','当前几何或材料已变化，不能下载为当前工程的可用网格。');if(signal?.aborted)return failure(499,'MESH_ARTIFACT_CANCELLED','下载核对已取消。');return {status:200,filename,outputPath:this.store.derivedPaths(job).mesh,proof:job.derivedRegistration.files.mesh,headers:{'X-CAD-Mesh-Admission':admission.status,'X-CAD-Mesh-Policy':admission.policy,'X-CAD-Mesh-Quality-Policy':'strict','X-CAD-Mesh-Quality-Threshold':String(result.mesh.quality.threshold),'X-CAD-Mesh-Source-Revision':String(job.source.revision)}};}
      return {status:200,filename:diagnostic?'diagnostic-'+filename:filename,proof:job.artifact.mesh,headers:{'X-CAD-Mesh-Admission':admission?.status||'unverified','X-CAD-Mesh-Policy':admission?.policy||'unknown','X-CAD-Mesh-Quality-Policy':result.mesh?.acceptance?.qualityPolicy||'warning','X-CAD-Mesh-Quality-Threshold':String(result.mesh?.acceptance?.qualityThreshold??result.mesh?.quality?.threshold??'unknown'),'X-CAD-Mesh-Source-Revision':String(job.source?.revision??'unknown')}};
    }catch(error){return this.artifactFailure(error);}
  }
  async handle(method,pathname,input={},options={}){
    const scoped=scopedJobRoute.exec(pathname),match=jobRoute.exec(pathname),documentId=scoped?.[1]||documentRoute.exec(pathname)?.[1]||(match&&(this.jobs.get(match[1])?.documentId||this.assets?.registry.get(match[1])?.documentId));
    return this.withAssetAccess(documentId,async()=>{
      if(!scoped)return this.handleRequest(method,pathname,input,options);
      const unavailable=await this.catalogAccess();if(unavailable)return unavailable;
      const id=scoped[2],action=scoped[3],ref=this.assets?.registry.get(id),job=this.jobs.get(id);
      if((ref?.documentId||job?.documentId)!==documentId)return failure(404,'MESH_JOB_NOT_FOUND','当前工程中没有该网格任务。');
      if(method==='GET'&&!action){
        if(Object.keys(input).length)return failure(400,'MESH_AGENT_SUMMARY_INVALID','任务概要不接受额外查询字段。');
        await this.reconcileWorkerStops();const view=await this.safeLive(documentId);
        if(ref?this.assets.registry.get(id)!==ref:this.jobs.get(id)!==job)return failure(404,'MESH_JOB_NOT_FOUND','任务在读取期间已删除。');
        return {status:200,payload:{ok:true,documentId,meshJob:meshAgentSummary(ref?this.assets.descriptor(ref,view):this.descriptor(job,view),documentId,id)}};
      }
      if(method!=='POST'||!action)return failure(405,'MESH_METHOD_NOT_ALLOWED','该工程任务入口仅支持概要查询及明确控制。');
      const result=await this.handleRequest(method,'/api/mesh/jobs/'+id+'/'+action,input,options);
      if(result.payload?.meshJob)result.payload={...result.payload,documentId,meshJob:meshAgentSummary(result.payload.meshJob,documentId)};
      return result;
    });
  }
  async handleRequest(method,pathname,input={}, {signal}={}) {
    if(pathname==='/api/mesh/catalog'&&method==='GET')return this.catalogResponse();
    if(pathname==='/api/mesh/catalog/recover'&&method==='POST')return this.retryCatalog(input);
    if(documentRoute.test(pathname)&&method==='GET'&&this.catalogStatus().state==='recovering')return failure(503,'MESH_CATALOG_RECOVERING','正在读取网格历史，完整恢复前不显示空记录。',{meshCatalog:this.catalogStatus()});
    const catalogError=await this.catalogAccess();if(catalogError)return catalogError;
    await this.reconcileWorkerStops();
    const document=documentRoute.exec(pathname);
    if(document) {
      const id=document[1];if(method==="POST")return this.create(id,input);
      if(Object.hasOwn(input,'summary')){
        let query;try{query=meshAgentPageQuery(input);}catch(error){return failure(400,error.code,error.message);}
        const view=await this.live(id);
        const native=[...this.jobs.values()].filter(job=>job.documentId===id).map(job=>({id:job.jobId,createdAt:job.createdAt,requestIds:[job.optimizationRecovery?.requestId,this.completionRecoveryInfo(job)?.requestId],read:()=>this.descriptor(job,view)}));
        const imported=this.assets?this.assets.registry.list(id).map(ref=>({id:ref.assetId,createdAt:ref.job.createdAt,requestIds:[ref.job.optimizationRecovery?.requestId,this.assets.registry.state(ref).recovery?.requestId],read:()=>this.assets.descriptor(ref,view)})):[];
        const rows=[...native,...imported].filter(row=>!query.requestId||row.requestIds.includes(query.requestId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
        const end=Math.min(rows.length,query.offset+query.limit);
        return {status:200,payload:{ok:true,version:1,documentId:id,page:{offset:query.offset,limit:query.limit,total:rows.length,nextOffset:end<rows.length?end:null},jobs:rows.slice(query.offset,end).map(row=>meshAgentSummary(row.read(),id,row.id))}};
      }
      const view=await this.live(id);
      const imported=this.assets?this.assets.registry.list(id).map(ref=>this.assets.descriptor(ref,view)):[];
      const native=[...this.jobs.values()]
        .filter(job=>job.documentId===id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
        .map(job=>({...this.descriptor(job,view),mesh:(job.kind===DISCRETE_TETRA_TASK_KIND?job.derivedMeshSummary:job.meshSummary)||null}));
      return {status:200,payload:{ok:true,protocolVersion:1,documentId:id,meshCatalog:this.catalogStatus(),surfaceReconstruction:this.surfaceStatus(),discreteTetra:this.discreteTetraStatus(),jobs:[...native,...imported].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}};
    }
    const match=jobRoute.exec(pathname),job=match&&this.jobs.get(match[1]);
    if(match&&this.assets?.has(match[1]))return this.assets.handle(method,match[1],match[2]||'',input,signal);
    if(!job)return failure(404,"MESH_JOB_NOT_FOUND","网格任务不存在，可能已被删除。");
    if(method==='POST'&&match[2]==='derive')return this.requestDerivation(job,input);
    if(method==='POST'&&match[2]==='derive-discard')return this.discardDerivation(job,input);
    if(job.kind===DISCRETE_TETRA_TASK_KIND&&['visibility','render','quality','boundary'].includes(match[2])&&!fs.existsSync(this.store.derivedDirectory(job)))return failure(409,'MESH_DISCRETE_ADMISSION_REQUIRED','请先明确生成并验收派生网格；原剖分结果仍然保留。');
    if(method==='POST'&&match[2]==='recover-completion')return this.recoverCompletion(job,input);
    if(method==='POST'&&match[2]==='resume-optimization')return this.resumeOptimization(job,input);
    if(method==='GET'&&match[2]==='surface-report'){
      if(job.kind!==SURFACE_TASK_KIND)return failure(409,'SURFACE_REPORT_NOT_SURFACE','此任务不是表面重构任务。');
      if(job.state!=='complete')return failure(409,'SURFACE_REPORT_NOT_READY','表面任务没有已完成并可核验的结果。');
      let query;try{query=normalizeSurfaceReportQuery(input);}catch(error){return failure(400,error.code,error.message);}
      const stamp=this.renderStamp(job);
      try{
        const surfaceReport=await this.artifacts.execute({operation:'surface-report',job,query,signal});
        if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','表面任务已删除。');
        if(job.state!=='complete'||stamp!==this.renderStamp(job))return failure(409,'MESH_ARTIFACT_CHANGED','表面任务材料已变化，请重新读取。');
        if(signal?.aborted)return failure(499,'MESH_ARTIFACT_CANCELLED','表面报告读取已取消。');
        const view=await this.safeLive(job.documentId);
        if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','表面任务已删除。');
        if(job.state!=='complete'||stamp!==this.renderStamp(job))return failure(409,'MESH_ARTIFACT_CHANGED','表面任务材料已变化，请重新读取。');
        if(signal?.aborted)return failure(499,'MESH_ARTIFACT_CANCELLED','表面报告读取已取消。');
        return {status:200,payload:{ok:true,protocolVersion:1,meshJob:this.descriptor(job,view),surfaceReport}};
      }catch(error){if(error.code==='MESH_ARTIFACT_INVALID'&&this.jobs.get(job.jobId)===job){job.state='failed';job.visible=false;job.errorCode=error.code;job.error=error.message;this.persist(job);}return this.artifactFailure(error);}
    }
    let visibilityIntent=null;if(method==='POST'&&match[2]==='visibility'&&typeof input.visible==='boolean'){if(job.visibilityRequestedValue!==input.visible){job.visibilitySequence=(job.visibilitySequence||0)+1;job.visibilityRequestedValue=input.visible;}visibilityIntent=job.visibilitySequence;}
    if(method==="POST"&&match[2]==="cancel")return this.cancel(job);
    if(method==="DELETE"&&!match[2]) {
      if(this.optimizationSourcePins.has(job.jobId))return failure(409,'MESH_OPTIMIZATION_RECOVERY_BUSY','检查点正在复制到独立恢复尝试，请稍后再删除原记录。');
      if(job.recoveryAttempt?.state==='checking')return failure(409,'MESH_COMPLETION_RECOVERY_BUSY','正在核对原结果，请等待检查结束后再删除。');
      if(isActiveMeshJob(job))return failure(409,"MESH_JOB_RUNNING","请先取消剖分任务，确认进程停止后再删除记录。");
      if(job.discardingDerived||job.deleting)return failure(409,'MESH_DERIVATION_BUSY','任务正在清理。');job.deleting=true;job.derivationAttempt?.controller?.abort();
      let lease;try{await this.qualityQueries.cancelJob(job.jobId);await this.artifacts.cancelJob(job.jobId);await job.derivationPromise;this.renderProofs.delete(job.jobId);lease=await this.computeGate.acquire({kind:'catalog'});this.store.remove(job);this.jobs.delete(job.jobId);this.cleanupSources(job);}catch(error){return failure(503,error.code||'MESH_DELETE_UNAVAILABLE',error.message);}finally{lease?.release();job.deleting=false;}
      return {status:200,payload:{ok:true,jobId:job.jobId}};
    }
    if(method==="GET"&&match[2]==="boundary") {
      if(job.kind===SURFACE_TASK_KIND)return failure(409,'SURFACE_RESULT_NOT_VOLUME','表面重构尚未生成可用体网格边界。');
      if(job.state!=="complete")return failure(409,"MESH_BOUNDARY_NOT_READY",job.error||"任务尚未完成。");
      let result;
      try{result=await this.readResult(job,{signal});}
      catch(error){return this.artifactFailure(error);}
      if(!result.mesh?.boundaryMapping)return failure(409,"MESH_BOUNDARY_UNAVAILABLE","旧网格没有 CAD 面来源，请重新剖分。");
      const context=await this.serializeDocument(job.documentId,async()=>{const view=await this.command("document.summary",{documentId:job.documentId});return {view,schema:this.getPropertySchema?.(job.documentId,view)||null};});
      if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','网格任务已删除。');
      if(job.state!=='complete'||job.deleting||job.discardingDerived)return failure(409,'MESH_BOUNDARY_NOT_READY','网格任务已不可用或正在清理。');
      const descriptor=this.descriptor(job,context.view);
      try{return {status:200,payload:{ok:true,meshJob:descriptor,boundary:queryMeshBoundary(result.mesh.boundaryMapping,job,input,context.schema,descriptor.freshness.status==="current",{sourceFamily:job.kind===DISCRETE_TETRA_TASK_KIND?isConstrainedTetraJob(job)?DISCRETE_CONSTRAINED_MESH_FAMILY:DISCRETE_MESH_FAMILY:'occt-history'})}};}
      catch(error){return failure(400,"MESH_BOUNDARY_FILTER_INVALID",error.message);}
    }
    if(method==="GET"&&match[2]==="quality") {
      if(job.kind===SURFACE_TASK_KIND)return failure(409,'SURFACE_RESULT_NOT_VOLUME','表面重构不提供四面体单元质量报告。');
      if(job.state!=="complete")return failure(409,"MESH_QUALITY_NOT_READY",job.error||"任务尚未完成。",{meshJob:this.descriptor(job,await this.safeLive(job.documentId))});
      try {
        if(job.kind===DISCRETE_TETRA_TASK_KIND){
          const stamp=this.renderStamp(job),result=await this.artifacts.execute({operation:'derived-tetra-quality',job,query:input,signal});
          if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','派生质量查询期间任务已删除。');if(job.state!=='complete'||job.deleting||job.discardingDerived||stamp!==this.renderStamp(job))return failure(409,'MESH_ARTIFACT_CHANGED','派生质量查询期间任务已变化。');const accepted=this.acceptDerivedRead(job,result,stamp),view=await this.safeLive(job.documentId);if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','质量核对期间任务已删除。');if(job.deleting||job.discardingDerived||job.state!=='complete')return failure(409,'MESH_ARTIFACT_CHANGED','质量核对期间任务正在变化。');if(signal?.aborted)return failure(499,'MESH_ARTIFACT_CANCELLED','质量查询已取消。');return {status:200,payload:{...accepted,meshJob:this.descriptor(job,view)}};
        }
        if(!job.artifact?.quality)return failure(409,"MESH_QUALITY_UNAVAILABLE","此旧结果未保存单元明细，请重新剖分后定位。",{meshJob:this.descriptor(job,await this.safeLive(job.documentId))});
        const result=await this.qualityQueries.query({file:this.store.qualityOutput(job),job,input,signal,onPrepared:proof=>{job.artifact.qualityQuery=proof;this.persist(job);}});
        // CAD edits may finish while the independent query is running. Stamp
        // freshness from a new observation, never from the pre-query model.
        const view=await this.safeLive(job.documentId);
        if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','质量查询期间该网格任务已被删除。');
        if(job.state!=='complete')return failure(409,'MESH_QUALITY_NOT_READY',job.error||'任务已不可用。',{meshJob:this.descriptor(job,view)});
        return {status:200,payload:{ok:true,meshJob:this.descriptor(job,view),...result}};
      }catch(error) {
        if(error.code==='MESH_DERIVED_ARTIFACT_INVALID'){job.derivedReadError=error;job.visible=false;delete job.derivedRegistration;delete job.derivedMeshSummary;this.renderProofs.delete(job.jobId);return this.artifactFailure(error);}
        if(error.code==='MESH_QUALITY_QUERY_INVALID')return failure(400,error.code,error.message);
        const view=await this.safeLive(job.documentId);
        if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','质量查询期间该网格任务已被删除。');
        if(error.code!=='MESH_ARTIFACT_INVALID')return failure(error.code==='MESH_QUALITY_QUERY_CANCELLED'?499:503,error.code||'MESH_QUALITY_QUERY_FAILED',error.message,{meshJob:this.descriptor(job,view)});
        job.state="failed";job.visible=false;job.errorCode="MESH_ARTIFACT_INVALID";job.error=error.message;this.persist(job);
        return failure(409,job.errorCode,job.error,{meshJob:this.descriptor(job,view)});
      }
    }
    if(method==='GET'&&match[2]==='render'){
      if(job.kind===SURFACE_TASK_KIND)return failure(409,'SURFACE_RESULT_NOT_VOLUME','表面重构未通过体网格准入，不能显示为已剖分网格。');
      if(Object.keys(input).some(key=>!['wireKey','chunk'].includes(key))||typeof input.wireKey!=='string'||!/^wire-[23]-[1-9]\d*$/.test(input.wireKey)||!/^(0|[1-9]\d*)$/.test(String(input.chunk??''))||!Number.isSafeInteger(Number(input.chunk)))return failure(400,'MESH_RENDER_QUERY_INVALID','显示分组或数据块编号不合法。');
      if(job.state!=='complete')return failure(409,'MESH_RENDER_NOT_READY','网格任务没有可显示结果。');
      if(job.kind!==DISCRETE_TETRA_TASK_KIND&&!job.artifact?.render)return failure(409,'MESH_RENDER_INLINE','旧结果的显示数据已包含在结果中。');
      try{
        let proof=this.renderProofs.get(job.jobId);
        const age=proof?performance.now()-proof.verifiedAt:Infinity;
        if(!proof||proof.stamp!==this.renderStamp(job)||!Number.isFinite(age)||age<0||age>30000||job.kind===DISCRETE_TETRA_TASK_KIND&&!this.store.checkDerivedCertificate(job,proof.derivedCertificate)){await this.readResult(job,{signal});proof=this.renderProofs.get(job.jobId);}
        if(!proof?.usable)return failure(409,'MESH_ADMISSION_REQUIRED','未通过验收的网格仅供诊断，不显示网格线。');
        const view=await this.safeLive(job.documentId);
        if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','网格任务已删除。');
        if(job.state!=='complete'||job.deleting||job.discardingDerived)return failure(409,'MESH_RENDER_NOT_READY',job.error||'网格任务已不可用或正在清理。');
        if(this.descriptor(job,view).freshness.status!=='current')return failure(409,'MESH_SOURCE_STALE','几何或材料来源已变化，未读取旧网格显示数据。');
        if(signal?.aborted)return failure(499,'MESH_RENDER_CANCELLED','网格显示读取已取消。');
        const derived=job.kind===DISCRETE_TETRA_TASK_KIND,render=derived?this.store.readDerivedRender(job):this.store.readRender(job);if(!render.storage)return failure(409,'MESH_RENDER_INLINE','旧结果的显示数据已包含在结果中。');
        const body=readMeshRenderChunk(derived?this.store.derivedPaths(job).render:this.store.renderOutput(job),render,input.wireKey,Number(input.chunk));
        return {status:200,body,headers:{'Content-Type':'application/octet-stream','Content-Length':body.length,'Cache-Control':'no-store','X-CAD-Mesh-Format':'float64-le','X-CAD-Mesh-Wire':input.wireKey,'X-CAD-Mesh-Chunk':String(input.chunk)}};
      }catch(error){if(error.code==='MESH_RENDER_QUERY_INVALID')return failure(400,error.code,error.message);if(job.kind===DISCRETE_TETRA_TASK_KIND&&['MESH_ARTIFACT_INVALID','MESH_DERIVED_ARTIFACT_INVALID'].includes(error.code)){job.derivedReadError=Object.assign(Error('派生显示材料校验失败，原始剖分保留。'),{code:'MESH_DERIVED_ARTIFACT_INVALID'});job.visible=false;delete job.derivedRegistration;delete job.derivedMeshSummary;this.renderProofs.delete(job.jobId);return this.artifactFailure(job.derivedReadError);}if(error.code&&error.code!=='MESH_ARTIFACT_INVALID')return this.artifactFailure(error);if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','网格任务已删除。');job.state='failed';job.visible=false;job.errorCode='MESH_ARTIFACT_INVALID';job.error=error.message;this.renderProofs.delete(job.jobId);this.persist(job);return failure(409,job.errorCode,job.error);}
    }
    const view=await this.safeLive(job.documentId);
    if(method==="POST"&&match[2]==="visibility") {
      if(job.kind===SURFACE_TASK_KIND)return failure(409,'SURFACE_RESULT_NOT_VOLUME','表面重构不是已验收体网格，不使用网格显隐控制。');
      if(job.kind==="preparation")return failure(409,"MESH_PREPARATION_NOT_MESH","修复预览不是网格结果，不使用网格显隐控制。");
      if(typeof input.visible!=="boolean")return failure(400,"MESH_VISIBILITY_INVALID","visible 必须为布尔值。");
      const meshJob=this.descriptor(job,view);
      if(input.visible&&(job.state!=="complete"||meshJob.freshness.status!=="current"))
        return failure(409,"MESH_SOURCE_STALE",meshJob.error||meshJob.freshness.reason,{meshJob});
      let displayView=view;
      if(input.visible)try{const result=await this.readResult(job,{signal});displayView=await this.safeLive(job.documentId);if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','网格任务已删除。');if(job.state!=='complete'||job.deleting||job.discardingDerived||this.descriptor(job,displayView).freshness.status!=='current')return failure(409,'MESH_SOURCE_STALE','验收期间工程或网格任务已变化。');if(signal?.aborted)return failure(499,'MESH_ARTIFACT_CANCELLED','网格显示读取已取消。');if(!meshAdmitted(result.mesh?.admission))return failure(409,'MESH_ADMISSION_REQUIRED','网格尚未通过工程验收；可查看质量报告和定位问题单元。',{meshJob:this.descriptor(job,displayView)});}catch(error){return this.artifactFailure(error);}
      if(visibilityIntent!==job.visibilitySequence)return {status:200,payload:{ok:true,superseded:true,meshJob:this.descriptor(job,displayView)}};
      job.visible=input.visible;
      if(input.visible)for(const other of this.jobs.values())if(other.documentId===job.documentId&&other!==job)other.visible=false;
      // Display intent is deliberately not persisted; recovered results always start hidden.
      return {status:200,payload:{ok:true,meshJob:this.descriptor(job,displayView)}};
    }
    if(method==="GET"&&!match[2]) {
      let result;
      if(job.state==="complete"||job.state==="failed"&&(job.preparationSummary?.reportAvailable||job.artifact?.discreteFailure)||['failed','cancelled','interrupted'].includes(job.state)&&job.artifact?.checkpoint)try{result=await this.readResult(job,{signal});}catch(error){const reply=this.artifactFailure(error);reply.payload.meshJob=this.descriptor(job,view);return reply;}
      const latestView=result?await this.safeLive(job.documentId):view;if(this.jobs.get(job.jobId)!==job)return failure(404,'MESH_JOB_NOT_FOUND','网格任务已删除。');
      if(job.deleting||job.discardingDerived)return failure(409,'MESH_ARTIFACT_CHANGED','网格正在清理，未交付旧读取结果。');
      if(signal?.aborted)return failure(499,'MESH_ARTIFACT_CANCELLED','网格结果读取已取消。');
      return {status:200,payload:{...(result||{ok:true}),...(result?.derivedMeshRegistration?{downloadUrl:'/api/mesh/outputs/'+job.jobId+'.msh'}:{}),meshJob:this.descriptor(job,latestView)}};
    }
    return failure(405,"METHOD_NOT_ALLOWED","不支持此网格任务操作。");
  }
  async create(id,input) {
    const catalogError=await this.catalogAccess();if(catalogError)return catalogError;
    if(this.closed)return failure(503,"MESH_SERVICE_STOPPING","网格服务正在停止。");
    if(input?.kind===SURFACE_TASK_KIND)return this.createSurface(id,input);
    if(input?.kind===DISCRETE_TETRA_TASK_KIND)return this.createDiscreteTetra(id,input);
    if(this.admitting.has(id))return failure(409,'MESH_JOB_ADMISSION_PENDING','当前工程正在核对网格磁盘容量，请等待原准入结果；没有重复登记。');
    let strategyRef,strategySnapshot;
    if(input.strategyRef!==undefined)try{
      strategyRef=normalizeMeshStrategyRef(input.strategyRef);
      if(input.kind==='preparation'||['sizing','repairMode','qualityThreshold','qualityPolicy','optimization'].some(key=>input[key]!==undefined))throw Object.assign(Error('引用工程方案时不能再指定临时尺寸、修复模式、质量阈值、验收规则或优化。'),{code:'MESH_STRATEGY_INVALID'});
      if(!this.getMeshStrategy)throw Object.assign(Error('当前服务不支持工程网格方案。'),{code:'MESH_STRATEGY_UNAVAILABLE'});
      strategySnapshot=await this.serializeDocument(id,()=>this.getMeshStrategy(id,strategyRef));input={...input,...strategySnapshot.options};
    }catch(error){return failure(error.code==='MESH_STRATEGY_CONFLICT'?409:error.code==='MESH_STRATEGY_NOT_FOUND'?404:400,error.code||'MESH_STRATEGY_INVALID',error.message);}
    let sizing,qualityPolicy,optimization;try{qualityPolicy=normalizeMeshQualityPolicy(input.qualityPolicy);sizing=normalizeMeshSizing(input.sizing);optimization=normalizeMeshOptimization(input.optimization);if((sizing||optimization)&&input.kind==='preparation')throw Object.assign(Error('诊断预览不生成网格，不接受尺寸或网格优化设置。'),{code:'MESH_SIZING_INVALID'});}catch(error){return failure(400,error.code,error.message);}
    if(this.closed)return failure(503,"MESH_SERVICE_STOPPING","网格服务正在停止。");
    if(this.storedCount()>=this.maxStoredJobs||this.documentStoredCount(id)>=this.maxJobsPerDocument)return failure(409,'MESH_TASK_CAPACITY','网格任务记录已达容量上限；请明确删除不再需要的历史任务后再创建。已有结果不会自动删除。');
    if(input.kind!==undefined&&!["mesh","preparation"].includes(input.kind))return failure(400,"MESH_JOB_KIND_INVALID","不支持此任务类型。");
    if(input.deepCheck!==undefined&&typeof input.deepCheck!=="boolean")return failure(400,"MESH_DIAGNOSTIC_OPTIONS_INVALID","深入检查设置必须为布尔值。");
    if(input.preparationJobId!==undefined&&(typeof input.preparationJobId!=="string"||input.kind==="preparation"))return failure(400,"MESH_PREPARATION_REFERENCE_INVALID","预览来源仅可用于剖分任务。");
    if(input.selection)return failure(409,"MESH_CONFORMAL_SCOPE_REQUIRED","工程网格必须对全部几何联合共形剖分；Body/Face 选择用于结果显示，不用于缩小剖分范围。");
    if(input.background!==undefined&&typeof input.background!=="boolean")return failure(400,"MESH_BACKGROUND_INVALID","background 必须为布尔值。");
    if(input.qualityThreshold!==undefined&&(typeof input.qualityThreshold!=="number"||!Number.isFinite(input.qualityThreshold)||input.qualityThreshold<0||input.qualityThreshold>1))
      return failure(400,"MESH_QUALITY_INVALID","质量阈值必须是 0 到 1 之间的有限数值。");
    if(input.repairMode!==undefined&&!["conservative","aggressive","strict"].includes(input.repairMode))
      return failure(400,"MESH_REPAIR_MODE_INVALID","不支持此几何修复模式。");
    const existing=[...this.jobs.values()].find(job=>job.documentId===id&&isActiveMeshJob(job));
    if(existing)return failure(409,"MESH_JOB_ALREADY_RUNNING","当前工程已有剖分任务，请等待完成或先取消。",{meshJob:this.descriptor(existing,await this.safeLive(id))});
    const job={jobId:"mesh-"+crypto.randomUUID(),documentId:id,kind:input.kind||"mesh",preparationJobId:input.preparationJobId,state:"preparing",visible:false,createdAt:new Date().toISOString(),
      options:{repairMode:input.repairMode||"conservative",qualityThreshold:input.qualityThreshold??0.2,qualityPolicy,deepCheck:input.deepCheck??input.kind==="preparation",...(sizing?{sizing}:{}),...(optimization?{optimization}:{}),...(strategyRef?{strategyRef,strategySnapshot}:{}),...(this.worker?.memoryPolicy?{nativeMemoryLimitBytes:this.worker.memoryPolicy.limitBytes}:{})},baseRevision:input.baseRevision};
    return this.registerJob(job,id,input.background,()=>this.prepare(job));
  }
  async registerJob(job,id,background,prepare){
    const surface=[SURFACE_TASK_KIND,DISCRETE_TETRA_TASK_KIND].includes(job.kind);
    if(surface&&this.surfacePreparing.size>=this.maxSurfacePreparing)return failure(429,'SURFACE_SOURCE_CAPACITY','表面来源捕获名额已满，未登记新任务；请等待已有任务。');
    if(this.admitting.has(id))return failure(409,'MESH_JOB_ADMISSION_PENDING','当前工程正在核对网格磁盘容量，请等待原准入结果；没有重复登记。');
    if(this.storedCount()+this.admitting.size>=this.maxStoredJobs)return failure(409,'MESH_TASK_CAPACITY','工程任务记录与正在核对容量的任务已达上限；未登记新任务或删除已有结果。');
    job.completion=new Promise(resolve=>{job.resolve=resolve;});
    if(surface)this.surfacePreparing.add(job.jobId);
    this.admitting.add(id);
    try{
      if(this.storageBudget){job.storageLease=await this.storageBudget.reserve(job.jobId);job.options.storageReservationBytes=job.storageLease.bytes;}
      if(job.kind===DISCRETE_TETRA_TASK_KIND&&job.storageLease&&job.storageLease.bytes<(job.options.optimizationProcess?TETRA_CHECKPOINT_RESERVATION_BYTES:256*1024**2))throw Object.assign(Error('单任务磁盘预留不足以保存完整离散体材料和优化检查点；尚未导出几何或登记任务。'),{code:'MESH_STORAGE_TASK_RESERVATION'});
      if(this.closed){job.storageLease?.release();if(surface)this.surfacePreparing.delete(job.jobId);return failure(503,'MESH_SERVICE_STOPPING','网格服务正在停止，未登记新任务。');}
      this.persist(job);
    }catch(error){job.storageLease?.release();if(surface)this.surfacePreparing.delete(job.jobId);return failure(error.code?.startsWith('MESH_STORAGE_')?['MESH_STORAGE_CAPACITY','MESH_STORAGE_FREE_SPACE'].includes(error.code)?507:503:500,error.code||'MESH_STORAGE_FAILED',error.message);}finally{this.admitting.delete(id);}
    this.jobs.set(job.jobId,job);
    job.preparation=prepare().catch(error=>this.finishFailure(job,error)).finally(()=>{if(surface)this.surfacePreparing.delete(job.jobId);});
    if(background)return {status:202,payload:{ok:true,protocolVersion:1,meshJob:this.descriptor(job,null)}};
    return job.completion;
  }
  async createSurface(id,input){
    if(!this.surfaceWorkerFactory||typeof this.getCapabilities!=='function')return failure(503,'SURFACE_WORKER_UNAVAILABLE','当前后台未封存或配置表面重构引擎，未使用 Gmsh 或本地解析器替代。');
    let settings;try{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['kind','surface','baseRevision','background'].includes(key))||input.background!==undefined&&typeof input.background!=='boolean'||input.baseRevision!==undefined&&(!Number.isSafeInteger(input.baseRevision)||input.baseRevision<0))throw Error();settings=normalizeSurfaceTaskSettings(input.surface);}catch(error){return failure(400,error.code||'SURFACE_TASK_OPTIONS_INVALID',error.code?error.message:'表面重构任务设置无效；不能附带选择范围、路径或体网格参数。');}
    if(this.storedCount()>=this.maxStoredJobs||this.documentStoredCount(id)>=this.maxJobsPerDocument)return failure(409,'MESH_TASK_CAPACITY','工程任务记录已达容量上限，请明确删除不再需要的历史任务。');
    const existing=[...this.jobs.values()].find(job=>job.documentId===id&&isActiveMeshJob(job));if(existing)return failure(409,'MESH_JOB_ALREADY_RUNNING','当前工程已有网格或表面修复任务。',{meshJob:this.descriptor(existing,await this.safeLive(id))});
    const job={jobId:'mesh-'+crypto.randomUUID(),documentId:id,kind:SURFACE_TASK_KIND,state:'preparing',visible:false,createdAt:new Date().toISOString(),options:{surface:settings,nativeSurfaceMemoryLimitBytes:this.surfaceMemoryLimitBytes},baseRevision:input.baseRevision,controller:new AbortController()};
    return this.registerJob(job,id,input.background,()=>this.prepareSurface(job));
  }
  async prepareSurface(job){
    const snapshot=await captureProjectDiscreteSource({documentId:job.documentId,command:this.command,serializeDocument:this.serializeDocument,getCapabilities:this.getCapabilities,options:job.options.surface.source,baseRevision:job.baseRevision,signal:job.controller.signal});
    if(job.terminationReason)return this.finishTermination(job);job.source=snapshot.source;this.persist(job);
    const captured=await this.artifacts.execute({operation:'capture-surface-source',job,result:snapshot});job.artifact={...job.artifact,...captured.artifact};
    if(job.terminationReason)return this.finishTermination(job);
    // Queued jobs retain a certified on-disk source, not tens of MiB of live DTOs.
    job.state='queued';this.persist(job);this.queue.push(job);this.pump();
  }
  async createDiscreteTetra(id,input){
    if(!this.discreteTetraWorkerFactory||typeof this.getCapabilities!=='function')return failure(503,'MESH_DISCRETE_WORKER_UNAVAILABLE','当前后台未配置配套的离散体域分区及四面体引擎，没有改用其他剖分路线。');
    let settings;try{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['kind','discreteTetra','baseRevision','background'].includes(key))||input.background!==undefined&&typeof input.background!=='boolean'||input.baseRevision!==undefined&&(!Number.isSafeInteger(input.baseRevision)||input.baseRevision<0))throw Error();settings=normalizeDiscreteTetraSettings(input.discreteTetra);}catch(error){return failure(400,error.code||'MESH_DISCRETE_SETTINGS_INVALID',error.code?error.message:'离散体任务设置无效，不能附带路径、局部选择或外来材料归属。');}
    if(this.storedCount()>=this.maxStoredJobs||this.documentStoredCount(id)>=this.maxJobsPerDocument)return failure(409,'MESH_TASK_CAPACITY','工程任务记录已达容量上限，请明确删除不再需要的历史任务。');
    const existing=[...this.jobs.values()].find(job=>job.documentId===id&&isActiveMeshJob(job));if(existing)return failure(409,'MESH_JOB_ALREADY_RUNNING','当前工程已有剖分任务。',{meshJob:this.descriptor(existing,await this.safeLive(id))});
    const job={jobId:'mesh-'+crypto.randomUUID(),documentId:id,kind:DISCRETE_TETRA_TASK_KIND,state:'preparing',discreteStage:'capturing-source',visible:false,createdAt:new Date().toISOString(),options:{discreteTetra:settings,nativeSurfaceMemoryLimitBytes:this.surfaceMemoryLimitBytes,nativeMemoryLimitBytes:this.discreteTetraMemoryLimitBytes},baseRevision:input.baseRevision,controller:new AbortController()};
    if(settings.optimization&&this.discreteTetraWorkerFactory.checkpointSupported===true)job.options.optimizationProcess='checkpoint-v1';
    return this.registerJob(job,id,input.background,()=>this.prepareDiscreteTetra(job));
  }
  async prepareDiscreteTetra(job){
    const capture=this.discreteTetraWorkerFactory.constrainedSupported===true?captureProjectConstrainedTetraSource:captureProjectDiscreteTetraSource;
    const snapshot=await capture({documentId:job.documentId,command:this.command,serializeDocument:this.serializeDocument,getCapabilities:this.getCapabilities,settings:job.options.discreteTetra,baseRevision:job.baseRevision,signal:job.controller.signal});
    if(isConstrainedCadTetraSource(snapshot)){
      if(snapshot.settings.optimization&&job.options.optimizationProcess!=='checkpoint-v1')throw Object.assign(Error('开放面优化需要匹配的检查点能力，未改用内联优化。'),{code:'MESH_OPTIMIZATION_RECOVERY_UNAVAILABLE'});
      job.options.sourceFamily=CONSTRAINED_TETRA_TASK_FAMILY;
    }
    if(job.terminationReason)return this.finishTermination(job);job.source=snapshot.cad.source;job.materialSourceSha256=snapshot.materials.sha256;this.persist(job);
    const captured=await this.artifacts.execute({operation:'capture-tetra-source',job,result:snapshot});job.artifact={...job.artifact,...captured.artifact};if(job.terminationReason)return this.finishTermination(job);
    job.state='queued';job.discreteStage='queued';this.persist(job);this.queue.push(job);this.pump();
  }
  async prepare(job) {
    const {sourcePath,manifestPath}=this.sourcePaths(job);
    fs.mkdirSync(path.dirname(sourcePath),{recursive:true});
    const snapshot=await this.serializeDocument(job.documentId,async()=>{
      if(job.terminationReason)return null;
      const view=await this.command("document.summary",{documentId:job.documentId});
      if(!view.ok)throw new Error(view.error||"几何内核不可用。");
      if(!view.bodyCount)throw new Error("工程中没有可剖分几何。");
      if(job.options.strategyRef)await this.getMeshStrategy(job.documentId,job.options.strategyRef);
      if(job.baseRevision!==undefined&&job.baseRevision!==view.revision) {
        const error=new Error("工程已变化，请刷新后重新开始剖分。");error.code="STALE_REVISION";throw error;
      }
      const source=captureMeshSource(view,job.documentId);validateMeshSizingSource(job.options.sizing,view);job.source=source;this.persist(job);
      if(job.preparationJobId){
        const asset=this.assets?.registry.get(job.preparationJobId);
        if(asset){if(asset.documentId!==job.documentId||asset.job.kind!=='preparation'||asset.job.state!=='complete'||asset.job.options.repairMode!==job.options.repairMode)throw Object.assign(Error('恢复的修复预览与当前工程或模式不匹配。'),{code:'MESH_PREPARATION_REFERENCE_INVALID'});if(assessMeshSource({...asset.job.source,documentId:job.documentId},view,job.documentId).status!=='current')throw Object.assign(Error('恢复预览的几何身份已变化。'),{code:'MESH_PREPARATION_STALE'});return {view,source,previewAsset:asset};}
        const preview=this.jobs.get(job.preparationJobId);
        if(!preview||preview.documentId!==job.documentId||preview.kind!=="preparation"||preview.options.repairMode!==job.options.repairMode)throw Object.assign(new Error("修复预览不属于当前工程或修复模式不一致。"),{code:"MESH_PREPARATION_REFERENCE_INVALID"});
        if(assessMeshSource(preview.source,view,job.documentId).status!=="current")throw Object.assign(new Error("预览来源已变化，请重新诊断和预览。"),{code:"MESH_PREPARATION_STALE"});
        return {view,source,previewJob:preview};
      }
      const exported=await this.command("mesh.prepare",{documentId:job.documentId,parameters:{path:sourcePath,manifestPath,repairMode:job.options.repairMode,includePreview:job.kind==="preparation",deepCheck:job.options.deepCheck}});
      return {view,source,exported};
    });
    if(job.terminationReason)return this.finishTermination(job);
    // The immutable native export owns its files now. Do not hold the live CAD
    // document queue while waiting for disk verification/copy or another query.
    let exported=snapshot.exported;
    if(snapshot.previewAsset){const asset=snapshot.previewAsset,prepared=await this.artifacts.execute({operation:'asset-reuse-prepared',job:{jobId:asset.assetId},ownerId:job.jobId,result:{ref:this.assets.registry.workerRef(asset),targetJob:this.store.record(job)}});if(job.terminationReason)return this.finishTermination(job);job.options.deepCheck=asset.job.options.deepCheck;exported={ok:true,diagnostics:prepared.diagnostics,manifest:prepared.manifest};}
    if(snapshot.previewJob){
      const preview=snapshot.previewJob;
      let prepared;try{prepared=await this.artifacts.execute({operation:'reuse-prepared',job:preview,targetJob:job});}catch(error){if(error.code==='MESH_ARTIFACT_INVALID'&&this.jobs.get(preview.jobId)===preview){preview.state="failed";preview.visible=false;preview.errorCode=error.code;preview.error=error.message;this.persist(preview);}throw error;}
      if(job.terminationReason)return this.finishTermination(job);
      snapshot.source=preview.source;job.source=snapshot.source;job.options.deepCheck=preview.options.deepCheck;
      exported={ok:true,diagnostics:prepared.diagnostics,manifest:prepared.manifest};
    }
    if(exported.diagnostics)validatePreparation(exported.diagnostics,snapshot.source,exported.preview);
    if(!exported.ok)throw Object.assign(new Error(exported.error||"无法导出剖分几何。"),{code:exported.code,diagnostics:exported.diagnostics});
    snapshot.manifest=exported.manifest||await this.artifacts.execute({operation:'source-manifest',job});
    resolveMeshSizing(job.options.sizing,snapshot.manifest);
    if(job.terminationReason)return this.finishTermination(job);
    if(snapshot.manifest.revision!==snapshot.source.revision||assessMeshSource(snapshot.source,{...snapshot.manifest,bodyMetadata:snapshot.manifest.bodies},job.documentId).status!=="current")throw new Error("BREP 清单与工程身份不一致，未执行剖分。");
    snapshot.preview=exported.preview||null;snapshot.diagnostics=exported.diagnostics||null;delete snapshot.exported;delete snapshot.previewJob;delete snapshot.previewAsset;
    if(job.kind==="preparation"){
      if(!snapshot.diagnostics||!snapshot.preview)throw new Error("内核未返回可验证的修复预览。");
      const result={ok:true,protocolVersion:1,requestId:job.jobId,preparation:{diagnostics:snapshot.diagnostics,preview:snapshot.preview}};
      const preparedArtifact=(await this.artifacts.execute({operation:'capture-prepared',job})).artifact;if(job.terminationReason)return this.finishTermination(job);const sealed=await this.sealResult(job,result);if(job.terminationReason)return this.finishTermination(job);job.artifact={...sealed.artifact,...preparedArtifact};
      job.preparationSummary=preparationSummary(snapshot.diagnostics);this.cleanupSources(job);await this.verifyCompletionBudget(job);if(job.terminationReason)return this.finishTermination(job);job.state="complete";job.finishedAt=new Date().toISOString();this.commitCompletion(job);job.storageLease?.release();
      const view=await this.safeLive(job.documentId);this.settle(job,{status:200,payload:{...result,meshJob:this.descriptor(job,view)}});return;
    }
    job.source=snapshot.source;job.snapshot=snapshot;job.state="queued";this.persist(job);this.queue.push(job);this.pump();
  }
  pump() {
    if(this.closed||[...this.jobs.values()].some(job=>job.stopUnconfirmed))return;
    while(this.running<this.maxConcurrent&&this.queue.length) {
      const job=this.queue.shift();if(job.state!=="queued")continue;
      this.running++;
      job.task=(job.kind===SURFACE_TASK_KIND?this.runSurface(job):job.kind===DISCRETE_TETRA_TASK_KIND?this.runDiscreteTetra(job):this.run(job)).catch(error=>this.finishFailure(job,error)).finally(()=>{this.running--;this.pump();});
    }
  }
  async run(job) {
    job.client=this.workerFactory?this.workerFactory():this.worker;job.ownsClient=Boolean(this.workerFactory);
    job.state="running";job.startedAt=new Date().toISOString();this.persist(job);
    const snapshot=job.snapshot,solids=snapshot.view.bodyMetadata.filter(body=>body.kind==="solid");
    let completed;
    try {
      const route=await handleMeshRoute({method:"POST",pathname:"/api/mesh/create",requestId:job.jobId,client:job.client,
        qualityOutputPath:this.store.qualityOutput(job),
        renderOutputPath:this.store.renderOutput(job),
        outputDirectory:path.join(this.dataDir,"meshes"),input:{inputPath:this.sourcePaths(job).sourcePath,outputPath:job.jobId+".msh",dimension:3,
          ...job.options,resolveIntersections:true,bodyIds:solids.map(body=>body.bodyId),
          bodyGeometry:solids.map(body=>({bodyId:body.bodyId,volume:body.volume,centroid:body.centroid,bounds:body.bounds})),bodyManifest:snapshot.manifest}});
      if(job.terminationReason)return await this.finishTermination(job);
      const result=route.payload;
      if(!result.ok){const error=new Error(result.error);error.code=result.code;error.status=route.status;throw error;}
      const processResources=validateMeshResourceProof(job.options,result.processResources,{required:job.options.nativeMemoryLimitBytes!==undefined});if(processResources)job.processResources=processResources;
      const groups=result.mesh?.render?.groups;
      if(!result.mesh||!Array.isArray(groups))throw new Error('网格回复缺少可检查的实体分组。');
      result.mesh.sourceInventory=captureMeshInventory(snapshot.manifest);
      result.mesh.render.groups=qualifyMeshGroups(groups,job.source);
      if(result.mesh.boundaryMapping)validateMeshBoundary(result.mesh.boundaryMapping,job.source);
      validateMeshSizingReport(result.mesh.sizing,job.options.sizing,result.mesh);
      validateMeshOptimizationReport(result.mesh.optimization,job.options.optimization,result.mesh);
      if(snapshot.diagnostics){result.preparation={diagnostics:snapshot.diagnostics,preview:null};job.preparationSummary=preparationSummary(snapshot.diagnostics);}
      const sealed=await this.sealResult(job,result);if(job.terminationReason)return await this.finishTermination(job);job.artifact=sealed.artifact;Object.assign(result,sealed.result);
      job.meshSummary={dimension:result.mesh.dimension,nodeCount:result.mesh.nodeCount,elementCount:result.mesh.elementCount,quality:result.mesh.quality,admission:result.mesh.admission};
      completed={status:200,payload:{...result,
        ...(result.mesh?.outputPath?{downloadUrl:"/api/mesh/outputs/"+encodeURIComponent(path.basename(result.mesh.outputPath))}:{})}};
    } catch(error) {
      if(snapshot.diagnostics&&!error.diagnostics)error.diagnostics=snapshot.diagnostics;
      throw error;
    } finally {
      let stopped=true;
      if(job.ownsClient){const children=job.client?.children;const exactChildren=children instanceof Set?[...children]:undefined;try{await (job.stopping||(job.client.dispose?job.client.dispose():job.client.closeAndWait()));}catch(error){stopped=false;job.stopUnconfirmed=true;job.stopChildren=exactChildren;job.stopError=error;console.error("[mesh] Worker cleanup:",error.message);}}
      if(stopped){job.client=null;job.snapshot=null;this.cleanupSources(job);}
    }
    if(completed){
      if(job.stopUnconfirmed)return this.finishFailure(job,job.stopError);
      if(job.terminationReason)return this.finishTermination(job);
      await this.verifyCompletionBudget(job);if(job.terminationReason)return this.finishTermination(job);
      job.state='complete';job.finishedAt=new Date().toISOString();this.commitCompletion(job);job.storageLease?.release();
      for(const other of this.jobs.values())if(other.documentId===job.documentId&&other!==job)other.visible=false;
      completed.payload.meshJob=this.descriptor(job,await this.safeLive(job.documentId));this.settle(job,completed);
    }
  }
  settle(job,result) {
    if(!job.settled){job.settled=true;const resolve=job.resolve;job.resolve=null;job.completion=null;resolve?.(result);}
  }
  async runSurface(job){
    job.client=this.surfaceWorkerFactory();job.ownsClient=true;let completed;
    try{
      job.state='running';job.startedAt=new Date().toISOString();this.persist(job);
      const snapshot=await this.artifacts.execute({operation:'surface-source',job});if(job.terminationReason)return await this.finishTermination(job);
      const output=await job.client.refine(surfaceExecutionInput(snapshot,job.options.surface),{signal:job.controller.signal});if(job.terminationReason)return await this.finishTermination(job);
      job.processResources=validateSurfaceResourceProof(job.options,output.processResources,{required:true});
      const result=surfaceTaskResult(job,snapshot,output);validateSurfaceTaskResult(result,job,snapshot);
      const sealed=await this.sealResult(job,result);if(job.terminationReason)return await this.finishTermination(job);
      job.artifact={...job.artifact,...sealed.artifact};job.surfaceSummary=sealed.result.surfaceSummary;completed={status:200,payload:{ok:true,protocolVersion:1,requestId:job.jobId,surfaceSummary:job.surfaceSummary}};
    }finally{
      const exactChildren=[...job.client.children];let stopped=true;
      try{await(job.stopping||job.client.closeAndWait());}catch(error){stopped=false;job.stopUnconfirmed=true;job.stopChildren=exactChildren;job.stopError=error;}
      if(stopped)job.client=null;
    }
    if(completed){if(job.stopUnconfirmed)return this.finishFailure(job,job.stopError);if(job.terminationReason)return this.finishTermination(job);await this.verifyCompletionBudget(job);if(job.terminationReason)return this.finishTermination(job);job.state='complete';job.finishedAt=new Date().toISOString();this.commitCompletion(job);job.storageLease?.release();completed.payload.meshJob=this.descriptor(job,await this.safeLive(job.documentId));this.settle(job,completed);}
  }
  async runDiscreteTetra(job){
    job.client=this.discreteTetraWorkerFactory({validate:(packet,{signal})=>this.artifacts.execute({operation:'validate-discrete-native',job,result:packet,signal})});job.ownsClient=true;let completed;
    try{
      let output;
      if(job.optimizationRecovery){
        job.state='running';job.startedAt=new Date().toISOString();this.persist(job);
        output=await this.optimizePublishedCheckpoint(job);
      }else{
      job.state='running';job.discreteStage='partition';job.startedAt=new Date().toISOString();this.persist(job);
      const input=await this.artifacts.execute({operation:'tetra-partition-command',job,signal:job.controller.signal});if(job.terminationReason)return await this.finishTermination(job);
      const partition=await job.client[isConstrainedTetraJob(job)?'partitionConstrained':'partition'](input,{signal:job.controller.signal});if(job.terminationReason)return await this.finishTermination(job);
      job.processResources=validateTetraResources(job.options,{partition:partition.processResources});this.persist(job);
      const captured=await this.artifacts.execute({operation:'capture-tetra-partition',job,result:partition,signal:job.controller.signal});job.artifact={...job.artifact,...captured.artifact};this.persist(job);if(job.terminationReason)return await this.finishTermination(job);
      if(captured.summary.conflictCellCount)throw Object.assign(Error('交叠体域包含不一致的材料赋值，已停止体网格生成；请先明确材料归属。'),{code:'MESH_MATERIAL_CONFLICT',details:captured.summary});
      const command=await this.artifacts.execute({operation:'tetra-command',job,signal:job.controller.signal});if(job.terminationReason)return await this.finishTermination(job);job.discreteStage='tetra';this.persist(job);
      if(job.options.optimizationProcess==='checkpoint-v1'){
        const checkpoint=await job.client[isConstrainedTetraJob(job)?'createPatchedCheckpoint':'createCheckpoint'](command.input,{sourceInput:command.sourceInput,signal:job.controller.signal});
        job.processResources=validateTetraResources(job.options,{...job.processResources,generation:checkpoint.processResources});
        if(job.terminationReason)return await this.finishTermination(job);job.discreteStage='checkpoint';this.persist(job);
        const saved=await this.artifacts.execute({operation:'capture-tetra-checkpoint',job,result:checkpoint,signal:job.controller.signal,beforePublish:()=>this.verifyTetraCheckpointPublication(job)});
        job.artifact={...job.artifact,...saved.artifact};this.persist(job);
        if(job.terminationReason)return await this.finishTermination(job);
        output=await this.optimizePublishedCheckpoint(job);
      }else output=await job.client[isConstrainedTetraJob(job)?'tetrahedralizePatched':'tetrahedralize'](command.input,{sourceInput:command.sourceInput,signal:job.controller.signal});
      }
      job.processResources=validateTetraResources(job.options,{...job.processResources,tetra:output.processResources},{required:true});
      if(job.terminationReason)return await this.finishTermination(job);job.discreteStage='sealing';this.persist(job);
      const stored=await this.artifacts.execute({operation:'seal-tetra-output',job,result:output,signal:job.controller.signal,...(job.options.optimizationProcess?{beforePublish:()=>this.verifyTetraCheckpointPublication(job)}:{})});job.artifact={...job.artifact,...stored.artifact};job.discreteTetraSummary=stored.result.discreteTetraSummary;completed={status:200,payload:{...stored.result}};
    }catch(error){
      if(job.artifact?.partition&&['MESH_MATERIAL_CONFLICT','MESH_QUALITY_REJECTED'].includes(error.code)&&!job.terminationReason){
        if(error.code==='MESH_QUALITY_REJECTED')job.processResources=validateTetraResources(job.options,{...job.processResources,tetra:error.processResources},{required:true});
        error.discreteFailure={code:error.code,message:error.message,details:error.details,...error.execution&&{execution:error.execution,algorithm:error.algorithm,processResources:error.processResources}};
      }throw error;
    }finally{
      const exactChildren=[...job.client.children];let stopped=true;try{await(job.stopping||job.client.closeAndWait());}catch(error){stopped=false;job.stopUnconfirmed=true;job.stopChildren=exactChildren;job.stopError=error;}if(stopped)job.client=null;
    }
    if(completed){if(job.stopUnconfirmed)return this.finishFailure(job,job.stopError);if(job.terminationReason)return this.finishTermination(job);await this.verifyCompletionBudget(job);if(job.terminationReason)return this.finishTermination(job);job.state='complete';job.discreteStage='complete';job.finishedAt=new Date().toISOString();this.commitCompletion(job);job.storageLease?.release();completed.payload.meshJob=this.descriptor(job,await this.safeLive(job.documentId));this.settle(job,completed);}
  }
  async optimizePublishedCheckpoint(job){
    const command=await this.artifacts.execute({operation:'tetra-optimization-command',job,signal:job.controller.signal});
    await this.verifyTetraCheckpointPublication(job);job.discreteStage='optimizing';this.persist(job);
    return job.client[isConstrainedTetraJob(job)?'optimizePatchedCheckpoint':'optimizeCheckpoint'](command.input,{sourceInput:command.sourceInput,signal:job.controller.signal});
  }
  async verifyTetraCheckpointPublication(job){
    if(this.closed||job.terminationReason||job.controller.signal.aborted||this.jobs.get(job.jobId)!==job)throw Object.assign(Error('任务已停止，没有发布检查点或开始优化。'),{code:'MESH_CANCELLED'});
    await job.storageLease?.verify();
    const view=await this.safeLive(job.documentId);
    if(this.descriptor(job,view).freshness.status!=='current')throw Object.assign(Error('生成期间几何或材料已变化，未开始优化或发布过期结果。'),{code:'MESH_SOURCE_STALE'});
    if(this.closed||job.terminationReason||job.controller.signal.aborted)throw Object.assign(Error('任务已停止，原检查点保留。'),{code:'MESH_CANCELLED'});
  }
  async finishFailure(job,error) {
    if(job.stopUnconfirmed){job.terminationReason||='shutdown';return this.finishTermination(job);}
    if(job.terminationReason)return this.finishTermination(job);
    job.visible=false;job.error=error.message;job.errorCode=error.code||"MESH_PROJECT_FAILED";job.finishedAt=new Date().toISOString();
    if(error.discreteFailure&&job.kind===DISCRETE_TETRA_TASK_KIND)try{const stored=await this.artifacts.execute({operation:'capture-tetra-failure',job,result:error.discreteFailure});job.artifact={...job.artifact,...stored.artifact};job.discreteFailureSummary=stored.summary;}catch(reportError){job.error+='；失败诊断保存未完成：'+reportError.message;}
    if(error.diagnostics&&job.source)try{validatePreparation(error.diagnostics,job.source);const sealed=await this.sealResult(job,{ok:true,protocolVersion:1,requestId:job.jobId,preparation:{diagnostics:error.diagnostics,preview:null}});if(job.terminationReason)return this.finishTermination(job);job.artifact=sealed.artifact;job.preparationSummary=preparationSummary(error.diagnostics);}catch(reportError){job.error+="；诊断记录保存失败："+reportError.message;}
    if(job.terminationReason)return this.finishTermination(job);job.state='failed';if(error.code!=='MESH_COMPLETION_UNCOMMITTED'||!job.artifact?.result)this.removeOutput(job);this.cleanupSources(job);
    if(error.code==='MESH_COMPLETION_UNCOMMITTED')job.metadataProof=null;
    try{this.persist(job);}catch(storageError){job.error+="；任务状态保存失败："+storageError.message;}
    job.storageLease?.release();this.settle(job,failure(error.status|| (error.code==="STALE_REVISION"?409:400),job.errorCode,job.error,{meshJob:this.descriptor(job,null)}));
  }
  async finishTermination(job,{reconcile=false}={}) {
    if(job.settled&&!reconcile)return;
    try{await this.artifacts.cancelJob(job.jobId);if(job.stopping)await job.stopping;}
    catch(error){job.stopUnconfirmed=true;job.stopError=error;}
    if(job.stopUnconfirmed){job.state='cancelling';job.errorCode='MESH_STOP_UNCONFIRMED';job.error='工作进程尚未核验退出，任务未作为已结束发布；保留中间文件以供恢复。';try{this.persist(job);}catch{/* Keep the original stop error. */}this.settle(job,failure(503,job.errorCode,job.error,{meshJob:this.descriptor(job,null)}));this.observeWorkerStop(job);return;}
    job.state=job.terminationReason==="shutdown"?"interrupted":"cancelled";job.visible=false;job.finishedAt=new Date().toISOString();
    job.errorCode=job.state==="cancelled"?"MESH_CANCELLED":"MESH_SERVICE_INTERRUPTED";
    job.error=job.state==="cancelled"?"任务已取消，没有发布网格结果。":"服务停止时任务被中断；未自动重试。";
    this.removeOutput(job);this.cleanupSources(job);
    try{this.persist(job);}catch(error){job.error+="；任务状态保存失败："+error.message;}
    job.storageLease?.release();this.settle(job,failure(409,job.errorCode,job.error,{meshJob:this.descriptor(job,null)}));
  }
  async cancel(job) {
    if(job.derivationAttempt?.state==='working'){job.derivationAttempt.controller.abort();await this.artifacts.cancelJob(job.jobId);await job.derivationPromise;return {status:200,payload:{ok:true,meshJob:this.descriptor(job,await this.safeLive(job.documentId))}};}
    if(!isActiveMeshJob(job))return failure(409,"MESH_JOB_NOT_ACTIVE","任务已结束，无需取消。",{meshJob:this.descriptor(job,await this.safeLive(job.documentId))});
    if(job.state==="cancelling")return {status:202,payload:{ok:true,meshJob:this.descriptor(job,null)}};
    if(job.state==="running"&&(!job.ownsClient||typeof job.client?.closeAndWait!=="function"))
      return failure(409,"MESH_CANCEL_UNAVAILABLE","此工作进程无法隔离取消，任务继续运行。");
    job.terminationReason="cancel";job.controller?.abort();job.state="cancelling";this.persist(job);
    const stoppingArtifacts=this.artifacts.cancelJob(job.jobId);
    if(job.client) {job.stopping=Promise.all([job.client.closeAndWait(),stoppingArtifacts]);job.stopping.catch(()=>{});await job.completion;}
    else if(this.queue.includes(job)) {this.queue=this.queue.filter(item=>item!==job);await this.finishTermination(job);}
    // Preparing: let the native BREP export finish; never terminate the CAD geometry worker.
    return {status:job.state==="cancelling"?202:200,payload:{ok:true,meshJob:this.descriptor(job,null)}};
  }
  close() {
    if(this.closing)return this.closing;
    this.closed=true;
    for(const job of this.jobs.values())job.derivationAttempt?.controller?.abort();
    const pending=[this.assets?.close(),this.qualityQueries.close(),this.artifacts.close(),this.ready,...this.recoveryTasks,...this.derivationTasks];
    this.computeGate.close();
    for(const job of this.jobs.values())pending.push(job.preparation,job.task,job.stopObservation);
    for(const job of this.jobs.values())if(isActiveMeshJob(job)) {
      pending.push(job.completion,job.preparation,job.task);
      job.terminationReason||="shutdown";job.state="cancelling";job.visible=false;
      job.controller?.abort();
      job.errorCode="MESH_SERVICE_STOPPING";job.error="后台正在停止，等待任务与工作进程安全收尾；未发布网格结果。";
      try{this.persist(job);}catch(error){console.error("[mesh] Interrupt persistence:",error.message);}
      if(job.ownsClient&&job.client&&!job.stopObservation){job.stopping||=job.client.dispose?job.client.dispose():job.client.closeAndWait();job.stopping.catch(()=>{});pending.push(job.stopping);}
      else if(this.queue.includes(job))pending.push(this.finishTermination(job));
    }
    this.queue=[];
    this.closing=Promise.allSettled(pending.filter(Boolean)).then(async results=>{const observed=await Promise.allSettled([...this.stopObservations]);const failed=[...results,...observed].find(result=>result.status==='rejected');if(failed)throw failed.reason;});
    this.closing.catch(error=>console.error('[mesh] Stop remains unconfirmed:',error.message));
    return this.closing;
  }
  closeAndWait(){return this.close();}
}
