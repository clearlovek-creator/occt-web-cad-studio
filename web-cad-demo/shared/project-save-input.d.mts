export type ProjectSaveInput={protocolVersion:1;operation:'project.save';documentId:string;requestId:string;baseRevision?:number;baseStateToken?:string;baseStateSequence?:number;copyName?:string};
export function normalizeProjectSaveInput(value:unknown):ProjectSaveInput;
export function projectSaveCanonical(value:unknown):string;
export type ProjectSaveTask=ProjectSaveInput&{version:1;taskId:string;canGenerate:boolean};
export type ProjectBackupReceipt={ok:true;documentId:string;requestId:string;revision:number;stateToken:string;stateSequence:number;projectBackup:{version:1;taskId:string;fileName:string;bytes:number;sha256:string;workspaceToken:string;createdAt:string;downloadPath:string}};
export function normalizeProjectSaveTask(value:unknown,task:import('./modeling-task-status.mjs').ModelingTaskStatus,expectedInput?:ProjectSaveInput):ProjectSaveTask;
export function normalizeProjectBackupReceipt(value:unknown,task:import('./modeling-task-status.mjs').ModelingTaskStatus,expectedInput?:ProjectSaveInput):ProjectBackupReceipt;
export function normalizeStoredProjectBackupReceipt(value:unknown,documentId:string,taskId:string):ProjectBackupReceipt;
