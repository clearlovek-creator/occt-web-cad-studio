import {pathToFileURL} from 'node:url';
import {normalizeBackupMaintenanceResponse,normalizeBackupMaintenanceList} from '../shared/project-backup-maintenance.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const entryPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.pending)?$/;
const usage='用法：node scripts/maintain-project-backups.mjs --document ID [--api http://127.0.0.1:8788/api] --list | --preview ENTRY | --status REVIEW | --commit REVIEW --digest SHA256 | --discard REVIEW';
export function parseMaintenanceArgs(args){
  const values=new Map();for(let at=0;at<args.length;at++){const name=args[at];if(!['--document','--api','--list','--preview','--status','--commit','--digest','--discard'].includes(name)||values.has(name))throw Error(usage);if(name==='--list'){values.set(name,true);continue;}const value=args[++at];if(typeof value!=='string'||value.startsWith('--'))throw Error(usage);values.set(name,value);}
  const documentId=values.get('--document'),actions=['--list','--preview','--status','--commit','--discard'].filter(name=>values.has(name));
  if(typeof documentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(documentId)||actions.length!==1)throw Error(usage);
  const action=actions[0].slice(2),id=values.get(actions[0]);if(action==='preview'&&!entryPattern.test(id)||['status','commit','discard'].includes(action)&&!UUID.test(id)||action==='commit'&&!/^[a-f0-9]{64}$/.test(values.get('--digest'))||action!=='commit'&&values.has('--digest'))throw Error(usage);
  const url=new URL(values.get('--api')||'http://127.0.0.1:8788/api');if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!/^\/api\/?$/.test(url.pathname))throw Error('维护工具只接受本机 HTTP /api 服务地址，不能访问外部服务或任意文件。');
  return {api:url.href.replace(/\/$/,''),documentId,action,...(action==='list'?{}:{id}),...(action==='commit'?{snapshotDigest:values.get('--digest')}:{})};
}
/** One explicit request only. No service startup, filesystem mutation or retry fallback. */
export async function runMaintenance(options,{fetchImpl=fetch,timeoutMs=120000}={}){
  const checked=parseMaintenanceArgs(['--api',options.api,'--document',options.documentId,'--'+options.action,...(options.action==='list'?[]:[options.id]),...(options.action==='commit'?['--digest',options.snapshotDigest]:[])]);
  const base=`${checked.api}/documents/${encodeURIComponent(checked.documentId)}/project/backup-maintenance`;
  const method=checked.action==='preview'||checked.action==='commit'?'POST':checked.action==='discard'?'DELETE':'GET';
  const url=base+(checked.action==='status'||checked.action==='discard'?'/'+checked.id:checked.action==='commit'?'/'+checked.id+'/commit':'');
  const body=checked.action==='preview'?{entryId:checked.id}:checked.action==='commit'?{snapshotDigest:checked.snapshotDigest}:undefined;
  const abort=new AbortController();let reader,rejectStop;
  const unconfirmed=()=>new Error(method==='GET'?'维护记录读取失败；未执行任何清理。':'请求结果尚未确认；请使用 --list 或 --status 查询原清单，不要自动重复提交。');
  const stopped=new Promise((_,reject)=>rejectStop=reject),timer=setTimeout(()=>{abort.abort();rejectStop(unconfirmed());},timeoutMs),observe=promise=>Promise.race([promise,stopped]);
  try{
    const response=await observe(fetchImpl(url,{method,signal:abort.signal,redirect:'error',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}));
    if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw unconfirmed();reader=response.body?.getReader();if(!reader)throw unconfirmed();const chunks=[];let size=0,empty=0;
    for(;;){const row=await observe(reader.read());if(row.done)break;if(!row.value.length){if(++empty>64)throw unconfirmed();continue;}size+=row.value.length;if(size>256*1024)throw unconfirmed();chunks.push(row.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw unconfirmed();}
    if(!response.ok)throw Error(`维护请求被拒绝（HTTP ${response.status}，${/^[A-Z0-9_]{1,100}$/.test(value?.code)?value.code:'UNKNOWN'}）；请核对原材料或原清单，不会自动重试。`);
    if(checked.action==='list')return normalizeBackupMaintenanceList(value,checked.documentId);
    if(checked.action==='discard'){if(!value||Object.keys(value).some(key=>!['ok','documentId','reviewId','recordDeleted','materialDeleted'].includes(key))||value.ok!==true||value.documentId!==checked.documentId||value.reviewId!==checked.id||value.recordDeleted!==true||value.materialDeleted!==false)throw unconfirmed();return value;}
    return normalizeBackupMaintenanceResponse(value,checked.documentId,checked.action==='preview'?undefined:checked.id);
  }catch(error){if(error instanceof TypeError||abort.signal.aborted)throw unconfirmed();throw error;}finally{clearTimeout(timer);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}abort.abort();void stopped.catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await runMaintenance(parseMaintenanceArgs(process.argv.slice(2))),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
