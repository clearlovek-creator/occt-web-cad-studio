import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const STEP_SOURCE_ALGORITHM='sha256-chain-1m-v1';
const blockSize=1024*1024;
const digest=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
function stepProof(){
  const hash=createHash('sha256');let state='webcad-step-sha256-chain-1m-v1',total=0,index=0;
  return {update(part){hash.update(part);state=digest(`${state}:${index++}:${digest(part)}`);total+=part.length;},finish(){return {size:total,sha256:hash.digest('hex'),fingerprint:digest(state+':'+total),algorithm:STEP_SOURCE_ALGORITHM};}};
}
export class StepSourceError extends Error{constructor(code,message){super(message);this.name='StepSourceError';this.code=code;}}
const fail=(code,message)=>new StepSourceError(code,message);

/** Lexical containment and every path component must be real, never a link. */
function checkedStepPath(file,dataDir,{roots=['imports','project-assets'],allowMissing=false}={}){
  if(typeof file!=='string'||!path.isAbsolute(file)||! /\.(?:step|stp)$/i.test(file))throw fail('PROJECT_SOURCE_UNTRUSTED','STEP 来源不在受管目录或类型无效，拒绝读取外部路径。');
  const source=path.resolve(file),base=path.resolve(dataDir);
  let root,relative;
  for(const name of roots){const candidate=path.join(base,name),part=path.relative(candidate,source);if(part&&part!=='..'&&!part.startsWith('..'+path.sep)&&!path.isAbsolute(part)){root=candidate;relative=part;break;}}
  if(!root)throw fail('PROJECT_SOURCE_UNTRUSTED','STEP 来源不在受管工程目录，拒绝读取外部路径。');
  // Windows aliases and alternate data streams must not bypass the same path
  // boundary in the Node validator and the native file replacement helper.
  if(relative.split(path.sep).some(part=>!part||/[<>:"|?*\x00-\x1f]/.test(part)||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))throw fail('PROJECT_SOURCE_UNTRUSTED','STEP 来源包含不明确或保留的文件名，未访问该路径。');
  try{
    const baseStat=fs.lstatSync(base);if(!baseStat.isDirectory()||baseStat.isSymbolicLink())throw fail('PROJECT_SOURCE_UNTRUSTED','工程来源目录不能是链接。');
    let current=root;const pieces=relative.split(path.sep);
    for(let index=-1;index<pieces.length;index++){
      if(index>=0)current=path.join(current,pieces[index]);let stat;try{stat=fs.lstatSync(current);}catch(error){if(allowMissing&&error.code==='ENOENT')return source;throw error;}
      if(stat.isSymbolicLink()||(index<pieces.length-1?!stat.isDirectory():!stat.isFile()||stat.nlink!==1))throw fail('PROJECT_SOURCE_UNTRUSTED','STEP 来源路径含链接或异常文件类型，未读取内容。');
    }
    return source;
  }catch(error){if(error?.code==='ENOENT')throw fail('PROJECT_SOURCE_MISSING','STEP 来源丢失；请恢复原始来源后再保存或重算。');throw error;}
}
export function managedStepPath(file,dataDir){return checkedStepPath(file,dataDir);}
/** Destination only. Missing components are allowed; this never creates them. */
export function managedStepDestination(file,dataDir){return checkedStepPath(file,dataDir,{allowMissing:true});}
/** Private repair artifacts are never valid active modeling sources. */
export function restorationStepPath(file,dataDir,{allowMissing=false}={}){return checkedStepPath(file,dataDir,{roots:['source-restores'],allowMissing});}

/** Same 1 MiB chained fingerprint as OCCT StepImport, plus ordinary file SHA256. */
export function readManagedStepSource(file,dataDir,{maxBytes=512*1024*1024,retainBytes=true}={}){
  const source=managedStepPath(file,dataDir),entry=fs.lstatSync(source,{bigint:true});let fd;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0||entry.size>BigInt(maxBytes))throw fail('PROJECT_TOO_LARGE','STEP 来源总量超过工程包大小限制。');
  try{
    fd=fs.openSync(source,'r');const before=fs.fstatSync(fd,{bigint:true});if(!same(entry,before)||!before.isFile()||before.nlink!==1n)throw fail('PROJECT_SOURCE_CHANGED','STEP 来源在打开时发生变化，未采用结果。');
    const proof=stepProof(),buffer=Buffer.allocUnsafe(blockSize),chunks=[];let total=0;
    for(;;){
      // A read may legally return fewer bytes than requested. Native ifstream
      // fingerprints fixed 1 MiB blocks, so fill each block before hashing it.
      let filled=0;while(filled<blockSize){const bytes=fs.readSync(fd,buffer,filled,blockSize-filled,null);if(!bytes)break;filled+=bytes;}
      if(!filled)break;total+=filled;if(total>maxBytes)throw fail('PROJECT_TOO_LARGE','STEP 来源读取超过大小限制。');
      const part=buffer.subarray(0,filled);proof.update(part);if(retainBytes)chunks.push(Buffer.from(part));
    }
    const after=fs.fstatSync(fd,{bigint:true}),current=fs.lstatSync(managedStepPath(source,dataDir),{bigint:true});
    if(total!==Number(before.size)||!same(before,after)||!same(before,current))throw fail('PROJECT_SOURCE_CHANGED','STEP 来源在读取时发生变化，未采用结果。');
    return {bytes:retainBytes?Buffer.concat(chunks,total):undefined,...proof.finish()};
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}

/** Background audits yield at every I/O block and retain only one 1 MiB buffer. */
async function hashStepSource(file,dataDir,{maxBytes=512*1024*1024,signal}={},validate=managedStepPath){
  const check=()=>{if(signal?.aborted)throw fail('SOURCE_INSPECTION_INTERRUPTED','来源内容检查已停止。');};check();
  const source=validate(file,dataDir),entry=fs.lstatSync(source,{bigint:true});
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0||entry.size>BigInt(maxBytes))throw fail('PROJECT_TOO_LARGE','STEP 来源总量超过检查预算。');
  const handle=await fs.promises.open(source,'r');
  try{
    check();const before=await handle.stat({bigint:true});if(!same(entry,before)||!before.isFile()||before.nlink!==1n)throw fail('PROJECT_SOURCE_CHANGED','STEP 来源在打开时发生变化。');
    const proof=stepProof(),buffer=Buffer.allocUnsafe(blockSize);let total=0;
    for(;;){
      let filled=0;while(filled<blockSize){check();const {bytesRead}=await handle.read(buffer,filled,blockSize-filled,null);if(!bytesRead)break;filled+=bytesRead;}
      check();if(!filled)break;total+=filled;if(total>maxBytes)throw fail('PROJECT_TOO_LARGE','STEP 来源读取超过检查预算。');proof.update(buffer.subarray(0,filled));
    }
    const after=await handle.stat({bigint:true}),current=fs.lstatSync(validate(source,dataDir),{bigint:true});check();
    if(total!==Number(before.size)||!same(before,after)||!same(before,current))throw fail('PROJECT_SOURCE_CHANGED','STEP 来源在读取期间发生变化，未采用结果。');
    return {...proof.finish(),stamp:['dev','ino','size','mtimeNs','ctimeNs'].map(key=>before[key].toString()).join(':')};
  }finally{await handle.close();}
}
export function hashManagedStepSource(file,dataDir,options){return hashStepSource(file,dataDir,options);}
export function hashRestorationStepSource(file,dataDir,options){return hashStepSource(file,dataDir,options,restorationStepPath);}

export function verifyStepSource(reference,actual){
  const expected=reference?.sourceFingerprint,algorithm=reference?.sourceFingerprintAlgorithm;
  if(expected===undefined&&algorithm===undefined){if(Number(reference?.decompositionVersion)>=2)throw fail('PROJECT_SOURCE_PROOF_INVALID','新版 STEP 来源缺少应有的内容指纹，不能降级为旧版未认证来源。');return 'legacy-unverified';}
  if(algorithm!==STEP_SOURCE_ALGORITHM||typeof expected!=='string'||! /^[a-f0-9]{64}$/.test(expected))throw fail('PROJECT_SOURCE_PROOF_INVALID','STEP 来源指纹缺失或算法不受支持，不能确认与建模来源一致。');
  if(expected!==actual.fingerprint)throw fail('PROJECT_SOURCE_CHANGED','STEP 来源已改变，与建模时的文件不一致；请恢复原始字节或显式重新导入，未生成工程包。');
  return 'verified';
}
