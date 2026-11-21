import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const MESH_ADMISSION_MEMO_LIMITS=Object.freeze({entries:32,bytes:8*1024*1024,reportBytes:1024*1024});
const hash=/^[a-f0-9]{64}$/;
const digest=value=>value&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&hash.test(value.sha256);
/** No cross-epoch optimization for mutable workspace-source workers. Sealed
 * children independently validate the same release before loading any task. */
export function admissionRuntimeKey(environment=process.env){
  const directory=environment.CAD_BACKEND_RELEASE_DIR,id=environment.CAD_BACKEND_RELEASE_ID,manifest=environment.CAD_BACKEND_MANIFEST_SHA256;
  if(typeof directory!=='string'||typeof id!=='string'||!/^backend-[A-Za-z0-9-]+$/.test(id)||typeof manifest!=='string'||!hash.test(manifest))return null;
  try{if(fs.realpathSync(path.join(directory,'runtime'))!==fs.realpathSync(fileURLToPath(new URL('../',import.meta.url))))return null;}catch{return null;}
  return id+'/'+manifest;
}
export function meshAdmissionMemoKey(job,runtimeKey){
  if(!runtimeKey||job?.kind==='preparation'||!job?.source||job.source.documentId!==job.documentId||!digest(job.artifact?.result)||!digest(job.artifact?.quality))return null;
  try{return crypto.createHash('sha256').update(JSON.stringify([runtimeKey,job.jobId,job.documentId,job.kind||'mesh',job.source,job.options,job.processResources,job.preparationSummary,...['result','quality','mesh','render','preparedBrep','preparedManifest'].map(key=>job.artifact[key])])).digest('hex');}catch{return null;}
}
const message=receipt=>JSON.stringify([receipt.version,receipt.key,receipt.runtimeKey,receipt.admission]);
export function verifyMeshAdmissionReceipt(receipt,job,authority){
  if(!authority?.runtimeKey||typeof authority.secret!=='string'||!hash.test(authority.secret)||!receipt||receipt.version!==1||receipt.runtimeKey!==authority.runtimeKey||receipt.key!==meshAdmissionMemoKey(job,authority.runtimeKey)||!hash.test(receipt.mac||''))return null;
  try{const expected=crypto.createHmac('sha256',Buffer.from(authority.secret,'hex')).update(message(receipt)).digest(),actual=Buffer.from(receipt.mac,'hex');if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;return structuredClone(receipt.admission);}catch{return null;}
}
/** Process-local, authority-issued results only. Every use STILL hashes all
 * original files in MeshJobStore; this is not a stat/mtime or persisted pass. */
export class MeshAdmissionMemo{
  #entries=new Map();#secret;#runtimeKey;#bytes=0;#metrics={hits:0,misses:0,writes:0,evictions:0,oversize:0};
  constructor({runtimeKey=admissionRuntimeKey(),maxEntries=MESH_ADMISSION_MEMO_LIMITS.entries,maxBytes=MESH_ADMISSION_MEMO_LIMITS.bytes,maxReportBytes=MESH_ADMISSION_MEMO_LIMITS.reportBytes}={}){
    if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>128||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024||!Number.isSafeInteger(maxReportBytes)||maxReportBytes<1||maxReportBytes>1024*1024||maxReportBytes>maxBytes)throw Error('Invalid admission memo budget');
    this.maxEntries=maxEntries;this.maxBytes=maxBytes;this.maxReportBytes=maxReportBytes;this.#runtimeKey=typeof runtimeKey==='string'&&runtimeKey?runtimeKey:null;this.#secret=crypto.randomBytes(32).toString('hex');
  }
  authority(){return this.#runtimeKey?{runtimeKey:this.#runtimeKey,secret:this.#secret}:null;}
  status(){return {enabled:Boolean(this.#runtimeKey),scope:this.#runtimeKey?'verified-release-process':'disabled-workspace-source',entries:this.#entries.size,bytes:this.#bytes,maxEntries:this.maxEntries,maxBytes:this.maxBytes,maxReportBytes:this.maxReportBytes,metrics:{...this.#metrics}};}
  get(job){const key=meshAdmissionMemoKey(job,this.#runtimeKey),entry=key&&this.#entries.get(key);if(!entry){this.#metrics.misses++;return null;}this.#entries.delete(key);this.#entries.set(key,entry);this.#metrics.hits++;return JSON.parse(entry.bytes.toString('utf8'));}
  put(job,admission){
    const key=meshAdmissionMemoKey(job,this.#runtimeKey);if(!key||admission?.version!==1||!['accepted','warning','blocked','unverified'].includes(admission.status)||admission.usable!==['accepted','warning'].includes(admission.status))return false;
    let bytes;try{const receipt={version:1,key,runtimeKey:this.#runtimeKey,admission:structuredClone(admission)};receipt.mac=crypto.createHmac('sha256',Buffer.from(this.#secret,'hex')).update(message(receipt)).digest('hex');bytes=Buffer.from(JSON.stringify(receipt));}catch{return false;}
    if(bytes.length>this.maxReportBytes||bytes.length>this.maxBytes){this.#metrics.oversize++;return false;}
    if(this.#entries.has(key)){this.#bytes-=this.#entries.get(key).bytes.length;this.#entries.delete(key);}
    while(this.#entries.size>=this.maxEntries||this.#bytes+bytes.length>this.maxBytes){const oldest=this.#entries.keys().next().value;this.#bytes-=this.#entries.get(oldest).bytes.length;this.#entries.delete(oldest);this.#metrics.evictions++;}
    this.#entries.set(key,{jobId:job.jobId,bytes});this.#bytes+=bytes.length;this.#metrics.writes++;return true;
  }
  dropJob(jobId){for(const[key,entry]of this.#entries)if(entry.jobId===jobId){this.#bytes-=entry.bytes.length;this.#entries.delete(key);}}
  clear(){this.#entries.clear();this.#bytes=0;}
}
