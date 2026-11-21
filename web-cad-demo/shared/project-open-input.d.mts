export type ProjectOpenInput={protocolVersion:1;operation:'project.open';documentId:string;sourceDocumentId:string;requestId:string;fileName:string;expectedBytes:number;sourceRevision?:number;sourceStateToken?:string;sourceStateSequence?:number};
export function normalizeProjectOpenInput(value:unknown,maxBytes?:number):ProjectOpenInput;
export function projectOpenCanonical(value:unknown):string;
export type ProjectOpenTask=ProjectOpenInput&{version:1;taskId:string;canUpload:boolean};
export function normalizeProjectOpenTask(value:unknown,task:import('./modeling-task-status.mjs').ModelingTaskStatus,sourceDocumentId?:string,expectedInput?:ProjectOpenInput):ProjectOpenTask;
