import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {managedStepDestination,restorationStepPath,hashRestorationStepSource} from './step-source-integrity.mjs';
import {captureRestorationMaterials} from './source-restoration-catalog.mjs';

const idPattern=/^restore-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const documentPattern=/^[A-Za-z0-9_-]{1,64}$/;
const requestPhases=new Set(['receiving','validating','committing','rolling-back','reviewing','revalidating','abandoning','settled','failed','interrupted']);
const safeNames=new Set(['SourceRestoreProofError','SourceRestoreTransactionError','SourceSwapError','SourceCatalogError','SourceAuditError','StepSourceError','SourceInspectionError','SourceRestoreServiceError']);
export class SourceRestoreServiceError extends Error{constructor(code,message){super(message);this.name='SourceRestoreServiceError';this.code=code;}}
const fault=(code,message)=>new SourceRestoreServiceError(code,message);
export function sourceRestoreFailure(error){return {code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:'SOURCE_RESTORE_FAILED',error:safeNames.has(error?.name)&&typeof error.message==='string'?error.message.slice(0,600):'来源恢复操作未完成，原材料保留。请查询原操作记录，不要直接重复提交。'};}
const date=()=>new Date().toISOString();

/** Durable request admission and bounded asynchronous orchestration. The
 * transaction record remains the authority for every actual file mutation. */
