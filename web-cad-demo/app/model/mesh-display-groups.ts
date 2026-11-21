import type {MeshJobPayload} from './mesh';

/** Body-level controls select authenticated ROOT groups only. Constrained
 * Sheet roots are already persisted as Face groups; keep those file bytes and
 * distinguish them from the optional Face children of a Solid. Admission and
 * current-source checks remain the caller's responsibility. */
export function bodyMeshRootGroupIds(result:Pick<MeshJobPayload,'mesh'|'meshJob'>):Set<string>{
  const constrained=result.mesh.boundaryMapping?.backend==='cad-discrete-constrained-partition-v1';
  const sheets=new Set(result.meshJob.source?.bodies.filter(body=>body.kind==='sheet').map(body=>body.bodyId));
  return new Set(result.mesh.render?.groups?.filter(group=>group.kind==='solid'||group.sourceBodySurface===true||constrained&&group.kind==='face'&&sheets.has(group.bodyId)).map(group=>group.groupId));
}
