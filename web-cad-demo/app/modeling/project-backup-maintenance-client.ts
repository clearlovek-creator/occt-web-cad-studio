import {normalizeBackupMaintenanceResponse,normalizeBackupMaintenanceList,normalizeBackupMaintenance,type BackupMaintenanceRecord} from '../../shared/project-backup-maintenance.mjs';
import {requestProjectBackupMetadata} from './project-backup-catalog-client.ts';
import {ProjectBackupReadError} from './project-backup-read.ts';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const unknown=()=>new ProjectBackupReadError('PROJECT_BACKUP_MAINTENANCE_UNCONFIRMED','维护回复与原清单不一致，请读取原清单核对；不会自动重复清理。');
export class BackupMaintenanceClient{
  private apiRoot:string;private fetchImpl:typeof fetch;private timeoutMs:number;
  constructor(apiRoot:string,fetchImpl:typeof fetch,timeoutMs=120000){this.apiRoot=apiRoot;this.fetchImpl=fetchImpl;this.timeoutMs=timeoutMs;}
  private root(documentId:string){if(!/^[A-Za-z0-9_-]{1,64}$/.test(documentId))throw new TypeError('工程身份无效。');return `${this.apiRoot}/documents/${encodeURIComponent(documentId)}/project/backup-maintenance`;}
  private reviewId(id:string){if(!UUID.test(id))throw new TypeError('维护清单标识无效。');return id;}
  async list(documentId:string,signal?:AbortSignal){return normalizeBackupMaintenanceList(await requestProjectBackupMetadata(this.fetchImpl,this.root(documentId),{signal,maintenance:true}),documentId);}
  async get(documentId:string,reviewId:string,signal?:AbortSignal){return normalizeBackupMaintenanceResponse(await requestProjectBackupMetadata(this.fetchImpl,`${this.root(documentId)}/${this.reviewId(reviewId)}`,{signal,maintenance:true}),documentId,reviewId).maintenance;}
  async preview(documentId:string,entryId:string){
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.pending)?$/.test(entryId))throw new TypeError('维护材料标识无效。');
    const value=await requestProjectBackupMetadata(this.fetchImpl,this.root(documentId),{method:'POST',body:{entryId},maintenance:true,timeoutMs:this.timeoutMs});
    try{const record=normalizeBackupMaintenanceResponse(value,documentId).maintenance;if(record.entryId!==entryId||record.state!=='reviewed')throw unknown();return record;}catch{throw unknown();}
  }
  async commit(documentId:string,value:BackupMaintenanceRecord){
    const original=normalizeBackupMaintenance(value,documentId);if(original.state==='completed')throw new TypeError('已完成的清单不需要再次执行。');
    try{
      const packet=await requestProjectBackupMetadata(this.fetchImpl,`${this.root(documentId)}/${this.reviewId(original.reviewId)}/commit`,{method:'POST',body:{snapshotDigest:original.snapshotDigest},maintenance:true,timeoutMs:this.timeoutMs});
      const record=normalizeBackupMaintenanceResponse(packet,documentId,original.reviewId).maintenance;
      if(record.snapshotDigest!==original.snapshotDigest||record.entryId!==original.entryId||record.state!=='completed')throw unknown();return {record,recovered:false};
    }catch(reason){
      const error=reason instanceof TypeError?unknown():reason;
      // Resolve a lost receipt by GET only, never by repeating commit.
      if(error instanceof ProjectBackupReadError&&error.code==='PROJECT_BACKUP_MAINTENANCE_UNCONFIRMED'){
        try{const record=await this.get(documentId,original.reviewId);if(record.snapshotDigest===original.snapshotDigest&&record.entryId===original.entryId&&record.state==='completed')return {record,recovered:true};}catch{/* Keep the original unknown result, not a guessed failure or retry. */}
      }
      throw error;
    }
  }
  async discard(documentId:string,reviewId:string){
    const value=await requestProjectBackupMetadata(this.fetchImpl,`${this.root(documentId)}/${this.reviewId(reviewId)}`,{method:'DELETE',maintenance:true,timeoutMs:this.timeoutMs}) as Record<string,unknown>;
    if(!value||Object.keys(value).some(key=>!['ok','documentId','reviewId','recordDeleted','materialDeleted'].includes(key))||value.ok!==true||value.documentId!==documentId||value.reviewId!==reviewId||value.recordDeleted!==true||value.materialDeleted!==false)throw unknown();return {recordDeleted:true as const,materialDeleted:false as const};
  }
}
