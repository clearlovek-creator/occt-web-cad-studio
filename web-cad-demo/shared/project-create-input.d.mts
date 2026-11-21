export type ProjectCreateInput={protocolVersion:1;operation:'project.create';documentId:string;sourceDocumentId:string;requestId:string;name:string;sourceRevision:number;sourceStateToken:string;sourceStateSequence:number};
export function normalizeProjectCreateInput(value:unknown):ProjectCreateInput;
export function projectCreateCanonical(value:unknown):string;
export type ProjectCreateTask=ProjectCreateInput&{version:1;taskId:string;canCreate:boolean};
export function normalizeProjectCreateTask(value:unknown,task:import('./modeling-task-status.mjs').ModelingTaskStatus,sourceDocumentId?:string,expectedInput?:ProjectCreateInput):ProjectCreateTask;
export type ProjectCreateReceipt={ok:true;requestId:string;documentId:string;revision:number;stateToken:string;stateSequence:number;projectCreate:ProjectCreateTask;bodyCount:0;featureCount:0;[key:string]:unknown};
export function normalizeProjectCreateReceipt(value:unknown,task:import('./modeling-task-status.mjs').ModelingTaskStatus,expectedInput:ProjectCreateInput):ProjectCreateReceipt;
