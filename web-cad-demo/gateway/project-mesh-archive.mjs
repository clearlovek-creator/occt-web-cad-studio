import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {MeshJobStore,validateMeshJobRecord} from './mesh-job-store.mjs';
import {resolveMeshCompletion} from './mesh-completion-record.mjs';
import {captureMeshSource} from '../shared/mesh-source.mjs';
import {meshAdmitted} from '../shared/mesh-admission.mjs';

export const MESH_ARCHIVE_LIMITS=Object.freeze({maxJobs:500,maxBlobs:9000,maxBytes:384*1024**2,maxManifestBytes:16*1024**2});
const documentId=/^[A-Za-z0-9_-]{1,64}$/,jobId=/^mesh-[a-f0-9-]{36}$/,sha256=/^[a-f0-9]{64}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=(message,code='PROJECT_MESH_ARCHIVE_INVALID')=>{throw Object.assign(Error(message),{code});};
const clone=value=>JSON.parse(JSON.stringify(value));
const sameIdentity=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(key=>a[key]===b[key]);
const ordinary={metadata:'metadata.json',completion:'completion.json',result:'result.json',quality:'quality.json',render:'render.bin',preparedBrep:'prepared.brep',preparedManifest:'prepared-manifest.json',surfaceSource:'surface-source.json',discreteSource:'discrete-source.json',partition:'partition.json',discreteFailure:'failure.json',checkpoint:'optimization-checkpoint.json',optimizationOrigin:'optimization-origin.json'};
const derived={derivedManifest:'manifest.json',derivedMesh:'mesh.msh',derivedRender:'render.bin',derivedQuality:'quality.json',derivedResult:'result.json'};
export const MESH_ARCHIVE_ROLES=Object.freeze([...Object.keys(ordinary),'mesh',...Object.keys(derived)]);
function limits(value={}){if(!keys(value,Object.keys(MESH_ARCHIVE_LIMITS)))fail('网格工程资产额度无效。');for(const [key,n]of Object.entries(value))if(!Number.isSafeInteger(n)||n<1||n>MESH_ARCHIVE_LIMITS[key])fail('网格工程资产额度无效。');return {...MESH_ARCHIVE_LIMITS,...value};}
function directoryChain(directory){for(let current=path.resolve(directory);;current=path.dirname(current)){const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail('网格工程资产目录含链接或异常目录。');if(path.dirname(current)===current)break;}}
function readFile(file,budget){
  directoryChain(path.dirname(file));const before=fs.lstatSync(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n)fail('网格工程资产不是独立普通文件。');
  if(before.size>BigInt(budget))fail('网格工程资产超过保存额度，未截断或遗漏文件。','PROJECT_MESH_ARCHIVE_LIMIT');
  const fd=fs.openSync(file,'r');try{if(!sameIdentity(before,fs.fstatSync(fd,{bigint:true})))fail('网格文件在打开时变化。');const bytes=Buffer.allocUnsafe(Number(before.size));let offset=0;while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,Math.min(1024**2,bytes.length-offset),null);if(!count)fail('网格文件读取不完整。');offset+=count;}if(!sameIdentity(before,fs.fstatSync(fd,{bigint:true}))||!sameIdentity(before,fs.lstatSync(file,{bigint:true})))fail('网格文件在读取时变化。');return {bytes,identity:before};}finally{fs.closeSync(fd);}
}
function json(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('网格工程资产包含无效 UTF-8 JSON。');}}
function rolePath(store,job,role){if(role==='completion')return store.completionOutput(job);if(['discreteSource','partition','checkpoint','optimizationOrigin'].includes(role))return store.tetraFile(job,role);if(Object.hasOwn(ordinary,role))return path.join(store.directory(job),ordinary[role]);if(role==='mesh')return store.output(job);if(Object.hasOwn(derived,role))return path.join(store.derivedDirectory(job),derived[role]);fail('网格工程资产角色未知，未采用文件路径。');}
function rolesFor(store,job){
  const roles=['metadata'];if(fs.existsSync(rolePath(store,job,'completion')))roles.push('completion');
  for(const role of Object.keys(ordinary).filter(key=>!['metadata','completion'].includes(key)))if(job.artifact?.[role])roles.push(role);
  if(job.artifact?.mesh)roles.push('mesh');
  if(job.kind==='discrete-tetra'&&fs.existsSync(store.derivedDirectory(job)))roles.push(...Object.keys(derived));
  return roles.sort();
}
function effectiveRecord(asset,blobs,source){
  const get=role=>blobs.get(asset.files[role])?.data,metadataBytes=get('metadata');if(!metadataBytes||metadataBytes.length>16*1024**2)fail('网格工程资产缺少有界的任务记录。');
  let record=json(metadataBytes);const identity={documentId:asset.documentId||source.documentId,jobId:asset.jobId};validateMeshJobRecord(record,identity);
  if(get('completion')){if(get('completion').length>16*1024**2)fail('网格完成凭据超出额度。');record=resolveMeshCompletion(record,{bytes:metadataBytes.length,sha256:hash(metadataBytes)},json(get('completion')),identity,validateMeshJobRecord);}
  if(!['complete','failed','cancelled','interrupted'].includes(record.state))fail('仍在执行或已删除的网格任务不能封入工程。','PROJECT_MESH_ARCHIVE_BUSY');
  const required=['metadata',...(get('completion')?['completion']:[])];
  for(const role of Object.keys(ordinary).filter(key=>!['metadata','completion'].includes(key)))if(record.artifact?.[role])required.push(role);
  if(record.artifact?.mesh)required.push('mesh');
  const derivedRoles=Object.keys(derived).filter(role=>asset.files[role]);if(derivedRoles.length){if(derivedRoles.length!==Object.keys(derived).length||record.kind!=='discrete-tetra'||record.state!=='complete')fail('派生网格文件集不完整或任务类型不匹配。');required.push(...Object.keys(derived));}
  if(JSON.stringify(required.sort())!==JSON.stringify(Object.keys(asset.files).sort()))fail('网格资产清单与任务实际依赖不一致。');
  for(const role of required.filter(role=>record.artifact?.[role])){const blob=blobs.get(asset.files[role]),proof=record.artifact[role];if(blob.bytes!==proof.bytes||blob.sha256!==proof.sha256)fail('网格资产字节与原始任务凭据不一致。');}
  return clone(record);
}

