import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const idPattern=/^[A-Za-z0-9_-]{1,64}$/,snapshotPattern=/^state-[0-9]+-[0-9]+-[0-9]+\.xbf$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const statStamp=stat=>['dev','ino','size','mtimeNs','ctimeNs'].map(key=>stat[key].toString()).join(':')+':'+(stat.isDirectory()?'directory':'file');
export class SourceCatalogError extends Error{constructor(code,message){super(message);this.name='SourceCatalogError';this.code=code;}}
export function sourceArtifactStamp(file){try{const stat=fs.lstatSync(file,{bigint:true});if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())return null;return statStamp(stat);}catch{return null;}}

/** Disk-only discovery. Never calls the model loader, history repair or cleanup. */
export class SourceCheckpointCatalog{
  constructor({dataDir,maxEntries=20000,maxCheckpoints=2048,maxSnapshotBytes=2*1024*1024*1024,maxJsonBytes=64*1024*1024,maxMetadataBytes=256*1024*1024}={}){Object.assign(this,{dataDir:path.resolve(dataDir),maxEntries,maxCheckpoints,maxSnapshotBytes,maxJsonBytes,maxMetadataBytes});}
  newPlan(){return {checkpoints:[],currentSources:[],looseSources:[],retainedSources:[],metadataWatches:new Map(),issues:[],metadataBytes:0,hasUnsnapshottedGeometry:false};}
  issue(plan,code,message,checkpoint){if(plan.issues.length<30)plan.issues.push({code,message,checkpoint});}
  safe(file){
    const relative=path.relative(this.dataDir,path.resolve(file));if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new SourceCatalogError('SOURCE_CATALOG_PATH','来源清点路径超出受管存储。');
    let current=this.dataDir;for(const part of ['',...relative.split(path.sep)]){current=part?path.join(current,part):current;try{const stat=fs.lstatSync(current);if(stat.isSymbolicLink())throw new SourceCatalogError('SOURCE_CATALOG_LINK','受管存储中存在链接，未跟随读取。');}catch(error){if(error.code==='ENOENT')break;throw error;}}
    return path.resolve(file);
  }
  async json(file,plan,binding){
    this.safe(file);const before=sourceArtifactStamp(file);plan.metadataWatches.set(file,before);
    const stat=await fs.promises.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>this.maxJsonBytes)throw new SourceCatalogError('SOURCE_CATALOG_METADATA','来源清单类型或大小不符合要求。');
    if(stat.size>this.maxMetadataBytes-plan.metadataBytes)throw new SourceCatalogError('SOURCE_AUDIT_LIMIT','清单累计读取量超出本次清点预算。');
    const handle=await fs.promises.open(file,'r');let bytes;
    try{
      const opened=await handle.stat({bigint:true});if(statStamp(opened)!==before)throw new SourceCatalogError('SOURCE_CATALOG_CHANGED','来源清单在打开时变化。');
      const chunks=[];let total=0;for await(const chunk of handle.createReadStream({highWaterMark:1024*1024,autoClose:false})){
        if(plan.signal?.aborted)throw new SourceCatalogError('SOURCE_AUDIT_CANCELLED','来源清点已停止。');total+=chunk.length;plan.metadataBytes+=chunk.length;if(total>this.maxJsonBytes||plan.metadataBytes>this.maxMetadataBytes)throw new SourceCatalogError('SOURCE_AUDIT_LIMIT','来源清单超过读取预算。');chunks.push(chunk);
      }
      if(statStamp(await handle.stat({bigint:true}))!==before||sourceArtifactStamp(file)!==before)throw new SourceCatalogError('SOURCE_CATALOG_CHANGED','来源清单在读取期间变化。');bytes=Buffer.concat(chunks,total);
    }finally{await handle.close();}
    if(binding&&(bytes.length!==binding.bytes||digest(bytes)!==binding.sha256))throw new SourceCatalogError('SOURCE_RECOVERY_CHECKSUM','恢复清单与事务记录不一致。');return JSON.parse(bytes.toString('utf8'));
  }
  add(plan,file,scope,documentId,sha256){
    this.safe(file);if(plan.checkpoints.some(item=>item.file===file&&item.scope===scope&&item.documentId===documentId&&item.sha256===sha256))return;
    if(plan.checkpoints.length>=this.maxCheckpoints)throw new SourceCatalogError('SOURCE_AUDIT_LIMIT','保留检查点超出来源清点预算，未截取部分结果假装完整。');
    plan.checkpoints.push({file,scope,documentId,name:(documentId?documentId+'/':'')+path.basename(file).slice(0,160),sha256});
  }
  manifest(plan,value,documentId,{scope,absolute=false}={}){
    if(!value||!absolute&&![1,2].includes(value.version)||!['current','undo','redo'].every(key=>key==='current'?value[key]===null||typeof value[key]==='string':Array.isArray(value[key]))||value.documentId!==undefined&&value.documentId!==documentId)throw new SourceCatalogError('SOURCE_MANIFEST_INVALID','工程来源清单结构无效。');
    const directory=path.join(this.dataDir,'history',documentId);
    for(const [kind,entries] of [['current',value.current?[value.current]:[]],['undo',value.undo],['redo',value.redo]])for(const entry of entries){
      if(typeof entry!=='string')throw new SourceCatalogError('SOURCE_MANIFEST_INVALID','工程检查点名称无效。');const file=absolute?path.resolve(entry):path.join(directory,entry);
      if(!snapshotPattern.test(path.basename(file))||path.dirname(file)!==directory||!absolute&&entry!==path.basename(entry))throw new SourceCatalogError('SOURCE_MANIFEST_INVALID','工程检查点引用超出所属目录。');
      const checksum=value.checksums?.[path.basename(file)];if(checksum!==undefined&&!/^[a-f0-9]{64}$/.test(checksum))throw new SourceCatalogError('SOURCE_MANIFEST_INVALID','工程检查点指纹无效。');
      this.add(plan,file,scope||kind,documentId,checksum);
    }
  }
  async project(documentId,{signal}={}){
    if(!idPattern.test(documentId))throw new SourceCatalogError('SOURCE_MANIFEST_INVALID','工程身份无效。');
    const plan=this.newPlan(),directory=path.join(this.dataDir,'history',documentId),manifest=path.join(directory,'manifest.json');plan.signal=signal;plan.metadataWatches.set(directory,sourceArtifactStamp(directory));
    try{this.manifest(plan,await this.json(manifest,plan),documentId);}catch(error){if(['SOURCE_AUDIT_LIMIT','SOURCE_AUDIT_CANCELLED'].includes(error.code))throw error;this.issue(plan,error.code||'SOURCE_MANIFEST_UNREADABLE','工程持久化来源清单无法完整读取，未加载或恢复几何。',documentId);}
    if(!plan.checkpoints.length)plan.hasUnsnapshottedGeometry=true;
    return plan;
  }
  async journal(plan,file,kind){
    const documentId=path.basename(file).replace(/\.pending\.json$/,'');if(!idPattern.test(documentId))throw new SourceCatalogError('SOURCE_RECOVERY_INVALID','恢复事务身份无效。');
    const journal=await this.json(file,plan);if(journal.documentId!==documentId||!['prepared','committed',...(kind==='project-transactions'?['rolled-back']:[])].includes(journal.phase))throw new SourceCatalogError('SOURCE_RECOVERY_INVALID','恢复事务元数据无效。');
    if(kind==='document-transactions'&&journal.version===2){
      const binding=journal.beforeManifest;if(!binding||typeof binding.file!=='string'||!new RegExp(`^${documentId}-[a-f0-9-]{36}\\.manifest\\.json$`).test(binding.file))throw new SourceCatalogError('SOURCE_RECOVERY_INVALID','恢复清单备份路径无效。');
      this.manifest(plan,await this.json(path.join(this.dataDir,kind,binding.file),plan,binding),documentId,{scope:'recovery'});
    }else if((journal.version===1||kind==='project-transactions'&&journal.version===2)&&journal.beforeHistory){
      // Terminal package-open journals only await cleanup. Old checkpoints may
      // already be pruned by later accepted edits; they are not recovery roots.
      this.manifest(kind==='project-transactions'&&journal.phase!=='prepared'?this.newPlan():plan,journal.beforeHistory,documentId,{scope:'recovery',absolute:true});
    }
    else throw new SourceCatalogError('SOURCE_RECOVERY_INVALID','恢复事务版本或来源清单不受支持。');
    if(kind==='project-transactions'){
      const rollback=journal.rollbackPath;if(typeof rollback!=='string'||path.dirname(path.resolve(rollback))!==path.join(this.dataDir,kind)||!new RegExp(`^rollback-${documentId}-[a-f0-9-]{36}\\.xbf$`).test(path.basename(rollback)))throw new SourceCatalogError('SOURCE_RECOVERY_INVALID','恢复快照路径无效。');
      const proof=journal.rollbackProof;if(journal.version===2&&(!proof||!Number.isSafeInteger(proof.bytes)||proof.bytes<32||proof.bytes>1024**3||typeof proof.sha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.sha256)))throw new SourceCatalogError('SOURCE_RECOVERY_INVALID','工程包恢复快照证明无效。');
      this.safe(rollback);if(journal.phase==='prepared'||sourceArtifactStamp(rollback))this.add(plan,path.resolve(rollback),journal.phase==='prepared'?'recovery':'retained',documentId,proof?.sha256);
    }
  }
  async storage({signal,onProgress=()=>{},includeRestorations=true}={}){
    const plan=this.newPlan(),files=[];plan.signal=signal;let entries=0,snapshotBytes=0;
    const walk=async(directory,kind,depth=0)=>{
      if(signal?.aborted)throw new SourceCatalogError('SOURCE_AUDIT_CANCELLED','来源清点已停止。');this.safe(directory);const stamp=sourceArtifactStamp(directory);plan.metadataWatches.set(directory,stamp);if(stamp===null){if(fs.existsSync(directory))this.issue(plan,'SOURCE_CATALOG_LINK','存储根目录含链接或异常类型，未跟随读取。',kind);return;}
      if(depth>8)throw new SourceCatalogError('SOURCE_AUDIT_LIMIT','受管来源目录层级超出预算。');
      const stream=await fs.promises.opendir(directory);
      for await(const entry of stream){
        if(signal?.aborted)throw new SourceCatalogError('SOURCE_AUDIT_CANCELLED','来源清点已停止。');if(++entries>this.maxEntries)throw new SourceCatalogError('SOURCE_AUDIT_LIMIT','存储条目超出来源清点预算。');if(entries%100===0)onProgress({entries});
        const file=path.join(directory,entry.name),stat=await fs.promises.lstat(file);
        if(stat.isSymbolicLink()){this.issue(plan,'SOURCE_CATALOG_LINK','存储中存在链接，未跟随读取。',entry.name.slice(0,200));continue;}
        if(stat.isDirectory())await walk(file,kind,depth+1);else if(stat.isFile()){
          files.push({file,kind});
          if(kind==='source-restores'&&['record.json','request.json'].includes(entry.name))plan.metadataWatches.set(file,sourceArtifactStamp(file));
          if(/\.xbf(?:-[a-f0-9]{64}\.corrupt)?$/i.test(entry.name)){snapshotBytes+=stat.size;if(snapshotBytes>this.maxSnapshotBytes)throw new SourceCatalogError('SOURCE_AUDIT_LIMIT','检查点累计大小超出本次来源清点预算。');}
        }else this.issue(plan,'SOURCE_CATALOG_FILE_TYPE','存储中存在不可核对的特殊条目。',entry.name.slice(0,200));
      }
    };
    for(const kind of ['history','history-quarantine','document-transactions','project-transactions','project-assets','imports',...(includeRestorations?['source-restores']:[])]){
      onProgress({entries});
      try{await walk(path.join(this.dataDir,kind),kind);}catch(error){if(['SOURCE_AUDIT_LIMIT','SOURCE_AUDIT_CANCELLED'].includes(error.code))throw error;this.issue(plan,error.code||'SOURCE_STORAGE_UNREADABLE','此存储区域无法完整清点，原文件保持不变。',kind);}
    }
    for(const {file,kind} of files){
      if(signal?.aborted)throw new SourceCatalogError('SOURCE_AUDIT_CANCELLED','来源清点已停止。');
      if(kind==='history'&&path.basename(file)==='manifest.json'){
        const documentId=path.basename(path.dirname(file));try{if(!idPattern.test(documentId)||path.dirname(path.dirname(file))!==path.join(this.dataDir,'history'))throw Error('unexpected manifest');this.manifest(plan,await this.json(file,plan),documentId);}catch(error){if(['SOURCE_AUDIT_LIMIT','SOURCE_AUDIT_CANCELLED'].includes(error.code))throw error;this.issue(plan,error.code||'SOURCE_MANIFEST_UNREADABLE','工程清单无法完整核对。',documentId);}
      }else if(['document-transactions','project-transactions'].includes(kind)&&file.endsWith('.pending.json')){
        try{await this.journal(plan,file,kind);}catch(error){if(['SOURCE_AUDIT_LIMIT','SOURCE_AUDIT_CANCELLED'].includes(error.code))throw error;this.issue(plan,error.code||'SOURCE_RECOVERY_UNREADABLE','恢复事务引用无法完整核对，未执行恢复。',path.basename(file));}
      }
    }
    for(const {file,kind} of files){
      if(signal?.aborted)throw new SourceCatalogError('SOURCE_AUDIT_CANCELLED','来源清点已停止。');
      const name=path.basename(file);
      if(kind==='source-restores')continue;
      if(/\.(?:step|stp)$/i.test(name)&&['imports','project-assets'].includes(kind)){plan.looseSources.push(file);continue;}
      if(!/\.xbf(?:-[a-f0-9]{64}\.corrupt)?$/i.test(name))continue;
      if(plan.checkpoints.some(item=>item.file===file))continue;
      const relative=path.relative(path.join(this.dataDir,kind),file).split(path.sep),first=relative[0];let documentId,scope='retained',checksum;
      if(['history','history-quarantine'].includes(kind)&&relative.length===2&&idPattern.test(first))documentId=first;
      if(kind==='project-assets'){const match=first.match(/^([A-Za-z0-9_-]{1,64})-[A-Za-z0-9]{6}$/);documentId=match?.[1];}
      if(kind==='history-quarantine'){scope='quarantine';checksum=name.match(/\.xbf-([a-f0-9]{64})\.corrupt$/i)?.[1]?.toLowerCase();}
      if(kind==='project-transactions'){scope='recovery';documentId=name.match(/^(?:rollback|export)-([A-Za-z0-9_-]{1,64})-[a-f0-9-]{36}\.xbf$/)?.[1];}
      this.add(plan,file,scope,documentId,checksum);
    }
    if(includeRestorations){
      const retained=files.filter(item=>item.kind==='source-restores');
      try{
        if(typeof this.restorationCapture==='function'){
          const evidence=await this.restorationCapture({files:retained,signal});
          if(evidence.metadataBytes>this.maxMetadataBytes-plan.metadataBytes)throw new SourceCatalogError('SOURCE_AUDIT_LIMIT','恢复记录累计读取量超出本次清点预算。');
          plan.metadataBytes+=evidence.metadataBytes;for(const [file,stamp] of evidence.metadataWatches)plan.metadataWatches.set(file,stamp);
          for(const issue of evidence.issues)this.issue(plan,issue.code,issue.message,issue.checkpoint);
          plan.retainedSources=evidence.materials;
        }else if(retained.length)this.issue(plan,'SOURCE_RESTORE_CATALOG_UNAVAILABLE','恢复材料存在，但其操作归属检查组件未提供，未认证材料归属。','source-restores');
      }catch(error){if(['SOURCE_AUDIT_LIMIT','SOURCE_AUDIT_CANCELLED'].includes(error.code))throw error;this.issue(plan,error.code||'SOURCE_RESTORE_CATALOG_UNREADABLE','恢复材料的操作记录无法完整核对，文件全部保留。','source-restores');}
      const known=new Set(plan.retainedSources.map(item=>item.file));
      for(const item of retained)if(/\.(?:step|stp)$/i.test(item.file)&&!known.has(item.file))plan.retainedSources.push({file:item.file,materialRole:'retained',materialLabel:'归属待核对的恢复材料',projects:[]});
    }
    plan.catalogEntries=entries;return plan;
  }
}
