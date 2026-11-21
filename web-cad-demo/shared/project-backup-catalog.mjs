import {normalizeStoredProjectBackupReceipt} from './project-save-input.mjs';
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const fail=()=>{throw new TypeError('备份目录响应无效；未采用替代文件或执行删除。');};
const object=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
export function normalizeProjectBackupEntry(value,documentId){
  if(!object(value,['entryId','taskId','stage','state','integrity','busy','canDownload','canDelete','receipt'])||!ID.test(value.taskId)||!['pending','published'].includes(value.stage)||value.entryId!==value.taskId+(value.stage==='pending'?'.pending':'')||!['available','generating','retained','unavailable'].includes(value.state)||typeof value.busy!=='boolean'||typeof value.canDownload!=='boolean'||typeof value.canDelete!=='boolean')fail();
  if(value.stage==='pending'&&!['generating','retained'].includes(value.state)||value.stage==='published'&&!['available','unavailable'].includes(value.state)||value.integrity!==(value.state==='available'?'not-checked':'unavailable')||value.canDownload!==(value.state==='available')||value.canDelete!==(value.state==='available'&&!value.busy)||value.state==='generating'&&!value.busy)fail();
  const receipt=value.receipt===undefined?undefined:normalizeStoredProjectBackupReceipt(value.receipt,documentId,value.taskId);
  if(value.state==='available'&&!receipt)fail();
  return {entryId:value.entryId,taskId:value.taskId,stage:value.stage,state:value.state,integrity:value.integrity,busy:value.busy,canDownload:value.canDownload,canDelete:value.canDelete,...(receipt?{receipt}:{})};
}
export function normalizeProjectBackupCatalog(value,documentId){
  if(!object(value,['ok','version','documentId','snapshot','entries','total','nextCursor','storage'])||value.ok!==true||value.version!==1||value.documentId!==documentId||typeof value.snapshot!=='string'||!HASH.test(value.snapshot)||!Array.isArray(value.entries)||value.entries.length>100||!Number.isSafeInteger(value.total)||value.total<value.entries.length||value.total>512||!object(value.storage,['unattributedEntries','retainedMaterial'])||!Number.isSafeInteger(value.storage.unattributedEntries)||value.storage.unattributedEntries<0||value.storage.unattributedEntries>512||typeof value.storage.retainedMaterial!=='boolean'||value.storage.unattributedEntries>0&&!value.storage.retainedMaterial)fail();
  const entries=value.entries.map(entry=>normalizeProjectBackupEntry(entry,documentId));if(new Set(entries.map(entry=>entry.entryId)).size!==entries.length)fail();
  if(value.nextCursor!==null&&(typeof value.nextCursor!=='string'||!entries.length||value.nextCursor!==`${value.snapshot}:${entries.at(-1).entryId}`))fail();
  return {ok:true,version:1,documentId,snapshot:value.snapshot,entries,total:value.total,nextCursor:value.nextCursor,storage:{unattributedEntries:value.storage.unattributedEntries,retainedMaterial:value.storage.retainedMaterial}};
}
export function normalizeProjectBackupMetadata(value,documentId,taskId){
  if(!object(value,['ok','version','documentId','entry'])||value.ok!==true||value.version!==1||value.documentId!==documentId)fail();
  const entry=normalizeProjectBackupEntry(value.entry,documentId);if(entry.taskId!==taskId||entry.stage!=='published')fail();return entry;
}
