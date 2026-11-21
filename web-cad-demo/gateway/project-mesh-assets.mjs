import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {MeshAssetRegistry,readAssetFile,assetDirectoryChain} from './mesh-asset-registry.mjs';
import {meshAssetCertificateCurrent,openMaterializedMeshAsset} from './project-mesh-archive.mjs';
import {assessMeshSource} from '../shared/mesh-source.mjs';
import {meshAdmitted} from '../shared/mesh-admission.mjs';
import {captureCadMeshMaterials} from './cad-mesh-materials.mjs';
import {parseDiscreteMeshDerivation,DERIVED_MESH_RESERVATION_BYTES} from './discrete-mesh-registration.mjs';
import {parseMeshRecoveryRequest} from '../shared/mesh-completion-recovery.mjs';
import {queryMeshBoundary} from './mesh-boundary-query.mjs';
import {readMeshRenderChunk} from './mesh-render-store.mjs';
import {DISCRETE_MESH_FAMILY,DISCRETE_CONSTRAINED_MESH_FAMILY} from './discrete-mesh-family.mjs';
import {isConstrainedTetraJob} from './discrete-tetra-task-result.mjs';
import {optimizationRecoverable} from './mesh-optimization-recovery.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code}),response=(status,code,error,extra={})=>({status,payload:{ok:false,code,error,...extra}}),same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
const sourceOf=ref=>ref.job.source?{...ref.job.source,documentId:ref.documentId}:undefined;
/** Imported assets have their own identity and mutable display/derivation state.
 * The generating record and its original namespace remain immutable. */
