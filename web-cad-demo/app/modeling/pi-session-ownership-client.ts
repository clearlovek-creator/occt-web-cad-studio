import {normalizePiOwnership,piOwnerProof,type PiOwnership} from './pi-ownership-proof.ts';
import {PiOwnerLocalBackups,withPiOwnerStorageLock,type PiOwnerBackupSummary} from './pi-owner-local-backup.ts';
export {normalizePiOwnership,type PiOwnership} from './pi-ownership-proof.ts';
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type Pending={version:1;sessionId:string;documentId:string;historyDigest:string};
export type PiOwnershipState={ownership:PiOwnership|null;reading:boolean;submitting:boolean;repairing:boolean;pending:boolean;blocked:boolean;error:string|null;backups:PiOwnerBackupSummary[];backupError:string|null};
export const piOwnershipPendingKey=(apiRoot:string,sessionId:string,documentId:string)=>`web-cad-pi-owner-pending:${encodeURIComponent(apiRoot)}:${documentId}:${sessionId}`;
const hash=/^[a-f0-9]{64}$/;
export class PiSessionOwnershipClient{
  private apiRoot:string;readonly sessionId:string;readonly documentId:string;private storage:StorageLike;private fetcher:typeof fetch;private changed:(value:PiOwnershipState)=>void;
  readonly key:string;private state:PiOwnershipState={ownership:null,reading:false,submitting:false,repairing:false,pending:false,blocked:false,error:null,backups:[],backupError:null};private pending:Pending|null=null;private pendingBytes:string|null=null;private disposed=false;private readPromise:Promise<PiOwnership>|null=null;private invalidCache=false;private invalidValue:string|null=null;private backups:PiOwnerLocalBackups;private listeners=new Set<(value:PiOwnershipState)=>void>();
  constructor(apiRoot:string,sessionId:string,documentId:string,storage:StorageLike,fetcher:typeof fetch=(input,init)=>fetch(input,init),changed:(value:PiOwnershipState)=>void=()=>{}){
    this.apiRoot=apiRoot;this.sessionId=sessionId;this.documentId=documentId;this.storage=storage;this.fetcher=fetcher;this.changed=changed;
    this.key=piOwnershipPendingKey(apiRoot,sessionId,documentId);
    this.backups=new PiOwnerLocalBackups(storage,this.key,apiRoot,sessionId,documentId);
    try{const bytes=storage.getItem(this.key);this.invalidValue=bytes;if(bytes!==null){if(bytes.length>1024)throw Error();const value=JSON.parse(bytes);if(value?.version!==1||value.sessionId!==sessionId||value.documentId!==documentId||!hash.test(value.historyDigest||'')||Object.keys(value).length!==4)throw Error();this.pending=value;this.pendingBytes=bytes;this.state.pending=true;}this.invalidValue=null;}catch{this.invalidCache=true;this.state.blocked=true;this.state.error='本地归属恢复记录异常，已保留原记录；未发送确认。';}
    try{this.state.backups=this.backups.list();}catch(error){this.state.backupError=error instanceof Error?error.message:'本地恢复备份不可读取。';}
  }
  snapshot(){return structuredClone(this.state);}
  subscribe(listener:(value:PiOwnershipState)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private emit(patch:Partial<PiOwnershipState>){if(this.disposed)return;this.state={...this.state,...patch};this.changed(this.snapshot());for(const listener of this.listeners)listener(this.snapshot());}
  close(){this.disposed=true;}
  private async record(value:Pending|null){return withPiOwnerStorageLock(this.key,async()=>{if(this.invalidCache)throw Error('本地归属恢复记录异常，未覆盖。');const before=this.storage.getItem(this.key),expected=this.pendingBytes;if(before!==expected&&!(before===null&&value===null))throw Error('另一个页面已改变归属核对记录，未发送确认。');let nextBytes:string|null=null;if(value){nextBytes=JSON.stringify(value);this.storage.setItem(this.key,nextBytes);if(this.storage.getItem(this.key)!==nextBytes)throw Error('归属请求身份无法保存，未发送确认。');}else{this.storage.removeItem(this.key);if(this.storage.getItem(this.key)!==null)throw Error('本地恢复标记移除尚未确认，请只读核对原结果。');}this.pending=value;this.pendingBytes=nextBytes;this.emit({pending:Boolean(value)});});}
  private async request(method:'GET'|'POST',body?:unknown){
    const response=await this.fetcher(`${this.apiRoot}/pi/session-ownership/${encodeURIComponent(this.sessionId)}${method==='GET'?`?documentId=${encodeURIComponent(this.documentId)}&preview=1`:''}`,{method,cache:'no-store',signal:AbortSignal.timeout(30000),...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const text=await response.text();if(text.length>1024*1024)throw Error('归属响应超过预算。');const value=JSON.parse(text);
    if(!response.ok||value?.ok!==true){const error=new Error(value?.error||'归属请求未完成。') as Error&{notStarted?:boolean};error.notStarted=value?.outcome==='not-started';throw error;}
    if(value.version!==1)throw Error('归属服务协议不匹配。');return normalizePiOwnership(value.ownership,this.sessionId,this.documentId);
  }
  inspect():Promise<PiOwnership>{if(this.disposed||this.state.repairing)return Promise.reject(Error('核对窗口已关闭或正在恢复本地记录。'));if(this.readPromise)return this.readPromise;this.emit({reading:true,error:null});const work=(async()=>{try{const owner=await this.request('GET');if(this.disposed)throw Error('核对窗口已关闭，旧回复未采用。');if(this.pending&&owner.state==='bound'){if(owner.adoption!=='explicit-legacy'||owner.historyDigest!==this.pending.historyDigest)throw Error('已保存归属与原确认不一致，未连接会话。');await this.record(null);}this.emit({ownership:owner});return owner;}catch(error){this.emit({error:error instanceof Error?error.message:'归属尚未确认。'});throw error;}finally{this.emit({reading:false});this.readPromise=null;}})();this.readPromise=work;return work;}
  async adopt(confirmed:boolean){
    const owner=this.state.ownership;if(this.disposed||this.state.reading||this.state.submitting||this.state.repairing||this.pending||this.invalidCache||!confirmed||owner?.state!=='legacy'||!owner.preview?.messages.length||owner.preview.skippedLines)throw Error('请先只读核对历史并明确确认，未知请求不能重复提交。');
    this.emit({submitting:true,error:null});
    try{await this.record({version:1,sessionId:this.sessionId,documentId:this.documentId,historyDigest:owner.historyDigest!});const result=await this.request('POST',{documentId:this.documentId,historyDigest:owner.historyDigest});if(result.state!=='bound'||result.adoption!=='explicit-legacy'||result.historyDigest!==owner.historyDigest)throw Error('归属确认回复不匹配，请只读检查原请求。');await this.record(null);this.emit({ownership:result});return result;}catch(error){if((error as Error&{notStarted?:boolean}).notStarted&&!this.disposed)await this.record(null);this.emit({error:error instanceof Error?error.message:'归属结果尚未确认，请只读检查。'});throw error;}finally{this.emit({submitting:false});}
  }
  async repairCache(confirmed:boolean,isCurrent:()=>boolean=()=>true){
    const shown=this.state.ownership,original=this.invalidValue;
    if(this.disposed||!isCurrent()||this.state.reading||this.state.submitting||this.state.repairing||!confirmed||!this.invalidCache||original===null||shown?.state!=='bound')throw Error('请先只读核对后台已确认的当前工程归属，再明确同意保留并修复本地记录。');
    const expected=JSON.stringify(piOwnerProof(shown));this.emit({repairing:true,error:null});
    try{return await withPiOwnerStorageLock(this.key,async()=>{
      const owner=await this.request('GET');if(this.disposed||!isCurrent())throw Error('核对窗口已关闭，未修改本地恢复记录。');if(JSON.stringify(piOwnerProof(owner))!==expected)throw Error('后台归属在核对期间变化，未修复本地记录。');
      const backup=await this.backups.prepare(original,owner);if(this.disposed||!isCurrent())throw Error('核对窗口已关闭，未修改本地恢复记录。');
      const current=this.storage.getItem(this.key);if(current!==original&&!(current===null&&backup.alreadyPreserved))throw Error('其他页面已改变待恢复记录，未清除或覆盖新记录。');
      backup.publish();if(this.storage.getItem(this.key)!==current)throw Error('待恢复记录在备份期间变化，原备份已保留，未清除新记录。');
      if(current!==null)this.storage.removeItem(this.key);if(this.storage.getItem(this.key)!==null)throw Error('原记录已备份，但移除标记尚未确认；请再次核对，不要清理备份。');
      this.invalidCache=false;this.invalidValue=null;this.pending=null;this.pendingBytes=null;this.emit({blocked:false,pending:false,ownership:owner,backups:this.backups.list(),backupError:null});return backup.summary;
    });}catch(error){try{this.emit({backups:this.backups.list()});}catch(backupError){this.emit({backupError:backupError instanceof Error?backupError.message:'本地备份尚未确认。'});}this.emit({error:error instanceof Error?error.message:'本地记录恢复未完成，原材料已保留。'});throw error;}finally{this.emit({repairing:false});}
  }
  async exportBackup(id:string){return this.backups.export(id);}
}
