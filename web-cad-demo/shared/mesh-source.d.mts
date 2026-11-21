export type MeshSource = {version:1;documentId:string;revision:number|null;bodies:Array<{bodyId:string;kind:string;bodyIdentity:string;topologyIdentity:string;topologyRevision:number}>};
export type MeshFreshness = {status:"current"|"stale"|"unverified";reason:string;changedBodyIds:string[]};
export function captureMeshSource(view: unknown, documentId?: string): MeshSource;
export function assessMeshSource(source: MeshSource | undefined, view: unknown, documentId?: string): MeshFreshness;
export function qualifyMeshGroups<T>(groups:T[],source:MeshSource):T[];