/** Binary blobs are separate from the small, path-free manifest. Hashes provide
 * integrity, not a saved admission flag: full semantic verification is separate. */
export function validateProjectMeshArchive(value,{policy={}}={}){
  const budget=limits(policy);
  if(!keys(value,['version','source','assets','blobs'])||![1,2].includes(value.version)||!documentId.test(value.source?.documentId)||!Array.isArray(value.assets)||value.assets.length>budget.maxJobs||!Array.isArray(value.blobs)||value.blobs.length>budget.maxBlobs)fail('网格工程资产清单结构或数量无效。');
  const source=captureMeshSource({bodyMetadata:value.source.bodies,revision:value.source.revision},value.source.documentId);if(!isDeepStrictEqual(source,value.source))fail('网格工程资产来源未规范化。');
  const manifest={version:value.version,source,assets:value.assets};if(Buffer.byteLength(JSON.stringify(manifest))>budget.maxManifestBytes)fail('网格工程资产清单超过额度。','PROJECT_MESH_ARCHIVE_LIMIT');
  let total=0;const blobs=new Map();for(const blob of value.blobs){
    if(!keys(blob,['sha256','bytes','data'])||!sha256.test(blob.sha256)||!Number.isSafeInteger(blob.bytes)||blob.bytes<1||!Buffer.isBuffer(blob.data)||blob.data.buffer instanceof SharedArrayBuffer||blob.data.buffer.resizable||blob.data.length!==blob.bytes||blobs.has(blob.sha256))fail('网格工程资产的数据块身份无效或重复。');
    total+=blob.bytes;if(total>budget.maxBytes)fail('网格工程资产数据总量超过额度。','PROJECT_MESH_ARCHIVE_LIMIT');if(hash(blob.data)!==blob.sha256)fail('网格工程资产数据校验失败。');blobs.set(blob.sha256,blob);
  }
  let expandedBytes=0;const jobs=[],seenJobs=new Set(),used=new Set();
  for(const asset of value.assets){
    const identity=value.version===2?asset.assetId:asset.jobId;
    if(!keys(asset,value.version===2?['assetId','documentId','jobId','files']:['jobId','files'])||!jobId.test(asset.jobId)||!jobId.test(identity)||value.version===2&&!documentId.test(asset.documentId)||seenJobs.has(identity)||!plain(asset.files)||Object.keys(asset.files).length<1||Object.keys(asset.files).some(role=>!MESH_ARCHIVE_ROLES.includes(role)))fail('网格工程资产任务身份或文件角色无效。');seenJobs.add(identity);
    for(const sha of Object.values(asset.files)){if(!sha256.test(sha)||!blobs.has(sha))fail('网格工程资产引用了缺失的数据块。');used.add(sha);expandedBytes+=blobs.get(sha).bytes;if(expandedBytes>budget.maxBytes)fail('网格资产展开总量超过额度，未通过重复引用绕过预算。','PROJECT_MESH_ARCHIVE_LIMIT');}
    jobs.push(effectiveRecord(asset,blobs,source));
  }
  if(used.size!==blobs.size)fail('网格工程资产包含未引用的数据块。');
  return {manifest:clone(manifest),blobs,jobs,bytes:total,expandedBytes};
}

