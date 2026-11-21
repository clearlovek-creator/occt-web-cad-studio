import {normalizeProjectBackupCatalog,normalizeProjectBackupMetadata} from '../../shared/project-backup-catalog.mjs';
import {ProjectBackupReadError} from './project-backup-read.ts';

/** Bounded metadata read. Timeout/connection loss never authorizes a mutation retry. */
export async function requestProjectBackupMetadata(fetchImpl:typeof fetch,url:string,{method='GET',signal,timeoutMs=10000,body,maintenance=false}:{method?:'GET'|'DELETE'|'POST';signal?:AbortSignal;timeoutMs?:number;body?:Record<string,string>;maintenance?:boolean}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new TypeError('备份接口观察预算无效。');
  const abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const cancelled=()=>abort.abort(new ProjectBackupReadError('PROJECT_BACKUP_DOWNLOAD_CANCELLED','已停止下载，后台备份仍保留。'));
  const unknown=()=>new ProjectBackupReadError(maintenance?'PROJECT_BACKUP_MAINTENANCE_UNCONFIRMED':method==='DELETE'?'PROJECT_BACKUP_DELETE_UNCONFIRMED':'PROJECT_BACKUP_CATALOG_UNAVAILABLE',maintenance?'维护结果尚未确认，请刷新原清单核对；不会自动重复清理。':method==='DELETE'?'删除结果尚未确认。请刷新备份列表核对；不会自动再次删除。':'备份目录暂不可读，请刷新重试；不会生成替代文件。');
  const timer=setTimeout(()=>abort.abort(unknown()),timeoutMs);signal?.addEventListener('abort',cancelled,{once:true});
  let rejectStop:(reason:unknown)=>void=()=>{};
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;}),onAbort=()=>rejectStop(abort.signal.reason);
  abort.signal.addEventListener('abort',onAbort,{once:true});
  const observe=<T,>(promise:Promise<T>)=>Promise.race([promise,stopped]);
  try{
    if(signal?.aborted)cancelled();if(abort.signal.aborted)throw abort.signal.reason;
    const response=await observe(fetchImpl(url,{method,signal:abort.signal,redirect:'error',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}));
    if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw unknown();
    reader=response.body?.getReader();if(!reader)throw unknown();const pieces:Uint8Array[]=[];let size=0,empty=0;
    for(;;){const row=await observe(reader.read());if(row.done)break;if(!row.value.length){if(++empty>64)throw unknown();continue;}size+=row.value.length;if(size>256*1024)throw unknown();pieces.push(row.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const piece of pieces){bytes.set(piece,offset);offset+=piece.length;}
    let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw unknown();}
    if(!response.ok){const messages:Record<string,string>={PROJECT_BACKUP_NOT_FOUND:'原备份已不可用，请刷新列表；不会重新生成。',PROJECT_BACKUP_BUSY:'备份或维护任务正在使用中，或保存结果尚未确认，请先核对状态。',PROJECT_BACKUP_CHANGED:'材料与原记录不同，请保留材料并重新核对。',PROJECT_BACKUP_CATALOG_CHANGED:'备份目录已变化，请刷新列表。',PROJECT_BACKUP_CATALOG_CAPACITY:'备份材料超过目录检查预算，已保留；请联系维护人员检查。',PROJECT_BACKUP_MAINTENANCE_NOT_REQUIRED:'这是完整正常的备份，请使用“删除备份文件”，无需异常清理。',PROJECT_BACKUP_MAINTENANCE_EXPIRED:'清单已过期，请重新核对材料并生成新清单。',PROJECT_BACKUP_MAINTENANCE_NOT_FOUND:'未找到当前工程的材料或维护清单，未授权替代清理。',PROJECT_BACKUP_MAINTENANCE_CONFLICT:'提交与原核对清单不一致，未授权替代清理。',PROJECT_BACKUP_MAINTENANCE_UNSAFE:'材料含未知文件、共享文件或超出预期的内容，已保留，不能清理。',PROJECT_BACKUP_MAINTENANCE_LIMIT:'维护记录已达预算，可显式清除已完成或未执行的清单记录。',PROJECT_BACKUP_MAINTENANCE_STORE:'维护记录异常，已保留；请联系维护人员检查。',GATEWAY_STOPPING:'服务正在停止，材料与清单已保留，请恢复服务后核对。'};const code=typeof value?.code==='string'?value.code:'',known=Object.hasOwn(messages,code);throw new ProjectBackupReadError(known?code:maintenance?'PROJECT_BACKUP_MAINTENANCE_UNCONFIRMED':'PROJECT_BACKUP_CATALOG_UNAVAILABLE',known?messages[code]:unknown().message);}
    return value as unknown;
  }catch(error){if(error instanceof ProjectBackupReadError)throw error;if(abort.signal.aborted)throw abort.signal.reason;throw unknown();}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancelled);abort.signal.removeEventListener('abort',onAbort);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}abort.abort();void stopped.catch(()=>{});}
}
const metadata=requestProjectBackupMetadata;
function root(apiRoot:string,documentId:string){if(!/^[A-Za-z0-9_-]{1,64}$/.test(documentId))throw new TypeError('工程身份无效。');return `${apiRoot}/documents/${encodeURIComponent(documentId)}/project/backups`;}
function id(taskId:string){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(taskId))throw new TypeError('备份身份无效。');return taskId;}
export async function listStoredProjectBackups(apiRoot:string,fetchImpl:typeof fetch,documentId:string,{after,signal}:{after?:string;signal?:AbortSignal}={}){
  const query=new URLSearchParams({limit:'20'});if(after!==undefined)query.set('after',after);
  const page=normalizeProjectBackupCatalog(await metadata(fetchImpl,`${root(apiRoot,documentId)}?${query}`,{signal}),documentId);
  if(after!==undefined&&!after.startsWith(page.snapshot+':'))throw new ProjectBackupReadError('PROJECT_BACKUP_CATALOG_CHANGED','备份目录已变化，请刷新列表。');return page;
}
export async function getStoredProjectBackup(apiRoot:string,fetchImpl:typeof fetch,documentId:string,taskId:string,signal?:AbortSignal){return normalizeProjectBackupMetadata(await metadata(fetchImpl,`${root(apiRoot,documentId)}/${id(taskId)}`,{signal}),documentId,taskId);}
export async function deleteStoredProjectBackup(apiRoot:string,fetchImpl:typeof fetch,documentId:string,taskId:string){
  const value=await metadata(fetchImpl,`${root(apiRoot,documentId)}/${id(taskId)}`,{method:'DELETE'}) as {ok?:unknown;deleted?:unknown;taskId?:unknown;documentId?:unknown};
  if(!value||Object.keys(value).some(key=>!['ok','deleted','taskId','documentId'].includes(key))||value.ok!==true||value.deleted!==true||value.taskId!==taskId||value.documentId!==documentId)throw new ProjectBackupReadError('PROJECT_BACKUP_DELETE_UNCONFIRMED','删除结果尚未确认。请刷新备份列表核对；不会自动再次删除。');
  return {deleted:true as const,taskId,documentId};
}
