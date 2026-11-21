export type MeshRecoveryRequest={requestId:string;failedStateToken:string};
export type MeshRecoveryInfo={version:1;state:'available'|'checking'|'failed'|'complete';failedStateToken:string;requestId?:string;code?:string;error?:string};
export function parseMeshRecoveryRequest(value:unknown):MeshRecoveryRequest;
export function parseMeshRecoveryInfo(value:unknown):MeshRecoveryInfo;
