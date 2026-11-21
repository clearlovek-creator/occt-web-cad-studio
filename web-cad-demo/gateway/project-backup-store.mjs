import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeProjectSaveInput,projectSaveCanonical} from '../shared/project-save-input.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const identity=stat=>Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(key=>[key,stat[key]]));
const same=(left,right)=>Object.keys(left).every(key=>left[key]===right[key]);
export class ProjectBackupError extends Error{
  constructor(code,message,status=503){super(message);this.name='ProjectBackupError';this.code=code;this.status=status;this.retryableByModel=false;}
}
const fault=(code,message,status)=>new ProjectBackupError(code,message,status);
/** Immutable generated files, not geometry checkpoints. Unknown material is never GC'd. */
export class ProjectBackupStore{
  constructor(dataDir,{maxFileBytes=256*1024*1024,maxTotalBytes=1024**3,maxEntries=64,maxDownloads=4}={}){
    if(!Number.isSafeInteger(maxFileBytes)||maxFileBytes<1||maxFileBytes>1024**3||!Number.isSafeInteger(maxTotalBytes)||maxTotalBytes<maxFileBytes||maxTotalBytes>8*1024**3||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>512||!Number.isSafeInteger(maxDownloads)||maxDownloads<1||maxDownloads>8)throw fault('PROJECT_BACKUP_CONFIG','工程备份存储预算无效。');
    this.root=path.resolve(dataDir,'project-backups');Object.assign(this,{maxFileBytes,maxTotalBytes,maxEntries,maxDownloads});this.active=new Map();this.readers=new Map();this.maintenance=new Set();fs.mkdirSync(this.root,{recursive:true});this.checkRoot();
  }
  checkRoot(){const stat=fs.lstatSync(this.root);if(!stat.isDirectory()||stat.isSymbolicLink())throw fault('PROJECT_BACKUP_STORE_UNAVAILABLE','备份目录类型异常，未执行保存。');}
  directory(taskId,pending=false){if(!UUID.test(taskId))throw fault('PROJECT_BACKUP_ID','备份任务标识无效。',400);this.checkRoot();return path.join(this.root,taskId+(pending?'.pending':''));}
  regular(file,maxBytes){let stat;try{stat=fs.lstatSync(file,{bigint:true});}catch{throw fault('PROJECT_BACKUP_CHANGED','备份材料不可读取，未返回替代文件。');}if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size>BigInt(maxBytes))throw fault('PROJECT_BACKUP_CHANGED','备份材料不是符合预算的独占普通文件。');return stat;}
  checkDirectory(directory){const stat=fs.lstatSync(directory,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw fault('PROJECT_BACKUP_CHANGED','备份条目目录已变化。');return stat;}
  inventory(){
    this.checkRoot();let bytes=0;const names=fs.readdirSync(this.root);if(names.length>512)throw fault('PROJECT_BACKUP_CAPACITY','保留的备份材料过多，未自动清理。',429);
    for(const name of names){const id=name.replace(/\.pending$/,'');if(!UUID.test(id))throw fault('PROJECT_BACKUP_STORE_UNAVAILABLE','备份目录含未知材料，已保留并停止新保存。');const directory=path.join(this.root,name);this.checkDirectory(directory);const files=fs.readdirSync(directory);if(files.length>2||files.some(file=>!['backup.cadproj','receipt.json'].includes(file)))throw fault('PROJECT_BACKUP_STORE_UNAVAILABLE','备份条目含未知材料，已保留。');let size=0;for(const file of files)size+=Number(this.regular(path.join(directory,file),file==='receipt.json'?32768:this.maxFileBytes).size);bytes+=this.active.has(id)?Math.max(size,this.maxFileBytes+32768):size;}
    return {entries:names.length,bytes};
  }
  reserve(taskId){
    if(this.maintenance.has(taskId))throw fault('PROJECT_BACKUP_BUSY','备份材料正在维护，未开始新的生成。',409);
    const directory=this.directory(taskId,true),final=this.directory(taskId),usage=this.inventory();
    if(this.active.has(taskId)||fs.existsSync(directory)||fs.existsSync(final))throw fault('PROJECT_BACKUP_EXISTS','原任务已有备份或未完成材料，未重新生成。',409);
    if(usage.entries>=this.maxEntries||usage.bytes+this.maxFileBytes+32768>this.maxTotalBytes)throw fault('PROJECT_BACKUP_CAPACITY','备份存储预算不足，请显式删除不再需要的已完成备份；未修改工程。',429);
    fs.mkdirSync(directory);const stat=this.checkDirectory(directory),lease={taskId,directory,identity:identity(stat),published:false};this.active.set(taskId,lease);return lease;
  }
  assertLease(lease){if(this.active.get(lease.taskId)!==lease||lease.published||path.dirname(lease.directory)!==this.root||!same(lease.identity,identity(this.checkDirectory(lease.directory))))throw fault('PROJECT_BACKUP_CHANGED','备份生成归属已变化，未发布。');}
  fileName(name){return `${String(name||'工程').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,120)||'工程'}.cadproj`;}
  validateManifest(value,taskId){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['format','version','taskId','input','fingerprint','result','resultSha256'].includes(key))||value.format!=='web-cad-project-backup'||value.version!==1||value.taskId!==taskId)throw fault('PROJECT_BACKUP_RECEIPT_INVALID','备份回执格式或身份无效。');
    let input;try{input=normalizeProjectSaveInput(value.input);}catch{throw fault('PROJECT_BACKUP_RECEIPT_INVALID','备份保存基线无效。');}const fingerprint=sha(projectSaveCanonical(input)),result=value.result,backup=result?.projectBackup;
    if(value.fingerprint!==fingerprint||value.resultSha256!==sha(JSON.stringify(result))||!result||Object.keys(result).some(key=>!['ok','documentId','requestId','revision','stateToken','stateSequence','projectBackup'].includes(key))||result.ok!==true||result.documentId!==input.documentId||result.requestId!==input.requestId||!Number.isSafeInteger(result.revision)||result.revision<0||!HASH.test(result.stateToken)||!Number.isSafeInteger(result.stateSequence)||result.stateSequence<0||!backup||Object.keys(backup).some(key=>!['version','taskId','fileName','bytes','sha256','workspaceToken','createdAt','downloadPath'].includes(key))||backup.version!==1||backup.taskId!==taskId||typeof backup.fileName!=='string'||backup.fileName!==this.fileName(backup.fileName.slice(0,-8))||!Number.isSafeInteger(backup.bytes)||backup.bytes<1||backup.bytes>this.maxFileBytes||!HASH.test(backup.sha256)||!HASH.test(backup.workspaceToken)||typeof backup.createdAt!=='string'||!Number.isFinite(Date.parse(backup.createdAt))||backup.downloadPath!==`/api/documents/${input.documentId}/project/backups/${taskId}/download`)throw fault('PROJECT_BACKUP_RECEIPT_INVALID','备份回执内容与原任务或文件不一致。');
    if(input.baseRevision!==undefined&&input.baseRevision!==result.revision||input.baseStateToken!==undefined&&input.baseStateToken!==result.stateToken||input.baseStateSequence!==undefined&&input.baseStateSequence!==result.stateSequence)throw fault('PROJECT_BACKUP_RECEIPT_INVALID','备份回执不属于登记时的工程基线。');
    Object.freeze(result.projectBackup);Object.freeze(result);Object.freeze(input);return {input,fingerprint,result};
  }
  read(taskId,documentId){return this.readManifest(taskId,{documentId});}
  readManifest(taskId,{documentId,pending=false}={}){
    const directory=this.directory(taskId,pending);if(!fs.existsSync(directory))return null;const directoryBefore=this.checkDirectory(directory);const file=path.join(directory,'receipt.json'),before=this.regular(file,32768),fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(32769);let size=0;
    try{for(;;){const count=fs.readSync(fd,buffer,size,buffer.length-size,size);if(!count)break;size+=count;if(size>32768)throw fault('PROJECT_BACKUP_CHANGED','备份回执在读取期间超出预算。');}if(!same(identity(before),identity(fs.fstatSync(fd,{bigint:true})))||!same(identity(before),identity(this.regular(file,32768))))throw fault('PROJECT_BACKUP_CHANGED','备份回执读取期间变化。');}finally{fs.closeSync(fd);}const bytes=buffer.subarray(0,size);
    if(!same(identity(directoryBefore),identity(this.checkDirectory(directory))))throw fault('PROJECT_BACKUP_CHANGED','备份条目在读取期间变化。');
    let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fault('PROJECT_BACKUP_RECEIPT_INVALID','备份回执无法解析，原材料已保留。');}const manifest=this.validateManifest(parsed,taskId);if(documentId!==undefined&&manifest.input.documentId!==documentId)throw fault('PROJECT_BACKUP_NOT_FOUND','未找到当前工程的备份。',404);return manifest;
  }
  async publish(lease,input,bytes,checkpoint,{name}={}){
    this.assertLease(lease);input=normalizeProjectSaveInput(input);if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>this.maxFileBytes)throw fault('PROJECT_BACKUP_SIZE','生成的备份超过单文件预算。',413);
    const result={ok:true,documentId:input.documentId,requestId:input.requestId,revision:checkpoint.revision,stateToken:checkpoint.stateToken,stateSequence:checkpoint.stateSequence,projectBackup:{version:1,taskId:lease.taskId,fileName:this.fileName(name),bytes:bytes.length,sha256:sha(bytes),workspaceToken:checkpoint.workspaceToken,createdAt:new Date().toISOString(),downloadPath:`/api/documents/${input.documentId}/project/backups/${lease.taskId}/download`}};
    const manifest={format:'web-cad-project-backup',version:1,taskId:lease.taskId,input,fingerprint:sha(projectSaveCanonical(input)),result,resultSha256:sha(JSON.stringify(result))};this.validateManifest(manifest,lease.taskId);
    const target=path.join(lease.directory,'backup.cadproj');let handle=await fsp.open(target,'wx',0o600);try{for(let offset=0;offset<bytes.length;){const {bytesWritten}=await handle.write(bytes,offset,Math.min(1024*1024,bytes.length-offset),offset);if(!bytesWritten)throw fault('PROJECT_BACKUP_WRITE_FAILED','备份文件写入未完成。');offset+=bytesWritten;}await handle.sync();}finally{await handle.close();}
    // Directory timestamps change when our files are created; keep stable directory identity.
    const current=this.checkDirectory(lease.directory);if(current.dev!==lease.identity.dev||current.ino!==lease.identity.ino)throw fault('PROJECT_BACKUP_CHANGED','备份目录归属已变化。');
    const fileStat=this.regular(target,this.maxFileBytes),verification=fs.openSync(target,'r');try{this.verifyHandle(verification,target,fileStat,result.projectBackup);}finally{fs.closeSync(verification);}
    handle=await fsp.open(path.join(lease.directory,'receipt.json'),'wx',0o600);try{await handle.writeFile(JSON.stringify(manifest));await handle.sync();}finally{await handle.close();}
    const final=this.directory(lease.taskId);if(fs.existsSync(final))throw fault('PROJECT_BACKUP_EXISTS','备份发布身份已被占用，未覆盖。',409);this.checkRoot();const ready=this.checkDirectory(lease.directory);if(ready.dev!==lease.identity.dev||ready.ino!==lease.identity.ino)throw fault('PROJECT_BACKUP_CHANGED','备份目录在发布前变化。');fs.renameSync(lease.directory,final);lease.published=true;return result;
  }
  verifyHandle(fd,file,before,backup){
    if(Number(before.size)!==backup.bytes)throw fault('PROJECT_BACKUP_CHANGED','备份长度与原回执不一致。');const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let at=0,count;while((count=fs.readSync(fd,buffer,0,buffer.length,at))>0){at+=count;hash.update(buffer.subarray(0,count));}if(at!==backup.bytes||hash.digest('hex')!==backup.sha256||!same(identity(before),identity(fs.fstatSync(fd,{bigint:true})))||!same(identity(before),identity(this.regular(file,this.maxFileBytes))))throw fault('PROJECT_BACKUP_CHANGED','备份内容或文件身份已变化，未返回替代文件。');
  }
  release(lease){
    if(this.active.get(lease.taskId)!==lease)return;
    this.active.delete(lease.taskId);
    if(lease.published||!fs.existsSync(lease.directory))return;
    // Only an empty, still-owned private directory can be discarded as no artifact.
    const stat=this.checkDirectory(lease.directory);if(stat.dev!==lease.identity.dev||stat.ino!==lease.identity.ino)throw fault('PROJECT_BACKUP_CHANGED','未完成备份归属变化，已保留。');if(fs.readdirSync(lease.directory).length===0)fs.rmdirSync(lease.directory);
  }
  async openDownload(taskId,documentId){
    if(this.maintenance.has(taskId))throw fault('PROJECT_BACKUP_BUSY','备份材料正在维护，请稍后读取。',409);
    if([...this.readers.values()].reduce((a,b)=>a+b,0)>=this.maxDownloads)throw fault('PROJECT_BACKUP_DOWNLOAD_CAPACITY','备份下载读取已满，请等待现有读取结束。',429);
    const manifest=this.read(taskId,documentId);if(!manifest)throw fault('PROJECT_BACKUP_NOT_FOUND','原备份文件已不可用，不会重新生成。',410);
    const file=path.join(this.directory(taskId),'backup.cadproj'),before=this.regular(file,this.maxFileBytes),fd=fs.openSync(file,'r');try{this.verifyHandle(fd,file,before,manifest.result.projectBackup);}catch(error){fs.closeSync(fd);throw error;}
    this.readers.set(taskId,(this.readers.get(taskId)||0)+1);let closed=false,started=false;
    const close=()=>{if(closed)return;closed=true;fs.closeSync(fd);const n=this.readers.get(taskId)-1;if(n)this.readers.set(taskId,n);else this.readers.delete(taskId);};
    const regular=this.regular.bind(this),read=this.read.bind(this),maxFileBytes=this.maxFileBytes;return {result:manifest.result,close,assertUnchanged(){if(!same(identity(before),identity(regular(file,maxFileBytes)))||JSON.stringify(read(taskId,documentId))!==JSON.stringify(manifest))throw fault('PROJECT_BACKUP_CHANGED','备份在读取后变化，未删除。');},async *chunks(){if(started||closed)throw fault('PROJECT_BACKUP_STREAM_CLOSED','备份下载读取已关闭。');started=true;const hash=createHash('sha256');let at=0,pending;
      try{for(;;){const bytes=Buffer.allocUnsafe(64*1024),count=fs.readSync(fd,bytes,0,bytes.length,at);if(!count)break;at+=count;const chunk=bytes.subarray(0,count);hash.update(chunk);if(pending)yield pending;pending=chunk;await new Promise(resolve=>setImmediate(resolve));}if(at!==manifest.result.projectBackup.bytes||hash.digest('hex')!==manifest.result.projectBackup.sha256||!same(identity(before),identity(fs.fstatSync(fd,{bigint:true})))||!same(identity(before),identity(regular(file,maxFileBytes))))throw fault('PROJECT_BACKUP_CHANGED','备份在下载期间变化，已中断，不返回完整的错误文件。');if(pending)yield pending;
      }finally{close();}
    }};
  }
  async remove(taskId,documentId){
    if(this.active.has(taskId)||this.readers.has(taskId)||this.maintenance.has(taskId))throw fault('PROJECT_BACKUP_BUSY','备份正在生成、下载或维护，未删除。',409);
    const download=await this.openDownload(taskId,documentId);try{for await(const chunk of download.chunks())void chunk;}finally{download.close();}
    if(this.active.has(taskId)||this.readers.has(taskId)||this.maintenance.has(taskId))throw fault('PROJECT_BACKUP_BUSY','备份正在使用或维护，未删除。',409);
    download.assertUnchanged();const directory=this.directory(taskId),files=fs.readdirSync(directory);if(files.length!==2||!files.includes('backup.cadproj')||!files.includes('receipt.json'))throw fault('PROJECT_BACKUP_CHANGED','备份包含未知材料，未删除。');fs.unlinkSync(path.join(directory,'backup.cadproj'));fs.unlinkSync(path.join(directory,'receipt.json'));fs.rmdirSync(directory);return {deleted:true,taskId,documentId};
  }
  status(){try{return {available:true,...this.inventory(),maxFileBytes:this.maxFileBytes,maxTotalBytes:this.maxTotalBytes,maxEntries:this.maxEntries,maxDownloads:this.maxDownloads,active:this.active.size,downloads:[...this.readers.values()].reduce((a,b)=>a+b,0)};}catch(error){return {available:false,code:error.code||'PROJECT_BACKUP_STORE_UNAVAILABLE',active:this.active.size};}}
}
