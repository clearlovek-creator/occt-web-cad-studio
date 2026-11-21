import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createPiHistoryPreview} from './pi-history-preview.mjs';

const FILE='web-cad-owner.json',SESSION=/^[A-Za-z0-9_-]{1,80}$/,DOCUMENT=/^[A-Za-z0-9_-]{1,64}$/;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp=stat=>Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(key=>[key,String(stat[key])]));
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
export class PiSessionOwnershipError extends Error{constructor(code,message){super(message);this.name='PiSessionOwnershipError';this.code=code;this.outcome='not-started';this.retryableByModel=false;}}
const fail=(code,message)=>new PiSessionOwnershipError(code,message);
function identities(sessionId,documentId){if(typeof sessionId!=='string'||!SESSION.test(sessionId)||typeof documentId!=='string'||!DOCUMENT.test(documentId))throw fail('PI_SESSION_OWNER_INVALID','Pi 会话或工程标识无效，未写入归属。');}
function exists(file){try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw fail('PI_SESSION_OWNER_UNAVAILABLE','Pi 会话材料不可读取，原文件已保留。');}}
function directory(root){const stat=fs.lstatSync(root,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('PI_SESSION_OWNER_UNAVAILABLE','Pi 会话目录不是受支持的独立目录，未启动进程。');return stamp(stat);}
function regular(file,max){const stat=fs.lstatSync(file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size>BigInt(max))throw fail('PI_SESSION_OWNER_UNAVAILABLE','Pi 会话材料不是预算内的独占普通文件，未采用。');return stat;}
function names(root){const handle=fs.opendirSync(root),values=[];try{for(let item;(item=handle.readSync());){if(values.length===256)throw fail('PI_SESSION_OWNER_LIMIT','Pi 会话材料超过核对数量预算，已保留。');values.push(item.name);}}finally{handle.closeSync();}return values.sort();}
function safely(action){try{return action();}catch(error){if(error instanceof PiSessionOwnershipError)throw error;throw fail('PI_SESSION_OWNER_UNAVAILABLE','Pi 工程归属材料暂不可用，未修改旧历史或启动替代会话。');}}
function readOwner(root,sessionId,documentId){
  const before=directory(root),file=path.join(root,FILE);if(!exists(file))return null;const stat=regular(file,8192),fd=fs.openSync(file,'r'),bytes=Buffer.allocUnsafe(8193);let at=0;
  try{for(;;){const size=fs.readSync(fd,bytes,at,bytes.length-at,at);if(!size)break;at+=size;if(at>8192)throw fail('PI_SESSION_OWNER_UNAVAILABLE','Pi 归属记录超过预算，已保留。');}const after=directory(root);if(!same(stamp(stat),stamp(fs.fstatSync(fd,{bigint:true})))||!same(stamp(stat),stamp(regular(file,8192)))||before.dev!==after.dev||before.ino!==after.ino)throw fail('PI_SESSION_OWNER_CHANGED','Pi 归属记录读取期间变化，未采用。');}finally{fs.closeSync(fd);}
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,at)));}catch{throw fail('PI_SESSION_OWNER_UNAVAILABLE','Pi 归属记录无法解析，未覆盖或重建。');}
  const {bindingSha256,...binding}=value||{};
  if(!value||Array.isArray(value)||Object.keys(value).some(key=>!['format','version','sessionId','documentId','ownerToken','createdAt','adoption','bindingSha256'].includes(key))||value.format!=='web-cad-pi-owner'||value.version!==1||typeof value.sessionId!=='string'||!SESSION.test(value.sessionId)||typeof value.documentId!=='string'||!DOCUMENT.test(value.documentId)||typeof value.ownerToken!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.ownerToken)||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||!value.adoption||Array.isArray(value.adoption)||Object.keys(value.adoption).some(key=>!['kind','historyDigest'].includes(key))||!['new','explicit-legacy'].includes(value.adoption.kind)||value.adoption.kind==='new'&&value.adoption.historyDigest!==undefined||value.adoption.kind==='explicit-legacy'&&!/^[a-f0-9]{64}$/.test(value.adoption.historyDigest)||bindingSha256!==hash(binding))throw fail('PI_SESSION_OWNER_UNAVAILABLE','Pi 归属记录的格式或摘要无效，未覆盖旧记录。');
  if(value.sessionId!==sessionId||documentId!==undefined&&value.documentId!==documentId)throw fail('PI_SESSION_DOCUMENT_MISMATCH','Pi 原生历史已绑定其他会话或工程，不能重新绑定；请使用对应工程的独立会话。');return value;
}
/** Metadata-only bounded scan. Unknown legacy sessions are never silently attributed. */
export async function assertFreshPiDocument(sessionRoot,documentId,{isCancelled=()=>false}={}){
  if(typeof documentId!=='string'||!DOCUMENT.test(documentId))throw fail('PI_SESSION_OWNER_INVALID','新工程身份无效。');
  return safelyAsync(async()=>{
    const root=path.resolve(sessionRoot);if(!exists(root))return;
    const inventory=()=>{const handle=fs.opendirSync(root),entries=[];try{for(let entry;(entry=handle.readSync());){if(entries.length>=2048)throw fail('PI_SESSION_OWNER_LIMIT','Pi 会话目录超过新工程身份核对预算，未创建目标。');entries.push(entry.name);}}finally{handle.closeSync();}return entries.sort();};
    const before=directory(root),entries=inventory(),identity=value=>process.platform==='win32'?value.toLowerCase():value;
    for(let index=0;index<entries.length;index++){
      if(isCancelled())throw fail('PI_SESSION_OWNER_STOPPING','服务正在停止，未采用新工程身份。');
      const name=entries[index],child=path.join(root,name);if(identity(name)===identity(`webcad-${documentId}`))throw fail('PI_DOCUMENT_HISTORY_EXISTS','目标 ID 已有 Pi 会话材料，不能作为全新工程复用；旧历史已保留。');
      if(!SESSION.test(name))throw fail('PI_SESSION_OWNER_UNAVAILABLE','Pi 会话目录含未知名称，未确认新工程身份。');
      directory(child);
      if(exists(path.join(child,FILE))){const owner=readOwner(child,name);if(identity(owner.documentId)===identity(documentId))throw fail('PI_DOCUMENT_HISTORY_EXISTS','目标 ID 已绑定旧 Pi 会话，不能创建新的几何工程覆盖其语义；旧历史已保留。');}
      if(index%16===15)await new Promise(resolve=>setImmediate(resolve));
    }
    if(!same(before,directory(root))||!same(entries,inventory()))throw fail('PI_SESSION_OWNER_CHANGED','Pi 会话清单在核对期间变化，未采用新工程身份。');
  });
}
async function safelyAsync(action){try{return await action();}catch(error){if(error instanceof PiSessionOwnershipError)throw error;throw fail('PI_SESSION_OWNER_UNAVAILABLE','Pi 工程身份材料暂不可用，未修改旧历史。');}}
function writeOwner(root,sessionId,documentId,adoption){
  const before=directory(root),file=path.join(root,FILE),binding={format:'web-cad-pi-owner',version:1,sessionId,documentId,ownerToken:randomUUID(),createdAt:new Date().toISOString(),adoption},value={...binding,bindingSha256:hash(binding)};
  // Exclusive creation is fail-closed: an incomplete record is retained, never overwritten.
  let fd;try{fd=fs.openSync(file,'wx',0o600);}catch(error){if(error.code==='EEXIST'){const owner=readOwner(root,sessionId,documentId);if(!owner)throw fail('PI_SESSION_OWNER_CHANGED','Pi 归属记录在确认期间消失，未启动会话。');return owner;}throw error;}
  try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const after=directory(root);if(before.dev!==after.dev||before.ino!==after.ino)throw fail('PI_SESSION_OWNER_CHANGED','Pi 会话目录在写入归属期间变化，未启动会话。');const verified=readOwner(root,sessionId,documentId);if(!verified)throw fail('PI_SESSION_OWNER_CHANGED','Pi 归属记录在确认期间消失，未启动会话。');return verified;
}
export function ensurePiSessionOwner(sessionRoot,sessionId,documentId){return safely(()=>{
  identities(sessionId,documentId);const root=path.resolve(sessionRoot);if(!exists(root))fs.mkdirSync(root,{recursive:true});directory(root);const owner=readOwner(root,sessionId,documentId);if(owner)return owner;
  if(names(root).length)throw fail('PI_SESSION_OWNER_REQUIRED','旧 Pi 会话尚无可验证的工程归属。请先核对原历史并显式确认归属；未启动或改绑旧会话。');return writeOwner(root,sessionId,documentId,{kind:'new'});
});}
export async function inspectPiSessionOwner(sessionRoot,sessionId,documentId,{isCancelled=()=>false,includePreview=false}={}){
  try{
    identities(sessionId,documentId);const root=path.resolve(sessionRoot);if(!exists(root))return {state:'absent',sessionId,documentId};const owner=readOwner(root,sessionId,documentId);if(owner)return {state:'bound',sessionId,documentId,owner};
    const before=directory(root),entries=names(root);if(!entries.length)return {state:'empty',sessionId,documentId};const files=[],preview=includePreview?createPiHistoryPreview():null;let totalBytes=0;
    for(const name of entries){
      if(isCancelled())throw fail('PI_SESSION_OWNER_STOPPING','服务正在停止，未继续核对或写入 Pi 归属。');
      if(!/^[^\\/:*?"<>|\x00-\x1f]{1,240}\.jsonl$/i.test(name))throw fail('PI_SESSION_OWNER_UNAVAILABLE','旧会话目录包含未知材料，不能自动确认归属；原材料已保留。');
      const file=path.join(root,name),stat=regular(file,64*1024*1024),handle=await fs.promises.open(file,'r'),digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let at=0;preview?.startFile();
      try{for(;;){if(isCancelled())throw fail('PI_SESSION_OWNER_STOPPING','服务正在停止，未继续核对或写入 Pi 归属。');const {bytesRead}=await handle.read(buffer,0,buffer.length,at);if(!bytesRead)break;at+=bytesRead;if(at>64*1024*1024||totalBytes+at>256*1024*1024)throw fail('PI_SESSION_OWNER_LIMIT','旧 Pi 历史超过内容核对预算，未采用。');const chunk=buffer.subarray(0,bytesRead);digest.update(chunk);preview?.push(chunk);await new Promise(resolve=>setImmediate(resolve));}preview?.endFile();if(at!==Number(stat.size)||!same(stamp(stat),stamp(await handle.stat({bigint:true})))||!same(stamp(stat),stamp(regular(file,64*1024*1024))))throw fail('PI_SESSION_OWNER_CHANGED','旧 Pi 历史在核对期间变化，未授权归属。');files.push({name,bytes:at,sha256:digest.digest('hex'),identity:stamp(stat)});totalBytes+=at;}finally{await handle.close();}
    }
    if(!same(before,directory(root))||!same(entries,names(root)))throw fail('PI_SESSION_OWNER_CHANGED','旧 Pi 会话目录在核对期间变化，未采用。');return {state:'legacy',sessionId,documentId,fileCount:files.length,totalBytes,historyDigest:hash({sessionId,documentId,directory:before,files}),...(preview?{preview:preview.result()}:{})};
  }catch(error){if(error instanceof PiSessionOwnershipError)throw error;throw fail('PI_SESSION_OWNER_UNAVAILABLE','旧 Pi 会话核对失败，未写入归属或修改历史。');}
}
export async function adoptPiSessionOwner(sessionRoot,sessionId,documentId,historyDigest,options={}){
  if(typeof historyDigest!=='string'||!/^[a-f0-9]{64}$/.test(historyDigest))throw fail('PI_SESSION_OWNER_CONFLICT','Pi 归属提交缺少原历史核对摘要。');
  const preview=await inspectPiSessionOwner(sessionRoot,sessionId,documentId,options);
  if(preview.state==='bound'){if(preview.owner.adoption.kind!=='explicit-legacy'||preview.owner.adoption.historyDigest!==historyDigest)throw fail('PI_SESSION_OWNER_CONFLICT','Pi 归属与原确认摘要不一致，未改写。');return preview.owner;}
  if(preview.state!=='legacy'||preview.historyDigest!==historyDigest)throw fail('PI_SESSION_OWNER_CHANGED','旧 Pi 历史与用户核对的摘要不一致，未确认归属。');
  if(options.isCancelled?.())throw fail('PI_SESSION_OWNER_STOPPING','服务正在停止，未写入 Pi 归属。');
  try{return safely(()=>{const owner=writeOwner(path.resolve(sessionRoot),sessionId,documentId,{kind:'explicit-legacy',historyDigest});if(owner.adoption.kind!=='explicit-legacy'||owner.adoption.historyDigest!==historyDigest)throw fail('PI_SESSION_OWNER_CONFLICT','Pi 归属已由不同的核对过程确认，未改写。');return owner;});}
  catch(error){error.outcome='unknown';throw error;}
}
export function publicPiSessionOwner(value){if(value.state==='bound'){const owner=value.owner;return {state:'bound',sessionId:owner.sessionId,documentId:owner.documentId,ownerToken:owner.ownerToken,createdAt:owner.createdAt,adoption:owner.adoption.kind,...(owner.adoption.kind==='explicit-legacy'?{historyDigest:owner.adoption.historyDigest}:{})};}return {...value};}
