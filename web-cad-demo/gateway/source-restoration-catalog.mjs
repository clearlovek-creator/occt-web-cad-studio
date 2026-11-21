import fs from 'node:fs';
import path from 'node:path';
import {SourceCatalogError,sourceArtifactStamp} from './source-checkpoint-catalog.mjs';

/** Describe retained repair bytes without treating them as CAD inputs or
 * invoking recovery. The modeling dependency proof explicitly excludes this
 * namespace so that its own staging cannot invalidate its reference graph. */
export function captureRestorationMaterials(service,{files=[],signal}={}){
  const materials=new Map(),metadataWatches=new Map(),issues=[];let metadataBytes=0;
  const issue=(code,message,checkpoint)=>{if(issues.length<30)issues.push({code,message,checkpoint});};
  const check=()=>{if(signal?.aborted)throw new SourceCatalogError('SOURCE_AUDIT_CANCELLED','来源清点已停止。');};
  check();const ids=service.ids(),records=service.transactions.records(),byId=new Map(records.map(record=>[record.operationId,record]));
  const observed=new Set(files.map(item=>item.file));
  if(service.active)issue('SOURCE_RESTORE_ACTIVE','来源恢复任务仍在进行，当前保留材料可能变化，不能把本次清点视为稳定覆盖。',service.active.id);
  if(service.blocking)issue('SOURCE_RESTORE_RECOVERY_REQUIRED','存在未完成或待复核的来源恢复事务；请查看恢复记录。',service.blocking.operationId);
  for(const id of ids){
    check();const directory=service.transactions.directory(id),recordFile=path.join(directory,'record.json'),requestFile=service.requestPath(id);
    for(const file of [recordFile,requestFile]){const stamp=sourceArtifactStamp(file);metadataWatches.set(file,stamp);if(stamp!==null)metadataBytes+=fs.lstatSync(file).size;}
    const record=byId.get(id),request=service.readRequest(id,{optional:true});
    if(!record&&!request)issue('SOURCE_RESTORE_ORPHANED_MATERIAL','操作目录没有已接受的记录，材料保持原样，不推断可清理。',id);
    if(request&&!request.uploadComplete)issue('SOURCE_RESTORE_PARTIAL_UPLOAD','此操作保留了未确认完整的上传材料，不能认证为原始来源。',id);
    const projects=record?.proof.projects||((request?.documentId&&request.documentId!=='@storage')?[request.documentId]:[]);
    const add=(name,role,label,expected)=>{
      const file=service.transactions.artifact(id,name);materials.set(file,{file,operationId:id,materialRole:role,materialLabel:label,projects,expected});
    };
    if(record||request?.uploadComplete||observed.has(path.join(directory,'candidate.step')))add('candidate.step','candidate',record?'已校验候选':request?.uploadComplete?'上传候选（未认证）':'部分上传材料',record?.candidate);
    if(record?.beforeArtifact)add(record.beforeArtifact,'before','操作前保留副本',record.before);
    record?.attempts.forEach((attempt,index)=>{
      if(attempt.backup&&(attempt.outcome==='completed'||observed.has(path.join(directory,attempt.backup))))add(attempt.backup,`retained-${index+1}`,'替换时实际移出版本',attempt.start);
      if(attempt.recoveryBackup&&observed.has(path.join(directory,attempt.recoveryBackup)))add(attempt.recoveryBackup,`recovery-${index+1}`,'回退时实际移出版本',attempt.end.status==='file'?attempt.end:undefined);
    });
    for(const item of files.filter(item=>path.dirname(item.file)===directory&&/\.(?:step|stp)$/i.test(item.file))){
      if(!materials.has(item.file))add(path.basename(item.file),'retained','暂存或其他保留材料',undefined);
    }
  }
  for(const [file,stamp] of metadataWatches)if(sourceArtifactStamp(file)!==stamp)throw new SourceCatalogError('SOURCE_CATALOG_CHANGED','恢复记录在清点期间发生变化。');
  return {materials:[...materials.values()],metadataWatches,metadataBytes,issues};
}
