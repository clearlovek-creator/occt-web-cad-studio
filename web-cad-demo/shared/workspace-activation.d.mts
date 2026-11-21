export type WorkspaceActivation={protocolVersion:1;operation:'project.activate';documentId:string;sourceDocumentId:string;requestId:string;sourceRevision:number|null;sourceStateToken:string|null;sourceStateSequence:number|null};
export function normalizeWorkspaceActivation(value:unknown):WorkspaceActivation;
export function normalizeWorkspaceActivationProof(value:unknown,expected:WorkspaceActivation):WorkspaceActivation;
