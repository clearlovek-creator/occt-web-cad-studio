import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MiB=1024**2,GiB=1024**3;
const fault=(code,message)=>Object.assign(Error(message),{code});
const inside=(root,target)=>target===root||target.startsWith(root+path.sep);
export function meshStoragePolicy(environment=process.env){
  const integer=(name,fallback,min,max)=>{const raw=environment[name];if(raw!==undefined&&(typeof raw!=='string'||!/^\d{1,16}$/.test(raw)))throw fault('MESH_STORAGE_CONFIG_INVALID',name+' 必须为整数字节值。');const value=raw===undefined?fallback:Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)throw fault('MESH_STORAGE_CONFIG_INVALID',name+' 超出允许范围。');return value;};
  const maxBytes=integer('MESH_STORAGE_MAX_BYTES',64*GiB,MiB,1024*GiB),reservationBytes=integer('MESH_STORAGE_RESERVATION_BYTES',4*GiB,64*1024,8*GiB),minimumFreeBytes=integer('MESH_STORAGE_MIN_FREE_BYTES',GiB,0,1024*GiB);
  if(reservationBytes>maxBytes)throw fault('MESH_STORAGE_CONFIG_INVALID','单任务磁盘预留不能大于网格存储总预算。');
  return {version:1,maxBytes,reservationBytes,minimumFreeBytes,maxEntries:250000,maxDepth:12,maxScanMs:15000};
}

/** Logical admission, not an OS quota or a physical disk reservation.
 * Counts mesh files, imported project assets and transaction staging, including unknown files;
 * never deletes data to admit a new task. Uses asynchronous bounded inventory. */
