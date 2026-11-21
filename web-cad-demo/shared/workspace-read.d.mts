export type WorkspaceRead={protocolVersion:1;operation:'project.read';documentId:string;requestId:string};
export function normalizeWorkspaceRead(value:unknown):WorkspaceRead;
export function normalizeWorkspaceReadProof(value:unknown,expected:WorkspaceRead):WorkspaceRead;
