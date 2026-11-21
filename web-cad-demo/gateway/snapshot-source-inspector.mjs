import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {childExit,waitChildExit} from './child-exit.mjs';

export class SourceInspectionError extends Error{constructor(code,message){super(message);this.name='SourceInspectionError';this.code=code;}}
const fault=(code,message)=>new SourceInspectionError(code,message);
const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
function checkManagedSnapshot(file,roots){
  if(!roots.length)return;
  if(typeof file!=='string'||!path.isAbsolute(file))throw fault('SOURCE_SNAPSHOT_UNTRUSTED','检查点不在受管工程目录。');
  const target=path.resolve(file),root=roots.find(candidate=>{const relative=path.relative(candidate,target);return relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);});
  if(!root)throw fault('SOURCE_SNAPSHOT_UNTRUSTED','检查点不在受管工程目录。');
  let current=root;
  for(const part of ['',...path.relative(root,target).split(path.sep)]){
    current=part?path.join(current,part):current;
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink()||(current!==target&&!stat.isDirectory()))throw fault('SOURCE_SNAPSHOT_UNTRUSTED','检查点路径含链接或非受管目录。');
  }
}
async function fingerprint(file,maxBytes,signal){
  const entry=await fs.promises.lstat(file,{bigint:true});
  if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1n||entry.size<32n||entry.size>BigInt(maxBytes))throw fault('SOURCE_SNAPSHOT_INVALID','检查点文件类型或大小不符合来源检查要求。');
  const handle=await fs.promises.open(file,'r');
  try{
    const before=await handle.stat({bigint:true});if(!same(entry,before))throw fault('SOURCE_SNAPSHOT_CHANGED','检查点在打开时发生变化。');
    const hash=createHash('sha256'),header=Buffer.alloc(7);let total=0,filled=0;
    for await(const chunk of handle.createReadStream({highWaterMark:1024*1024,autoClose:false})){
      if(signal?.aborted)throw fault('SOURCE_INSPECTION_INTERRUPTED','来源检查已停止。');
      total+=chunk.length;if(total>maxBytes)throw fault('SOURCE_SNAPSHOT_INVALID','检查点超过来源检查大小限制。');
      if(filled<7){const count=Math.min(7-filled,chunk.length);chunk.copy(header,filled,0,count);filled+=count;}
      hash.update(chunk);
    }
    const after=await handle.stat({bigint:true}),current=await fs.promises.lstat(file,{bigint:true});
    if(header.toString('ascii')!=='BINFILE'||total!==Number(before.size)||!same(before,after)||!same(before,current))throw fault('SOURCE_SNAPSHOT_CHANGED','检查点内容无效或在完整性读取期间发生变化。');
    return {sha256:hash.digest('hex'),stat:before};
  }finally{await handle.close();}
}
function normalize(value){
  if(value?.ok!==true||value.version!==1||typeof value.metadataComplete!=='boolean'||!Array.isArray(value.sources)||value.sources.length>1000)throw fault('SOURCE_INSPECTOR_PROTOCOL','来源检查器响应结构无效。');
  const ids=new Set(),sources=value.sources.map(item=>{
    if(!item||typeof item.featureId!=='string'||! /^[A-Za-z0-9_-]{1,96}$/.test(item.featureId)||ids.has(item.featureId))throw fault('SOURCE_INSPECTOR_PROTOCOL','检查点含无效或重复的来源特征。');ids.add(item.featureId);
    const result={featureId:item.featureId};for(const key of ['state','sourcePath','fileName','sourceFingerprint','sourceFingerprintAlgorithm'])if(item[key]!==undefined){if(typeof item[key]!=='string'||item[key].length>(key==='sourcePath'?8192:512))throw fault('SOURCE_INSPECTOR_PROTOCOL','来源检查字段类型或长度无效。');result[key]=item[key];}
    if(item.decompositionVersion!==undefined){if(!Number.isSafeInteger(item.decompositionVersion)||item.decompositionVersion<1)throw fault('SOURCE_INSPECTOR_PROTOCOL','来源几何版本元数据无效。');result.decompositionVersion=item.decompositionVersion;}return result;
  });return {version:1,metadataComplete:value.metadataComplete,sources};
}