export class MeshStorageBudget {
  constructor({dataDir,policy=meshStoragePolicy(),fsImpl=fs,clock=Date.now,monotonic=()=>performance.now()}={}){
    const validated=meshStoragePolicy({MESH_STORAGE_MAX_BYTES:String(policy.maxBytes),MESH_STORAGE_RESERVATION_BYTES:String(policy.reservationBytes),MESH_STORAGE_MIN_FREE_BYTES:String(policy.minimumFreeBytes)});
    for(const key of ['maxEntries','maxDepth','maxScanMs'])if(policy[key]!==undefined&&(!Number.isSafeInteger(policy[key])||policy[key]<1||policy[key]>validated[key]))throw fault('MESH_STORAGE_CONFIG_INVALID','磁盘清点预算无效。');
    this.policy={...validated,...Object.fromEntries(['maxEntries','maxDepth','maxScanMs'].filter(key=>policy[key]!==undefined).map(key=>[key,policy[key]]))};this.dataDir=path.resolve(dataDir);this.fs=fsImpl;this.clock=clock;this.monotonic=monotonic;this.leases=new Map();this.tail=Promise.resolve();this.waiting=0;this.last=null;this.lastError=null;
  }
  status(){return {basis:'logical-mesh-bytes-and-free-space-admission-v1',...this.policy,reservations:this.leases.size,reservedBytes:this.leases.size*this.policy.reservationBytes,waiting:this.waiting,last:this.last?{...this.last}:null,lastError:this.lastError};}
  serial(action){if(this.waiting>=32)return Promise.reject(fault('MESH_STORAGE_BUSY','磁盘容量准入队列已满。'));this.waiting++;const work=this.tail.then(action);this.tail=work.catch(()=>{});return work.finally(()=>this.waiting--);}
  async inventory(){
    const started=this.monotonic(),root=await this.fs.realpath(this.dataDir);let bytes=0,entries=0,files=0;
    const check=()=>{if(++entries>this.policy.maxEntries||this.monotonic()-started>this.policy.maxScanMs)throw fault('MESH_STORAGE_SCAN_LIMIT','网格存储清点超过条目或时间预算；没有按不完整清单准入。');};
    const walk=async(directory,depth)=>{
      check();if(depth>this.policy.maxDepth)throw fault('MESH_STORAGE_SCAN_LIMIT','网格存储目录层级超过清点预算。');
      let stat;try{stat=await this.fs.lstat(directory,{bigint:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(!stat.isDirectory()||stat.isSymbolicLink()||!inside(root,await this.fs.realpath(directory)))throw fault('MESH_STORAGE_UNSAFE','网格存储包含链接或异常目录；未准入，也未清理原文件。');
      const handle=await this.fs.opendir(directory);try{for await(const entry of handle){
        check();const file=path.join(directory,entry.name);let item;try{item=await this.fs.lstat(file,{bigint:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(item.isSymbolicLink())throw fault('MESH_STORAGE_UNSAFE','网格存储包含链接；未跟随或清理。');
        if(item.isDirectory())await walk(file,depth+1);
        else if(item.isFile()&&item.nlink===1n){const size=Number(item.size);if(!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(bytes+size))throw fault('MESH_STORAGE_SCAN_LIMIT','网格存储字节数不可准确表示。');bytes+=size;files++;}
        else throw fault('MESH_STORAGE_UNSAFE','网格存储包含多链接或非普通文件；未准入。');
      }}catch(error){try{await handle.close();}catch{/* for-await may already have closed it. */}throw error;}
    };
    for(const name of ['mesh-jobs','mesh-sources','meshes','project-assets','mesh-asset-registry','mesh-asset-state','project-transactions'])await walk(path.join(root,name),0);
    const free=await this.fs.statfs(root,{bigint:true}),available=free.bavail*free.bsize;check();if(available<0n||available>BigInt(Number.MAX_SAFE_INTEGER))throw fault('MESH_STORAGE_UNAVAILABLE','无法核对磁盘可用空间。');
    return {bytes,availableBytes:Number(available),files,entries,observedAt:new Date(this.clock()).toISOString()};
  }
  async inspect(reservations,additionalBytes=0){try{const value=await this.inventory();this.last=value;this.lastError=null;const reservedBytes=reservations*this.policy.reservationBytes;if(value.bytes+reservedBytes+additionalBytes>this.policy.maxBytes)throw fault('MESH_STORAGE_CAPACITY','网格存储预算不足；请明确删除不再需要的任务/文件后重试，现有工程和结果未自动删除。');if(value.availableBytes<reservedBytes+additionalBytes+this.policy.minimumFreeBytes)throw fault('MESH_STORAGE_FREE_SPACE','磁盘可用空间不足以保留任务余量；未开始新的网格写入。');return value;}catch(error){this.lastError=error.code?.startsWith('MESH_STORAGE_')?error.code:'MESH_STORAGE_UNAVAILABLE';if(error.code?.startsWith('MESH_STORAGE_'))throw error;throw fault('MESH_STORAGE_UNAVAILABLE','网格存储清点未完成；未准入新任务。');}}
  verifyPublication(additionalBytes){return this.serial(()=>{if(!Number.isSafeInteger(additionalBytes)||additionalBytes<0||additionalBytes>32*1024*1024)throw fault('MESH_STORAGE_REQUEST_INVALID','完成凭据写入预算无效。');return this.inspect(this.leases.size,additionalBytes);});}
  reserve(owner){return this.serial(async()=>{if(typeof owner!=='string'||!owner||owner.length>160||this.leases.has(owner))throw fault('MESH_STORAGE_REQUEST_INVALID','磁盘预留身份无效或重复。');await this.inspect(this.leases.size+1);const identity=crypto.randomUUID();this.leases.set(owner,identity);let released=false;return {bytes:this.policy.reservationBytes,verify:(options={})=>this.serial(()=>{if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='additionalBytes')||!Number.isSafeInteger(options.additionalBytes??0)||(options.additionalBytes??0)<0||(options.additionalBytes??0)>32*1024*1024)throw fault('MESH_STORAGE_REQUEST_INVALID','网格完成记录的额外写入预算无效。');if(released||this.leases.get(owner)!==identity)throw fault('MESH_STORAGE_RESERVATION_LOST','原磁盘预留不再有效，未发布结果。');return this.inspect(Math.max(0,this.leases.size-1),options.additionalBytes??0);}),release:()=>{if(released)return;released=true;if(this.leases.get(owner)===identity)this.leases.delete(owner);}};});}
}