/** Caller owns the document/mesh snapshot fence. Every file is copied from one
 * checked FD and all file identities and role inventories are rechecked last. */
export function captureProjectMeshArchive({store,documentId:id,source,jobs,assertIdle=()=>{}},{policy={}}={}){
  const budget=limits(policy);assertIdle();if(!(store instanceof MeshJobStore)||!documentId.test(id)||source?.documentId!==id||!Array.isArray(jobs)||jobs.length>budget.maxJobs)fail('网格工程资产捕获身份无效。');
  const assets=[],blobs=new Map(),proofs=[];let expandedBytes=0;
  for(const live of jobs){
    if(live.documentId!==id||live.deleting||live.discardingDerived||live.derivationAttempt?.state==='working'||!['complete','failed','cancelled','interrupted'].includes(live.state))fail('网格仍在计算、准备或清理，请结束后再保存完整工程。','PROJECT_MESH_ARCHIVE_BUSY');
    const {record}=store.readPersisted(live),roles=rolesFor(store,record),files={};
    for(const role of roles){const file=rolePath(store,record,role),read=readFile(file,budget.maxBytes-expandedBytes),digest=hash(read.bytes);expandedBytes+=read.bytes.length;files[role]=digest;proofs.push({file,identity:read.identity});if(!blobs.has(digest))blobs.set(digest,{sha256:digest,bytes:read.bytes.length,data:read.bytes});}
    assets.push({jobId:record.jobId,files});
  }
  const archive={version:1,source:clone(source),assets:assets.sort((a,b)=>a.jobId.localeCompare(b.jobId)),blobs:[...blobs.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256))};validateProjectMeshArchive(archive,{policy});
  assertIdle();for(const proof of proofs)if(!sameIdentity(proof.identity,fs.lstatSync(proof.file,{bigint:true})))fail('工程网格在捕获期间变化，未生成混合备份。','PROJECT_MESH_ARCHIVE_CHANGED');
  for(const asset of archive.assets){const record=store.readPersisted({documentId:id,jobId:asset.jobId}).record;if(JSON.stringify(rolesFor(store,record))!==JSON.stringify(Object.keys(asset.files).sort()))fail('工程网格文件集在捕获期间变化。','PROJECT_MESH_ARCHIVE_CHANGED');}
  return archive;
}

class PortableVerificationStore extends MeshJobStore{
  constructor(root,locators,derivedRoot){super(root);this.locators=locators;this.derivedRoot=derivedRoot;}
  resultOutput(job){return this.locators.get(job.jobId)||super.resultOutput(job);}
  derivedDirectory(job){return this.derivedRoot||super.derivedDirectory(job);}
  completionOutput(job){return this.completionFile||super.completionOutput(job);}
}
function cleanupStaging(parent,directory){
  const expectedParent=path.resolve(parent),target=path.resolve(directory);if(path.dirname(target)!==expectedParent||!path.basename(target).startsWith('mesh-archive-'))fail('拒绝清理网格资产暂存区之外的目录。');directoryChain(target);if(fs.realpathSync(target)!==path.join(fs.realpathSync(expectedParent),path.basename(target)))fail('拒绝清理链接后的暂存区。');fs.rmSync(target,{recursive:true,force:true});
}
function createArchiveStaging(parent){const base=path.join(path.resolve(parent),'mesh-archive-'),created=fs.mkdtempSync(path.toNamespacedPath(base));return path.join(path.resolve(parent),path.basename(created));}
/** Materializes only fixed roles into an exclusive scratch root and reruns the
 * original independent validators. It never executes CAD, CGAL or Gmsh. The
 * original IDs/proofs remain in their namespace; target-workspace binding is a
 * separate import transaction, not a rewrite of raw generating evidence. */