/** Bounded, isolated, read-only native inspection; never launches a CAD Worker. */
export class SnapshotSourceInspector {
  constructor({executablePath,roots=[],env=process.env,timeoutMs=30000,stopTimeoutMs=5000,maxSnapshotBytes=1024*1024*1024,spawnImpl=spawn}={}){
    this.roots=roots.map(root=>path.resolve(root));
    Object.assign(this,{executablePath,timeoutMs,stopTimeoutMs,maxSnapshotBytes,spawnImpl});this.env=Object.fromEntries(Object.entries(env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'].includes(key.toUpperCase())).map(([key,value])=>[key.toUpperCase(),value]));this.children=new Set();this.cache=new Map();this.cacheBytes=0;this.closed=false;
  }
  async inspect(file,{expectedSha256,signal}={}){
    if(this.closed||signal?.aborted)throw fault('SOURCE_INSPECTION_INTERRUPTED','来源检查已停止，未启动新的读取。');
    if(expectedSha256!==undefined&&! /^[a-f0-9]{64}$/.test(expectedSha256))throw fault('SOURCE_SNAPSHOT_INVALID','检查点缺少有效的内容证明。');
    checkManagedSnapshot(file,this.roots);
    const before=await fingerprint(file,this.maxSnapshotBytes,signal);checkManagedSnapshot(file,this.roots);if(expectedSha256&&before.sha256!==expectedSha256)throw fault('SOURCE_SNAPSHOT_CHECKSUM','检查点与历史清单指纹不一致，未采用来源引用。');
    if(this.closed||signal?.aborted)throw fault('SOURCE_INSPECTION_INTERRUPTED','来源检查已停止。');
    if(this.cache.has(before.sha256)){const cached=this.cache.get(before.sha256);this.cache.delete(before.sha256);this.cache.set(before.sha256,cached);return structuredClone(cached.value);}
    if(this.closed||signal?.aborted)throw fault('SOURCE_INSPECTION_INTERRUPTED','来源检查已停止。');
    if(!this.executablePath||!fs.existsSync(this.executablePath))throw fault('SOURCE_INSPECTOR_UNAVAILABLE','缺少只读检查点来源检查器，请构建 cad_snapshot_source_inspector 后重试。');
    if(this.children.size>=2)throw fault('SOURCE_INSPECTOR_BUSY','来源检查器仍在读取或等待退出，请稍后核对原任务。');
    const executable=process.platform==='win32'&&this.executablePath.length>=260?path.toNamespacedPath(this.executablePath):this.executablePath;
    const child=this.spawnImpl(executable,[],{env:this.env,windowsHide:true,stdio:['pipe','pipe','pipe']});this.children.add(child);
    const decoder=new StringDecoder('utf8');let reason=null,output='',bytes=0,stopTimer,timer,rejectExit;
    const stop=error=>{reason??=error;if(!child.killed)child.kill();if(!stopTimer)stopTimer=setTimeout(()=>{const error=fault('SOURCE_INSPECTOR_STOP_UNCONFIRMED','来源检查进程退出尚未确认，原进程仍受管理。');error.exitObserved=childExit(child);rejectExit?.(error);},this.stopTimeoutMs);};
    const aborted=()=>stop(fault('SOURCE_INSPECTION_INTERRUPTED','来源检查已中止，未修改任何几何或来源文件。'));
    signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
    try{
      await new Promise((resolve,reject)=>{
        rejectExit=reject;const exited=()=>{clearTimeout(stopTimer);output+=decoder.end();resolve();};child.once('close',exited);child.once('error',()=>{reason??=fault('SOURCE_INSPECTOR_UNAVAILABLE','只读来源检查器无法启动。');if(child.pid==null)exited();});
        timer=setTimeout(()=>stop(fault('SOURCE_INSPECTION_TIMEOUT','来源检查超过时间预算，未修改工程；请保留原文件并检查模型规模。')),this.timeoutMs);
        child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024){stop(fault('SOURCE_INSPECTOR_PROTOCOL','来源检查响应超过大小限制。'));return;}output+=decoder.write(chunk);});
        // Native diagnostics are private and bounded by the process pipe. Do not
        // copy paths or provider environment into API errors and normal logs.
        child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({path:path.resolve(file)})+'\n');
      });
      if(reason)throw reason;
      const lines=output.trim().split(/\r?\n/).filter(line=>line.startsWith('{'));if(lines.length!==1)throw fault('SOURCE_INSPECTOR_PROTOCOL','来源检查器没有返回唯一的结构化结果。');
      let raw;try{raw=JSON.parse(lines[0]);}catch{throw fault('SOURCE_INSPECTOR_PROTOCOL','来源检查响应无法解析。');}
      if(child.exitCode!==0||raw.ok!==true)throw fault('SOURCE_SNAPSHOT_UNREADABLE','检查点来源元数据无法读取，原始文件已保留。');
      const result=normalize(raw),after=await fingerprint(file,this.maxSnapshotBytes,signal);checkManagedSnapshot(file,this.roots);if(before.sha256!==after.sha256||!same(before.stat,after.stat))throw fault('SOURCE_SNAPSHOT_CHANGED','检查点在原生检查期间发生变化，未采用本次结果。');if(this.closed||signal?.aborted)throw fault('SOURCE_INSPECTION_INTERRUPTED','来源检查已停止。');
      const value={...result,snapshotSha256:before.sha256},size=Buffer.byteLength(JSON.stringify(value));this.cacheBytes-=this.cache.get(before.sha256)?.size||0;this.cache.set(before.sha256,{value,size});this.cacheBytes+=size;
      while(this.cache.size>128||this.cacheBytes>16*1024*1024){const [key,item]=this.cache.entries().next().value;this.cache.delete(key);this.cacheBytes-=item.size;}
      return structuredClone(value);
    }finally{clearTimeout(timer);clearTimeout(stopTimer);signal?.removeEventListener('abort',aborted);if(child.exitCode!==null||child.signalCode!==null||child.pid==null)this.children.delete(child);else child.once('exit',()=>this.children.delete(child));}
  }
  async close(){this.closed=true;await Promise.all([...this.children].map(async child=>{if(!child.killed)child.kill();await waitChildExit(child,{timeoutMs:this.stopTimeoutMs,code:'SOURCE_INSPECTOR_STOP_UNCONFIRMED'});this.children.delete(child);}));this.cache.clear();this.cacheBytes=0;}
}
