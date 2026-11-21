import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {managedStepDestination,hashManagedStepSource,restorationStepPath,hashRestorationStepSource,STEP_SOURCE_ALGORITHM} from './step-source-integrity.mjs';
import {SourceAccessGate} from './source-access-gate.mjs';

const idPattern=/^restore-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const artifactPattern=/^(?:candidate|(?:before|stage|retained|recovery-stage|recovery-retained)-[a-f0-9-]{36})\.step$/;
const states=new Set(['prepared','activating','committed','reverting','rolled-back','attention','abandoned']);
const proofKeys=['size','sha256','fingerprint','algorithm'];
const fileProof=proof=>({status:'file',...Object.fromEntries(proofKeys.map(key=>[key,proof[key]]))});
const equal=(a,b)=>a?.status===b?.status&&(a?.status==='missing'||proofKeys.every(key=>a?.[key]===b?.[key]));
const validFileProof=value=>value?.status==='file'&&Number.isSafeInteger(value.size)&&value.size>=0&&value.algorithm===STEP_SOURCE_ALGORITHM&&[value.sha256,value.fingerprint].every(item=>typeof item==='string'&&/^[a-f0-9]{64}$/.test(item));
export class SourceRestoreTransactionError extends Error{constructor(code,message){super(message);this.name='SourceRestoreTransactionError';this.code=code;}}
const fault=(code,message)=>new SourceRestoreTransactionError(code,message);

/** Filesystem transaction kernel. No HTTP routes or CAD commands are exposed
 * until its dependency proof, upload admission and UI are wired together.
 * All versions are retained; this is deliberately not a cleanup service.
 * Caller contract: hold the existing data-directory writer lease, route all
 * source-sensitive document work through the shared gate, recover before
 * admitting requests, and block such work while any record is blocking.
 * Neither the lease nor the gate excludes external filesystem programs. */
