export type StepImportReport={version:1;decompositionVersion?:number;rootCount?:number;emptyRootCount?:number;bodyCount?:number;solidCount?:number;sheetCount?:number;wireCount?:number;otherCount?:number;invalidBodyCount?:number;ambiguousSubshapeMetadata?:number;modelLengthUnit?:string;sourceLengthUnits?:string[];assemblyHierarchyRetained?:boolean;applicationRepairApplied?:boolean;translatorShapeProcessing?:string};
export type StepImportPhase='receiving'|'queued'|'preparing'|'converting'|'committing'|'complete'|'failed'|'interrupted'|'unknown';
export type StepImportStatus={version:1;documentId:string;requestId:string;fileName:string;phase:StepImportPhase;sequence:number;createdAt:string;updatedAt:string;bytes?:number;revision?:number;stateToken?:string;report?:StepImportReport|null;code?:string;error?:string;unchanged?:boolean;recovered?:boolean;reportDurable?:boolean;taskId?:string};
export const STEP_IMPORT_PHASES:StepImportPhase[];
export function activeStepImport(phase:string):boolean;
export function stepImportReport(value:unknown):StepImportReport|null;
export function normalizeStepImportStatus(value:unknown,documentId:string,requestId?:string):StepImportStatus|null;
