import type {ProjectBackupReceipt} from './project-save-input.mjs';
export type ProjectBackupEntry={entryId:string;taskId:string;stage:'pending'|'published';state:'available'|'generating'|'retained'|'unavailable';integrity:'not-checked'|'unavailable';busy:boolean;canDownload:boolean;canDelete:boolean;receipt?:ProjectBackupReceipt};
export type ProjectBackupCatalog={ok:true;version:1;documentId:string;snapshot:string;entries:ProjectBackupEntry[];total:number;nextCursor:string|null;storage:{unattributedEntries:number;retainedMaterial:boolean}};
export function normalizeProjectBackupEntry(value:unknown,documentId:string):ProjectBackupEntry;
export function normalizeProjectBackupCatalog(value:unknown,documentId:string):ProjectBackupCatalog;
export function normalizeProjectBackupMetadata(value:unknown,documentId:string,taskId:string):ProjectBackupEntry;