export class SourceRestoreTransactions {
  constructor({dataDir,proof,swap,gate=new SourceAccessGate(),maxCandidateBytes=200*1024*1024,maxSourceBytes=512*1024*1024,maxRetainedBytes=2*1024*1024*1024,maxEntries=20000}={}){
    Object.assign(this,{dataDir:path.resolve(dataDir),proof,swap,gate,maxCandidateBytes,maxSourceBytes,maxRetainedBytes,maxEntries});
    this.active=null;this.closing=false;
  }
  directory(id){if(!idPattern.test(id))throw fault('SOURCE_RESTORE_ID','来源恢复操作身份无效。');return path.join(this.dataDir,'source-restores',id);}
  artifact(id,name){if(!artifactPattern.test(name))throw fault('SOURCE_RESTORE_RECORD_INVALID','恢复材料名称无效。');return restorationStepPath(path.join(this.directory(id),name),this.dataDir,{allowMissing:true});}
  ensureDirectory(directory){
    const relative=path.relative(this.dataDir,directory);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw fault('SOURCE_RESTORE_PATH','恢复目录超出受管存储。');
    let current=this.dataDir;
    for(const part of ['',...relative.split(path.sep)]){
      if(part){current=path.join(current,part);try{fs.mkdirSync(current);}catch(error){if(error.code!=='EEXIST')throw error;}}
      const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw fault('SOURCE_RESTORE_PATH','恢复路径含链接或非目录条目。');
    }
  }
  budget(additional=0){
    let bytes=additional,entries=0;const root=path.join(this.dataDir,'source-restores');
    const walk=(directory,depth=0)=>{if(depth>8)throw fault('SOURCE_RESTORE_LIMIT','恢复材料目录层级超出预算。');for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      if(++entries>this.maxEntries)throw fault('SOURCE_RESTORE_LIMIT','恢复材料条目超过保留预算，未删除任何旧材料。');
      const file=path.join(directory,entry.name),stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory()||stat.isFile()&&stat.nlink!==1)throw fault('SOURCE_RESTORE_PATH','恢复区含链接或异常文件，不能继续写入。');
      if(stat.isDirectory())walk(file,depth+1);else bytes+=stat.size;
      if(bytes>this.maxRetainedBytes)throw fault('SOURCE_RESTORE_LIMIT','恢复材料累计大小超过预算，旧版本保持不变。');
    }};
    if(fs.existsSync(root)){const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw fault('SOURCE_RESTORE_PATH','恢复区不能是链接或文件。');walk(root);}
    if(bytes>this.maxRetainedBytes)throw fault('SOURCE_RESTORE_LIMIT','恢复材料累计大小超过预算。');
    return {bytes,entries};
  }
  save(record){
    const directory=this.directory(record.operationId);this.ensureDirectory(directory);
    const file=path.join(directory,'record.json'),temporary=path.join(directory,'record-'+randomUUID()+'.tmp');
    if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw fault('SOURCE_RESTORE_RECORD_INVALID','来源恢复记录不是独立的普通文件。');}
    const bytes=Buffer.from(JSON.stringify(record));if(bytes.length>65536)throw fault('SOURCE_RESTORE_LIMIT','来源恢复记录超出大小预算。');this.budget(bytes.length);
    const fd=fs.openSync(temporary,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    // If rename fails, retain both the previous record and complete temporary
    // bytes. Never erase the old journal to make a Windows rename succeed.
    fs.renameSync(temporary,file);
  }
  read(id){
    const directory=this.directory(id),file=path.join(directory,'record.json');
    restorationStepPath(path.join(directory,'candidate.step'),this.dataDir,{allowMissing:true});
    const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>65536)throw fault('SOURCE_RESTORE_RECORD_INVALID','来源恢复记录类型或大小无效。');
    let record,fd;try{
      fd=fs.openSync(file,'r');const before=fs.fstatSync(fd),bytes=Buffer.alloc(65537);let total=0;
      if(!before.isFile()||before.nlink!==1||before.ino!==stat.ino||before.dev!==stat.dev||before.size!==stat.size)throw Error('changed');
      while(total<bytes.length){const count=fs.readSync(fd,bytes,total,bytes.length-total,null);if(!count)break;total+=count;}
      const after=fs.fstatSync(fd),current=fs.lstatSync(file);
      if(total>65536||total!==before.size||['ino','dev','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]||before[key]!==current[key])||current.isSymbolicLink()||current.nlink!==1)throw Error('changed');
      record=JSON.parse(bytes.subarray(0,total).toString('utf8'));
    }catch{throw fault('SOURCE_RESTORE_RECORD_INVALID','来源恢复记录损坏或在读取时变化，未猜测或覆盖原记录。');}finally{if(fd!==undefined)fs.closeSync(fd);}
    if(record.version!==1||record.operationId!==id||!Number.isSafeInteger(record.order)||record.order<1||!states.has(record.state)||typeof record.targetRelative!=='string'||path.isAbsolute(record.targetRelative)||record.targetRelative!==path.relative(this.dataDir,path.resolve(this.dataDir,record.targetRelative))||!validFileProof(record.candidate)||!(record.before?.status==='missing'||validFileProof(record.before))||!Array.isArray(record.attempts)||record.attempts.length>16||!record.proof||! /^[a-f0-9]{64}$/.test(record.proof.signature)||!Number.isSafeInteger(record.proof.referenceCount)||record.proof.referenceCount<1||!Array.isArray(record.proof.projects)||record.proof.projects.some(item=>typeof item!=='string'||! /^[A-Za-z0-9_-]{1,64}$/.test(item)))throw fault('SOURCE_RESTORE_RECORD_INVALID','来源恢复记录结构无效，未执行文件操作。');
    managedStepDestination(path.join(this.dataDir,record.targetRelative),this.dataDir);
    if(record.before.status==='file')this.artifact(id,record.beforeArtifact);
    for(const attempt of record.attempts){
      if(!['commit','rollback'].includes(attempt.action)||! /^[a-f0-9-]{36}$/.test(attempt.id)||!(attempt.start?.status==='missing'||validFileProof(attempt.start))||!(attempt.end?.status==='missing'||validFileProof(attempt.end)))throw fault('SOURCE_RESTORE_RECORD_INVALID','来源替换阶段记录无效。');
      for(const key of ['stage','backup','recoveryStage','recoveryBackup'])if(attempt[key]!==undefined)this.artifact(id,attempt[key]);
      if(!equal(attempt.start,attempt.action==='commit'?record.before:record.candidate)||!equal(attempt.end,attempt.action==='commit'?record.candidate:record.before))throw fault('SOURCE_RESTORE_RECORD_INVALID','来源替换前后证明不一致。');
    }
    if(['activating','reverting'].includes(record.state)&&(!record.attempts.length||record.attempts.at(-1).action!==(record.state==='activating'?'commit':'rollback')))throw fault('SOURCE_RESTORE_RECORD_INVALID','缺少进行中的文件替换阶段。');
    return record;
  }
  records(){
    const directory=path.join(this.dataDir,'source-restores');if(!fs.existsSync(directory))return [];
    const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw fault('SOURCE_RESTORE_PATH','恢复区不能是链接或文件。');
    const entries=fs.readdirSync(directory,{withFileTypes:true});if(entries.length>this.maxEntries)throw fault('SOURCE_RESTORE_LIMIT','来源恢复记录数量超出读取预算。');
    const records=[],orders=new Set();
    for(const entry of entries){
      if(!entry.isDirectory()||!idPattern.test(entry.name))throw fault('SOURCE_RESTORE_RECORD_INVALID','恢复区含未知材料目录，未自动处理。');
      if(!fs.existsSync(path.join(directory,entry.name,'record.json')))continue;
      const record=this.read(entry.name);if(orders.has(record.order))throw fault('SOURCE_RESTORE_RECORD_INVALID','来源恢复记录顺序存在冲突。');orders.add(record.order);records.push(record);
    }
    return records.sort((a,b)=>a.order-b.order);
  }
  targetIdentity(record){const file=path.resolve(this.dataDir,record.targetRelative);return process.platform==='win32'?file.toLowerCase():file;}
  superseded(record,records=this.records()){
    const owner=records.findLast(item=>item.state!=='abandoned'&&this.targetIdentity(item)===this.targetIdentity(record));
    return owner&&owner.operationId!==record.operationId?owner.operationId:null;
  }
  public(record,records=this.records()){const supersededBy=this.superseded(record,records);return {version:1,operationId:record.operationId,state:record.state,fileName:path.basename(record.targetRelative),createdAt:record.createdAt,updatedAt:record.updatedAt,referenceCount:record.proof.referenceCount,projects:record.proof.projects,before:record.before,candidate:record.candidate,changed:record.changed??null,errorCode:record.errorCode||null,recovery:record.recovery||null,supersededBy,blocking:['activating','reverting','attention'].includes(record.state),canCommit:record.state==='prepared'&&!supersededBy,canRollback:record.state==='committed'&&record.changed===true&&!supersededBy};}
  task(action){
    if(this.closing)return Promise.reject(fault('SOURCE_RESTORE_CLOSED','来源恢复服务正在停止。'));
    if(this.active)return Promise.reject(fault('SOURCE_RESTORE_BUSY','另一个来源恢复操作仍在执行，请先查询原操作。'));
    const running=Promise.resolve().then(action);this.active=running;
    return running.finally(()=>{if(this.active===running)this.active=null;});
  }
  async profile(target){try{return fileProof(await hashManagedStepSource(target,this.dataDir,{maxBytes:this.maxSourceBytes}));}catch(error){if(error.code==='PROJECT_SOURCE_MISSING')return {status:'missing'};throw error;}}
  async copy(source,destination,expected,{privateSource=false}={}){
    const actual=privateSource?await hashRestorationStepSource(source,this.dataDir,{maxBytes:this.maxSourceBytes}):await hashManagedStepSource(source,this.dataDir,{maxBytes:this.maxSourceBytes});
    if(!equal(fileProof(actual),expected))throw fault('SOURCE_RESTORE_STALE','待保留的来源内容已改变，请重新核对，未采用新字节。');
    this.budget(actual.size);restorationStepPath(destination,this.dataDir,{allowMissing:true});await fs.promises.copyFile(source,destination,fs.constants.COPYFILE_EXCL);
    const handle=await fs.promises.open(destination,'r+');try{await handle.sync();}finally{await handle.close();}
    const copied=await hashRestorationStepSource(destination,this.dataDir,{maxBytes:this.maxSourceBytes});
    const after=privateSource?await hashRestorationStepSource(source,this.dataDir,{maxBytes:this.maxSourceBytes}):await hashManagedStepSource(source,this.dataDir,{maxBytes:this.maxSourceBytes});
    if(!equal(fileProof(copied),expected)||!equal(fileProof(after),expected))throw fault('SOURCE_RESTORE_STALE','来源在备份期间改变，保留材料待复核，未执行替换。');
  }
  async checkProof(record){
    const candidate=await hashRestorationStepSource(this.artifact(record.operationId,'candidate.step'),this.dataDir,{maxBytes:this.maxCandidateBytes});
    if(!equal(fileProof(candidate),record.candidate))throw fault('SOURCE_RESTORE_CANDIDATE_CHANGED','已校验的候选文件改变，不能继续恢复。');
    const proof=await this.proof.validate(path.join(this.dataDir,record.targetRelative),candidate);
    if(proof.signature!==record.proof.signature)throw fault('SOURCE_RESTORE_STALE','工程或保留历史的来源引用已改变，请重新校验，不会直接执行旧计划。');
  }
  prepare({operationId,target}){return this.task(async()=>{
    this.directory(operationId);target=managedStepDestination(target,this.dataDir);const directory=this.directory(operationId);
    if(fs.existsSync(path.join(directory,'record.json')))throw fault('SOURCE_RESTORE_EXISTS','此操作已有记录，请查询原记录，未再次准备或覆盖。');
    const records=this.records();if(records.some(item=>['activating','reverting','attention'].includes(item.state)))throw fault('SOURCE_RESTORE_RECOVERY_REQUIRED','有尚未核对完成的来源事务，不能叠加新的恢复。');
    const order=(records.at(-1)?.order||0)+1;if(!Number.isSafeInteger(order))throw fault('SOURCE_RESTORE_LIMIT','来源恢复顺序超出有效范围。');
    const candidate=await hashRestorationStepSource(this.artifact(operationId,'candidate.step'),this.dataDir,{maxBytes:this.maxCandidateBytes});
    const proof=await this.proof.validate(target,candidate),before=await this.profile(target),now=new Date().toISOString();
    const record={version:1,operationId,order,state:'prepared',targetRelative:path.relative(this.dataDir,target),candidate:fileProof(candidate),before,createdAt:now,updatedAt:now,proof:{signature:proof.signature,referenceCount:proof.referenceCount,projects:proof.projects},attempts:[]};
    if(before.status==='file'){record.beforeArtifact='before-'+randomUUID()+'.step';await this.copy(target,this.artifact(operationId,record.beforeArtifact),before);}
    this.save(record);return this.public(record);
  });}
  get(id){return this.public(this.read(id));}
  abandon(id){return this.task(async()=>{const record=this.read(id);if(record.state==='abandoned')return this.public(record);if(record.state!=='prepared')throw fault('SOURCE_RESTORE_NOT_READY','只能放弃尚未提交的恢复，已经替换的文件必须显式回退。');record.state='abandoned';record.updatedAt=new Date().toISOString();this.save(record);return this.public(record);});}
  revalidate(id){return this.task(async()=>{
    const record=this.read(id);if(record.state!=='prepared')throw fault('SOURCE_RESTORE_NOT_READY','只能重新校验尚未提交的来源恢复。');if(this.superseded(record))throw fault('SOURCE_RESTORE_SUPERSEDED','此来源已有较新的恢复操作，请核对最新记录。');
    const candidate=await hashRestorationStepSource(this.artifact(id,'candidate.step'),this.dataDir,{maxBytes:this.maxCandidateBytes});
    if(!equal(fileProof(candidate),record.candidate))throw fault('SOURCE_RESTORE_CANDIDATE_CHANGED','原候选文件已改变，不能重新认证为同一次上传。');
    const target=path.join(this.dataDir,record.targetRelative);
    if(!equal(await this.profile(target),record.before))throw fault('SOURCE_RESTORE_STALE','待恢复的现有文件已改变；请建立新的恢复操作以保留和复核新版本。');
    const proof=await this.proof.validate(target,candidate);record.proof={signature:proof.signature,referenceCount:proof.referenceCount,projects:proof.projects};delete record.errorCode;delete record.recovery;record.updatedAt=new Date().toISOString();this.save(record);return this.public(record);
  });}
  async transition(record,action){
    const id=record.operationId,target=path.join(this.dataDir,record.targetRelative);
    await this.checkProof(record);
    const start=action==='commit'?record.before:record.candidate,end=action==='commit'?record.candidate:record.before;
    if(!equal(await this.profile(target),start))throw fault('SOURCE_RESTORE_STALE','当前来源文件已改变，未覆盖其他程序或用户写入的内容。');
    if(equal(start,end)){
      record.state=action==='commit'?'committed':'rolled-back';record.changed=false;record.updatedAt=new Date().toISOString();this.save(record);return this.public(record);
    }
    if(record.attempts.length>=16)throw fault('SOURCE_RESTORE_LIMIT','此操作的替换尝试已达到预算，保留所有材料待复核。');
    const attempt={id:randomUUID(),action,start,end};
    if(end.status==='file'){
      attempt.stage='stage-'+attempt.id+'.step';const source=this.artifact(id,action==='commit'?'candidate.step':record.beforeArtifact);
      await this.copy(source,this.artifact(id,attempt.stage),end,{privateSource:true});
    }
    if(start.status==='file')attempt.backup='retained-'+attempt.id+'.step';
    record.attempts.push(attempt);record.state=action==='commit'?'activating':'reverting';delete record.errorCode;record.updatedAt=new Date().toISOString();this.save(record);
    try{
      // Parent creation happens only after the recoverable intent is durable.
      this.ensureDirectory(path.dirname(target));managedStepDestination(target,this.dataDir);
      if(!equal(await this.profile(target),start))throw fault('SOURCE_RESTORE_STALE','来源在文件替换前改变，未采用旧基线。');
      const result=await this.swap.swap({mode:end.status==='missing'?'retire':start.status==='missing'?'install':'replace',target,...(attempt.stage?{stage:this.artifact(id,attempt.stage)}:{}),...(attempt.backup?{backup:this.artifact(id,attempt.backup)}:{})});
      if(!result.ok)throw fault('SOURCE_RESTORE_FILE_OPERATION','Windows 未确认来源替换成功，正在核对保留文件。');
      if(!equal(await this.profile(target),end))throw fault('SOURCE_RESTORE_POSTCHECK','来源替换后的内容与候选证明不一致。');
      if(attempt.backup&&!equal(fileProof(await hashRestorationStepSource(this.artifact(id,attempt.backup),this.dataDir,{maxBytes:this.maxSourceBytes})),start))throw fault('SOURCE_RESTORE_BACKUP_MISMATCH','实际保留的旧文件与基线不同，须人工复核，未猜测回滚。');
      attempt.outcome='completed';record.state=action==='commit'?'committed':'rolled-back';record.changed=true;record.updatedAt=new Date().toISOString();this.save(record);return this.public(record);
    }catch(error){
      record.errorCode=typeof error.code==='string'?error.code:'SOURCE_RESTORE_FILE_OPERATION';
      await this.reconcile(record);return this.public(record);
    }
  }
  commit(id){return this.task(()=>this.gate.write(async()=>{const record=this.read(id);if(record.state==='committed'||record.state==='rolled-back')return this.public(record);if(record.state!=='prepared')throw fault('SOURCE_RESTORE_NOT_READY','此操作需要先恢复或复核，不能重复执行。');if(this.superseded(record))throw fault('SOURCE_RESTORE_SUPERSEDED','此来源已有较新的恢复操作，旧计划不能再提交。');return this.transition(record,'commit');}));}
  rollback(id){return this.task(()=>this.gate.write(async()=>{const record=this.read(id);if(record.state==='rolled-back')return this.public(record);if(record.state!=='committed'||record.changed!==true)throw fault('SOURCE_RESTORE_NOT_COMMITTED','此操作没有可回退的已提交来源替换。');if(this.superseded(record))throw fault('SOURCE_RESTORE_SUPERSEDED','此来源已有较新的恢复操作，不能用旧回退覆盖后续恢复。');return this.transition(record,'rollback');}));}
  async reconcile(record){
    const id=record.operationId,attempt=record.attempts.at(-1),target=path.join(this.dataDir,record.targetRelative);
    const priorPhase=record.attentionFrom||(['activating','reverting'].includes(record.state)?record.state:attempt?.action==='rollback'?'reverting':'activating');
    try{
      if(!attempt)throw fault('SOURCE_RESTORE_RECORD_INVALID','缺少待恢复的文件阶段。');
      const current=await this.profile(target);
      if(!equal(current,attempt.start)){
        if(!equal(current,attempt.end)&&current.status!=='missing')throw fault('SOURCE_RESTORE_EXTERNAL_CHANGE','来源出现未记录的内容，不能覆盖或猜测恢复。');
        // A native retained file certifies what was actually displaced, not
        // merely what a pre-operation copy happened to observe earlier.
        if(attempt.start.status==='file'){
          if(!attempt.backup||!equal(fileProof(await hashRestorationStepSource(this.artifact(id,attempt.backup),this.dataDir,{maxBytes:this.maxSourceBytes})),attempt.start))throw fault('SOURCE_RESTORE_BACKUP_MISMATCH','不能核对文件替换时实际保留的旧版本。');
          attempt.recoveryStage='recovery-stage-'+randomUUID()+'.step';
          await this.copy(this.artifact(id,attempt.backup),this.artifact(id,attempt.recoveryStage),attempt.start,{privateSource:true});
        }
        if(current.status==='file')attempt.recoveryBackup='recovery-retained-'+randomUUID()+'.step';
        this.save(record);
        const result=await this.swap.swap({mode:attempt.start.status==='missing'?'retire':current.status==='missing'?'install':'replace',target,...(attempt.recoveryStage?{stage:this.artifact(id,attempt.recoveryStage)}:{}),...(attempt.recoveryBackup?{backup:this.artifact(id,attempt.recoveryBackup)}:{})});
        if(!result.ok||!equal(await this.profile(target),attempt.start))throw fault('SOURCE_RESTORE_RECOVERY_FAILED','来源文件回退未完成，材料全部保留。');
        if(attempt.recoveryBackup&&!equal(fileProof(await hashRestorationStepSource(this.artifact(id,attempt.recoveryBackup),this.dataDir,{maxBytes:this.maxSourceBytes})),current))throw fault('SOURCE_RESTORE_BACKUP_MISMATCH','回退时实际保留文件与核对结果不同。');
      }
      attempt.outcome='recovered';record.state=attempt.action==='commit'?'prepared':'committed';delete record.attentionFrom;record.recovery='已核对并恢复到此次文件操作之前；未自动继续建模或再次提交。';record.updatedAt=new Date().toISOString();this.save(record);
    }catch(error){record.state='attention';record.attentionFrom=priorPhase;record.errorCode=typeof error.code==='string'?error.code:'SOURCE_RESTORE_RECOVERY_FAILED';record.recovery='来源恢复未能安全完成，全部材料保留，须人工复核。';record.updatedAt=new Date().toISOString();this.save(record);}
  }
  review(id){return this.task(()=>this.gate.write(async()=>{
    const record=this.read(id);if(record.state!=='attention'||this.superseded(record))throw fault('SOURCE_RESTORE_NOT_READY','只能重新核对当前待复核来源事务。');
    if(['committed','rolled-back'].includes(record.attentionFrom)){
      const expected=record.attentionFrom==='committed'?record.candidate:record.before;
      if(!equal(await this.profile(path.join(this.dataDir,record.targetRelative)),expected))throw fault('SOURCE_RESTORE_EXTERNAL_CHANGE','当前文件仍不是记录中已完成的版本；没有覆盖任何文件，请保留材料并恢复正确版本后重查。');
      record.state=record.attentionFrom;delete record.attentionFrom;delete record.errorCode;record.updatedAt=new Date().toISOString();this.save(record);
    }else if(['activating','reverting'].includes(record.attentionFrom)){record.state=record.attentionFrom;await this.reconcile(record);}
    else throw fault('SOURCE_RESTORE_RECORD_INVALID','待复核记录缺少原阶段证据，不能猜测执行。');
    return this.public(record);
  }));}
  recover(){return this.task(()=>this.gate.write(async()=>{
    const directory=path.join(this.dataDir,'source-restores');if(!fs.existsSync(directory))return [];
    this.budget();
    const records=this.records(),results=[];
    for(const record of records){
      if(['activating','reverting','attention'].includes(record.state)&&this.superseded(record,records))throw fault('SOURCE_RESTORE_RECORD_INVALID','较新恢复覆盖了未完成事务，须人工核对记录顺序。');
      if(['activating','reverting'].includes(record.state))await this.reconcile(record);
      else if(!this.superseded(record,records)&&(record.state==='committed'||record.state==='rolled-back')){
        const expected=record.state==='committed'?record.candidate:record.before;
        if(!equal(await this.profile(path.join(this.dataDir,record.targetRelative)),expected)){record.attentionFrom=record.state;record.state='attention';record.errorCode='SOURCE_RESTORE_EXTERNAL_CHANGE';record.updatedAt=new Date().toISOString();this.save(record);}
      }
      results.push(this.public(record));
    }
    return results;
  }));}
  async close(){this.closing=true;if(this.active)await this.active;}
}
