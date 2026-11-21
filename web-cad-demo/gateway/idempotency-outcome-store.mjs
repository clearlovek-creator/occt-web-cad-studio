import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const DOCUMENT=/^[A-Za-z0-9_-]{1,64}$/;
const FILE=/^outcome-([a-f0-9]{64})\.json$/;
export class IdempotencyOutcomeError extends Error {
  constructor(message){super(message);this.name='IdempotencyOutcomeError';this.code='IDEMPOTENCY_RESULT_UNAVAILABLE';}
}

/** Immutable outcomes. Manifests retain metadata only; replay never re-executes a missing outcome. */
export class IdempotencyOutcomeStore {
  constructor(historyRoot,{maxBytes=256*1024*1024}={}){this.root=path.resolve(historyRoot);this.maxBytes=maxBytes;}
  directory(documentId){if(!DOCUMENT.test(documentId))throw new IdempotencyOutcomeError('Invalid outcome document ID.');return path.join(this.root,documentId,'outcomes');}
  assertDirectory(documentId,create=false){
    const directory=this.directory(documentId),parent=path.dirname(directory);
    for(const target of [parent,directory]){
      if(create&&!fs.existsSync(target))fs.mkdirSync(target,{recursive:true});
      const stat=fs.lstatSync(target);if(!stat.isDirectory()||stat.isSymbolicLink())throw new IdempotencyOutcomeError('幂等结果目录类型异常，已停止读写。');
    }
    return directory;
  }
  reference(value){
    if(!value||value.version!==1||!FILE.test(value.file)||typeof value.sha256!=='string'||value.file!==`outcome-${value.sha256}.json`||!Number.isSafeInteger(value.bytes)||value.bytes<2||value.bytes>this.maxBytes)throw new IdempotencyOutcomeError('幂等结果索引无效，未重新执行原命令。');
    return {version:1,file:value.file,sha256:value.sha256,bytes:value.bytes};
  }
  readBytes(documentId,reference){
    const ref=this.reference(reference),file=path.join(this.assertDirectory(documentId),ref.file);
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==ref.bytes)throw new IdempotencyOutcomeError('幂等结果文件类型或长度异常，未重新执行原命令。');
    const bytes=fs.readFileSync(file);
    if(bytes.length!==ref.bytes||createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw new IdempotencyOutcomeError('幂等结果完整性校验失败，未重新执行原命令。');
    return bytes;
  }
  write(documentId,response){
    if(!response||typeof response!=='object'||Array.isArray(response))throw new IdempotencyOutcomeError('幂等结果必须是完整 JSON 对象，未提交修改。');
    const text=JSON.stringify(response),bytes=Buffer.byteLength(text??'');
    if(!text||bytes<2||bytes>this.maxBytes)throw new IdempotencyOutcomeError('完整命令结果超过持久化限制，未提交本次修改。');
    const sha256=createHash('sha256').update(text).digest('hex'),ref={version:1,file:`outcome-${sha256}.json`,sha256,bytes};
    const directory=this.assertDirectory(documentId,true),file=path.join(directory,ref.file);
    if(fs.existsSync(file)){this.readBytes(documentId,ref);return ref;}
    const temporary=path.join(directory,`.pending-${randomUUID()}.tmp`);let fd;
    try{
      fd=fs.openSync(temporary,'wx');fs.writeFileSync(fd,text);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      // A hard link publishes without overwriting an existing immutable result.
      try{fs.linkSync(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;this.readBytes(documentId,ref);}
    }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
    return ref;
  }
  storeEntry(documentId,entry){
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry.key!=='string'||!entry.key)throw new IdempotencyOutcomeError('幂等记录缺少请求键。');
    const {response,responseRef,...metadata}=entry;
    if(response!==undefined)return {...metadata,responseRef:this.write(documentId,response)};
    return {...metadata,responseRef:this.reference(responseRef)};
  }
  read(documentId,entry){
    if(Object.hasOwn(entry,'response'))return entry.response; // Legacy manifests are migrated on the next successful write.
    try{const response=JSON.parse(this.readBytes(documentId,entry.responseRef));if(!response||typeof response!=='object'||Array.isArray(response))throw new IdempotencyOutcomeError('已保存命令结果不是有效对象，未重新执行。');return response;}
    catch(error){if(error instanceof IdempotencyOutcomeError)throw error;throw new IdempotencyOutcomeError('无法读取已提交命令的完整结果，未重新执行。请保留工程数据并检查存储：'+error.message);}
  }
  cleanup(documentId,entries){
    const directory=this.directory(documentId);if(!fs.existsSync(directory))return;this.assertDirectory(documentId);
    const referenced=new Set(entries.filter(entry=>entry.responseRef).map(entry=>this.reference(entry.responseRef).file));
    for(const item of fs.readdirSync(directory,{withFileTypes:true})){
      if(!item.isFile()||(!FILE.test(item.name)&&!/^\.pending-[a-f0-9-]{36}\.tmp$/.test(item.name))||referenced.has(item.name))continue;
      fs.rmSync(path.join(directory,item.name),{force:true});
    }
  }
}
