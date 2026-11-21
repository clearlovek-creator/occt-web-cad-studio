import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {managedStepPath,managedStepDestination,restorationStepPath,hashManagedStepSource,hashRestorationStepSource,verifyStepSource} from './step-source-integrity.mjs';
import {sourceArtifactStamp} from './source-checkpoint-catalog.mjs';

const active=job=>['queued','running','stopping'].includes(job.state);
const key=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const date=()=>new Date().toISOString();
export class SourceAuditError extends Error{constructor(code,message){super(message);this.name='SourceAuditError';this.code=code;}}
function sourceStamp(file,dataDir,retained=false){try{const stat=fs.lstatSync((retained?restorationStepPath:managedStepPath)(file,dataDir),{bigint:true});return ['dev','ino','size','mtimeNs','ctimeNs'].map(name=>stat[name].toString()).join(':');}catch{return null;}}
const label=file=>typeof file==='string'?path.basename(file).slice(0,240):'unknown.step';
function checkpointStamp(file){try{const stat=fs.lstatSync(file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink())return null;return ['dev','ino','size','mtimeNs','ctimeNs'].map(name=>stat[name].toString()).join(':');}catch{return null;}}

/** Bounded observations only: no source repair, rebinding, cleanup or CAD writes. */
export class SourceAuditService {
  constructor({dataDir,inspector,capture,signature,maxRecords=100,maxActive=2,maxReadBytes=512*1024*1024,maxCheckpoints=128,maxSources=1000,maxReferenceBytes=16*1024*1024,maxRetainedBytes=32*1024*1024,scope='current-undo-redo',activeRegistry=new Set()}={}){Object.assign(this,{dataDir,inspector,capture,signature,maxRecords,maxActive,maxReadBytes,maxCheckpoints,maxSources,maxReferenceBytes,maxRetainedBytes,scope,activeRegistry});this.jobs=new Map();this.latest=new Map();this.closed=false;}
  start(id){
    if(this.closed)throw new SourceAuditError('SERVICE_STOPPING','后台正在停止，未启动新的来源检查。');
    const previous=this.jobs.get(this.latest.get(id));if(previous&&active(previous))return this.public(previous);
    if(this.activeRegistry.size>=this.maxActive)throw new SourceAuditError('SOURCE_AUDIT_BUSY','来源检查已达并发上限，请等待原任务。');
    const job={jobId:'sources-'+randomUUID(),documentId:id,state:'queued',phase:'waiting',createdAt:date(),updatedAt:date(),completedCheckpoints:0,totalCheckpoints:0,assets:[],issues:[],watches:new Map(),restorationPaths:new Set(),snapshotWatches:new Map(),metadataWatches:new Map(),controller:new AbortController(),coverageComplete:true};this.activeRegistry.add(job);
    this.jobs.set(job.jobId,job);this.latest.set(id,job.jobId);job.promise=Promise.resolve().then(()=>this.run(job));
    for(const [jobId,item] of this.jobs)if(this.jobs.size>this.maxRecords&&!active(item)){this.jobs.delete(jobId);if(this.latest.get(item.documentId)===jobId)this.latest.delete(item.documentId);}
    return this.public(job);
  }
  check(job){if(this.closed||job.controller.signal.aborted)throw new SourceAuditError('SOURCE_AUDIT_CANCELLED','来源检查已停止，未修改几何和文件。');}
  issue(job,code,message,checkpoint){job.coverageComplete=false;if(job.issues.length<30)job.issues.push({code,message,checkpoint});}
  async run(job){
    try{
      if(this.scope==='storage'){job.state='running';job.phase='discovery';}
      const plan=await this.capture(job.documentId,{signal:job.controller.signal,onProgress:({entries})=>{this.check(job);job.catalogEntries=entries;job.updatedAt=date();}});this.check(job);Object.assign(job,{state:'running',phase:'checkpoints',stateToken:plan.stateToken,revision:plan.revision,signature:plan.signature,totalCheckpoints:plan.checkpoints.length,metadataWatches:plan.metadataWatches||new Map(),catalogEntries:plan.catalogEntries});
      if(plan.checkpoints.length>this.maxCheckpoints)throw new SourceAuditError('SOURCE_AUDIT_LIMIT','保留检查点超过本次检查预算，未截取部分结果假装完整。');
      for(const issue of plan.issues||[])this.issue(job,issue.code,issue.message,issue.checkpoint);
      if(plan.restoreError)this.issue(job,'SOURCE_HISTORY_UNAVAILABLE','历史恢复存在异常，引用范围不能视为完整。');
      const records=[];let referenceBytes=0;
      const record=reference=>{referenceBytes+=Buffer.byteLength(JSON.stringify(reference));if(referenceBytes>this.maxReferenceBytes||records.length>=100000)throw new SourceAuditError('SOURCE_AUDIT_LIMIT','来源引用数量或累计数据量超过检查预算。');records.push(reference);};
      if(!plan.checkpoints.length){if(plan.currentSources.length||plan.hasUnsnapshottedGeometry)this.issue(job,'SOURCE_NO_CHECKPOINT','当前模型缺少受管检查点，尚不能完整核对历史引用。');for(const ref of plan.currentSources)record({...ref,scope:'current',checkpoint:'未持久化'});}
      const checkpointGroups=new Map();for(const checkpoint of plan.checkpoints){if(!checkpointGroups.has(checkpoint.file))checkpointGroups.set(checkpoint.file,[]);checkpointGroups.get(checkpoint.file).push(checkpoint);}
      for(const group of checkpointGroups.values()){
        const checkpoint=group[0],proofs=[...new Set(group.map(item=>item.sha256).filter(Boolean))];
        this.check(job);
        job.snapshotWatches.set(checkpoint.file,checkpointStamp(checkpoint.file));
        if(proofs.length>1){this.issue(job,'SOURCE_CHECKPOINT_PROOF_CONFLICT','同一检查点存在互相冲突的内容证明，未采用其来源引用。',checkpoint.name);job.completedCheckpoints+=group.length;continue;}
        try{
          const stamp=checkpointStamp(checkpoint.file),inspected=await this.inspector.inspect(checkpoint.file,{expectedSha256:proofs[0],signal:job.controller.signal});this.check(job);if(stamp!==checkpointStamp(checkpoint.file))throw new SourceAuditError('SOURCE_SNAPSHOT_CHANGED','检查点在检查中发生变化。');job.snapshotWatches.set(checkpoint.file,stamp);
          for(const entry of group)if(!entry.sha256)this.issue(job,'SOURCE_CHECKPOINT_UNCERTIFIED','旧检查点缺少历史内容指纹。',entry.name);
          if(!inspected.metadataComplete)this.issue(job,'SOURCE_METADATA_UNAVAILABLE','检查点缺少来源元数据，未推断为没有依赖。',checkpoint.name);
          for(const entry of group)for(const ref of inspected.sources)record({...ref,scope:entry.scope,documentId:entry.documentId||(this.scope==='current-undo-redo'?job.documentId:undefined),checkpoint:entry.name,checkpointSha256:inspected.snapshotSha256});
        }catch(error){if(['SOURCE_INSPECTOR_STOP_UNCONFIRMED','SOURCE_AUDIT_LIMIT'].includes(error.code))throw error;this.check(job);this.issue(job,error.code||'SOURCE_CHECKPOINT_UNREADABLE','此检查点来源无法核对，原文件已保留。',checkpoint.name);}
        job.completedCheckpoints+=group.length;job.updatedAt=date();
      }
      this.check(job);job.phase='sources';const groups=new Map();
      for(const reference of records){const identity=typeof reference.sourcePath==='string'?reference.sourcePath:'missing:'+reference.featureId;if(!groups.has(identity))groups.set(identity,[]);groups.get(identity).push(reference);}
      for(const file of plan.looseSources||[])if(!groups.has(file))groups.set(file,[]);
      const retainedMaterials=new Map((plan.retainedSources||[]).map(item=>[item.file,item]));for(const file of retainedMaterials.keys())if(!groups.has(file))groups.set(file,[]);
      if(groups.size>this.maxSources)throw new SourceAuditError('SOURCE_AUDIT_LIMIT','来源文件数超过本次检查预算。');
      let total=0;
      for(const [file,references] of groups){
        this.check(job);const material=retainedMaterials.get(file),retainedOnly=Boolean(material),privateRead=retainedOnly&&!references.length;
        const projects=[...new Set([...references.map(item=>item.documentId),...(material?.projects||[])].filter(Boolean))].sort();
        const row={assetId:key(file),fileName:label(file),status:references.length?'verified':'unreferenced',referenceCount:references.length,currentReferences:references.filter(item=>item.scope==='current').length,undoReferences:references.filter(item=>item.scope==='undo').length,redoReferences:references.filter(item=>item.scope==='redo').length,recoveryReferences:references.filter(item=>item.scope==='recovery').length,quarantineReferences:references.filter(item=>item.scope==='quarantine').length,retainedReferences:references.filter(item=>item.scope==='retained').length,projectCount:projects.length,projects:projects.slice(0,20),references:[]};
        if(retainedOnly){Object.assign(row,{retainedOnly:true,operationId:material.operationId,materialRole:material.materialRole,materialLabel:material.materialLabel});if(privateRead)job.restorationPaths.add(file);else this.issue(job,'SOURCE_RESTORE_RESERVED_REFERENCE','建模检查点引用了私有恢复材料，不能将其作为正常来源认证。');}
        try{
          const source=await (privateRead?hashRestorationStepSource:hashManagedStepSource)(file,this.dataDir,{maxBytes:this.maxReadBytes-total,signal:job.controller.signal});total+=source.size;row.bytes=source.size;row.sha256=source.sha256;job.watches.set(file,source.stamp);
          if(privateRead&&material.expected)row.status=['size','sha256','fingerprint','algorithm'].every(key=>material.expected[key]===source[key])?'verified':'changed';
          for(const reference of references){let status='verified';try{status=verifyStepSource(reference,source);}catch(error){status=error.code==='PROJECT_SOURCE_CHANGED'?'changed':'unverified';}
            if(status==='changed')row.status='changed';else if(status!=='verified'&&row.status==='verified')row.status=status;
            if(row.references.length<20)row.references.push({featureId:reference.featureId,documentId:reference.documentId,scope:reference.scope,checkpoint:reference.checkpoint,status,featureState:reference.state||'valid'});
          }
        }catch(error){row.status=error.code==='PROJECT_SOURCE_MISSING'?'missing':error.code==='PROJECT_SOURCE_UNTRUSTED'?'untrusted':'unreadable';row.code=error.code||'SOURCE_READ_FAILED';for(const ref of references.slice(0,20))row.references.push({featureId:ref.featureId,documentId:ref.documentId,scope:ref.scope,checkpoint:ref.checkpoint,status:row.status,featureState:ref.state||'valid'});}
        if(!job.watches.has(file))job.watches.set(file,sourceStamp(file,this.dataDir,privateRead));job.assets.push(row);job.updatedAt=date();
        // Yield between source files. No complete source arrays are retained.
        await new Promise(resolve=>setImmediate(resolve));
      }
      this.check(job);job.state='complete';job.phase='complete';job.finishedAt=date();
    }catch(error){
      if(error.code==='SOURCE_INSPECTOR_STOP_UNCONFIRMED'){
        job.state='stopping';job.phase='stopping';job.code=error.code;job.error='只读检查进程尚未确认退出，不能报告已取消。';await error.exitObserved;job.state=job.controller.signal.aborted||this.closed?'cancelled':'failed';
      }else job.state=job.controller.signal.aborted||this.closed?'cancelled':'failed';
      job.phase=job.state;job.coverageComplete=false;job.code=error.code||'SOURCE_AUDIT_FAILED';job.error=job.state==='cancelled'?'检查已停止，没有修改几何、来源文件或绑定。':'来源检查未完成，原始文件保留；请检查诊断后重新发起只读检查。';job.finishedAt=date();
    }finally{job.updatedAt=date();this.activeRegistry.delete(job);this.retain(job);}
  }
  retain(job){
    const size=value=>Buffer.byteLength(JSON.stringify({assets:value.assets,issues:value.issues,watches:[...value.watches],restorationPaths:[...value.restorationPaths],snapshotWatches:[...value.snapshotWatches],metadataWatches:[...value.metadataWatches]}));
    job.retainedBytes=size(job);
    if(job.retainedBytes>this.maxRetainedBytes){job.assets=[];job.issues=[];job.watches.clear();job.restorationPaths.clear();job.snapshotWatches.clear();job.metadataWatches.clear();job.state='failed';job.phase='failed';job.coverageComplete=false;job.code='SOURCE_AUDIT_LIMIT';job.error='报告超过保留预算，未保留部分结果冒充完整检查。';job.retainedBytes=size(job);}
    let total=[...this.jobs.values()].reduce((sum,item)=>sum+(item.retainedBytes||0),0);
    for(const [id,item] of this.jobs)if(item!==job&&!active(item)&&(total>this.maxRetainedBytes||this.jobs.size>this.maxRecords)){this.jobs.delete(id);total-=item.retainedBytes||0;if(this.latest.get(item.documentId)===id)this.latest.delete(item.documentId);}
  }
  public(job){
    let stale=false;if(job.signature){try{stale=this.signature(job.documentId)!==job.signature;}catch{stale=true;}}
    if(!stale&&job.state==='complete')for(const [file,stamp] of job.watches)if(sourceStamp(file,this.dataDir,job.restorationPaths.has(file))!==stamp){stale=true;break;}
    if(!stale&&job.state==='complete')for(const [file,stamp] of job.snapshotWatches)if(checkpointStamp(file)!==stamp){stale=true;break;}
    if(!stale&&job.state==='complete')for(const [file,stamp] of job.metadataWatches)if(sourceArtifactStamp(file)!==stamp){stale=true;break;}
    return {jobId:job.jobId,documentId:job.documentId,state:job.state,phase:job.phase,createdAt:job.createdAt,updatedAt:job.updatedAt,finishedAt:job.finishedAt,revision:job.revision,stateToken:job.stateToken,completedCheckpoints:job.completedCheckpoints,totalCheckpoints:job.totalCheckpoints,coverageComplete:job.state==='complete'&&job.coverageComplete,integrityOK:!stale&&job.state==='complete'&&job.coverageComplete&&job.assets.every(item=>item.status==='verified'||this.scope==='storage'&&item.status==='unreferenced'),stale,scope:this.scope,catalogEntries:job.catalogEntries,cleanupAvailable:false,assets:structuredClone(job.assets),issues:structuredClone(job.issues),...(job.code?{code:job.code,error:job.error}:{})};
  }
  get(id){const job=this.jobs.get(this.latest.get(id));return job?this.public(job):null;}
  resolveAsset(id,jobId,assetId){
    const job=this.jobs.get(jobId);
    if(!job||job.documentId!==id||this.latest.get(id)!==jobId)throw new SourceAuditError('SOURCE_RESTORE_AUDIT_EXPIRED','来源检查已释放或不再是当前报告，请重新检查后选择来源。');
    const report=this.public(job),row=job.assets.find(item=>item.assetId===assetId);
    if(report.state!=='complete'||report.stale||!row||!['missing','changed'].includes(row.status)||row.referenceCount<1)throw new SourceAuditError('SOURCE_RESTORE_ASSET_NOT_READY','请选择未过期报告中缺失或内容变化、且确有建模引用的来源。');
    const matches=[...job.watches.keys()].filter(file=>key(file)===assetId);
    if(matches.length!==1)throw new SourceAuditError('SOURCE_RESTORE_ASSET_NOT_READY','来源身份不唯一，未采用该选择。');
    return {target:managedStepDestination(matches[0],this.dataDir),fileName:row.fileName};
  }
  cancel(id){const job=this.jobs.get(this.latest.get(id));if(job&&active(job)){job.state='stopping';job.phase='stopping';job.controller.abort();}return job?this.public(job):null;}
  async close(){this.closed=true;for(const job of this.jobs.values())if(active(job))job.controller.abort();await Promise.all([...this.jobs.values()].map(job=>job.promise));}
}
