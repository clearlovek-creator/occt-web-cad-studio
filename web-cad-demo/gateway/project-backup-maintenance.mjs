import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ProjectBackupError} from './project-backup-store.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ENTRY=/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(\.pending)?$/;
const DOC=/^[A-Za-z0-9_-]{1,64}$/;
const HASH=/^[a-f0-9]{64}$/;
const identity=stat=>Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(key=>[key,String(stat[key])]));
const canonical=value=>JSON.stringify(value);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const same=(left,right)=>canonical(left)===canonical(right);
const fail=(code,message,status=409)=>new ProjectBackupError(code,message,status);
const object=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
function present(file){try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function names(directory,limit,material=false){const rows=[],handle=fs.opendirSync(directory);try{for(let item;(item=handle.readSync());){if(rows.length===limit)throw material?fail('PROJECT_BACKUP_MAINTENANCE_UNSAFE','条目包含超出预期的材料，已保留，未清理。'):fail('PROJECT_BACKUP_MAINTENANCE_LIMIT','维护材料数量超过预算，已保留。',429);rows.push(item.name);}}finally{handle.closeSync();}return rows.sort();}

/** Explicit, durable, file-only maintenance. Never scans or repairs native recovery materials. */
export class ProjectBackupMaintenance{
  constructor(store,catalog,{isTaskBusy=()=>false,maxRecords=128,reviewTtlMs=900000,now=Date.now}={}){
    if(!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>512||!Number.isSafeInteger(reviewTtlMs)||reviewTtlMs<1000||reviewTtlMs>86400000)throw fail('PROJECT_BACKUP_MAINTENANCE_CONFIG','备份维护预算无效。',503);
    Object.assign(this,{store,catalog,isTaskBusy,maxRecords,reviewTtlMs,now});this.root=path.resolve(store.root,'..','project-backup-maintenance');this.running=new Set();this.closed=false;this.operations=0;this.idleWaiters=[];fs.mkdirSync(this.root,{recursive:true});this.checkRoot();
  }
  checkRoot(){this.store.checkRoot();const stat=fs.lstatSync(this.root);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('PROJECT_BACKUP_MAINTENANCE_STORE','维护记录目录异常，材料已保留。',503);}
  parseEntry(entryId){if(typeof entryId!=='string'||!ENTRY.test(entryId))throw fail('PROJECT_BACKUP_ARGUMENTS','备份维护条目标识无效。',400);return entryId.match(ENTRY)[1];}
  recordPath(reviewId){if(typeof reviewId!=='string'||!UUID.test(reviewId))throw fail('PROJECT_BACKUP_ARGUMENTS','维护清单标识无效。',400);this.checkRoot();return path.join(this.root,reviewId+'.json');}
  source(entryId){this.parseEntry(entryId);this.store.checkRoot();return path.join(this.store.root,entryId);}
  quarantine(reviewId){this.recordPath(reviewId);return path.join(this.store.root,reviewId+'.maintenance');}
  assertIdle(taskId){if(this.store.active.has(taskId)||this.store.readers.has(taskId)||this.isTaskBusy(taskId))throw fail('PROJECT_BACKUP_BUSY','关联保存任务仍在活动、结果未确认或文件正在读取，未维护材料。');}
  assertOpen(){if(this.closed)throw fail('GATEWAY_STOPPING','服务正在停止，未继续新的备份维护阶段；原材料和清单已保留。',503);}
  async locked(taskId,action){this.assertOpen();this.assertIdle(taskId);if(this.store.maintenance.size)throw fail('PROJECT_BACKUP_BUSY','已有备份维护正在核对或清理，请稍后再试。');this.store.maintenance.add(taskId);this.operations++;try{return await action();}finally{this.store.maintenance.delete(taskId);if(!--this.operations)for(const resolve of this.idleWaiters.splice(0))resolve();}}
  closeAndWait(){this.closed=true;return this.operations?new Promise(resolve=>this.idleWaiters.push(resolve)):Promise.resolve();}
  directory(directory){const stat=this.store.checkDirectory(directory);return identity(stat);}
  async hashFile(directory,name){
    if(!['backup.cadproj','receipt.json'].includes(name))throw fail('PROJECT_BACKUP_MAINTENANCE_UNSAFE','条目包含未知文件，未清理。');
    const file=path.join(directory,name),limit=name==='receipt.json'?32768:this.store.maxFileBytes,before=this.store.regular(file,limit),handle=await fs.promises.open(file,'r'),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let offset=0;
    try{for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)break;offset+=bytesRead;if(offset>limit)throw fail('PROJECT_BACKUP_CHANGED','维护核对期间文件超出预算，未清理。');hash.update(buffer.subarray(0,bytesRead));await new Promise(resolve=>setImmediate(resolve));}if(offset!==Number(before.size)||!same(identity(before),identity(await handle.stat({bigint:true})))||!same(identity(before),identity(this.store.regular(file,limit))))throw fail('PROJECT_BACKUP_CHANGED','维护核对期间文件发生变化，未清理。');return {name,bytes:offset,sha256:hash.digest('hex'),identity:identity(before)};}finally{await handle.close();}
  }
  async snapshot(directory){const before=this.directory(directory),files=[];for(const name of names(directory,2,true))files.push(await this.hashFile(directory,name));if(!same(before,this.directory(directory)))throw fail('PROJECT_BACKUP_CHANGED','维护核对期间目录发生变化，未清理。');return {directory:before,files};}
  validate(record,reviewId){
    const bad=()=>{throw fail('PROJECT_BACKUP_MAINTENANCE_STORE','维护清单格式或摘要异常，原材料已保留。',503);};
    if(!object(record,['version','reviewId','documentId','entryId','taskId','createdAt','expiresAt','snapshot','snapshotDigest','state','outcome'])||record.version!==1||record.reviewId!==reviewId||!UUID.test(record.reviewId)||!DOC.test(record.documentId)||!ENTRY.test(record.entryId)||record.taskId!==this.parseEntry(record.entryId)||!Number.isSafeInteger(record.createdAt)||record.createdAt<0||!Number.isSafeInteger(record.expiresAt)||record.expiresAt>8640000000000000||record.expiresAt<=record.createdAt||record.expiresAt-record.createdAt>86400000||!['reviewed','prepared','isolated','completed'].includes(record.state)||!HASH.test(record.snapshotDigest))bad();
    const snapshot=record.snapshot;
    const validIdentity=value=>object(value,['dev','ino','size','mtimeNs','ctimeNs','nlink'])&&Object.keys(value).length===6&&Object.values(value).every(item=>typeof item==='string'&&/^-?[0-9]{1,32}$/.test(item));
    if(!object(snapshot,['directory','files'])||!validIdentity(snapshot.directory)||!Array.isArray(snapshot.files)||snapshot.files.length>2||new Set(snapshot.files.map(file=>file?.name)).size!==snapshot.files.length)bad();
    for(const file of snapshot.files)if(!object(file,['name','bytes','sha256','identity'])||!['backup.cadproj','receipt.json'].includes(file.name)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>(file.name==='receipt.json'?32768:this.store.maxFileBytes)||!HASH.test(file.sha256)||!validIdentity(file.identity)||file.identity.nlink!=='1'||file.identity.size!==String(file.bytes))bad();
    if(record.snapshotDigest!==digest({documentId:record.documentId,entryId:record.entryId,snapshot})||record.state==='completed'&&!['removed','already-absent'].includes(record.outcome)||record.state!=='completed'&&record.outcome!==undefined)bad();return record;
  }
  read(reviewId,documentId){
    if(!DOC.test(documentId))throw fail('PROJECT_BACKUP_ARGUMENTS','工程身份无效。',400);
    const file=this.recordPath(reviewId);if(!present(file))throw fail('PROJECT_BACKUP_MAINTENANCE_NOT_FOUND','未找到当前工程的维护清单。',404);const before=this.store.regular(file,32768),fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(32769);let length=0;
    try{for(;;){const count=fs.readSync(fd,buffer,length,buffer.length-length,length);if(!count)break;length+=count;if(length>32768)throw fail('PROJECT_BACKUP_MAINTENANCE_STORE','维护清单超过预算。',503);}if(!same(identity(before),identity(fs.fstatSync(fd,{bigint:true})))||!same(identity(before),identity(this.store.regular(file,32768))))throw fail('PROJECT_BACKUP_MAINTENANCE_STORE','维护清单读取期间变化，未采用。',503);}finally{fs.closeSync(fd);}
    let record;try{record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));}catch{throw fail('PROJECT_BACKUP_MAINTENANCE_STORE','维护清单无法解析，已保留。',503);}this.validate(record,reviewId);if(record.documentId!==documentId)throw fail('PROJECT_BACKUP_MAINTENANCE_NOT_FOUND','未找到当前工程的维护清单。',404);return record;
  }
  write(record){
    this.validate(record,record.reviewId);const file=this.recordPath(record.reviewId);if(present(file))this.store.regular(file,32768);const temporary=path.join(this.root,record.reviewId+'.'+randomUUID()+'.tmp'),bytes=Buffer.from(canonical(record));if(bytes.length>32768)throw fail('PROJECT_BACKUP_MAINTENANCE_STORE','维护清单超过预算，未继续。',503);
    const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}this.checkRoot();fs.renameSync(temporary,file);
  }
  publicRecord(record){return {reviewId:record.reviewId,documentId:record.documentId,entryId:record.entryId,state:record.state,snapshotDigest:record.snapshotDigest,createdAt:new Date(record.createdAt).toISOString(),expiresAt:new Date(record.expiresAt).toISOString(),expired:record.state==='reviewed'&&this.now()>=record.expiresAt,running:record.state!=='completed'&&this.running.has(record.reviewId),files:record.snapshot.files.map(({name,bytes,sha256})=>({name,bytes,sha256})),...(record.state==='completed'?{outcome:record.outcome}:{})};}
  get(documentId,reviewId){return {ok:true,version:1,maintenance:this.publicRecord(this.read(reviewId,documentId))};}
  discard(documentId,reviewId){
    this.assertOpen();
    const record=this.read(reviewId,documentId);if(this.running.has(reviewId)||!['reviewed','completed'].includes(record.state)||this.store.maintenance.has(record.taskId))throw fail('PROJECT_BACKUP_BUSY','执行中或中断未决的维护记录不能清除。');
    this.store.regular(this.recordPath(reviewId),32768);fs.unlinkSync(this.recordPath(reviewId));return {ok:true,documentId,reviewId,recordDeleted:true,materialDeleted:false};
  }
  list(documentId){
    if(!DOC.test(documentId))throw fail('PROJECT_BACKUP_ARGUMENTS','工程身份无效。',400);this.checkRoot();const records=[];let unreadableRecords=0;
    for(const name of names(this.root,this.maxRecords)){if(!name.endsWith('.json')||!UUID.test(name.slice(0,-5))){unreadableRecords++;continue;}try{records.push(this.publicRecord(this.read(name.slice(0,-5),documentId)));}catch(error){if(error.code!=='PROJECT_BACKUP_MAINTENANCE_NOT_FOUND')unreadableRecords++;}}
    records.sort((left,right)=>right.createdAt.localeCompare(left.createdAt)||left.reviewId.localeCompare(right.reviewId));return {ok:true,version:1,documentId,records,unreadableRecords};
  }
  async preview(documentId,entryId){
    const taskId=this.parseEntry(entryId);if(!DOC.test(documentId))throw fail('PROJECT_BACKUP_ARGUMENTS','工程身份无效。',400);this.checkRoot();if(names(this.root,this.maxRecords).length>=this.maxRecords)throw fail('PROJECT_BACKUP_MAINTENANCE_LIMIT','维护清单记录已满，未自动清理历史记录。',429);
    return this.locked(taskId,async()=>{
      const item=this.catalog.entry(entryId);if(!item||item.owner!==documentId)throw fail('PROJECT_BACKUP_MAINTENANCE_NOT_FOUND','无法确认当前工程的材料归属，未生成清理清单。',404);
      const snapshot=await this.snapshot(this.source(entryId));this.assertOpen();this.assertIdle(taskId);const after=this.catalog.entry(entryId);
      if(!after||after.owner!==documentId||after.signature!==item.signature||canonical(after.entry.receipt)!==canonical(item.entry.receipt)||!same(snapshot.directory,this.directory(this.source(entryId))))throw fail('PROJECT_BACKUP_CHANGED','核对期间材料归属或回执变化，未生成清理清单。');
      if(item.entry.stage==='published'&&item.entry.receipt){const file=snapshot.files.find(file=>file.name==='backup.cadproj'),backup=item.entry.receipt.projectBackup;if(file?.bytes===backup.bytes&&file.sha256===backup.sha256&&snapshot.files.length===2&&item.entry.state==='available')throw fail('PROJECT_BACKUP_MAINTENANCE_NOT_REQUIRED','这是内容完整的正常备份，请使用“删除备份文件”，而不是异常维护。');}
      const reviewId=randomUUID(),createdAt=this.now(),record={version:1,reviewId,documentId,entryId,taskId,createdAt,expiresAt:createdAt+this.reviewTtlMs,snapshot,snapshotDigest:digest({documentId,entryId,snapshot}),state:'reviewed'};this.write(record);return {ok:true,version:1,maintenance:this.publicRecord(record)};
    });
  }
  async remaining(record,directory){
    const current=this.directory(directory);if(current.dev!==record.snapshot.directory.dev||current.ino!==record.snapshot.directory.ino)throw fail('PROJECT_BACKUP_CHANGED','隔离材料目录身份已变化，未继续清理。');
    const files=names(directory,2,true);for(const name of files){const expected=record.snapshot.files.find(file=>file.name===name);if(!expected||!same(expected,await this.hashFile(directory,name)))throw fail('PROJECT_BACKUP_CHANGED','隔离材料与原核对清单不同，未继续清理。');}
    const after=this.directory(directory);if(!same(current,after))throw fail('PROJECT_BACKUP_CHANGED','隔离材料核对期间变化，未继续清理。');return files;
  }
  async commit(documentId,reviewId,snapshotDigest){
    const original=this.read(reviewId,documentId);if(snapshotDigest!==original.snapshotDigest)throw fail('PROJECT_BACKUP_MAINTENANCE_CONFLICT','提交摘要与用户核对的清单不一致，未清理。');if(original.state==='completed')return this.get(documentId,reviewId);
    return this.locked(original.taskId,async()=>{
      let record=this.read(reviewId,documentId);if(record.state==='reviewed'&&this.now()>=record.expiresAt)throw fail('PROJECT_BACKUP_MAINTENANCE_EXPIRED','维护清单已过期，请重新核对材料。');this.running.add(reviewId);
      try{
        const source=this.source(record.entryId),quarantine=this.quarantine(reviewId);let isolated=present(quarantine),sourceExists=present(source),removed=false;
        if(sourceExists&&isolated)throw fail('PROJECT_BACKUP_CHANGED','原位置与隔离位置同时存在材料，已保留，未继续清理。');
        if(record.state==='reviewed'&&(!sourceExists||isolated))throw fail('PROJECT_BACKUP_CHANGED','原材料在提交前已变化，未清理。');
        if(sourceExists){if(!same(record.snapshot,await this.snapshot(source)))throw fail('PROJECT_BACKUP_CHANGED','材料与原核对清单不同，未清理。');this.assertOpen();this.assertIdle(record.taskId);record={...record,state:'prepared'};this.write(record);this.store.checkRoot();if(present(quarantine)||!same(record.snapshot.directory,this.directory(source)))throw fail('PROJECT_BACKUP_CHANGED','隔离前材料归属变化，未清理。');fs.renameSync(source,quarantine);isolated=true;}
        if(isolated){const files=await this.remaining(record,quarantine);this.assertOpen();this.assertIdle(record.taskId);if(present(source))throw fail('PROJECT_BACKUP_CHANGED','原位置出现新的材料，已保留，未继续清理。');record={...record,state:'isolated'};this.write(record);
          for(const name of files){const current=this.directory(quarantine),expected=record.snapshot.files.find(file=>file.name===name);if(current.dev!==record.snapshot.directory.dev||current.ino!==record.snapshot.directory.ino||!same(expected.identity,identity(this.store.regular(path.join(quarantine,name),name==='receipt.json'?32768:this.store.maxFileBytes))))throw fail('PROJECT_BACKUP_CHANGED','清理前文件归属变化，原剩余材料已保留。');fs.unlinkSync(path.join(quarantine,name));}
          const current=this.directory(quarantine);if(current.dev!==record.snapshot.directory.dev||current.ino!==record.snapshot.directory.ino)throw fail('PROJECT_BACKUP_CHANGED','隔离目录归属变化，未删除目录。');fs.rmdirSync(quarantine);removed=true;
        }
        record={...record,state:'completed',outcome:removed?'removed':'already-absent'};this.write(record);return {ok:true,version:1,maintenance:this.publicRecord(record)};
      }finally{this.running.delete(reviewId);}
    });
  }
}
