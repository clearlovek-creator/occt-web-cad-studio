import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ProjectBackupError} from './project-backup-store.mjs';
import {normalizeStoredProjectBackupReceipt} from '../shared/project-save-input.mjs';

const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DOC=/^[A-Za-z0-9_-]{1,64}$/;
const fail=(code,message,status=400)=>new ProjectBackupError(code,message,status);
const stamp=stat=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(key=>String(stat[key])).join(':');
function boundedNames(directory,maximum){
  const entries=[],handle=fs.opendirSync(directory);
  try{for(let item;(item=handle.readSync());){if(entries.length===maximum)throw fail('PROJECT_BACKUP_CATALOG_CAPACITY','备份材料超过目录检查预算，已保留；请联系维护人员检查。',429);entries.push(item.name);}}finally{handle.closeSync();}
  return entries;
}

/** Reads receipt metadata only. No task-list window, payload hashing, repair or cleanup. */
export class ProjectBackupCatalog{
  constructor(store,{resolveOwner=()=>null}={}){this.store=store;this.resolveOwner=resolveOwner;}
  entry(name){
    const pending=name.endsWith('.pending'),taskId=pending?name.slice(0,-8):name;
    if(!ID.test(taskId))return null;
    let manifest=null,problem=false,signature='',owner=null;
    const directory=path.join(this.store.root,name);
    try{fs.lstatSync(directory);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    try{
      const before=this.store.checkDirectory(directory);signature=stamp(before);
      try{manifest=this.store.readManifest(taskId,{pending});}catch{problem=true;}
      if(manifest)owner=manifest.input.documentId;
      const files=boundedNames(directory,3);
      if(files.length!==2||!files.includes('receipt.json')||!files.includes('backup.cadproj'))problem=true;
      if(manifest){
        const payload=this.store.regular(path.join(directory,'backup.cadproj'),this.store.maxFileBytes);
        if(Number(payload.size)!==manifest.result.projectBackup.bytes)problem=true;
        signature+=':'+stamp(payload);
      }
      if(stamp(this.store.checkDirectory(directory))!==stamp(before))problem=true;
    }catch{problem=true;}
    // Only an already validated durable save binding may attribute incomplete material.
    // It never becomes a replacement receipt or a downloadable artifact.
    if(!owner){try{owner=this.resolveOwner(taskId);}catch{owner=null;}}
    if(typeof owner!=='string'||!DOC.test(owner))return null;
    let receipt;
    if(manifest)try{receipt=normalizeStoredProjectBackupReceipt(manifest.result,owner,taskId);}catch{problem=true;}
    const generating=pending&&this.store.active.has(taskId);
    const state=pending?(generating?'generating':'retained'):problem||!receipt?'unavailable':'available';
    const busy=this.store.active.has(taskId)||this.store.readers.has(taskId);
    const entry={entryId:name,taskId,stage:pending?'pending':'published',state,integrity:state==='available'?'not-checked':'unavailable',busy,canDownload:state==='available',canDelete:state==='available'&&!busy,...(receipt?{receipt}:{})};
    return {owner,entry,signature};
  }
  get(documentId,taskId){
    if(!DOC.test(documentId)||!ID.test(taskId))throw fail('PROJECT_BACKUP_ARGUMENTS','备份身份无效。');
    this.store.checkRoot();const value=this.entry(taskId);
    if(!value||value.owner!==documentId)throw fail('PROJECT_BACKUP_NOT_FOUND','未找到当前工程的备份。',404);
    return {ok:true,version:1,documentId,entry:value.entry};
  }
  list(documentId,{limit=20,after}={}){
    if(!DOC.test(documentId)||!Number.isSafeInteger(limit)||limit<1||limit>100||after!==undefined&&(typeof after!=='string'||!/^([a-f0-9]{64}):([a-f0-9-]{36}(?:\.pending)?)$/.test(after)))throw fail('PROJECT_BACKUP_ARGUMENTS','备份列表参数无效。');
    this.store.checkRoot();const names=boundedNames(this.store.root,512),items=[];let unattributedEntries=0,retainedMaterial=false;
    for(const name of names){const item=this.entry(name);if(!item){unattributedEntries++;retainedMaterial=true;continue;}if(item.entry.state!=='available')retainedMaterial=true;if(item.owner===documentId)items.push(item);}
    items.sort((a,b)=>(b.entry.receipt?.projectBackup.createdAt||'').localeCompare(a.entry.receipt?.projectBackup.createdAt||'')||a.entry.entryId.localeCompare(b.entry.entryId));
    const snapshot=createHash('sha256').update(JSON.stringify({documentId,items:items.map(({entry,signature})=>({entry:{...entry,busy:false,canDelete:false},signature}))})).digest('hex');
    let start=0;if(after!==undefined){const [expected,id]=after.split(':');const index=items.findIndex(item=>item.entry.entryId===id);if(expected!==snapshot||index<0)throw fail('PROJECT_BACKUP_CATALOG_CHANGED','备份目录已变化，请刷新列表；未自动跳过或替换条目。',409);start=index+1;}
    const entries=items.slice(start,start+limit).map(item=>item.entry),hasMore=start+entries.length<items.length;
    return {ok:true,version:1,documentId,snapshot,entries,total:items.length,nextCursor:hasMore?`${snapshot}:${entries.at(-1).entryId}`:null,storage:{unattributedEntries,retainedMaterial}};
  }
}
