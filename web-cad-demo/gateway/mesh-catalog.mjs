import fs from 'node:fs';
import path from 'node:path';
import {resolveMeshCompletion} from './mesh-completion-record.mjs';

export const MESH_CATALOG_LIMITS=Object.freeze({maxEntries:50000,maxJobs:10000,maxMetadataBytes:64*1024*1024,maxRecordBytes:16*1024*1024,maxScanMs:30000});
const fault=(code,message)=>Object.assign(Error(message),{code});
export function meshCatalogLimits(overrides={}){
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))throw fault('MESH_CATALOG_CONFIG_INVALID','网格历史恢复预算无效。');
  for(const [key,value] of Object.entries(overrides))if(!Object.hasOwn(MESH_CATALOG_LIMITS,key)||!Number.isSafeInteger(value)||value<1||value>MESH_CATALOG_LIMITS[key])throw fault('MESH_CATALOG_CONFIG_INVALID','网格历史恢复预算无效。');
  return {...MESH_CATALOG_LIMITS,...overrides};
}
const documentPattern=/^[A-Za-z0-9_-]{1,64}$/,jobPattern=/^mesh-[a-f0-9-]{36}$/;
/** Complete read-only scan. No partial catalog or interrupted-state writes on
 * scan failure. Called off the Gateway thread for online recovery. */
