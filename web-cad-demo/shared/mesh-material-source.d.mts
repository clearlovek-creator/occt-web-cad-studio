import type {MeshSource,MeshFreshness} from './mesh-source.mjs';
export type MeshMaterialSource={version:1;basis:'cad-body-material-snapshot-v1';bodies:{bodyId:string;material:string|null}[];materials:{name:string;definition:Record<string,unknown>}[];sha256?:string};
export function canonicalMeshMaterial(value:unknown,depth?:number):unknown;
export function isMeshMaterialName(value:unknown):boolean;
export function captureMeshMaterialSource(view:unknown,source?:MeshSource):MeshMaterialSource;
export function assessMeshMaterialSource(binding:MeshMaterialSource|undefined,view:unknown,source:MeshSource|undefined):MeshFreshness;
