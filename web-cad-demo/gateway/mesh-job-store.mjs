import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {captureMeshSource} from "../shared/mesh-source.mjs";
import {normalizeMeshSizing,validateMeshSizingSource,validateMeshSizingReport} from '../shared/mesh-sizing.mjs';
import {validateMeshStrategyExecution} from './mesh-strategy-proof.mjs';
import {validateMeshResourceProof,validateMeshResourceExecution} from './mesh-resource-proof.mjs';
import {validateQualityIndex} from "./mesh-quality-query.mjs";
import {withStreamedQualityIndex} from './mesh-quality-stream.mjs';
import {assessMeshAdmission} from './mesh-admission.mjs';
import {normalizeMeshQualityPolicy,meshAcceptanceSettings,validateMeshAcceptanceSettings} from '../shared/mesh-quality-policy.mjs';
import {normalizeMeshOptimization,validateMeshOptimizationReport} from '../shared/mesh-optimization.mjs';
import {admissionRuntimeKey,verifyMeshAdmissionReceipt} from './mesh-admission-memo.mjs';
import {scanMeshCatalog} from './mesh-catalog.mjs';
import {validateMeshBoundary} from './mesh-boundary-query.mjs';
import {sealMeshRender,validateMeshRender,readRenderManifest,MESH_RENDER_LIMITS} from './mesh-render-store.mjs';
import {validatePreparation,preparationSummary} from "./mesh-preparation-report.mjs";
import {writeAtomicRecord,recordPersistenceDiagnostic} from './atomic-record-file.mjs';
import {meshCompletionRecord,resolveMeshCompletion} from './mesh-completion-record.mjs';
import {SURFACE_TASK_KIND,SURFACE_SOURCE_BYTES,SURFACE_RESULT_BYTES} from '../shared/discrete-surface-task.mjs';
import {validateSurfaceJobOptions,validateSurfaceResourceProof,validateSurfaceSourceSnapshot,validateSurfaceTaskResult,validateSurfaceSummary} from './discrete-surface-task-result.mjs';
import {surfaceReportPage,normalizeSurfaceReportQuery} from './discrete-surface-report.mjs';
import {DISCRETE_TETRA_TASK_KIND,CAD_DISCRETE_TETRA_SOURCE_BYTES,CAD_DISCRETE_TETRA_RESULT_BYTES} from '../shared/discrete-tetra-task.mjs';
import {TETRA_PARTITION_BYTES,TETRA_FAILURE_BYTES,validateTetraJobOptions,validateTetraResources,validateTetraSummary,validateTetraFailureSummary,validateTetraSource,validateTetraPartition,validateTetraTaskResult,validateTetraTaskFailure} from './discrete-tetra-task-result.mjs';
import {TETRA_CHECKPOINT_BYTES,validateTetraTaskCheckpoint} from './discrete-tetra-checkpoint.mjs';
import {OPTIMIZATION_ORIGIN_BYTES,validateOptimizationRecovery,validateOptimizationOrigin,optimizationOrigin,optimizationRecordHash} from './mesh-optimization-recovery.mjs';
import {expectedDiscreteMeshFiles,DISCRETE_MESH_FILE_LIMITS} from './discrete-mesh-files.mjs';
import {discreteMeshSourceToken} from './discrete-mesh-registration.mjs';

const documentIdPattern=/^[A-Za-z0-9_-]{1,64}$/;
const jobIdPattern=/^mesh-[a-f0-9-]{36}$/;
const states=new Set(["preparing","queued","running","cancelling","complete","failed","cancelled","interrupted","deleted"]);
const activeStates=new Set(["preparing","queued","running","cancelling"]);
export const isActiveMeshJob=job=>activeStates.has(job.state);

