import type {ProjectBackupReceipt} from '../../shared/project-save-input.mjs';
export class ProjectBackupReadError extends Error{
  readonly code:string;
  constructor(code:string,message:string){super(message);this.name='ProjectBackupReadError';this.code=code;}
}
/** One bounded file at a time; the caller owns cancellation and UI publication. */
export async function readProjectBackup(apiRoot:string,fetchImpl:typeof fetch,receipt:ProjectBackupReceipt,{signal,onProgress=()=>{},timeoutMs=180000,maxBytes=256*1024*1024}:{signal:AbortSignal;onProgress?:(received:number,total:number)=>void;timeoutMs?:number;maxBytes?:number}){
  const backup=receipt.projectBackup;
  if(!globalThis.crypto?.subtle)throw new ProjectBackupReadError('PROJECT_BACKUP_CRYPTO_UNAVAILABLE','备份已生成，但当前页面不能校验文件摘要。请通过 HTTPS 或 localhost 打开工作台，再从原任务下载；不会重新生成。');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1024**3||backup.bytes>maxBytes)throw new ProjectBackupReadError('PROJECT_BACKUP_CLIENT_LIMIT','备份已生成，但超过页面下载读取预算；未重新生成文件。');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new ProjectBackupReadError('PROJECT_BACKUP_CLIENT_LIMIT','备份下载时限配置无效。');
  const abort=new AbortController(),deadline=performance.now()+timeoutMs;
  const stop=()=>abort.abort(new ProjectBackupReadError('PROJECT_BACKUP_DOWNLOAD_CANCELLED','已停止下载，后台备份仍保留。'));
  signal.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(()=>abort.abort(new ProjectBackupReadError('PROJECT_BACKUP_DOWNLOAD_TIMEOUT','备份下载读取超时，原备份仍保留，可再次下载；不会重新生成。')),timeoutMs);
  let rejectStop:(reason:unknown)=>void=()=>{},reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined;
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});
  const onAbort=()=>rejectStop(abort.signal.reason);
  abort.signal.addEventListener('abort',onAbort,{once:true});
  const observe=<T,>(promise:Promise<T>)=>Promise.race([promise,stopped]);
  try{
    if(signal.aborted)stop();if(abort.signal.aborted)throw abort.signal.reason;
    // Construct the path from validated identities, never follow an arbitrary URL.
    const url=`${apiRoot}/documents/${encodeURIComponent(receipt.documentId)}/project/backups/${encodeURIComponent(backup.taskId)}/download`;
    response=await observe(fetchImpl(url,{signal:abort.signal,redirect:'error',headers:{Accept:'application/vnd.webcad.project'}}));
    if(!response.ok){const code=response.status===410?'PROJECT_BACKUP_NOT_FOUND':'PROJECT_BACKUP_DOWNLOAD_FAILED';throw new ProjectBackupReadError(code,response.status===410?'原备份已不可用，未重新生成。':'备份读取失败，原保存任务不会重新执行。');}
    if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/vnd.webcad.project'||response.headers.get('content-length')!==String(backup.bytes))throw new ProjectBackupReadError('PROJECT_BACKUP_RESPONSE_INVALID','备份响应类型或长度与原回执不符，未下载。');
    const serverHash=response.headers.get('x-content-sha256');if(serverHash!==null&&serverHash!==backup.sha256)throw new ProjectBackupReadError('PROJECT_BACKUP_RESPONSE_INVALID','备份响应摘要与原回执不一致，未下载。');
    reader=response.body?.getReader();if(!reader)throw new ProjectBackupReadError('PROJECT_BACKUP_RESPONSE_INVALID','备份响应为空。');
    const bytes=new Uint8Array(backup.bytes);let at=0,empty=0,steps=0,lastProgress=performance.now();
    for(;;){
      if(abort.signal.aborted)throw abort.signal.reason;
      if(performance.now()>=deadline)throw new ProjectBackupReadError('PROJECT_BACKUP_DOWNLOAD_TIMEOUT','备份下载读取超过时限，原备份仍保留。');
      const row=await observe(reader.read());if(row.done)break;
      if(!row.value.length){if(++empty>64)throw new ProjectBackupReadError('PROJECT_BACKUP_RESPONSE_INVALID','备份响应含过多空片段，已停止读取。');continue;}
      if(at+row.value.length>backup.bytes)throw new ProjectBackupReadError('PROJECT_BACKUP_RESPONSE_INVALID','备份响应超过原回执长度，未下载。');
      bytes.set(row.value,at);at+=row.value.length;const now=performance.now();if(at===backup.bytes||now-lastProgress>=80){onProgress(at,backup.bytes);lastProgress=now;}
      if(++steps%128===0)await observe(new Promise<void>(resolve=>setTimeout(resolve,0)));
    }
    if(at!==backup.bytes)throw new ProjectBackupReadError('PROJECT_BACKUP_RESPONSE_INVALID','备份响应未完整读取，未下载。');
    const digest=await observe(crypto.subtle.digest('SHA-256',bytes));
    if(abort.signal.aborted)throw abort.signal.reason;if(performance.now()>=deadline)throw new ProjectBackupReadError('PROJECT_BACKUP_DOWNLOAD_TIMEOUT','备份摘要核对超过时限，未交付文件。');
    if([...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')!==backup.sha256)throw new ProjectBackupReadError('PROJECT_BACKUP_RESPONSE_INVALID','收到的备份内容与原回执摘要不一致，未下载。');
    return new File([bytes],backup.fileName,{type:'application/vnd.webcad.project'});
  }finally{
    clearTimeout(timer);signal.removeEventListener('abort',stop);abort.signal.removeEventListener('abort',onAbort);
    if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* A transport ignoring cancellation may still own its read. */}}
    else if(response?.body)void response.body.cancel().catch(()=>{});
    abort.abort();
    // A queued/ignored transport promise must never create an unhandled rejection.
    void stopped.catch(()=>{});
  }
}
