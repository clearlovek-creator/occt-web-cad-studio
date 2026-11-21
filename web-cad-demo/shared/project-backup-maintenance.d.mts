export type BackupMaintenanceRecord={reviewId:string;documentId:string;entryId:string;state:'reviewed'|'prepared'|'isolated'|'completed';snapshotDigest:string;createdAt:string;expiresAt:string;expired:boolean;running:boolean;files:{name:'backup.cadproj'|'receipt.json';bytes:number;sha256:string}[];outcome?:'removed'|'already-absent'};
export type BackupMaintenanceResponse={ok:true;version:1;maintenance:BackupMaintenanceRecord};
export type BackupMaintenanceList={ok:true;version:1;documentId:string;records:BackupMaintenanceRecord[];unreadableRecords:number};
export function normalizeBackupMaintenance(value:unknown,documentId:string):BackupMaintenanceRecord;
export function normalizeBackupMaintenanceResponse(value:unknown,documentId:string,reviewId?:string):BackupMaintenanceResponse;
export function normalizeBackupMaintenanceList(value:unknown,documentId:string):BackupMaintenanceList;