function atomicJson(target,value,maxBytes=256*1024*1024,createOnly=false) {
  fs.mkdirSync(path.dirname(target),{recursive:true});
  return writeAtomicRecord(target,value,{maxBytes,createOnly});
}
const artifactError=message=>Object.assign(new Error(message),{code:'MESH_ARTIFACT_INVALID'});
const sameJson=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sameFile=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
const identity=entry=>Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs'].map(key=>[key,String(entry[key])]));
function checkedFile(file,maxBytes,read){
  const before=fs.lstatSync(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)throw artifactError('网格结果文件类型不合法。');
  if(before.size>BigInt(maxBytes))throw Object.assign(new Error('网格材料超出本次读取预算，原文件保留。'),{code:'MESH_ARTIFACT_LIMIT'});
  const fd=fs.openSync(file,'r');try{if(!sameFile(before,fs.fstatSync(fd,{bigint:true})))throw artifactError('网格材料打开时发生变化。');const value=read(fd,Number(before.size));if(!sameFile(before,fs.fstatSync(fd,{bigint:true}))||!sameFile(before,fs.lstatSync(file,{bigint:true})))throw artifactError('网格材料读取时发生变化。');return value;}finally{fs.closeSync(fd);}
}
function digestFile(file,maxBytes=2*1024*1024*1024){return checkedFile(file,maxBytes,(fd,bytes)=>{const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let count,total=0;while((count=fs.readSync(fd,buffer,0,Math.min(buffer.length,bytes-total),null))>0){hash.update(buffer.subarray(0,count));total+=count;}if(total!==bytes)throw artifactError('网格材料不完整。');return {bytes,sha256:hash.digest('hex')};});}
function readCheckedJson(file,expected,maxBytes=256*1024*1024,onBytes){return checkedFile(file,maxBytes,(fd,size)=>{onBytes?.(size);const bytes=Buffer.allocUnsafe(size);let offset=0;while(offset<size){const count=fs.readSync(fd,bytes,offset,Math.min(1024*1024,size-offset),null);if(!count)throw artifactError('网格 JSON 不完整。');offset+=count;}const proof={bytes:size,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};if(expected&&!sameDigest(proof,expected))throw artifactError('网格 JSON 校验失败。');return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),proof};});}
function sameDigest(actual,expected) {return expected && actual.bytes===expected.bytes && actual.sha256===expected.sha256;}
function validDigest(value,maxBytes) {return value&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=maxBytes&&/^[a-f0-9]{64}$/.test(value.sha256);}
export function validateMeshJobRecord(job,identity) {
  const surface=job.kind===SURFACE_TASK_KIND,tetra=job.kind===DISCRETE_TETRA_TASK_KIND;
  if(surface){validateSurfaceJobOptions(job.options);validateSurfaceResourceProof(job.options,job.processResources,{required:job.state==='complete'});if(job.surfaceSummary)validateSurfaceSummary(job.surfaceSummary,job.options);}
  else if(tetra){validateTetraJobOptions(job.options);validateTetraResources(job.options,job.processResources,{required:job.state==='complete'});if(job.discreteTetraSummary)validateTetraSummary(job.discreteTetraSummary,job.options);}
  else{
  normalizeMeshQualityPolicy(job.options?.qualityPolicy);
  normalizeMeshOptimization(job.options?.optimization);
  validateMeshStrategyExecution(job.options);
  validateMeshResourceProof(job.options,job.processResources,{required:job.state==='complete'&&job.kind!=='preparation'&&job.options?.nativeMemoryLimitBytes!==undefined});
  }
  if(job.version!==1||job.documentId!==identity.documentId||job.jobId!==identity.jobId||!states.has(job.state))throw new Error("任务元数据身份、版本或状态不合法。");
  if(job.kind!==undefined&&!["mesh","preparation",SURFACE_TASK_KIND,DISCRETE_TETRA_TASK_KIND].includes(job.kind))throw new Error("任务类型不合法。");
  if(job.preparationJobId!==undefined&&!jobIdPattern.test(job.preparationJobId))throw new Error("预览来源任务编号不合法。");
  if(job.preparationSummary){const value=job.preparationSummary;if(value.reportAvailable!==true||!["preparing","ready","blocked"].includes(value.status)||![value.bodyCount,value.errorCount,value.warningCount].every(n=>Number.isSafeInteger(n)&&n>=0)||![value.solidCount,value.faceCount].every(n=>n===null||Number.isSafeInteger(n)&&n>=0))throw new Error("诊断概要不合法。");}
  if(job.options?.deepCheck!==undefined&&typeof job.options.deepCheck!=="boolean")throw new Error("诊断检查设置不合法。");
  if(typeof job.createdAt!=="string"||!Number.isFinite(Date.parse(job.createdAt)))throw new Error("任务创建时间不合法。");
  if(job.error!==undefined&&typeof job.error!=="string"||job.errorCode!==undefined&&typeof job.errorCode!=="string")throw new Error("任务错误信息格式不合法。");
  if(!surface&&!tetra&&job.options&&(!["conservative","aggressive","strict"].includes(job.options.repairMode)||!Number.isFinite(job.options.qualityThreshold)||job.options.qualityThreshold<0||job.options.qualityThreshold>1))throw new Error("任务设置不合法。");
  if(job.source) {
    if(job.source.version!==1||job.source.documentId!==job.documentId||!Number.isSafeInteger(job.source.revision))throw new Error("任务来源身份或版本不合法。");
    captureMeshSource({ok:true,documentId:job.documentId,bodyMetadata:job.source.bodies},job.documentId);
    validateMeshSizingSource(normalizeMeshSizing(job.options?.sizing),job.source);
  }
  else normalizeMeshSizing(job.options?.sizing);
  if(job.state==="complete"&&(!job.source||!validDigest(job.artifact?.result,256*1024*1024)||job.artifact?.mesh&&!validDigest(job.artifact.mesh,2*1024*1024*1024)))throw new Error("已完成任务缺少合法的来源或结果校验信息。");
  if(job.artifact?.quality&&!validDigest(job.artifact.quality,256*1024*1024))throw new Error("网格质量索引校验信息不合法。");
  if(job.artifact?.render&&!validDigest(job.artifact.render,2*1024*1024*1024))throw new Error('网格显示文件校验信息不合法。');
  // A derived acceleration cache is replaceable; its damage must not turn
  // an otherwise checked original mesh into a failed engineering artifact.
  if(job.artifact?.qualityQuery){const cache=job.artifact.qualityQuery;if(cache.version!==1||!validDigest(cache.source,256*1024*1024)||!validDigest(cache.manifest,16*1024*1024)||!/^[a-f0-9]{64}$/.test(cache.sourceKey))delete job.artifact.qualityQuery;}
  if(job.artifact?.preparedBrep&&!validDigest(job.artifact.preparedBrep,2*1024*1024*1024)||job.artifact?.preparedManifest&&!validDigest(job.artifact.preparedManifest,256*1024*1024))throw new Error("预览快照校验信息不合法。");
  if(job.kind==="preparation"&&job.state==="complete"&&(!job.artifact?.preparedBrep||!job.artifact?.preparedManifest))throw new Error("已完成预览缺少可验证的几何快照。");
  if(surface){
    if(job.preparationJobId!==undefined||job.preparationSummary!==undefined||job.meshSummary!==undefined||job.artifact&&Object.keys(job.artifact).some(key=>!['result','surfaceSource'].includes(key)))throw new Error('表面重构不能夹带体网格或 BREP 修复预览材料。');
    if(job.artifact?.surfaceSource&&!validDigest(job.artifact.surfaceSource,SURFACE_SOURCE_BYTES)||job.state==='complete'&&(!job.artifact?.surfaceSource||!job.surfaceSummary))throw new Error('表面重构缺少完整来源或结果概要。');
  }
  if(tetra){
    if(job.optimizationRecovery){validateOptimizationRecovery(job.optimizationRecovery);if(job.options.optimizationProcess!=='checkpoint-v1'||job.jobId===job.optimizationRecovery.originJobId)throw artifactError('优化恢复必须是独立尝试。');}
    if(job.preparationJobId!==undefined||job.preparationSummary!==undefined||job.meshSummary!==undefined||job.surfaceSummary!==undefined||job.artifact&&Object.keys(job.artifact).some(key=>!['result','discreteSource','partition','discreteFailure','checkpoint','optimizationOrigin'].includes(key)))throw artifactError('离散体任务不能夹带普通网格或其他任务材料。');
    if(job.source&&!/^[a-f0-9]{64}$/.test(job.materialSourceSha256||'')||job.discreteStage!==undefined&&!['capturing-source','queued','partition','tetra','checkpoint','optimizing','sealing','complete'].includes(job.discreteStage))throw artifactError('离散体来源或阶段不合法。');
    for(const [key,max]of [['discreteSource',CAD_DISCRETE_TETRA_SOURCE_BYTES],['partition',TETRA_PARTITION_BYTES],['discreteFailure',TETRA_FAILURE_BYTES],['checkpoint',TETRA_CHECKPOINT_BYTES]])if(job.artifact?.[key]&&!validDigest(job.artifact[key],max))throw artifactError('离散体材料凭据不合法。');
    if(job.artifact?.optimizationOrigin&&(!job.optimizationRecovery||!validDigest(job.artifact.optimizationOrigin,OPTIMIZATION_ORIGIN_BYTES))||job.optimizationRecovery&&job.artifact?.checkpoint&&!job.artifact.optimizationOrigin)throw artifactError('恢复检查点缺少原失败记录凭据。');
    if(job.artifact?.checkpoint&&(job.options.optimizationProcess!=='checkpoint-v1'||!job.artifact.partition||!job.processResources?.generation)||job.state==='complete'&&job.options.optimizationProcess==='checkpoint-v1'&&!job.artifact?.checkpoint)throw artifactError('独立优化任务缺少认证检查点或生成阶段证明。');
    if(job.artifact?.partition&&!job.artifact?.discreteSource||job.artifact?.discreteFailure&&(!job.artifact?.partition||job.artifact?.result)||job.state==='complete'&&(!job.artifact?.discreteSource||!job.artifact?.partition||!job.discreteTetraSummary||job.discreteStage!=='complete'))throw artifactError('离散体任务缺少完整来源、分区或概要。');
    if(job.discreteFailureSummary){validateTetraFailureSummary(job.discreteFailureSummary);if(!job.artifact?.discreteFailure)throw artifactError('离散体失败概要缺少凭据。');}
    if(job.artifact?.result&&!validDigest(job.artifact.result,CAD_DISCRETE_TETRA_RESULT_BYTES))throw artifactError('离散体结果超过保存预算。');
  }
  else if(job.optimizationRecovery!==undefined)throw artifactError('其他类型任务不能夹带优化恢复。');
}
const validateRecord=validateMeshJobRecord;