export function scanMeshCatalog({root,readRecord,validateRecord,limits={},clock=()=>performance.now()}){
  const policy=meshCatalogLimits(limits),started=clock(),stats={entries:0,records:0,metadataBytes:0,corrupt:0,deleted:0,completionRecords:0,completionRecovered:0};
  const check=()=>{if(clock()-started>policy.maxScanMs)throw fault('MESH_CATALOG_LIMIT','网格历史恢复超过时间预算，未采用不完整清单。');};
  const entry=()=>{check();if(++stats.entries>policy.maxEntries)throw fault('MESH_CATALOG_LIMIT','网格历史目录条目超过预算，未采用不完整清单。');};
  // Reject junctions in every existing parent, not only the final directory.
  for(let current=path.resolve(root);;current=path.dirname(current)){
    const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw fault('MESH_CATALOG_UNSAFE','网格历史路径包含链接或异常目录，原文件保留。');
    if(path.dirname(current)===current)break;
  }
  const directories=[];
  function each(directory,action){
    const before=fs.lstatSync(directory);if(!before.isDirectory()||before.isSymbolicLink())throw fault('MESH_CATALOG_UNSAFE','网格历史目录在扫描前变化。');directories.push({directory,dev:before.dev,ino:before.ino});
    const handle=fs.opendirSync(directory);try{let item;while((item=handle.readSync())){entry();action(item);}}finally{handle.closeSync();}
  }
  const jobs=[],seen=new Set();
  each(root,document=>{
    if(!documentPattern.test(document.name))return;
    if(document.isSymbolicLink())throw fault('MESH_CATALOG_UNSAFE','网格历史工程目录是链接，未跟随。');
    if(!document.isDirectory())return;
    const directory=path.join(root,document.name);
    each(directory,item=>{
      if(!jobPattern.test(item.name))return;
      if(item.isSymbolicLink())throw fault('MESH_CATALOG_UNSAFE','网格历史任务目录是链接，未跟随。');
      if(!item.isDirectory())return;
      if(++stats.records>policy.maxJobs)throw fault('MESH_CATALOG_LIMIT','网格历史任务数超过恢复预算，未截断历史或准入新任务。');
      if(seen.has(item.name))throw fault('MESH_CATALOG_ID_CONFLICT','不同工程包含同名网格任务，未覆盖其中任何一份记录。');seen.add(item.name);
      const identity={documentId:document.name,jobId:item.name},jobDirectory=path.join(directory,item.name),jobStat=fs.lstatSync(jobDirectory);
      if(!jobStat.isDirectory()||jobStat.isSymbolicLink())throw fault('MESH_CATALOG_UNSAFE','网格历史任务目录在扫描前被替换。');
      directories.push({directory:jobDirectory,dev:jobStat.dev,ino:jobStat.ino});
      const file=path.join(jobDirectory,'metadata.json');
      try{
        const readBounded=target=>{
          const stat=fs.lstatSync(target,{bigint:true});
          if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)throw fault('MESH_METADATA_CORRUPT','任务记录不是独立普通文件。');
          if(stat.size>BigInt(policy.maxRecordBytes))throw fault('MESH_CATALOG_LIMIT','网格任务记录超过单文件预算，未读取或截断。');
          if(stat.size<0n||stats.metadataBytes+Number(stat.size)>policy.maxMetadataBytes)throw fault('MESH_CATALOG_LIMIT','网格历史元数据总量超过预算，未采用不完整清单。');
          let charged=false;check();
          let proof;const value=readRecord(target,policy.maxRecordBytes,bytes=>{
            if(charged||!Number.isSafeInteger(bytes)||bytes<0)throw fault('MESH_CATALOG_UNAVAILABLE','网格历史读取没有提供准确字节数。');
            if(bytes>policy.maxRecordBytes||stats.metadataBytes+bytes>policy.maxMetadataBytes)throw fault('MESH_CATALOG_LIMIT','网格历史打开后的实际字节超过预算，未分配或解析。');
            stats.metadataBytes+=bytes;charged=true;
          },value=>proof=value);
          if(!charged)throw fault('MESH_CATALOG_UNAVAILABLE','网格历史读取没有核对实际文件字节。');
          return {value,proof,stat};
        };
        const metadata=readBounded(file);let job=metadata.value;
        validateRecord(job,identity);check();
        if(job.state==='deleted'){stats.deleted++;return;}
        const completionFile=path.join(jobDirectory,'completion.json');let hasCompletion=false;
        try{fs.lstatSync(completionFile);hasCompletion=true;}catch(error){if(error.code!=='ENOENT')throw error;}
        if(hasCompletion){
          entry();stats.completionRecords++;
          try{const completion=readBounded(completionFile);job=resolveMeshCompletion(job,metadata.proof,completion.value,identity,validateRecord);}
          catch(error){if(error.code?.startsWith('MESH_CATALOG_')||['EACCES','EPERM','EMFILE','ENFILE','EIO','EBUSY'].includes(error.code))throw error;if(error.code?.startsWith('MESH_METADATA_COMPLETION_'))throw error;throw fault('MESH_METADATA_COMPLETION_INVALID','网格完成凭据无法核对，原结果保留。');}
          const after=fs.lstatSync(file,{bigint:true}),before=metadata.stat;
          if(['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]))throw fault('MESH_METADATA_COMPLETION_CONFLICT','核对完成凭据期间任务记录变化，未采用旧结果。');
          if(job.completionReceipt)stats.completionRecovered++;
        }
        jobs.push({...job,metadataProof:metadata.proof,visible:false,recovered:true});
      }catch(error){
        if(error.code?.startsWith('MESH_CATALOG_'))throw error;
        if(error.code==='MESH_ARTIFACT_LIMIT')throw fault('MESH_CATALOG_LIMIT','网格历史打开后的记录超过预算，未采用不完整清单。');
        stats.corrupt++;
        const unavailable=['EACCES','EPERM','EMFILE','ENFILE','EIO','EBUSY'].includes(error.code);
        const completionError=error.code?.startsWith('MESH_METADATA_COMPLETION_');
        jobs.push({...identity,state:'failed',visible:false,recovered:true,createdAt:'',errorCode:unavailable?'MESH_METADATA_UNAVAILABLE':completionError?error.code:'MESH_METADATA_CORRUPT',error:unavailable?'任务记录暂时无法读取，原文件保留。':completionError?error.message:'任务记录损坏，原始文件已保留。'});
      }
    });
  });
  for(const item of directories){check();const stat=fs.lstatSync(item.directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==item.dev||stat.ino!==item.ino)throw fault('MESH_CATALOG_UNSAFE','网格历史目录在扫描期间被替换，未采用该清单。');}
  check();return {jobs,stats:{...stats,elapsedMs:Math.max(0,clock()-started),limits:policy}};
}
