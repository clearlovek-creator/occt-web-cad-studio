import {assessMeshSource} from '../../shared/mesh-source.mjs';
import {assessMeshMaterialSource} from '../../shared/mesh-material-source.mjs';
import type {MeshJobPayload} from './mesh.ts';

/** Local invalidation also covers resident GPU chunks; it must not wait for a
 * subsequent network read to notice a material edit. */
export function assessMeshDisplaySource(result:MeshJobPayload,view:unknown,documentId:string){
  const geometry=assessMeshSource(result.meshJob.source,view,documentId);
  return geometry.status!=='current'||result.meshJob.kind!=='discrete-tetra'?geometry:assessMeshMaterialSource(result.derivedMaterialSource,view,result.meshJob.source);
}