export function stageProjectMeshArchive(value,parent,{policy={}}={}){
  if(value?.version===2)return stageNamespacedMeshArchive(value,parent,{policy});
  const checked=validateProjectMeshArchive(value,{policy});directoryChain(parent);const directory=createArchiveStaging(parent),locators=new Map(),store=new PortableVerificationStore(directory,locators);
  try{
    for(const [index,asset]of checked.manifest.assets.entries()){
      const job=checked.jobs[index];fs.mkdirSync(store.directory(job),{recursive:true});
      const result=asset.files.result?json(checked.blobs.get(asset.files.result).data):null;
      if(result?.mesh?.outputPath!==undefined){const locator=result.mesh.outputPath;if(typeof locator!=='string'||locator.split(/[\\/]/).at(-1)!==job.jobId+'.msh')fail('原网格结果中的输出标签与任务身份不一致。');locators.set(job.jobId,path.resolve(locator));}
      for(const [role,digest]of Object.entries(asset.files)){const target=rolePath(store,job,role),blob=checked.blobs.get(digest);fs.mkdirSync(path.dirname(target),{recursive:true});const fd=fs.openSync(target,'wx');try{let offset=0;while(offset<blob.data.length){const count=fs.writeSync(fd,blob.data,offset,Math.min(1024**2,blob.data.length-offset),null);if(!count)fail('网格资产暂存写入未取得进展。');offset+=count;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(hash(blob.data)!==digest)fail('输入资产在暂存期间变化。','PROJECT_MESH_ARCHIVE_CHANGED');}
    }
    const summaries=[];
    for(const job of checked.jobs){
      const hasResult=Boolean(job.artifact?.result||job.artifact?.discreteFailure);let result=null;
      if(hasResult)result=store.readResult(job);
      else if(job.kind==='discrete-tetra'){if(job.artifact?.discreteSource)store.readTetraSource(job);if(job.artifact?.partition)store.readTetraPartition(job);if(job.artifact?.checkpoint)store.readTetraCheckpoint(job);}
      else if(job.kind==='surface-reconstruction'&&job.artifact?.surfaceSource)store.readSurfaceSource(job);
      if(job.kind==='preparation'&&job.state==='complete')store.readPrepared(job);
      summaries.push({jobId:job.jobId,kind:job.kind||'mesh',state:job.state,normalMeshAdmitted:meshAdmitted(result?.mesh?.admission),hasResult,hasDerived:job.kind==='discrete-tetra'&&Boolean(result?.derivedMeshRegistration),defaultVisible:false});
    }
    let disposed=false;return {directory,store,jobs:checked.jobs,summaries,manifest:checked.manifest,cleanup:()=>{if(disposed)return;cleanupStaging(parent,directory);disposed=true;}};
  }catch(error){try{cleanupStaging(parent,directory);}catch(cleanupError){Object.defineProperty(error,'cleanupError',{value:cleanupError});}throw error;}
}

/** Flatten imported assets without modifying any original generating bytes. */
export function combineProjectMeshArchives(source,archives){
  const assets=[],blobs=new Map();
  for(const input of archives){const checked=validateProjectMeshArchive(input.archive||input);for(const asset of checked.manifest.assets){const assetId=input.assetIds?.[asset.assetId||asset.jobId]||asset.assetId||asset.jobId;assets.push({assetId,documentId:asset.documentId||checked.manifest.source.documentId,jobId:asset.jobId,files:clone(asset.files)});}for(const [sha,blob]of checked.blobs)if(!blobs.has(sha))blobs.set(sha,blob);}
  const value={version:2,source:clone(source),assets:assets.sort((a,b)=>a.assetId.localeCompare(b.assetId)),blobs:[...blobs.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256))};validateProjectMeshArchive(value);return value;
}
function stageNamespacedMeshArchive(value,parent,{policy={}}={}){
  const checked=validateProjectMeshArchive(value,{policy});directoryChain(parent);const directory=createArchiveStaging(parent),contexts=new Map(),roots=[],summaries=[];
  try{
    for(const [index,asset]of checked.manifest.assets.entries()){
      const entry=path.join(directory,'entries',asset.assetId);fs.mkdirSync(entry,{recursive:true});const used=new Set(Object.values(asset.files)),archive={version:1,source:{...checked.manifest.source,documentId:asset.documentId},assets:[{jobId:asset.jobId,files:asset.files}],blobs:[...used].map(sha=>checked.blobs.get(sha))},staged=stageProjectMeshArchive(archive,entry,{policy});
      contexts.set(asset.assetId,{store:staged.store,job:staged.jobs[0],asset});roots.push({assetId:asset.assetId,rootName:path.basename(staged.directory)});summaries.push({...staged.summaries[0],assetId:asset.assetId});assertOrigin(checked.jobs[index],staged.jobs[0]);
    }
    const manifest={version:1,archive:checked.manifest,roots,blobs:[...checked.blobs.values()].map(({sha256,bytes})=>({sha256,bytes}))},bytes=Buffer.from(JSON.stringify(manifest));if(bytes.length>MESH_ARCHIVE_LIMITS.maxManifestBytes)fail('暂存网格资产清单超过额度。','PROJECT_MESH_ARCHIVE_LIMIT');const file=path.join(directory,'archive.json'),fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const manifestProof={bytes:bytes.length,sha256:hash(bytes)};
    let disposed=false;return {directory,contexts,jobs:checked.jobs,summaries,manifest:checked.manifest,manifestProof,cleanup:()=>{if(disposed)return;cleanupStaging(parent,directory);disposed=true;}};
  }catch(error){try{cleanupStaging(parent,directory);}catch(cleanupError){Object.defineProperty(error,'cleanupError',{value:cleanupError});}throw error;}
}
function assertOrigin(a,b){if(a.jobId!==b.jobId||a.documentId!==b.documentId||!isDeepStrictEqual(a.source,b.source))fail('网格资产原始命名空间发生变化。');}
export function materializeProjectMeshArchive(value,parent,options){return stageProjectMeshArchive(value.version===2?value:combineProjectMeshArchives(value.source,[value]),parent,options);}

/** A persisted entry is addressed only by the registry's checked manifest and
 * fixed role names. Original output locators are never filesystem authority. */
export function openMaterializedMeshAsset(directory,manifestProof,entryId,{derivedMode='base',derivedRoot}={}){
  if(!jobId.test(entryId)||!['base','absent','overlay'].includes(derivedMode)||derivedMode!=='base'&&!derivedRoot)fail('恢复网格资产身份无效。');
  const read=readFile(path.join(directory,'archive.json'),MESH_ARCHIVE_LIMITS.maxManifestBytes);if(read.bytes.length!==manifestProof?.bytes||hash(read.bytes)!==manifestProof.sha256)fail('恢复网格资产清单发生变化。');const persisted=json(read.bytes),manifest=persisted?.archive;
  if(!keys(persisted,['version','archive','roots','blobs'])||persisted.version!==1||manifest?.version!==2||!Array.isArray(manifest.assets)||manifest.assets.length>MESH_ARCHIVE_LIMITS.maxJobs||!Array.isArray(persisted.roots)||persisted.roots.length!==manifest.assets.length||!Array.isArray(persisted.blobs)||persisted.blobs.length>MESH_ARCHIVE_LIMITS.maxBlobs)fail('恢复网格资产清单结构无效。');
  const asset=manifest.assets.find(item=>item.assetId===entryId),root=persisted.roots.find(item=>item.assetId===entryId);if(!asset||!root||!keys(root,['assetId','rootName'])||!/^mesh-archive-[A-Za-z0-9]{6}$/.test(root.rootName)||!jobId.test(asset.jobId)||!documentId.test(asset.documentId)||!keys(asset,['assetId','documentId','jobId','files'])||!plain(asset.files)||Object.keys(asset.files).some(role=>!MESH_ARCHIVE_ROLES.includes(role)))fail('恢复网格资产条目无效。');
  const inventory=new Map();for(const blob of persisted.blobs){if(!keys(blob,['sha256','bytes'])||!sha256.test(blob.sha256)||!Number.isSafeInteger(blob.bytes)||blob.bytes<1||blob.bytes>MESH_ARCHIVE_LIMITS.maxBytes||inventory.has(blob.sha256))fail('恢复网格数据块凭据无效。');inventory.set(blob.sha256,blob);}
  const rootDirectory=path.join(directory,'entries',entryId,root.rootName);directoryChain(rootDirectory);if(derivedRoot)directoryChain(path.dirname(derivedRoot));const locators=new Map(),store=new PortableVerificationStore(rootDirectory,locators,derivedMode==='base'?undefined:derivedRoot),identity={jobId:asset.jobId,documentId:asset.documentId,kind:'discrete-tetra'},blobs=new Map(),files={...asset.files},certificate=[{file:path.join(directory,'archive.json'),identity:read.identity}];
  // Recovery inputs have a fixed subdirectory, selected by authenticated
  // metadata rather than by caller paths or an incomplete temporary identity.
  const metadataProof=inventory.get(files.metadata),metadata=readFile(path.join(store.directory(identity),'metadata.json'),16*1024**2);
  if(!metadataProof||metadata.bytes.length!==metadataProof.bytes||hash(metadata.bytes)!==files.metadata)fail('恢复资产元数据与清单不一致。');
  const initialRecord=json(metadata.bytes);validateMeshJobRecord(initialRecord,{documentId:asset.documentId,jobId:asset.jobId});
  if(initialRecord.optimizationRecovery)identity.optimizationRecovery=initialRecord.optimizationRecovery;
  if(derivedMode!=='base')for(const role of Object.keys(derived))delete files[role];
  for(const [role,sha]of Object.entries(files)){
    try{const proof=inventory.get(sha);if(!proof)fail('恢复网格引用的数据块缺失。');const target=rolePath(store,identity,role),value=readFile(target,proof.bytes);if(value.bytes.length!==proof.bytes||hash(value.bytes)!==sha)fail('恢复网格文件与清单凭据不一致。');blobs.set(sha,{...proof,data:value.bytes});certificate.push({file:target,identity:value.identity});}
    catch(error){if(Object.hasOwn(derived,role)&&!['EACCES','EPERM','EBUSY','EIO','EMFILE','ENFILE'].includes(error.code))throw Object.assign(Error('恢复的派生文件已变化；原始生成结果保留。'),{code:'MESH_DERIVED_ARTIFACT_INVALID'});throw error;}
  }
  const archive={version:1,source:{...manifest.source,documentId:asset.documentId},assets:[{jobId:asset.jobId,files}],blobs:[...blobs.values()]},checked=validateProjectMeshArchive(archive),job=checked.jobs[0],result=files.result?json(blobs.get(files.result).data):null;
  if(result?.mesh?.outputPath!==undefined){const locator=result.mesh.outputPath;if(typeof locator!=='string'||locator.split(/[\\/]/).at(-1)!==job.jobId+'.msh')fail('恢复网格输出标签与原任务不一致。');locators.set(job.jobId,path.resolve(locator));}
  return {store,job,asset,source:manifest.source,certificate,archive};
}
export function meshAssetCertificateCurrent(certificate){try{return Array.isArray(certificate)&&certificate.length>0&&certificate.every(item=>{
  if(item.absent){let parent=path.dirname(item.file);while(!fs.existsSync(parent)&&path.dirname(parent)!==parent)parent=path.dirname(parent);directoryChain(parent);try{fs.lstatSync(item.file);return false;}catch(error){return error.code==='ENOENT';}}
  directoryChain(path.dirname(item.file));const current=fs.lstatSync(item.file,{bigint:true});return (item.directory?current.isDirectory():current.isFile()&&current.nlink===1n)&&!current.isSymbolicLink()&&sameIdentity(current,item.identity);
});}catch{return false;}}