export class SourceRestoreService{
  constructor({dataDir,transactions,resolveAsset,maxUploadBytes=50*1024*1024,maxOperations=1000,uploadTimeoutMs=60000}={}){
    Object.assign(this,{dataDir:path.resolve(dataDir),transactions,resolveAsset,maxUploadBytes,maxOperations,uploadTimeoutMs});
    this.active=null;this.closed=false;this.blocking=null;
  }
  checkId(id){if(!idPattern.test(id))throw fault('SOURCE_RESTORE_ID','来源恢复操作身份无效。');return id;}
  requestPath(id){return path.join(this.transactions.directory(this.checkId(id)),'request.json');}
  readRequest(id,{optional=false}={}){
    const file=this.requestPath(id);this.transactions.artifact(id,'candidate.step');let fd;
    try{
      const entry=fs.lstatSync(file,{bigint:true});if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1n||entry.size>32768n)throw fault('SOURCE_RESTORE_RECORD_INVALID','来源上传记录类型或大小无效。');
      fd=fs.openSync(file,'r');const before=fs.fstatSync(fd,{bigint:true}),buffer=Buffer.alloc(32769);let size=0;
      if(['dev','ino','size','mtimeNs','ctimeNs'].some(key=>entry[key]!==before[key]))throw fault('SOURCE_RESTORE_RECORD_INVALID','来源上传记录在打开时变化。');
      while(size<buffer.length){const count=fs.readSync(fd,buffer,size,buffer.length-size,null);if(!count)break;size+=count;}
      const after=fs.fstatSync(fd,{bigint:true}),current=fs.lstatSync(file,{bigint:true});
      if(size>32768||BigInt(size)!==before.size||current.isSymbolicLink()||current.nlink!==1n||['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]||before[key]!==current[key]))throw fault('SOURCE_RESTORE_RECORD_INVALID','来源上传记录在读取时变化。');
      let value;try{value=JSON.parse(buffer.subarray(0,size).toString('utf8'));}catch{throw fault('SOURCE_RESTORE_RECORD_INVALID','来源上传记录损坏，原材料保留。');}
      if(value?.version!==1||value.operationId!==id||!['storage','current-undo-redo'].includes(value.scope)||!(value.documentId==='@storage'||documentPattern.test(value.documentId))||value.scope==='storage'&&value.documentId!=='@storage'||value.scope==='current-undo-redo'&&value.documentId==='@storage'||!requestPhases.has(value.phase)||typeof value.uploadComplete!=='boolean'||typeof value.targetRelative!=='string'||path.isAbsolute(value.targetRelative)||value.targetRelative!==path.relative(this.dataDir,path.resolve(this.dataDir,value.targetRelative))||typeof value.fileName!=='string'||value.fileName.length>240||typeof value.createdAt!=='string'||typeof value.updatedAt!=='string')throw fault('SOURCE_RESTORE_RECORD_INVALID','来源上传记录结构无效。');
      managedStepDestination(path.join(this.dataDir,value.targetRelative),this.dataDir);return value;
    }catch(error){if(error.code==='ENOENT'&&optional)return null;throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  persist(record){
    const directory=this.transactions.directory(record.operationId);this.transactions.ensureDirectory(directory);
    const file=this.requestPath(record.operationId),temporary=path.join(directory,'request-'+randomUUID()+'.tmp');
    if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw fault('SOURCE_RESTORE_RECORD_INVALID','上传记录不是独立普通文件。');}
    const bytes=Buffer.from(JSON.stringify(record));if(bytes.length>32768)throw fault('SOURCE_RESTORE_LIMIT','来源上传记录超出预算。');this.transactions.budget(bytes.length);
    const fd=fs.openSync(temporary,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);
  }
  ids(){
    const root=path.join(this.dataDir,'source-restores');if(!fs.existsSync(root))return [];
    const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw fault('SOURCE_RESTORE_RECORD_INVALID','来源恢复区不能是链接或文件。');
    const entries=fs.readdirSync(root,{withFileTypes:true});if(entries.length>this.maxOperations)throw fault('SOURCE_RESTORE_LIMIT','来源恢复操作数超过预算，旧材料未删除。');
    return entries.map(entry=>{if(!entry.isDirectory()||!idPattern.test(entry.name))throw fault('SOURCE_RESTORE_RECORD_INVALID','恢复区存在未知或异常目录。');return entry.name;});
  }
  refreshBlocking(){
    try{const records=this.transactions.records();const record=records.find(item=>['activating','reverting','attention'].includes(item.state));this.blocking=record?{code:'SOURCE_RESTORE_RECOVERY_REQUIRED',operationId:record.operationId,error:'有未完成或待复核的来源文件事务，建模和工程导出暂时阻断；来源检查与恢复记录仍可查看。'}:null;}
    catch(error){this.blocking={...sourceRestoreFailure(error),code:'SOURCE_RESTORE_RECORD_INVALID'};}
  }
  async initialize(){
    try{
      await this.transactions.recover();
      const records=this.transactions.records();
      for(const id of this.ids()){
        const request=this.readRequest(id,{optional:true});if(!request)continue;
        if(!['settled','failed','interrupted'].includes(request.phase)){
          const record=records.find(item=>item.operationId===id);
          if(record&&['committed','rolled-back','abandoned'].includes(record.state)){request.phase='settled';delete request.errorCode;delete request.error;}
          else{request.phase='interrupted';request.errorCode=request.uploadComplete?'SOURCE_RESTORE_RECHECK_REQUIRED':'SOURCE_RESTORE_UPLOAD_INTERRUPTED';request.error=request.uploadComplete?'后台曾在处理此操作时退出；请查询事务状态，未提交候选需要显式重新校验。':'上传未确认完成，保留已接收材料；请使用新的操作重新选择原始文件。';}
          request.updatedAt=date();this.persist(request);
        }
      }
      this.refreshBlocking();
    }catch(error){this.blocking={...sourceRestoreFailure(error),code:'SOURCE_RESTORE_RECOVERY_REQUIRED'};}
    return this.health();
  }
  health(){return {blocked:Boolean(this.blocking),active:this.active?{operationId:this.active.id,action:this.active.action}:null,...(this.blocking?{diagnostic:this.blocking}:{})};}
  catalogEvidence(options){return captureRestorationMaterials(this,options);}
  assertModelAccess(){if(this.blocking)throw fault('SOURCE_RESTORE_RECOVERY_REQUIRED',this.blocking.error);}
  assertIdle(){if(this.closed)throw fault('SERVICE_STOPPING','后台正在停止，未接收来源恢复操作。');if(this.active)throw fault('SOURCE_RESTORE_BUSY','另一个来源恢复操作仍在执行，请查询原操作，不要重复提交。');}
  describe(id,records=this.transactions.records()){
    const request=this.readRequest(id,{optional:true}),record=records.find(item=>item.operationId===id);
    if(!request&&!record)throw fault('SOURCE_RESTORE_NOT_FOUND','来源恢复操作不存在。');
    const summary=record?this.transactions.public(record,records):{version:1,operationId:id,state:request.abandoned?'abandoned':request.phase,fileName:request.fileName,createdAt:request.createdAt,updatedAt:request.updatedAt,referenceCount:0,projects:[],before:null,candidate:null,changed:null,errorCode:request.errorCode||null,recovery:null,supersededBy:null,blocking:false,canCommit:false,canRollback:false};
    const running=this.active?.id===id;
    return {...summary,documentId:request?.documentId||'@storage',scope:request?.scope||'storage',phase:running?this.active.action:summary.state,uploadComplete:request?.uploadComplete??true,requestErrorCode:request?.errorCode||null,requestError:request?.error||null,serviceBusy:Boolean(this.active),serviceBlocked:Boolean(this.blocking),canCommit:summary.canCommit&&!this.active&&!this.blocking,canRollback:summary.canRollback&&!this.active&&!this.blocking,canRevalidate:!this.active&&!this.blocking&&!summary.supersededBy&&(record?record.state==='prepared':request.uploadComplete&&!request.abandoned),canAbandon:!this.active&&(record?record.state==='prepared':Boolean(request&&!request.abandoned)),canReview:!this.active&&record?.state==='attention',materials:this.materials(record,request)};
  }
  materials(record,request){
    const roles=[],id=record?.operationId||request?.operationId;
    const add=(role,label,name,required=true)=>{const available=fs.existsSync(this.transactions.artifact(id,name));if(required||available)roles.push({role,label,available});};
    if(request?.uploadComplete||record)add('candidate','上传的候选 STEP','candidate.step');
    if(record?.beforeArtifact)add('before','操作前保留副本',record.beforeArtifact);
    record?.attempts.forEach((attempt,index)=>{if(attempt.backup)add(`retained-${index+1}`,`第 ${index+1} 次替换实际移出版本`,attempt.backup,attempt.outcome==='completed');if(attempt.recoveryBackup)add(`recovery-${index+1}`,`第 ${index+1} 次回退实际移出版本`,attempt.recoveryBackup,false);});
    return roles;
  }
  get(id){this.checkId(id);return this.describe(id);}
  list({documentId='@storage',offset=0,limit=50}={}){
    if(documentId!=='@storage'&&!documentPattern.test(documentId)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw fault('SOURCE_RESTORE_ARGUMENTS','恢复记录筛选或分页参数无效。');
    const records=this.transactions.records(),items=[];
    for(const id of this.ids()){
      const request=this.readRequest(id,{optional:true}),record=records.find(item=>item.operationId===id);if(!request&&!record)continue;
      if(documentId!=='@storage'&&request?.documentId!==documentId&&!record?.proof.projects.includes(documentId))continue;
      items.push({id,createdAt:request?.createdAt||record.createdAt});
    }
    items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    return {items:items.slice(offset,offset+limit).map(item=>this.describe(item.id,records)),total:items.length,offset,limit,health:this.health()};
  }
  settle(request,error){
    request.phase=error?'failed':'settled';request.updatedAt=date();delete request.error;delete request.errorCode;
    if(error){const failure=sourceRestoreFailure(error);request.errorCode=failure.code;request.error=failure.error;}
    this.persist(request);
  }
  run(request,action,work){
    this.assertIdle();const active={id:request.operationId,action,promise:null};this.active=active;
    request.phase=({prepare:'validating',commit:'committing',rollback:'rolling-back',revalidate:'revalidating',review:'reviewing',abandon:'abandoning'})[action];request.updatedAt=date();delete request.error;delete request.errorCode;
    try{this.persist(request);}catch(error){this.active=null;throw error;}
    active.promise=Promise.resolve().then(work).then(()=>this.settle(request),error=>this.settle(request,error)).catch(error=>{this.blocking={...sourceRestoreFailure(error),code:'SOURCE_RESTORE_RECORD_INVALID'};}).finally(()=>{
      const prior=this.blocking;this.refreshBlocking();if(prior?.code==='SOURCE_RESTORE_RECORD_INVALID')this.blocking=prior;if(this.active===active)this.active=null;
    });
    return this.get(request.operationId);
  }
  async upload(id,metadata,readable){
    this.checkId(id);this.assertIdle();this.assertModelAccess();
    const {scope,documentId,auditJobId,assetId,fileName}=metadata;
    if(!['storage','current-undo-redo'].includes(scope)||!(documentId==='@storage'||documentPattern.test(documentId))||scope==='storage'&&documentId!=='@storage'||scope==='current-undo-redo'&&documentId==='@storage'||typeof fileName!=='string'||fileName.length>240||fileName!==path.basename(fileName)||/[\x00-\x1f]/.test(fileName)||! /\.(?:step|stp)$/i.test(fileName))throw fault('SOURCE_RESTORE_ARGUMENTS','请选择有效的原始 STEP 文件与来源检查范围。');
    if(this.ids().includes(id)||this.ids().length>=this.maxOperations)throw fault('SOURCE_RESTORE_EXISTS','操作身份已存在或已达保留数量限制；请查询原记录，不会再次上传。');
    const binding=this.resolveAsset({scope,documentId,auditJobId,assetId}),now=date();
    const request={version:1,operationId:id,scope,documentId,auditJobId,assetId,fileName,targetRelative:path.relative(this.dataDir,binding.target),phase:'receiving',uploadComplete:false,createdAt:now,updatedAt:now};
    const active={id,action:'upload',promise:null,readable};this.active=active;let handle,timer;
    // A stop can destroy the stream while its file is still opening, before
    // for-await installs its error listener. Retain a guard through actual
    // stream close; the iterator still observes the stored stream error.
    const guardError=()=>{};readable.on('error',guardError);readable.once('close',()=>readable.off('error',guardError));
    const received=(async()=>{
      try{
        this.persist(request);const candidate=this.transactions.artifact(id,'candidate.step');
        handle=await fs.promises.open(candidate,'wx');let total=0;const retained=this.transactions.budget().bytes;
        timer=setTimeout(()=>readable.destroy?.(fault('SOURCE_RESTORE_UPLOAD_INTERRUPTED','来源上传超过时间预算，未执行文件恢复。')),this.uploadTimeoutMs);
        for await(const chunk of readable){
          if(this.closed)throw fault('SERVICE_STOPPING','后台正在停止，来源上传未完成。');const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=bytes.length;
          if(total>this.maxUploadBytes)throw fault('SOURCE_RESTORE_UPLOAD_TOO_LARGE','来源候选文件超过上传大小预算。');
          // This service owns the sole accepted source writer during upload.
          // Count its bytes incrementally, rather than stat every retained file
          // for every network chunk; re-scan before accepting the complete file.
          if(retained+total>this.transactions.maxRetainedBytes)throw fault('SOURCE_RESTORE_LIMIT','上传将超过恢复材料累计保留预算。');await handle.writeFile(bytes);
        }
        if(total<1)throw fault('SOURCE_RESTORE_UPLOAD_EMPTY','不能使用空文件恢复来源。');
        await handle.sync();const opened=await handle.stat({bigint:true}),current=fs.lstatSync(restorationStepPath(candidate,this.dataDir),{bigint:true});
        if(opened.nlink!==1n||['dev','ino','size','mtimeNs','ctimeNs'].some(key=>opened[key]!==current[key])||opened.size!==BigInt(total))throw fault('SOURCE_RESTORE_CANDIDATE_CHANGED','候选路径在上传期间改变，未认证该文件。');
        await handle.close();handle=null;clearTimeout(timer);this.transactions.budget();request.uploadComplete=true;request.phase='validating';request.updatedAt=date();this.persist(request);
      }finally{clearTimeout(timer);await handle?.close();}
    })();
    // Keep the same admitted request alive after upload. Disconnecting its HTTP
    // response does not cancel accepted validation or resubmit its candidate.
    active.promise=received.then(()=>{active.action='prepare';return this.transactions.prepare({operationId:id,target:binding.target});}).then(()=>this.settle(request),error=>this.settle(request,error)).catch(error=>{this.blocking={...sourceRestoreFailure(error),code:'SOURCE_RESTORE_RECORD_INVALID'};}).finally(()=>{const prior=this.blocking;this.refreshBlocking();if(prior?.code==='SOURCE_RESTORE_RECORD_INVALID')this.blocking=prior;if(this.active===active)this.active=null;});
    await received;
    return this.get(id);
  }
  action(id,action){
    this.checkId(id);this.assertIdle();if(!['commit','rollback','revalidate','abandon','review'].includes(action))throw fault('SOURCE_RESTORE_ARGUMENTS','来源恢复动作无效。');
    if(action!=='review')this.assertModelAccess();
    let request=this.readRequest(id,{optional:true});const record=this.transactions.records().find(item=>item.operationId===id);
    if(!request&&!record)throw fault('SOURCE_RESTORE_NOT_FOUND','来源恢复操作不存在。');
    request ||= {version:1,operationId:id,scope:'storage',documentId:'@storage',fileName:path.basename(record.targetRelative),targetRelative:record.targetRelative,phase:'settled',uploadComplete:true,createdAt:record.createdAt,updatedAt:date()};
    if(!record&&action==='abandon'){request.abandoned=true;return this.run(request,'abandon',()=>{});}
    if(!record&&action!=='revalidate')throw fault('SOURCE_RESTORE_NOT_READY','候选尚未通过完整校验，不能执行恢复。');
    if(!record&&(!request.uploadComplete||request.abandoned))throw fault('SOURCE_RESTORE_REUPLOAD_REQUIRED','上传未确认完整或已放弃，请使用新操作重新上传原文件。');
    return this.run(request,action,()=>record?this.transactions[action](id):this.transactions.prepare({operationId:id,target:path.join(this.dataDir,request.targetRelative)}));
  }
  async download(id,role,response){
    const summary=this.get(id),record=this.transactions.records().find(item=>item.operationId===id);
    if(!summary.materials.some(item=>item.role===role))throw fault('SOURCE_RESTORE_FILE_NOT_FOUND','此恢复材料不存在。');
    const index=Number(role.split('-')[1])-1,name=role==='candidate'?'candidate.step':role==='before'?record.beforeArtifact:role.startsWith('retained-')?record.attempts[index].backup:record.attempts[index].recoveryBackup;
    const file=this.transactions.artifact(id,name),proof=await hashRestorationStepSource(file,this.dataDir,{maxBytes:this.transactions.maxSourceBytes}),handle=await fs.promises.open(file,'r');
    try{
      const stamp=stat=>['dev','ino','size','mtimeNs','ctimeNs'].map(key=>stat[key].toString()).join(':');
      if(stamp(await handle.stat({bigint:true}))!==proof.stamp)throw fault('SOURCE_RESTORE_FILE_CHANGED','恢复材料在下载前发生变化。');
      response.writeHead(200,{'Content-Type':'application/step','Content-Disposition':`attachment; filename="${role}.step"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':proof.sha256});
      const hash=createHash('sha256');let size=0;
      for await(const chunk of handle.createReadStream({highWaterMark:1024*1024,autoClose:false})){
        hash.update(chunk);size+=chunk.length;if(size>proof.size)throw fault('SOURCE_RESTORE_FILE_CHANGED','恢复材料在下载时增长。');
        if(response.destroyed)throw fault('SOURCE_RESTORE_DOWNLOAD_CLOSED','恢复材料下载已关闭。');
        if(!response.write(chunk))await new Promise((resolve,reject)=>{const clean=()=>{response.off('drain',drained);response.off('close',closed);};const drained=()=>{clean();resolve();};const closed=()=>{clean();reject(fault('SOURCE_RESTORE_DOWNLOAD_CLOSED','恢复材料下载已关闭。'));};response.once('drain',drained);response.once('close',closed);if(response.destroyed)closed();});
      }
      if(size!==proof.size||hash.digest('hex')!==proof.sha256||stamp(await handle.stat({bigint:true}))!==proof.stamp)throw fault('SOURCE_RESTORE_FILE_CHANGED','恢复材料在下载期间改变，未完成响应。');response.end();
    }catch(error){if(response.headersSent)response.destroy();throw error;}finally{await handle.close();}
  }
  async close(){this.closed=true;if(this.active?.action==='upload')this.active.readable?.destroy?.(fault('SERVICE_STOPPING','后台停止，来源上传已中断。'));if(this.active?.promise)await this.active.promise;await this.transactions.close();}
}