/** Derived file names only; saved metadata never grants access to an arbitrary path. */
export class MeshJobStore {
  constructor(dataDir) {this.dataDir=path.resolve(dataDir);this.root=path.join(this.dataDir,"mesh-jobs");fs.mkdirSync(this.root,{recursive:true});}
  directory(job) {
    if(!documentIdPattern.test(job.documentId) || !jobIdPattern.test(job.jobId))throw new Error("网格任务身份不合法。");
    return path.join(this.root,job.documentId,job.jobId);
  }
  output(job) {this.directory(job);return path.join(this.dataDir,"meshes",job.jobId+".msh");}
  // Physical output and the immutable generating result's locator normally agree.
  // A read-only portable asset verifier can override only the latter; it still
  // hashes bytes exclusively from output(job), never from the saved locator.
  resultOutput(job) {return this.output(job);}
  completionOutput(job){return path.join(this.directory(job),'completion.json');}
  readPersisted(job){
    const identity={documentId:job.documentId,jobId:job.jobId},directory=this.directory(job);
    for(let current=directory;;current=path.dirname(current)){const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw artifactError('网格记录路径含链接或异常目录。');if(path.dirname(current)===current)break;}
    const metadata=readCheckedJson(path.join(directory,'metadata.json'),null,16*1024*1024);validateRecord(metadata.value,identity);
    const completionFile=this.completionOutput(job);let record=metadata.value;
    if(fs.existsSync(completionFile))record=resolveMeshCompletion(record,metadata.proof,readCheckedJson(completionFile,null,16*1024*1024).value,identity,validateRecord);
    return {record,metadataProof:metadata.proof};
  }
  qualityOutput(job) {return path.join(this.directory(job),"quality.json");}
  renderOutput(job) {return path.join(this.directory(job),'render.bin');}
  readRender(job) {return readRenderManifest(path.join(this.directory(job),'result.json'),job.artifact.result,job.jobId);}
  preparedBrep(job) {return path.join(this.directory(job),"prepared.brep");}
  preparedManifest(job) {return path.join(this.directory(job),"prepared-manifest.json");}
  surfaceSource(job){return path.join(this.directory(job),'surface-source.json');}
  writeSurfaceSource(job,snapshot,{staging}={}){
    validateSurfaceSourceSnapshot(snapshot,job);const directory=this.directory(job),target=staging||this.surfaceSource(job);
    if(staging&&(path.dirname(path.resolve(staging))!==directory||!/^artifact-[a-f0-9-]{36}\.result\.tmp$/.test(path.basename(staging))))throw artifactError('表面来源暂存位置无效。');
    atomicJson(target,snapshot,SURFACE_SOURCE_BYTES,!staging);return {surfaceSource:digestFile(target,SURFACE_SOURCE_BYTES)};
  }
  readSurfaceSource(job){if(!job.artifact?.surfaceSource)throw artifactError('表面重构缺少来源凭据。');const read=readCheckedJson(this.surfaceSource(job),job.artifact.surfaceSource,SURFACE_SOURCE_BYTES);return validateSurfaceSourceSnapshot(read.value,job);}
  tetraFile(job,kind){if(!['discreteSource','partition','discreteFailure','checkpoint','optimizationOrigin'].includes(kind))throw artifactError('离散体材料类型不合法。');return path.join(this.directory(job),...(job.optimizationRecovery&&kind!=='discreteFailure'?['recovery-inputs']:[]),{discreteSource:'discrete-source.json',partition:'partition.json',discreteFailure:'failure.json',checkpoint:'optimization-checkpoint.json',optimizationOrigin:'optimization-origin.json'}[kind]);}
  readTetraSource(job){if(!job.artifact?.discreteSource)throw artifactError('离散体任务缺少来源凭据。');return validateTetraSource(readCheckedJson(this.tetraFile(job,'discreteSource'),job.artifact.discreteSource,CAD_DISCRETE_TETRA_SOURCE_BYTES).value,job);}
  readTetraPartition(job){if(!job.artifact?.partition)throw artifactError('离散体任务缺少分区凭据。');const value=readCheckedJson(this.tetraFile(job,'partition'),job.artifact.partition,TETRA_PARTITION_BYTES).value;validateTetraPartition(value,job,this.readTetraSource(job));return value;}
  readTetraCheckpoint(job,{validateOrigin=true}={}){if(!job.artifact?.checkpoint)throw artifactError('任务没有认证的优化检查点。');const value=readCheckedJson(this.tetraFile(job,'checkpoint'),job.artifact.checkpoint,TETRA_CHECKPOINT_BYTES).value;validateTetraTaskCheckpoint(value,job,this.readTetraSource(job),this.readTetraPartition(job));if(job.optimizationRecovery&&validateOrigin)this.readOptimizationOrigin(job,value);return value;}
  readOptimizationOrigin(job,checkpoint=this.readTetraCheckpoint(job,{validateOrigin:false})){
    if(!job.optimizationRecovery||!job.artifact?.optimizationOrigin)throw artifactError('恢复任务缺少原失败记录。');
    const value=readCheckedJson(this.tetraFile(job,'optimizationOrigin'),job.artifact.optimizationOrigin,OPTIMIZATION_ORIGIN_BYTES).value;
    validateRecord(value.record,{documentId:job.optimizationRecovery.originDocumentId,jobId:job.optimizationRecovery.originJobId});
    return validateOptimizationOrigin(value,job,this.readTetraSource(job),this.readTetraPartition(job),checkpoint);
  }
  stageOptimizationRecovery(sourceStore,sourceJob,job,{staging}={}){
    validateOptimizationRecovery(job.optimizationRecovery);const retained=sourceStore.readPersisted(sourceJob),origin=sourceStore.record(retained.record);
    if(job.optimizationRecovery.originKind==='native'&&retained.metadataProof.sha256!==job.optimizationRecovery.failedStateToken)throw artifactError('原失败状态凭据已变化。');
    if(optimizationRecordHash(origin)!==job.optimizationRecovery.originRecordSha256)throw artifactError('原失败记录在恢复捕获期间变化。');
    const snapshot=sourceStore.readTetraSource(origin),partition=sourceStore.readTetraPartition(origin),checkpoint=sourceStore.readTetraCheckpoint(origin),failure=origin.artifact?.discreteFailure?readCheckedJson(sourceStore.tetraFile(origin,'discreteFailure'),origin.artifact.discreteFailure,TETRA_FAILURE_BYTES).value:null;
    const value=optimizationOrigin(origin,failure),artifact=Object.fromEntries(['discreteSource','partition','checkpoint'].map(key=>[key,{...origin.artifact[key]}]));
    const target={...job,artifact,processResources:{partition:origin.processResources.partition,generation:origin.processResources.generation}};
    validateOptimizationOrigin(value,target,snapshot,partition,checkpoint);
    const parent=this.directory(job);if(path.dirname(path.resolve(staging||''))!==parent||!/^artifact-[a-f0-9-]{36}\.result\.tmp$/.test(path.basename(staging||'')))throw artifactError('恢复暂存目录不合法。');
    for(let current=parent;;current=path.dirname(current)){const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw artifactError('恢复目录不能经过链接。');if(path.dirname(current)===current)break;}
    fs.mkdirSync(staging);const files=[];
    for(const [kind,max]of [['discreteSource',CAD_DISCRETE_TETRA_SOURCE_BYTES],['partition',TETRA_PARTITION_BYTES],['checkpoint',TETRA_CHECKPOINT_BYTES]]){
      const input=sourceStore.tetraFile(origin,kind),name=path.basename(input),target=path.join(staging,name);fs.copyFileSync(input,target,fs.constants.COPYFILE_EXCL);const fd=fs.openSync(target,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const actual=digestFile(target,max);if(!sameDigest(actual,artifact[kind]))throw artifactError('恢复副本与认证原材料不一致。');files.push({kind,name,identity:fs.lstatSync(target,{bigint:true}),proof:actual});
    }
    const targetFile=path.join(staging,'optimization-origin.json');atomicJson(targetFile,value,OPTIMIZATION_ORIGIN_BYTES,true);artifact.optimizationOrigin=digestFile(targetFile,OPTIMIZATION_ORIGIN_BYTES);files.push({kind:'optimizationOrigin',name:'optimization-origin.json',identity:fs.lstatSync(targetFile,{bigint:true}),proof:artifact.optimizationOrigin});
    const confirmed=sourceStore.readPersisted(sourceJob);if(confirmed.metadataProof.sha256!==retained.metadataProof.sha256||optimizationRecordHash(sourceStore.record(confirmed.record))!==job.optimizationRecovery.originRecordSha256)throw artifactError('原失败记录在复制期间变化。');
    return {artifact,processResources:target.processResources,identity:fs.lstatSync(staging,{bigint:true}),files};
  }
  writeTetraArtifact(job,kind,value,{staging}={}){
    const max={discreteSource:CAD_DISCRETE_TETRA_SOURCE_BYTES,partition:TETRA_PARTITION_BYTES,discreteFailure:TETRA_FAILURE_BYTES,checkpoint:TETRA_CHECKPOINT_BYTES}[kind];if(!max)throw artifactError('离散体材料类型不合法。');
    let summary;
    if(kind==='discreteSource')validateTetraSource(value,job);
    else if(kind==='partition')summary=validateTetraPartition(value,job,this.readTetraSource(job));
    else if(kind==='checkpoint')summary=validateTetraTaskCheckpoint(value,job,this.readTetraSource(job),this.readTetraPartition(job));
    else summary=validateTetraTaskFailure(value,job,this.readTetraSource(job),this.readTetraPartition(job),job.artifact?.checkpoint?this.readTetraCheckpoint(job):undefined);
    const directory=this.directory(job),target=staging||this.tetraFile(job,kind);
    if(staging&&(path.dirname(path.resolve(staging))!==directory||!/^artifact-[a-f0-9-]{36}\.result\.tmp$/.test(path.basename(staging))))throw artifactError('离散体材料暂存位置不合法。');
    atomicJson(target,value,max,!staging);return {artifact:{[kind]:digestFile(target,max)},...(summary&&{summary})};
  }
  readTetraFailure(job){if(!job.artifact?.discreteFailure)throw artifactError('离散体任务缺少失败诊断凭据。');const value=readCheckedJson(this.tetraFile(job,'discreteFailure'),job.artifact.discreteFailure,TETRA_FAILURE_BYTES).value,summary=validateTetraTaskFailure(value,job,this.readTetraSource(job),this.readTetraPartition(job),job.artifact?.checkpoint?this.readTetraCheckpoint(job):undefined);if(job.discreteFailureSummary&&!sameJson(summary,job.discreteFailureSummary))throw artifactError('离散体失败概要与原材料不一致。');return {ok:true,protocolVersion:1,requestId:job.jobId,discreteFailureSummary:summary};}
  readTetraMaterials(job){
    if(job.kind!==DISCRETE_TETRA_TASK_KIND||job.state!=='complete'||!job.artifact?.result)throw artifactError('只有完整完成的离散体任务可生成普通网格材料。');
    const snapshot=this.readTetraSource(job),partition=this.readTetraPartition(job),result=readCheckedJson(path.join(this.directory(job),'result.json'),job.artifact.result,CAD_DISCRETE_TETRA_RESULT_BYTES).value;
    const checkpoint=job.artifact?.checkpoint?this.readTetraCheckpoint(job):undefined,summary=validateTetraTaskResult(result,job,snapshot,partition,checkpoint);if(job.discreteTetraSummary&&!sameJson(summary,job.discreteTetraSummary))throw artifactError('离散体概要与原始材料不一致。');
    return {snapshot,result:result.discreteTetra.value,summary,...(checkpoint?{checkpoint}:{}),...(job.optimizationRecovery?{targetDocumentId:job.documentId}:{})};
  }
  derivedDirectory(job){if(job.kind!==DISCRETE_TETRA_TASK_KIND)throw artifactError('该任务没有离散派生目录。');return path.join(this.directory(job),'derived-mesh');}
  derivedPaths(job){const directory=this.derivedDirectory(job);return {source:this.tetraFile(job,'discreteSource'),partition:this.tetraFile(job,'partition'),original:path.join(this.directory(job),'result.json'),...(job.artifact?.checkpoint?{checkpoint:this.tetraFile(job,'checkpoint')}:{}),...(job.optimizationRecovery?{optimizationOrigin:this.tetraFile(job,'optimizationOrigin')}:{}),directory,manifest:path.join(directory,'manifest.json'),mesh:path.join(directory,'mesh.msh'),render:path.join(directory,'render.bin'),quality:path.join(directory,'quality.json'),result:path.join(directory,'result.json')};}
  removeDerived(job){
    const target=this.derivedDirectory(job),parent=this.directory(job);if(!fs.existsSync(target))return false;
    if(path.dirname(target)!==parent||fs.realpathSync(target)!==path.join(fs.realpathSync(parent),'derived-mesh'))throw artifactError('拒绝清理任务之外的派生目录。');
    for(let current=target;;current=path.dirname(current)){const st=fs.lstatSync(current);if(!st.isDirectory()||st.isSymbolicLink())throw artifactError('拒绝沿链接清理派生网格。');if(path.dirname(current)===current)break;}
    fs.rmSync(target,{recursive:true,force:true});return true;
  }
  derivedIdentity(file,directory=false){const entry=fs.lstatSync(file,{bigint:true});if(entry.isSymbolicLink()||!(directory?entry.isDirectory():entry.isFile()&&entry.nlink===1n))throw artifactError('派生网格包含非普通文件或链接。');return identity(entry);}
  checkDerivedCertificate(job,certificate){
    const paths=this.derivedPaths(job);if(certificate?.version!==1||certificate.sourceToken!==discreteMeshSourceToken(job)||!certificate.files||Object.keys(certificate.files).length!==Object.keys(paths).length)return false;
    try{return Object.entries(paths).every(([key,file])=>sameJson(this.derivedIdentity(file,key==='directory'),certificate.files[key]));}catch(error){if(['ENOENT','MESH_ARTIFACT_INVALID'].includes(error.code))return false;throw error;}
  }
  readDerivedRender(job){try{if(!job.derivedRegistration?.files?.result)throw artifactError('没有经过完整校验的派生登记。');return readRenderManifest(this.derivedPaths(job).result,job.derivedRegistration.files.result,job.jobId);}catch(error){if(error.code==='MESH_ARTIFACT_INVALID')throw Object.assign(Error('派生显示清单已变化，原始结果保留。'),{code:'MESH_DERIVED_ARTIFACT_INVALID'});throw error;}}
  readDerivedTetra(job){
    const paths=this.derivedPaths(job),original=Object.fromEntries(['source','partition','original',...(job.artifact?.checkpoint?['checkpoint']:[]),...(job.optimizationRecovery?['optimizationOrigin']:[])].map(key=>[key,this.derivedIdentity(paths[key])]));
    const materials=this.readTetraMaterials(job); // Original failures remain distinct from damaged derivatives.
    try{
      for(let current=paths.directory;;current=path.dirname(current)){const entry=fs.lstatSync(current);if(!entry.isDirectory()||entry.isSymbolicLink())throw artifactError('派生目录经过链接或异常目录。');if(path.dirname(current)===current)break;}
      if(!sameJson(fs.readdirSync(paths.directory).sort(),['manifest.json','mesh.msh','quality.json','render.bin','result.json']))throw artifactError('派生网格文件集不完整或含有额外内容。');
      const before=Object.fromEntries(Object.entries(paths).map(([key,file])=>[key,this.derivedIdentity(file,key==='directory')]));
      const expected=expectedDiscreteMeshFiles({...materials,jobId:job.jobId}),limits={mesh:DISCRETE_MESH_FILE_LIMITS.mesh,render:DISCRETE_MESH_FILE_LIMITS.render,quality:DISCRETE_MESH_FILE_LIMITS.quality,result:DISCRETE_MESH_FILE_LIMITS.manifest,manifest:DISCRETE_MESH_FILE_LIMITS.manifest};
      for(const [key,max]of Object.entries(limits)){const actual=digestFile(paths[key],max),wanted=key==='manifest'?expected.manifestProof:expected.manifest.files[key];if(!sameDigest(actual,wanted))throw artifactError('派生文件与原 CAD 和网格重新推导的完整内容不一致。');}
      const certificate={version:1,sourceToken:discreteMeshSourceToken(job),files:before};
      if(!this.checkDerivedCertificate(job,certificate)||Object.entries(original).some(([key,value])=>!sameJson(value,before[key])))throw Object.assign(Error('核验期间原始或派生文件身份变化，未接纳旧检查。'),{code:'MESH_ARTIFACT_CHANGED'});
      const mesh=expected.projection.mesh,registration={version:1,sourceToken:certificate.sourceToken,manifestProof:expected.manifestProof,files:expected.manifest.files,summary:{dimension:mesh.dimension,nodeCount:mesh.nodeCount,elementCount:mesh.elementCount,quality:mesh.quality,admission:mesh.admission}};
      return {ok:true,protocolVersion:1,requestId:job.jobId,mesh,derivedMaterialSource:materials.snapshot.materials,discreteTetraSummary:materials.summary,derivedMeshRegistration:registration,derivedCertificate:certificate,index:expected.projection.index};
    }catch(error){if(['EACCES','EPERM','EBUSY','EIO','ENOSPC','EMFILE','ENFILE','EROFS','MESH_ARTIFACT_LIMIT','MESH_ARTIFACT_CHANGED'].includes(error.code))throw error;throw Object.assign(Error('派生网格未通过完整内容校验；原始剖分结果保留，没有自动重算。'),{code:'MESH_DERIVED_ARTIFACT_INVALID',cause:error});}
  }
  writePrepared(job,brep,manifest) {
    fs.mkdirSync(this.directory(job),{recursive:true});
    fs.copyFileSync(brep,this.preparedBrep(job));fs.copyFileSync(manifest,this.preparedManifest(job));
    return {preparedBrep:digestFile(this.preparedBrep(job)),preparedManifest:digestFile(this.preparedManifest(job),256*1024*1024)};
  }
  record(job) {
    return {version:1,jobId:job.jobId,documentId:job.documentId,state:job.state,source:job.source,kind:job.kind,preparationJobId:job.preparationJobId,preparationSummary:job.preparationSummary,
      createdAt:job.createdAt,startedAt:job.startedAt,finishedAt:job.finishedAt,options:job.options,processResources:job.processResources,
      error:job.error,errorCode:job.errorCode,artifact:job.artifact,meshSummary:job.meshSummary,surfaceSummary:job.surfaceSummary,materialSourceSha256:job.materialSourceSha256,discreteStage:job.discreteStage,discreteTetraSummary:job.discreteTetraSummary,discreteFailureSummary:job.discreteFailureSummary,...(job.optimizationRecovery?{optimizationRecovery:job.optimizationRecovery}:{})};
  }
  save(job) {const record=this.record(job),bytes=Buffer.from(JSON.stringify(record));atomicJson(path.join(this.directory(job),"metadata.json"),record,16*1024*1024);return {bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}
  readCompletionRecovery(job,failedStateToken) {
    const read=readCheckedJson(path.join(this.directory(job),'metadata.json'),null,16*1024*1024);validateRecord(read.value,{documentId:job.documentId,jobId:job.jobId});
    if(read.proof.sha256!==failedStateToken||read.value.state!=='failed'||read.value.errorCode!=='MESH_COMPLETION_UNCOMMITTED'||!read.value.source||!read.value.artifact?.result)throw Object.assign(Error('原失败记录已变化，未发布旧恢复结果。'),{code:'MESH_COMPLETION_RECOVERY_CONFLICT'});
    return read;
  }
  completionWriteBytes(job,{recovery}={}) {
    const record=this.record(job),directory=this.directory(job),previous=readCheckedJson(path.join(directory,'metadata.json'),null,16*1024*1024);
    const receipt=meshCompletionRecord(previous.value,record,previous.proof,{recovery}),recordBytes=Buffer.byteLength(JSON.stringify(record)),receiptBytes=Buffer.byteLength(JSON.stringify(receipt));
    if(recordBytes>16*1024*1024||receiptBytes>16*1024*1024)throw Object.assign(Error('网格完成记录超过单文件预算。'),{code:'MESH_ARTIFACT_LIMIT'});
    return (fs.existsSync(path.join(directory,'completion.json'))?0:receiptBytes)+Math.max(0,recordBytes-previous.proof.bytes);
  }
  commitCompletion(job,{recovery}={}) {
    const record=this.record(job),identity={documentId:job.documentId,jobId:job.jobId},directory=this.directory(job),file=path.join(directory,'completion.json');validateRecord(record,identity);
    if(record.state!=='complete')throw Object.assign(Error('只有确认完成的网格才能发布完成凭据。'),{code:'MESH_METADATA_COMPLETION_CONFLICT'});
    if(fs.existsSync(file)){
      const existing=readCheckedJson(file,null,16*1024*1024).value;
      resolveMeshCompletion(record,null,existing,identity,validateRecord);
      if(recovery&&JSON.stringify(existing.recovery)!==JSON.stringify(recovery))throw Object.assign(Error('已有恢复凭据身份不同，未覆盖。'),{code:'MESH_METADATA_COMPLETION_CONFLICT'});
      if(existing.format!=='web-cad-mesh-completion'||existing.version!==1||JSON.stringify(existing.record)!==JSON.stringify(record)||existing.recordSha256!==crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex'))throw Object.assign(Error('已有完成凭据与本次不同，未覆盖。'),{code:'MESH_METADATA_COMPLETION_CONFLICT'});
    }else{
      const previous=readCheckedJson(path.join(directory,'metadata.json'),null,16*1024*1024);validateRecord(previous.value,identity);
      atomicJson(file,meshCompletionRecord(previous.value,record,previous.proof,{recovery}),16*1024*1024,true);
    }
    try{this.save(job);return {basis:'completion-receipt-v1',metadataSynchronized:true};}
    catch(error){return {basis:'completion-receipt-v1',metadataSynchronized:false,diagnostic:recordPersistenceDiagnostic(error)};}
  }
  loadCatalog(options={}) {
    const result=scanMeshCatalog({root:this.root,readRecord:(file,max,onBytes,onProof)=>{const read=readCheckedJson(file,null,max,onBytes);onProof?.(read.proof);return read.value;},validateRecord,...options});
    // Do not persist any interruption until the entire scan is complete.
    for(const job of result.jobs)if(isActiveMeshJob(job)){
      job.state='interrupted';job.finishedAt=new Date().toISOString();job.errorCode='MESH_SERVICE_INTERRUPTED';
      job.error='服务停止时任务尚未完成；未自动重试，请检查工程后重新剖分。';job.metadataProof=this.save(job);
    }
    for(const job of result.jobs)if(job.kind===DISCRETE_TETRA_TASK_KIND&&job.state==='complete')job.derivedMeshPresent=fs.existsSync(this.derivedDirectory(job));
    return result;
  }
  load(options) {return this.loadCatalog(options).jobs;}
  writeResult(job,result,{staging,streamQuality=true}={}) {
    if(job.kind===DISCRETE_TETRA_TASK_KIND){
      validateTetraTaskResult(result,job,this.readTetraSource(job),this.readTetraPartition(job),job.artifact?.checkpoint?this.readTetraCheckpoint(job):undefined);const directory=this.directory(job),target=staging||path.join(directory,'result.json');
      if(staging&&(path.dirname(path.resolve(staging))!==directory||!/^artifact-[a-f0-9-]{36}\.result\.tmp$/.test(path.basename(staging))))throw artifactError('离散体结果暂存位置不合法。');
      atomicJson(target,result,CAD_DISCRETE_TETRA_RESULT_BYTES,!staging);return {result:digestFile(target,CAD_DISCRETE_TETRA_RESULT_BYTES)};
    }
    if(job.kind===SURFACE_TASK_KIND){
      const source=this.readSurfaceSource(job);validateSurfaceTaskResult(result,job,source);const directory=this.directory(job),target=staging||path.join(directory,'result.json');
      if(staging&&(path.dirname(path.resolve(staging))!==directory||!/^artifact-[a-f0-9-]{36}\.result\.tmp$/.test(path.basename(staging))))throw artifactError('表面结果暂存位置无效。');
      atomicJson(target,result,SURFACE_RESULT_BYTES);return {result:digestFile(target,SURFACE_RESULT_BYTES)};
    }
    if(result.mesh&&job.options?.qualityPolicy!==undefined)result.mesh.acceptance=meshAcceptanceSettings(job.options);
    validateMeshStrategyExecution(job.options);
    if(result.mesh)validateMeshResourceExecution(job,result);
    if(result.mesh)validateMeshSizingReport(result.mesh.sizing,normalizeMeshSizing(job.options?.sizing),result.mesh);
    if(result.mesh)validateMeshOptimizationReport(result.mesh.optimization,job.options?.optimization,result.mesh);
    const directory=this.directory(job),file=staging||path.join(directory,"result.json");
    if(staging&&(path.dirname(path.resolve(staging))!==directory||!/^artifact-[a-f0-9-]{36}\.result\.tmp$/.test(path.basename(staging))))throw new Error('网格结果暂存位置不合法。');
    const artifact={};let qualityIndex=null;
    if(result.mesh?.render?.storage)artifact.render=sealMeshRender(result.mesh.render,this.renderOutput(job));
    if(result.mesh?.outputPath) {
      if(path.resolve(result.mesh.outputPath)!==this.output(job))throw new Error("网格输出不在此任务的受管文件位置。");
      artifact.mesh=digestFile(this.output(job));
    }
    if(result.mesh?.boundaryMapping)validateMeshBoundary(result.mesh.boundaryMapping,job.source);
    if(result.mesh?.qualityDiagnostics&&streamQuality){
      const quality=withStreamedQualityIndex(this.qualityOutput(job),job,index=>assessMeshAdmission(result.mesh,index,job.source,job.options),{expected:null});artifact.quality=quality.proof;result.mesh.admission=quality.value;
    }else{
      if(result.mesh?.qualityDiagnostics){const quality=readCheckedJson(this.qualityOutput(job));artifact.quality=quality.proof;qualityIndex=validateQualityIndex(quality.value,job);}
      if(result.mesh)result.mesh.admission=assessMeshAdmission(result.mesh,qualityIndex,job.source,job.options);
    }
    if(artifact.render&&Buffer.byteLength(JSON.stringify(result))>MESH_RENDER_LIMITS.manifestBytes)throw Object.assign(new Error('网格显示清单超过 16 MiB 预算；未发布不可读取的结果。'),{code:'MESH_RENDER_LIMIT'});
    atomicJson(file,result);artifact.result=digestFile(file,256*1024*1024);
    return artifact;
  }
  readSurfaceReport(job,query){
    const normalized=normalizeSurfaceReportQuery(query);if(job.kind!==SURFACE_TASK_KIND||!job.artifact?.result)throw artifactError('任务没有可核对的表面结果。');
    const result=readCheckedJson(path.join(this.directory(job),'result.json'),job.artifact.result,SURFACE_RESULT_BYTES).value,source=this.readSurfaceSource(job),summary=validateSurfaceTaskResult(result,job,source);
    if(job.surfaceSummary&&JSON.stringify(summary)!==JSON.stringify(job.surfaceSummary))throw artifactError('表面概要与完整结果不一致。');return surfaceReportPage(source,result,summary,normalized);
  }
  readResult(job,{streamQuality=true,admissionMemo,onAdmissionVerified}={}) {
    if(job.kind===DISCRETE_TETRA_TASK_KIND&&job.state==='complete'&&fs.existsSync(this.derivedDirectory(job))){const value=this.readDerivedTetra(job);delete value.index;return value;}
    if(job.kind===DISCRETE_TETRA_TASK_KIND&&!job.artifact?.result){
      if(job.artifact?.discreteFailure)return this.readTetraFailure(job);
      if(job.artifact?.checkpoint){const checkpoint=this.readTetraCheckpoint(job);return {ok:true,protocolVersion:1,requestId:job.jobId,checkpoint:{available:true,normalMeshAdmitted:false,automaticReplay:false,nodeCount:checkpoint.result.baseline.points.length,tetraCount:checkpoint.result.baseline.report.tetraCount,meetsRequestedQuality:checkpoint.result.baseline.quality.meetsRequestedQuality}};}
      return this.readTetraFailure(job);
    }
    const file=path.join(this.directory(job),"result.json");
    if(!job.artifact?.result)throw artifactError('网格结果缺少内容凭据。');
    const result=readCheckedJson(file,job.artifact.result,job.kind===SURFACE_TASK_KIND?SURFACE_RESULT_BYTES:job.kind===DISCRETE_TETRA_TASK_KIND?CAD_DISCRETE_TETRA_RESULT_BYTES:256*1024*1024).value;
    if(job.kind===DISCRETE_TETRA_TASK_KIND){const summary=validateTetraTaskResult(result,job,this.readTetraSource(job),this.readTetraPartition(job),job.artifact?.checkpoint?this.readTetraCheckpoint(job):undefined);if(job.discreteTetraSummary&&!sameJson(summary,job.discreteTetraSummary))throw artifactError('离散体概要与完整材料不一致。');return {ok:true,protocolVersion:1,requestId:job.jobId,discreteTetraSummary:summary};}
    if(job.kind===SURFACE_TASK_KIND){
      const summary=validateSurfaceTaskResult(result,job,this.readSurfaceSource(job));
      if(job.surfaceSummary&&JSON.stringify(summary)!==JSON.stringify(job.surfaceSummary))throw artifactError('表面结果概要与完整材料不一致。');
      return {ok:true,protocolVersion:1,requestId:job.jobId,surfaceSummary:summary};
    }
    if(job.artifact.mesh && !sameDigest(digestFile(this.output(job)),job.artifact.mesh))throw new Error("MSH 文件校验失败；文件可能缺失或已损坏。");
    if(job.artifact.render&&!sameDigest(digestFile(this.renderOutput(job)),job.artifact.render))throw new Error('网格显示文件校验失败。');
    if(job.artifact.preparedBrep&&!sameDigest(digestFile(this.preparedBrep(job)),job.artifact.preparedBrep))throw new Error("预览 BREP 快照校验失败。");
    if(job.artifact.preparedManifest&&!sameDigest(digestFile(this.preparedManifest(job),256*1024*1024),job.artifact.preparedManifest))throw new Error("预览来源清单校验失败。");
    if(!result.ok || result.requestId!==job.jobId || (job.kind==="preparation"?!result.preparation:!result.mesh&&!(job.state==="failed"&&result.preparation)))throw new Error("网格结果身份不匹配。");
    if(result.preparation){
      const report=validatePreparation(result.preparation.diagnostics,job.source,result.preparation.preview);
      if(report.repairMode!==job.options?.repairMode||typeof job.options.deepCheck==='boolean'&&report.deepCheck!==job.options.deepCheck)throw new Error("诊断报告与任务设置不一致。");
      const summary=preparationSummary(report);
      if(!job.preparationSummary||Object.keys(summary).some(key=>summary[key]!==job.preparationSummary[key]))throw new Error("诊断报告与任务概要不一致。");
      if(job.kind==="preparation"&&job.state==="complete"&&(!result.preparation.preview||report.status!=="ready"))throw new Error("已完成预览缺少可用的显示快照。");
    }
    if(result.mesh?.outputPath && path.resolve(result.mesh.outputPath)!==this.resultOutput(job))throw new Error("网格结果路径不匹配。");
    if(result.mesh){
      validateMeshAcceptanceSettings(result.mesh.acceptance,job.options);
      try{validateMeshResourceExecution(job,result);}catch{throw artifactError('网格进程资源证明与封存的任务预算不一致。');}
      try{validateMeshStrategyExecution(job.options);}catch{throw artifactError('网格任务引用的工程方案定义无法核对。');}
      try{validateMeshSizingReport(result.mesh.sizing,normalizeMeshSizing(job.options?.sizing),result.mesh);}catch{throw artifactError('网格尺寸执行证明与任务设置或来源不一致。');}
      try{validateMeshOptimizationReport(result.mesh.optimization,job.options?.optimization,result.mesh);}catch{throw artifactError('网格优化执行报告与任务设置或最终质量不一致。');}
      if(result.mesh.render?.storage){if(!sameDigest(result.mesh.render.storage,job.artifact.render))throw new Error('网格显示数据缺少一致的封存凭据。');validateMeshRender(result.mesh.render);}
      if(result.mesh.boundaryMapping)validateMeshBoundary(result.mesh.boundaryMapping,job.source);
      const known=admissionMemo?.authority?.runtimeKey===admissionRuntimeKey()?verifyMeshAdmissionReceipt(admissionMemo?.receipt,job,admissionMemo?.authority):null;
      if(known){
        // Match ALL original bytes, not timestamps or a saved accepted flag.
        // The receipt binds this exact content and settings to an earlier full
        // verification in the same sealed-code process authority.
        if(!sameDigest(digestFile(this.qualityOutput(job),256*1024*1024),job.artifact.quality))throw artifactError('网格质量索引内容校验失败。');
        result.mesh.admission=known;onAdmissionVerified?.({mode:'receipt'});
      }else{
        if(job.artifact.quality&&streamQuality)result.mesh.admission=withStreamedQualityIndex(this.qualityOutput(job),job,index=>assessMeshAdmission(result.mesh,index,job.source,job.options)).value;
        else{const qualityIndex=job.artifact.quality?validateQualityIndex(readCheckedJson(this.qualityOutput(job),job.artifact.quality).value,job):null;result.mesh.admission=assessMeshAdmission(result.mesh,qualityIndex,job.source,job.options);}
        onAdmissionVerified?.({mode:'full'});
      }
    }
    return result;
  }
  readPrepared(job) {
    if(job.kind!=="preparation"||job.state!=="complete")throw new Error("修复预览未完成，不能用于剖分。");
    const result=this.readResult(job);
    if(result.preparation?.diagnostics?.status!=="ready")throw new Error("修复预览没有可用快照。");
    return {result,manifest:readCheckedJson(this.preparedManifest(job),job.artifact.preparedManifest).value,brepPath:this.preparedBrep(job),manifestPath:this.preparedManifest(job)};
  }
  readQuality(job) {
    if(!job.artifact?.quality)return null;
    const file=this.qualityOutput(job);
    return validateQualityIndex(readCheckedJson(file,job.artifact.quality).value,job);
  }
  remove(job) {
    this.save({...job,state:"deleted"});
    fs.rmSync(this.output(job),{force:true});
    const target=this.directory(job);
    if(path.dirname(path.dirname(target))!==this.root)throw new Error("拒绝清理受管目录之外的任务。");
    fs.rmSync(target,{recursive:true,force:true});
  }
}