export class ProjectMeshAssets{
  constructor({host,registry=new MeshAssetRegistry(host.dataDir),projectBusy=()=>false}){Object.assign(this,{host,registry,projectBusy});this.phase='not-started';this.cache=new Map();this.cacheBytes=0;this.visible=new Set();this.work=new Map();this.mutations=new Map();this.fences=new Map();this.closed=false;this.ready=Promise.resolve();}
  start(previousAttemptId){
    if(this.phase==='recovering')return this.ready;
    this.previousAttemptId=previousAttemptId;this.attemptId=crypto.randomUUID();this.phase='recovering';this.visible.clear();this.cache.clear();this.cacheBytes=0;
    this.ready=this.host.artifacts.execute({operation:'asset-catalog'}).then(result=>{
      this.registry.adoptAll(result.items);this.retainedPointerStages=result.retainedPointerStages||[];
      for(const ref of this.registry.entries.values()){
        const state=this.registry.state(ref);
        if(state.attempts.some(row=>row.state==='working')||state.recovery?.state==='checking')this.registry.update(ref,value=>({...value,attempts:value.attempts.map(row=>row.state==='working'?{...row,state:'cancelled',code:'MESH_ASSET_INTERRUPTED',error:'服务停止时操作未完成；未自动重复执行。'}:row),recovery:value.recovery?.state==='checking'?{...value.recovery,state:'failed',code:'MESH_ASSET_INTERRUPTED',error:'服务停止时校验未完成，请明确重试。'}:value.recovery}));
      }
      if(!this.closed)this.phase='ready';
    }).catch(error=>{this.phase='unavailable';this.error=error;});
    return this.ready;
  }
  async access(){await this.ready;if(this.phase!=='ready')throw fail('MESH_ASSET_REGISTRY_UNAVAILABLE','网格资产登记尚未完整恢复，未返回部分历史。');if(this.closed)throw fail('MESH_SERVICE_STOPPING','网格资产服务正在停止。');}
  count(id){return this.phase==='ready'?this.registry.list(id).length:0;}
  pendingCount(except){let count=0;for(const lock of this.fences.values())if(lock!==except&&lock.nextSetId!==undefined&&this.registry.snapshot(lock.documentId).setId!==lock.nextSetId)count+=Math.max(0,lock.incomingCount-this.registry.list(lock.documentId).length);return count;}
  assertImportCapacity(lock,incoming){const total=this.host.jobs.size+(this.host.admitting?.size||0)+this.count()-this.count(lock.documentId)+incoming+this.pendingCount(lock),perDocument=[...this.host.jobs.values()].filter(job=>job.documentId===lock.documentId).length+incoming;if(total>(this.host.maxStoredJobs||2000)||perDocument>(this.host.maxJobsPerDocument||500))throw fail('MESH_TASK_CAPACITY','恢复后的网格资产超过工程或总存储数量上限，未覆盖已有结果。');}
  has(id){return Boolean(this.registry.get(id));}
  assertWritable(id){if(this.closed||this.fences.has(id)||this.projectBusy(id))throw fail('PROJECT_MESH_SNAPSHOT_BUSY','工程文件正在保存、打开或恢复，网格操作未重复开始。');}
  async begin(documentId){
    await this.access();const error=await this.host.catalogAccess?.();if(error)throw fail(error.payload.code,error.payload.error);
    const nativeBusy=[...this.host.jobs.values()].some(job=>job.documentId===documentId&&(['preparing','queued','running','cancelling'].includes(job.state)||job.completion||job.deleting||job.discardingDerived||job.stopUnconfirmed||job.derivationAttempt?.state==='working'||job.recoveryAttempt?.state==='checking'));
    if(this.fences.has(documentId)||this.projectBusy(documentId)||this.host.admitting.has(documentId)||nativeBusy||[...(this.host.activeRequests||[])].some(entry=>entry.documentId===documentId)||[...this.work.values(),...this.mutations.values()].some(work=>work.ref.documentId===documentId))throw fail('PROJECT_MESH_SNAPSHOT_BUSY','工程网格仍在计算、校验或清理，请结束后再保存或打开。');
    const lock={id:crypto.randomUUID(),documentId,beforeSetId:this.registry.snapshot(documentId).setId,assetIds:this.registry.list(documentId).map(ref=>ref.assetId)};
    this.fences.set(documentId,lock);
    try{lock.lease=await this.host.storageBudget.reserve('project-'+lock.id);if(this.closed)throw fail('MESH_SERVICE_STOPPING','网格资产服务正在停止。');return lock;}
    catch(error){lock.lease?.release();this.fences.delete(documentId);throw error;}
  }
  end(lock){
    if(this.fences.get(lock?.documentId)!==lock)return;
    try{if(this.registry.snapshot(lock.documentId).setId!==lock.beforeSetId)for(const id of lock.assetIds){this.drop(id);this.visible.delete(id);this.errors?.delete(id);}}
    catch(error){this.error=error;for(const id of lock.assetIds){this.drop(id);this.visible.delete(id);}}
    finally{lock.lease?.release();this.fences.delete(lock.documentId);}
  }
  async mutate(ref,action){this.assertWritable(ref.documentId);if(this.mutations.has(ref.assetId))throw fail('MESH_ASSET_BUSY','网格资产正在执行其他操作。');const controller=new AbortController(),entry={ref,controller};this.mutations.set(ref.assetId,entry);entry.promise=Promise.resolve().then(()=>{if(controller.signal.aborted)throw fail('MESH_ARTIFACT_CANCELLED','网格资产操作已取消。');return action(controller.signal);});try{return await entry.promise;}finally{if(this.mutations.get(ref.assetId)===entry)this.mutations.delete(ref.assetId);}}
  async pack(lock,{folderName,summary,projectData,name,maxUnpackedBytes,maxPackedBytes,signal}){const nativeJobs=[...this.host.jobs.values()].filter(job=>job.documentId===lock.documentId).map(job=>({jobId:job.jobId,documentId:job.documentId,state:job.state})),assetRefs=this.registry.list(lock.documentId).map(ref=>this.registry.workerRef(ref)),value=await this.host.artifacts.execute({operation:'project-package-save',result:{documentId:lock.documentId,folderName,summary,projectData,name,maxUnpackedBytes,maxPackedBytes,storageBytes:lock.lease.bytes,nativeJobs,assetRefs},ownerId:'project-'+lock.id,signal});if(this.fences.get(lock.documentId)!==lock)throw fail('PROJECT_MESH_SNAPSHOT_CHANGED','工程保存归属已变化。');await lock.lease.verify();return {bytes:readAssetFile(path.join(this.host.dataDir,'project-transactions',folderName,'project.cadproj'),maxPackedBytes,value.proof).bytes,meshAssetCount:value.meshAssetCount};}
  async prepare(lock,{folderName,maxUnpackedBytes,maxPackedBytes,signal}){const value=await this.host.artifacts.execute({operation:'project-package-open',result:{documentId:lock.documentId,folderName,maxUnpackedBytes,maxPackedBytes,storageBytes:lock.lease.bytes},ownerId:'project-'+lock.id,signal});if(this.fences.get(lock.documentId)!==lock)throw fail('PROJECT_MESH_SNAPSHOT_CHANGED','工程打开归属已变化。');this.assertImportCapacity(lock,value.preparedMeshAssets.index.bindings.length);lock.incomingCount=value.preparedMeshAssets.index.bindings.length;lock.nextSetId=value.preparedMeshAssets.snapshot.setId;await lock.lease.verify();return value;}
  fresh(ref,view){let value=assessMeshSource(sourceOf(ref),view,ref.documentId);if(value.status==='current'&&ref.job.kind==='discrete-tetra')try{if(captureCadMeshMaterials(view).sha256!==ref.job.materialSourceSha256)value={status:'stale',reason:'材料赋值或使用中的材料定义已变化，结果保持隐藏。',changedBodyIds:[]};}catch{value={status:'unverified',reason:'当前材料无法完整核对，结果保持隐藏。',changedBodyIds:[]};}return value;}
  current(ref,epoch){return this.registry.get(ref.assetId)===ref&&this.registry.state(ref).generation===epoch;}
  verified(ref){const item=this.cache.get(ref.assetId);return item&&item.epoch===this.registry.state(ref).generation&&performance.now()-item.verifiedAt<30000&&meshAssetCertificateCurrent(item.certificate)?item:null;}
  put(ref,reply){const mesh=reply.verification?.mesh,summary=mesh?{dimension:mesh.dimension,nodeCount:mesh.nodeCount,elementCount:mesh.elementCount,quality:mesh.quality,admission:mesh.admission}:null,item={epoch:this.registry.state(ref).generation,verifiedAt:performance.now(),summary,render:mesh?.render,certificate:reply.certificate,outputPath:reply.outputPath,renderPath:reply.renderPath,proof:ref.job.kind==='discrete-tetra'?reply.verification?.derivedMeshRegistration?.files?.mesh:ref.job.artifact?.mesh};item.bytes=Buffer.byteLength(JSON.stringify({summary:item.summary,render:item.render}));this.drop(ref.assetId);while(this.cacheBytes+item.bytes>64*1024**2&&this.cache.size)this.drop(this.cache.keys().next().value);this.cache.set(ref.assetId,item);this.cacheBytes+=item.bytes;}
  drop(id){const old=this.cache.get(id);if(old)this.cacheBytes-=old.bytes||0;this.cache.delete(id);}
  descriptor(ref,view){
    const job=ref.job,state=this.registry.state(ref),recovered=state.recovery?.state==='complete',cache=this.verified(ref),working=state.attempts.at(-1)?.state==='working',last=state.attempts.at(-1),freshness=this.fresh(ref,view),complete=recovered?'complete':job.state,hasDerived=state.derivedMode!=='absent',error=this.errors?.get(ref.assetId),derivationState=working?'working':error?.code==='MESH_DERIVED_ARTIFACT_INVALID'?'invalid':hasDerived?cache?.summary?'ready':'unverified':last?.operation==='discard'&&last.state==='complete'?'available':last?.state||'available';
    const optimizationRecovery=!recovered&&optimizationRecoverable(job)&&typeof this.host.optimizationRecoveryInfo==='function'?this.host.optimizationRecoveryInfo(job,{failedStateToken:this.registry.token(ref)}):null;
    return {
      jobId:ref.assetId,documentId:ref.documentId,revision:job.source?.revision??null,source:sourceOf(ref),selection:{kind:'all'},kind:job.kind||'mesh',state:complete,
      createdAt:job.createdAt,startedAt:job.startedAt,finishedAt:job.finishedAt,options:job.options,preparationSummary:job.preparationSummary,surfaceSummary:job.surfaceSummary,
      discreteTetraSummary:job.discreteTetraSummary,discreteFailureSummary:job.discreteFailureSummary,discreteStage:recovered&&job.kind==='discrete-tetra'?'complete':job.discreteStage,...(job.artifact?.checkpoint?{checkpoint:{recorded:true,normalMeshAdmitted:false,automaticReplay:false}}:{}),
      freshness,admission:cache?.summary?.admission||null,visible:this.visible.has(ref.assetId)&&freshness.status==='current'&&meshAdmitted(cache?.summary?.admission),requestedVisible:this.visible.has(ref.assetId),
      recovered:true,origin:{kind:'project-mesh-asset',documentId:job.documentId,jobId:job.jobId},...(!recovered&&job.error?{error:job.error,errorCode:job.errorCode}:{}),
      ...(job.kind==='discrete-tetra'?{normalMeshAdmitted:meshAdmitted(cache?.summary?.admission),derivation:{version:1,state:derivationState,sourceToken:this.registry.token(ref),canStart:complete==='complete'&&job.options?.discreteTetra?.quality?.mode==='strict'&&!working&&!hasDerived,defaultVisible:false,...(last?{requestId:last.requestId,...(last.code?{code:last.code,error:last.error}:{})}:{}),...(error?{code:error.code,error:error.message}:{})}}:{}),
      ...(job.errorCode==='MESH_COMPLETION_UNCOMMITTED'&&job.artifact?.result?{completionRecovery:{version:1,state:state.recovery?.state||'available',failedStateToken:this.registry.token(ref),...(state.recovery?{requestId:state.recovery.requestId,...(state.recovery.code?{code:state.recovery.code,error:state.recovery.error?.slice(0,300)}:{})}:{})}}:{})
      ,...(job.optimizationRecovery?{optimizationAttempt:{...job.optimizationRecovery}}:{}),...(optimizationRecovery?{optimizationRecovery}:{})
    };
  }
  async read(ref,operation='asset-read',query,signal){const epoch=this.registry.state(ref).generation,reply=await this.host.artifacts.execute({operation,job:{jobId:ref.assetId},ownerId:ref.assetId,result:{ref:this.registry.workerRef(ref),query},signal});if(!this.current(ref,epoch)||this.projectBusy(ref.documentId))throw fail('MESH_ASSET_CHANGED','读取期间工程或网格资产登记发生变化。');this.put(ref,reply);this.errors?.delete(ref.assetId);return reply;}
  publicResult(ref,value){const result={...value,requestId:ref.assetId};delete result.derivedCertificate;delete result.index;if(result.mesh)result.mesh={...result.mesh,...(result.mesh.outputPath?{outputPath:path.join(this.host.dataDir,'meshes',ref.assetId+'.msh')}:{})};return result;}
  async handle(method,assetId,action,input={},signal){await this.access();const ref=this.registry.get(assetId);if(!ref)return response(404,'MESH_JOB_NOT_FOUND','恢复网格资产已不存在。');if(this.projectBusy(ref.documentId))return response(409,'PROJECT_RECOVERY_REQUIRED','工程文件事务尚未完成，暂不读取网格资产。');
    try{
      if(method==='POST'&&action==='derive')return await this.mutate(ref,()=>this.derive(ref,input));
      if(method==='POST'&&action==='derive-discard')return await this.mutate(ref,()=>this.discard(ref,input));
      if(method==='POST'&&action==='recover-completion')return await this.mutate(ref,signal=>this.recover(ref,input,signal));
      if(method==='POST'&&action==='resume-optimization'){if(typeof this.host.resumeOptimization!=='function')return response(503,'MESH_OPTIMIZATION_RECOVERY_UNAVAILABLE','当前宿主没有独立优化恢复能力。');return await this.mutate(ref,()=>this.host.resumeOptimization(ref.job,input,{assetRef:ref}));}
      if(method==='POST'&&action==='cancel'){const work=this.work.get(assetId),mutation=this.mutations.get(assetId);work?.controller.abort();mutation?.controller.abort();await Promise.allSettled([work?.promise,mutation?.promise]);return {status:200,payload:{ok:true,meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))}};}
      if(method==='DELETE'&&!action){if(this.host.optimizationSourcePins?.has(assetId))return response(409,'MESH_OPTIMIZATION_RECOVERY_BUSY','检查点正在复制到独立尝试，暂不删除原资产。');return await this.mutate(ref,()=>this.remove(ref));}
      if(method==='POST'&&action==='visibility'){
        if(['preparation','surface-reconstruction'].includes(ref.job.kind))return response(409,'MESH_PREPARATION_NOT_MESH','修复或交叉处理预览不是可显示的体网格。');if(typeof input.visible!=='boolean')return response(400,'MESH_VISIBILITY_INVALID','visible 必须为布尔值。');if(!input.visible)this.visible.delete(assetId);else{const descriptor=this.descriptor(ref,await this.host.safeLive(ref.documentId));if(descriptor.freshness.status!=='current'||descriptor.state!=='complete')return response(409,'MESH_SOURCE_STALE',descriptor.freshness.reason);const reply=await this.read(ref,'asset-read',undefined,signal);if(!meshAdmitted(reply.verification?.mesh?.admission)||this.fresh(ref,await this.host.safeLive(ref.documentId)).status!=='current')return response(409,'MESH_ADMISSION_REQUIRED','恢复网格未通过当前工程验收。');if(this.registry.get(assetId)!==ref)throw fail('MESH_ASSET_CHANGED','网格资产已变化。');this.visible.add(assetId);}return {status:200,payload:{ok:true,meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))}};
      }
      if(method==='GET'&&!action){const job=ref.job,hasResult=job.artifact?.result||job.artifact?.discreteFailure||job.artifact?.checkpoint,value=hasResult?this.publicResult(ref,(await this.read(ref,'asset-read',undefined,signal)).value):{ok:true};return {status:200,payload:{...value,...(value.mesh&&job.kind==='discrete-tetra'?{downloadUrl:'/api/mesh/outputs/'+assetId+'.msh'}:{}),meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))}};}
      if(method==='GET'&&action==='quality'){const value=(await this.read(ref,'asset-quality',input,signal)).value;return {status:200,payload:{ok:true,...value,meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))}};}
      if(method==='GET'&&action==='surface-report'){const value=(await this.read(ref,'asset-surface-report',input,signal)).value;return {status:200,payload:{ok:true,surfaceReport:value,meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))}};}
      if(method==='GET'&&action==='boundary'){const value=(await this.read(ref,'asset-read',undefined,signal)).value;if(!value.mesh?.boundaryMapping)return response(409,'MESH_BOUNDARY_UNAVAILABLE','此恢复结果不含 CAD 面来源。');const context=await this.host.serializeDocument(ref.documentId,async()=>{const view=await this.host.command('document.summary',{documentId:ref.documentId});return {view,schema:this.host.getPropertySchema?.(ref.documentId,view)};});const descriptor=this.descriptor(ref,context.view),boundary=queryMeshBoundary(value.mesh.boundaryMapping,ref.job,input,context.schema,descriptor.freshness.status==='current',{sourceFamily:ref.job.kind==='discrete-tetra'?isConstrainedTetraJob(ref.job)?DISCRETE_CONSTRAINED_MESH_FAMILY:DISCRETE_MESH_FAMILY:'occt-history'});return {status:200,payload:{ok:true,boundary,meshJob:descriptor}};}
      if(method==='GET'&&action==='render'){if(Object.keys(input).some(key=>!['wireKey','chunk'].includes(key))||!/^wire-[23]-[1-9]\d*$/.test(input.wireKey||'')||!/^(0|[1-9]\d*)$/.test(String(input.chunk??'')))return response(400,'MESH_RENDER_QUERY_INVALID','网格线分组或数据块无效。');let cached=this.verified(ref);if(!cached){await this.read(ref,'asset-read',undefined,signal);cached=this.verified(ref);}if(!cached||!meshAdmitted(cached.summary?.admission)||this.fresh(ref,await this.host.safeLive(ref.documentId)).status!=='current')return response(409,'MESH_SOURCE_STALE','恢复网格未通过当前来源核对。');const body=readMeshRenderChunk(cached.renderPath,cached.render,input.wireKey,Number(input.chunk));return {status:200,body,headers:{'Content-Type':'application/octet-stream','Content-Length':body.length,'Cache-Control':'no-store','X-CAD-Mesh-Format':'float64-le','X-CAD-Mesh-Wire':input.wireKey,'X-CAD-Mesh-Chunk':String(input.chunk)}};}
      return response(405,'METHOD_NOT_ALLOWED','不支持此网格资产操作。');
    }catch(error){this.visible.delete(assetId);this.drop(assetId);if(error.code==='MESH_DERIVED_ARTIFACT_INVALID'){this.errors||=new Map();this.errors.set(assetId,error);}return response(error.code==='MESH_ASSET_IO'?503:409,error.code||'MESH_ARTIFACT_INVALID',error.message,{meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))});}
  }
  async outputAccess(ref,{signal,diagnostic=false}={}){
    const reply=await this.read(ref,'asset-read',undefined,signal),mesh=reply.verification?.mesh,descriptor=this.descriptor(ref,await this.host.safeLive(ref.documentId));
    if(!mesh||!meshAdmitted(mesh.admission)&&!diagnostic)return response(409,'MESH_ADMISSION_REQUIRED','恢复网格未通过验收。');
    if(ref.job.kind==='discrete-tetra'&&descriptor.freshness.status!=='current')return response(409,'MESH_SOURCE_STALE','当前几何或材料已变化。');
    const cached=this.verified(ref);if(!cached||this.registry.get(ref.assetId)!==ref||signal?.aborted)return response(409,'MESH_ASSET_CHANGED','恢复资产读取期间变化，未授权下载。');
    return {status:200,filename:ref.assetId+'.msh',outputPath:cached.outputPath,proof:cached.proof,headers:{'X-CAD-Mesh-Admission':mesh.admission?.status||'unverified','X-CAD-Mesh-Quality-Policy':ref.job.kind==='discrete-tetra'?'strict':mesh.acceptance?.qualityPolicy||'warning','X-CAD-Mesh-Quality-Threshold':String(mesh.quality?.threshold??0)}};
  }
  async derive(ref,input){
    this.assertWritable(ref.documentId);
    const request=parseDiscreteMeshDerivation(input),state=this.registry.state(ref);
    if(request.sourceToken!==this.registry.token(ref)||ref.job.kind!=='discrete-tetra'||this.descriptor(ref,null).state!=='complete'||ref.job.options?.discreteTetra?.quality?.mode!=='strict')return response(409,'MESH_DERIVATION_SOURCE_CONFLICT','派生请求未绑定可验收的原始结果。');
    const previous=state.attempts.find(row=>row.requestId===request.requestId);
    if(previous){if(previous.operation!=='derive')return response(409,'MESH_DERIVATION_REQUEST_CONFLICT','请求编号已用于另一种操作。');return {status:previous.state==='working'?202:200,payload:{ok:true,meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))}};}
    if(this.work.has(ref.assetId)||state.attempts.length>=32)return response(409,'MESH_DERIVATION_BUSY','资产已有未完成操作或尝试记录达到上限。');
    if(state.derivedMode!=='absent')return response(409,'MESH_DISCRETE_DERIVATION_EXISTS','已有派生网格，未覆盖原文件。');
    if(this.fresh(ref,await this.host.safeLive(ref.documentId)).status!=='current')return response(409,'MESH_SOURCE_STALE','当前工程与恢复网格来源不一致。');
    this.assertWritable(ref.documentId);
    if(this.registry.get(ref.assetId)!==ref)throw fail('MESH_ASSET_CHANGED','网格资产已变化。');
    const controller=new AbortController(),work={ref,controller};
    this.registry.update(ref,value=>({...value,attempts:[...value.attempts,{...request,operation:'derive',state:'working'}]}));
    const directory=this.registry.stateDirectory(ref,{create:true});this.visible.delete(ref.assetId);this.drop(ref.assetId);
    work.promise=(async()=>{
      let lease;
      const temporary=path.join(directory,'derive-'+request.requestId+'.tmp'),target=path.join(directory,'derived-mesh');
      const assertOwner=()=>{if(controller.signal.aborted||this.closed||this.registry.get(ref.assetId)!==ref)throw fail('MESH_DERIVATION_CANCELLED','恢复网格派生已取消。');this.assertWritable(ref.documentId);};
      try{
        if(!fs.existsSync(target)){lease=await this.host.storageBudget.reserve('asset-'+request.requestId);if(lease.bytes<DERIVED_MESH_RESERVATION_BYTES)throw fail('MESH_STORAGE_CAPACITY','当前磁盘预留不足以保存完整派生文件。');}
        assertOwner();
        const value=await this.host.artifacts.execute({operation:'asset-derive',job:{jobId:ref.assetId},result:{ref:this.registry.workerRef(ref),requestId:request.requestId},signal:controller.signal});
        assertOwner();await lease?.verify();
        if(this.fresh(ref,await this.host.safeLive(ref.documentId)).status!=='current')throw fail('MESH_SOURCE_STALE','派生期间来源发生变化。');
        assertOwner();
        if(!value.existing){
          assetDirectoryChain(temporary);
          const stat=fs.lstatSync(temporary,{bigint:true}),names=['manifest.json','mesh.msh','render.bin','quality.json','result.json'];
          if(!same(stat,value.identity)||!stat.isDirectory()||stat.isSymbolicLink()||fs.existsSync(target)||value.directoryName!==path.basename(temporary)||!Array.isArray(value.files)||value.files.length!==5||new Set(value.files.map(row=>row.name)).size!==5||fs.readdirSync(temporary).sort().join(',')!==[...names].sort().join(','))throw fail('MESH_DERIVED_ARTIFACT_INVALID','派生暂存身份或角色清单变化。');
          for(const item of value.files){
            if(!names.includes(item.name))throw fail('MESH_DERIVED_ARTIFACT_INVALID','派生文件角色无效。');
            const actual=fs.lstatSync(path.join(temporary,item.name),{bigint:true});
            if(!actual.isFile()||actual.isSymbolicLink()||actual.nlink!==1n||!same(actual,item.identity))throw fail('MESH_DERIVED_ARTIFACT_INVALID','派生文件发布前变化。');
          }
          const manifest=JSON.parse(readAssetFile(path.join(temporary,'manifest.json'),16*1024**2,value.manifestProof).bytes);
          if(manifest.jobId!==ref.job.jobId||manifest.format!=='web-cad-derived-discrete-mesh')throw fail('MESH_DERIVED_ARTIFACT_INVALID','派生清单不属于原始任务。');
          fs.renameSync(temporary,target);
        }
        this.registry.update(ref,value=>({...value,derivedMode:'overlay',attempts:value.attempts.map(row=>row.requestId===request.requestId?{...row,state:'complete'}:row)}));
      }catch(error){
        if(this.registry.get(ref.assetId)===ref)this.registry.update(ref,value=>({...value,attempts:value.attempts.map(row=>row.requestId===request.requestId?{...row,state:controller.signal.aborted?'cancelled':'failed',code:error.code||'MESH_DERIVATION_FAILED',error:error.message.slice(0,2048)}:row)}));
      }finally{
        try{if(fs.existsSync(temporary)){assetDirectoryChain(temporary);if(path.dirname(temporary)!==directory)throw Error('Asset cleanup escaped owner');fs.rmSync(temporary,{recursive:true,force:true});}}
        finally{lease?.release();this.work.delete(ref.assetId);}
      }
    })().catch(error=>{this.phase='unavailable';this.error=error;});
    this.work.set(ref.assetId,work);
    return {status:202,payload:{ok:true,meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))}};
  }
  async discard(ref,input){
    this.assertWritable(ref.documentId);
    const request=parseDiscreteMeshDerivation(input);
    if(request.sourceToken!==this.registry.token(ref)||ref.job.kind!=='discrete-tetra')return response(409,'MESH_DERIVATION_SOURCE_CONFLICT','清理未绑定原始恢复资产。');
    const previous=this.registry.state(ref).attempts.find(row=>row.requestId===request.requestId);
    if(previous){if(previous.operation!=='discard')return response(409,'MESH_DERIVATION_REQUEST_CONFLICT','请求编号已用于另一种操作。');return {status:200,payload:{ok:true,meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))}};}
    if(this.registry.state(ref).attempts.length>=32)return response(409,'MESH_DERIVATION_BUSY','尝试记录达到上限，未遗忘旧请求后重新执行。');
    const work=this.work.get(ref.assetId);work?.controller.abort();await work?.promise;
    this.assertWritable(ref.documentId);
    if(this.registry.get(ref.assetId)!==ref)throw fail('MESH_ASSET_CHANGED','网格资产已变化。');
    this.visible.delete(ref.assetId);this.drop(ref.assetId);
    const state=this.registry.state(ref);
    this.registry.update(ref,value=>({...value,derivedMode:'absent',attempts:[...value.attempts,{...request,operation:'discard',state:'working'}]}));
    try{
      const root=this.registry.assetRoot(this.registry.snapshot(ref.documentId)),context=openMaterializedMeshAsset(root,ref.manifestProof,ref.entryId,{derivedMode:'absent',derivedRoot:path.join(root,'absent-'+ref.assetId)}),targets=[path.join(context.store.directory(context.job),'derived-mesh'),path.join(this.registry.stateDirectory(ref),'derived-mesh')];
      for(const target of targets)if(fs.existsSync(target)){assetDirectoryChain(target);if(![path.join(context.store.directory(context.job),'derived-mesh'),path.join(this.registry.states,ref.assetId,'derived-mesh')].includes(target))throw Error('Asset derived cleanup escaped owner');fs.rmSync(target,{recursive:true,force:true});}
      this.registry.update(ref,value=>({...value,attempts:value.attempts.map(row=>row.requestId===request.requestId?{...row,state:'complete'}:row)}));this.errors?.delete(ref.assetId);
    }catch(error){this.registry.update(ref,value=>({...value,attempts:value.attempts.map(row=>row.requestId===request.requestId?{...row,state:'failed',code:error.code||'MESH_DERIVATION_DISCARD_FAILED',error:error.message.slice(0,2048)}:row)}));throw error;}
    return {status:200,payload:{ok:true,meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId)),previousMode:state.derivedMode}};
  }
  async remove(ref){this.assertWritable(ref.documentId);const work=this.work.get(ref.assetId);work?.controller.abort();await work?.promise;await this.host.artifacts.cancelJob(ref.assetId);this.registry.update(ref,value=>({...value,deleted:true}));this.visible.delete(ref.assetId);this.drop(ref.assetId);const root=this.registry.assetRoot(this.registry.snapshot(ref.documentId)),target=path.join(root,'entries',ref.entryId);if(fs.existsSync(target)){assetDirectoryChain(target);if(path.dirname(target)!==path.join(root,'entries'))throw Error('Asset deletion escaped owner');fs.rmSync(target,{recursive:true,force:true});}return {status:200,payload:{ok:true,jobId:ref.assetId}};}
  async recover(ref,input,signal){
    this.assertWritable(ref.documentId);
    const request=parseMeshRecoveryRequest(input);
    if(request.failedStateToken!==this.registry.token(ref)||ref.job.errorCode!=='MESH_COMPLETION_UNCOMMITTED'||!ref.job.artifact?.result)return response(409,'MESH_COMPLETION_RECOVERY_CONFLICT','恢复未绑定原失败结果。');
    const current=this.registry.state(ref);
    if(current.recovery?.state==='complete'||current.recovery?.requestId===request.requestId)return {status:200,payload:{ok:true,meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))}};
    if(this.work.has(ref.assetId))return response(409,'MESH_COMPLETION_RECOVERY_BUSY','恢复资产正在处理其他操作。');
    if(!this.host.storageBudget?.verifyPublication)throw fail('MESH_STORAGE_UNAVAILABLE','完成恢复尚未配置磁盘准入。');
    const receipt=path.join(this.registry.stateDirectory(ref),'recovered-completion.json');
    await this.host.storageBudget.verifyPublication(fs.existsSync(receipt)?4096:Buffer.byteLength(JSON.stringify(ref.job))+4096);
    if(signal?.aborted||this.closed)throw fail('MESH_ARTIFACT_CANCELLED','网格资产校验已取消。');this.assertWritable(ref.documentId);
    this.registry.update(ref,value=>({...value,recovery:{...request,state:'checking'}}));
    try{await this.host.artifacts.execute({operation:'asset-recover-completion',job:{jobId:ref.assetId},ownerId:ref.assetId,result:{ref:this.registry.workerRef(ref)},signal});if(signal?.aborted||this.closed)throw fail('MESH_ARTIFACT_CANCELLED','网格资产校验已取消。');this.assertWritable(ref.documentId);this.registry.update(ref,value=>({...value,recovery:{...request,state:'complete'}}));this.drop(ref.assetId);}
    catch(error){if(this.registry.get(ref.assetId)===ref)this.registry.update(ref,value=>({...value,recovery:{...request,state:'failed',code:error.code||'MESH_ARTIFACT_INVALID',error:error.message.slice(0,300)}}));}
    return {status:200,payload:{ok:true,meshJob:this.descriptor(ref,await this.host.safeLive(ref.documentId))}};
  }
  async close(){this.closed=true;const pending=[...this.work.values(),...this.mutations.values()];for(const work of pending)work.controller.abort();await Promise.allSettled(pending.map(work=>work.promise));}
}
