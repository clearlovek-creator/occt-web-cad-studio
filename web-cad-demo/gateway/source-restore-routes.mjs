import {resolveCorsOrigin} from './cors.mjs';
import {SourceRestoreServiceError,sourceRestoreFailure} from './source-restore-service.mjs';
const localHosts=new Set(['localhost','127.0.0.1','[::1]']);
const fault=(code,message)=>new SourceRestoreServiceError(code,message);
const idPart='(restore-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
function authorize(request,webOrigin,port){
  let host;try{host=new URL('http://'+request.headers.host);}catch{throw fault('SOURCE_RESTORE_FORBIDDEN','来源恢复只允许受信任的本机工作台访问。');}
  const remote=request.socket.remoteAddress,origin=String(request.headers.origin||'');
  if(!localHosts.has(host.hostname)||Number(host.port||80)!==port||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)||origin&&resolveCorsOrigin(origin,webOrigin)!==origin)throw fault('SOURCE_RESTORE_FORBIDDEN','来源恢复只允许受信任的本机工作台访问；请求未执行。');
}
function query(url,allowed){for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw fault('SOURCE_RESTORE_ARGUMENTS','来源恢复请求包含未知或重复参数。');}
function status(code){if(code==='SOURCE_RESTORE_FORBIDDEN')return 403;if(code==='SOURCE_RESTORE_NOT_FOUND'||code==='SOURCE_RESTORE_FILE_NOT_FOUND')return 404;if(code==='SOURCE_RESTORE_UPLOAD_TOO_LARGE'||code==='SOURCE_RESTORE_REQUEST_TOO_LARGE')return 413;if(code==='SOURCE_RESTORE_MEDIA_TYPE')return 415;if(/(?:BUSY|EXISTS|STALE|NOT_READY|EXPIRED|RECOVERY_REQUIRED|RECHECK|REUPLOAD|SUPERSEDED|CANDIDATE_CHANGED|CONFLICT)/.test(code))return 409;if(/(?:ID|ARGUMENTS|EMPTY)$/.test(code))return 400;if(code==='SERVICE_STOPPING')return 503;return 500;}
async function emptyActionBody(request){
  const chunks=[];let bytes=0;
  for await(const chunk of request){bytes+=chunk.length;if(bytes>1024)throw fault('SOURCE_RESTORE_REQUEST_TOO_LARGE','恢复动作请求超过大小限制。');chunks.push(chunk);}
  let body;try{body=bytes?JSON.parse(Buffer.concat(chunks,bytes).toString('utf8')):{};}catch{throw fault('SOURCE_RESTORE_ARGUMENTS','恢复动作必须是有效的空 JSON 对象。');}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw fault('SOURCE_RESTORE_ARGUMENTS','恢复动作只接受空对象，不接受客户端文件路径或替换参数。');
}

export async function handleSourceRestoreRoute({request,response,url,service,webOrigin,port,sendJson}){
  if(!url.pathname.startsWith('/api/source-restores'))return false;
  try{
    authorize(request,webOrigin,port);
    if(url.pathname==='/api/source-restores'&&request.method==='GET'){
      query(url,['documentId','offset','limit']);const offset=url.searchParams.get('offset')||'0',limit=url.searchParams.get('limit')||'50';
      if(! /^\d{1,8}$/.test(offset)||! /^\d{1,2}$/.test(limit))throw fault('SOURCE_RESTORE_ARGUMENTS','恢复记录分页参数无效。');
      sendJson(response,200,{ok:true,...service.list({documentId:url.searchParams.get('documentId')||'@storage',offset:Number(offset),limit:Number(limit)})});return true;
    }
    const match=url.pathname.match(new RegExp('^/api/source-restores/'+idPart+'(?:/(prepare|commit|rollback|revalidate|abandon|review)|/files/(candidate|before|retained-(?:[1-9]|1[0-6])|recovery-(?:[1-9]|1[0-6])))?$'));
    if(!match)throw fault('SOURCE_RESTORE_ARGUMENTS','来源恢复路径或操作身份无效。');
    const [,id,action,role]=match;
    if(request.method==='GET'&&!action){query(url,[]);if(role)await service.download(id,role,response);else sendJson(response,200,{ok:true,restoration:service.get(id),health:service.health()});return true;}
    if(request.method==='POST'&&action==='prepare'){
      query(url,['scope','documentId','auditJobId','assetId','fileName']);
      if(!['application/step','application/octet-stream'].includes(String(request.headers['content-type']||'').split(';')[0].trim().toLowerCase()))throw fault('SOURCE_RESTORE_MEDIA_TYPE','请上传原始 STEP 文件内容，不接受任意路径或 JSON 文件操作。');
      const length=request.headers['content-length'];if(length!==undefined&&(! /^\d+$/.test(length)||Number(length)>service.maxUploadBytes))throw fault('SOURCE_RESTORE_UPLOAD_TOO_LARGE','来源候选超过上传大小预算。');
      const metadata=Object.fromEntries(['scope','documentId','auditJobId','assetId','fileName'].map(key=>[key,url.searchParams.get(key)]));
      const restoration=await service.upload(id,metadata,request);sendJson(response,202,{ok:true,restoration,health:service.health()});return true;
    }
    if(request.method==='POST'&&action&&!role){
      query(url,[]);await emptyActionBody(request);
      const restoration=service.action(id,action);sendJson(response,202,{ok:true,restoration,health:service.health()});return true;
    }
    throw fault('SOURCE_RESTORE_ARGUMENTS','此来源恢复路径不支持该请求方式。');
  }catch(error){const failure=sourceRestoreFailure(error);if(response.headersSent)response.destroy();else if(!response.destroyed)sendJson(response,status(failure.code),{ok:false,...failure});return true;}
}
