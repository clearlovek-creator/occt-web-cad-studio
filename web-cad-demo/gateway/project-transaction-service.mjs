import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function atomicJson(file,value){const temporary=file+'.'+crypto.randomUUID()+'.tmp';let fd;try{fd=fs.openSync(temporary,'wx');fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);}finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export class ProjectTransactionError extends Error {
  constructor(code,message){super(message);this.name='ProjectTransactionError';this.code=code;}
}
const failure=(code,message)=>new ProjectTransactionError(code,message);
function digest(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024*1024)throw new Error('Transaction manifest backup has an invalid type or size.');const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024),fd=fs.openSync(file,'r');try{let size;while((size=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,size));}finally{fs.closeSync(fd);}return {bytes:stat.size,sha256:hash.digest('hex')};}

/** One history timeline; the journal protects native geometry and all engineering data. */
export class ProjectTransactionService {
  constructor({dataDir,historyStore,propertySchemaStore,projectDataStore=propertySchemaStore,command,prepareHistory,captureExecutionState=()=>null,assertExecutionState=()=>{},onExecutionStart=()=>{},onRecoveryStart=()=>{},onRollback=()=>{},onWarning=console.warn}){
    Object.assign(this,{historyStore,projectDataStore,command,prepareHistory,captureExecutionState,assertExecutionState,onExecutionStart,onRecoveryStart,onRollback,onWarning});
    this.directory=path.join(dataDir,'document-transactions');fs.mkdirSync(this.directory,{recursive:true});
    this.active=new Set();
  }
  journalPath(id){if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw new Error('Invalid transaction document ID.');return path.join(this.directory,id+'.pending.json');}
  assertWritable(id){if(fs.existsSync(this.journalPath(id)))throw failure('PROJECT_RECOVERY_REQUIRED','工程存在尚未完成的恢复事务，已停止后续修改；请重启服务完成恢复。');}
  check(value){if(!value?.ok)throw failure(value?.code||'PROJECT_KERNEL_FAILED',value?.error||'几何内核未完成事务操作。');return value;}
  backupPath(id,binding){if(!binding||typeof binding.file!=='string'||!new RegExp(`^${id}-[a-f0-9-]{36}\\.manifest\\.json$`).test(binding.file))throw new Error('Invalid transaction manifest backup name.');return path.join(this.directory,binding.file);}
  backupManifest(id){
    const binding={file:id+'-'+crypto.randomUUID()+'.manifest.json'},target=this.backupPath(id,binding),source=path.join(this.historyStore.documentDirectory(id),'manifest.json');
    try{try{fs.linkSync(source,target);}catch{fs.copyFileSync(source,target);}Object.assign(binding,digest(target));return binding;}
    catch(error){fs.rmSync(target,{force:true});throw error;}
  }
  finishFiles(id,journal){fs.rmSync(this.journalPath(id),{force:true});if(journal.beforeManifest)fs.rmSync(this.backupPath(id,journal.beforeManifest),{force:true});}
  validateJournal(id,journal){
    if(![1,2].includes(journal?.version)||journal.documentId!==id||!['prepared','committed'].includes(journal.phase))throw new Error('Invalid project mutation journal.');
    let history,schema;
    if(journal.version===2){
      const backup=this.backupPath(id,journal.beforeManifest),actual=digest(backup);
      if(actual.bytes!==journal.beforeManifest.bytes||actual.sha256!==journal.beforeManifest.sha256)throw new Error('Transaction manifest backup checksum failed.');
      history=this.historyStore.decodeManifest(id,JSON.parse(fs.readFileSync(backup,'utf8')),journal.phase==='prepared');
    }else{history=this.historyStore.normalize(id,journal.beforeHistory,journal.phase==='prepared');schema=this.projectDataStore.validateSnapshot(journal.beforeSchema);}
    if(!history.current)throw new Error('Recovery journal has no baseline checkpoint.');
    if(journal.phase==='prepared'){
      const binding=history.projectData[path.basename(history.current)];if(!binding)throw new Error('Recovery baseline lacks property evidence.');
      const certified=this.historyStore.readProjectDataFile(id,history.current,binding);
      if(schema&&!same(schema,certified))throw new Error('Recovery schema does not match its certified checkpoint.');schema=certified;
    }else{
      const live=this.historyStore.get(id);
      if(live.current!==journal.afterCurrent||!this.historyStore.isValidSnapshot(id,live.current))throw new Error('Committed recovery journal does not match the durable project.');
    }
    return {history,schema};
  }
  recover(){
    for(const entry of fs.readdirSync(this.directory)){
      const match=/^([A-Za-z0-9_-]{1,64})\.pending\.json$/.exec(entry);if(!match)continue;
      const id=match[1],file=this.journalPath(id);
      try{
        const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024*1024)throw new Error('Recovery journal has an invalid type or exceeds its limit.');
        const journal=JSON.parse(fs.readFileSync(file,'utf8')),{history,schema}=this.validateJournal(id,journal);
        if(journal.phase==='prepared'){
          this.projectDataStore.replaceSnapshot(id,schema,{preserveUpdatedAt:true});
          this.historyStore.commit(id,{...history,events:[...(history.events||[]),{eventId:'transaction-recovery-'+crypto.randomUUID(),operation:'history.recover-transaction',afterRevision:history.events?.findLast(event=>Number.isSafeInteger(event.afterRevision))?.afterRevision,timestamp:new Date().toISOString()}]},{cleanup:false});
        }
        this.finishFiles(id,journal);this.historyStore.cleanup(this.historyStore.documentDirectory(id),this.historyStore.get(id));
        this.onWarning(`[project] ${id}: ${journal.phase==='prepared'?'rolled back interrupted mutation':'finalized committed mutation'}.`);
      }catch(error){this.historyStore.markRestoreError(id,'工程事务恢复失败，原始记录已保留：'+error.message);this.onWarning(`[project] ${id}: recovery blocked: ${error.message}`);}
    }
  }
  async rollback(id,journal){
    // Recovery must never inherit an already aborted modeling task signal.
    // A status/report failure is not allowed to prevent the real rollback.
    try{this.onRecoveryStart(id);}catch(error){this.onWarning('[project] Recovery phase reporting failed: '+error.message);}
    const {history,schema}=this.validateJournal(id,journal);
    this.check(await this.command('document.restore',{documentId:id,parameters:{path:history.current}}));
    this.projectDataStore.replaceSnapshot(id,schema,{preserveUpdatedAt:true});
    this.historyStore.commit(id,history,{cleanup:false});
    this.onRollback(id);
    this.finishFiles(id,journal);
  }
  async run(id,action,{success=value=>value?.ok}={}){
    this.assertWritable(id);
    let history=this.prepareHistory?await this.prepareHistory(id):this.historyStore.repair(id);
    if(history.restoreError)throw failure('HISTORY_RESTORE_FAILED',history.restoreError);
    const beforeSchema=this.projectDataStore.validateSnapshot(this.projectDataStore.list(id));
    if(!history.current){
      const current=this.historyStore.snapshotPath(id);
      try{this.check(await this.command('document.snapshot',{documentId:id,parameters:{path:current}}));history=this.historyStore.commit(id,{...history,current});}
      catch(error){this.historyStore.discard(current);throw error;}
    }else if(!history.projectData[path.basename(history.current)])history=this.historyStore.commit(id,history);
    if(!same(beforeSchema,this.historyStore.readProjectData(id,history.current)))throw failure('PROJECT_DATA_OUT_OF_SYNC','属性文件与当前完整检查点不一致，已停止修改；请重新载入工程或重启服务恢复。');
    const journal={version:2,phase:'prepared',documentId:id,beforeManifest:this.backupManifest(id)};
    try{atomicJson(this.journalPath(id),journal);}catch(error){fs.rmSync(this.backupPath(id,journal.beforeManifest),{force:true});throw error;}
    this.historyStore.deferCleanup(id,true);this.active.add(id);
    let committed=false;
    try{
      // The action receives this transaction's already checked baseline, not a
      // second full repair pass. commit() still rehashes every retained snapshot.
      const executionState=this.captureExecutionState(id);
      this.onExecutionStart(id);
      const result=await action(history);
      // A process restart between native execution and checkpoint publication
      // must not turn restored baseline geometry into a false successful edit.
      this.assertExecutionState(id,executionState);
      if(!success(result)){
        await this.rollback(id,journal);
        const rejected=result?.response&&typeof result.response==='object'?result.response:result;
        // Internal proof only: do not add fields to legacy HTTP result shapes.
        if(rejected&&typeof rejected==='object')try{Object.defineProperty(rejected,'projectRollback',{value:{documentId:id,confirmed:true},configurable:true});}catch{/* Immutable results stay conservative. */}
        return result;
      }
      const after=this.historyStore.get(id);
      if(!after.current||!same(this.projectDataStore.validateSnapshot(this.projectDataStore.list(id)),this.historyStore.readProjectData(id,after.current)))throw new Error('Committed geometry and engineering-data checkpoint do not agree.');
      atomicJson(this.journalPath(id),{...journal,phase:'committed',afterCurrent:after.current});committed=true;
      try{this.finishFiles(id,journal);}catch(error){this.onWarning('[project] Committed mutation cleanup deferred: '+error.message);}
      return result;
    }catch(error){
      if(!committed)try{
        await this.rollback(id,journal);
        // Only a fully verified geometry + typed-data + history rollback can
        // turn an interrupted operation into a proven non-commit outcome.
        if(error&&typeof error==='object')try{Object.defineProperty(error,'projectRollback',{value:{documentId:id,confirmed:true},configurable:true});}catch{/* frozen errors remain conservatively unknown */}
      }catch(rollbackError){this.historyStore.markRestoreError(id,'工程恢复尚未完成：'+rollbackError.message);throw failure('PROJECT_ROLLBACK_FAILED','操作失败且恢复尚未完成，已保留恢复日志；请重启服务重试恢复。'+rollbackError.message);}
      throw error;
    }finally{
      this.historyStore.deferCleanup(id,false);
      this.active.delete(id);
      if(!fs.existsSync(this.journalPath(id)))try{this.historyStore.cleanup(this.historyStore.documentDirectory(id),this.historyStore.get(id));}catch(error){this.onWarning('[project] Checkpoint cleanup deferred: '+error.message);}
    }
  }
}
