export const DISCRETE_MESH_FAMILY='cad-discrete-partition-v1';
export const DISCRETE_CONSTRAINED_MESH_FAMILY='cad-discrete-constrained-partition-v1';
export const isDiscreteMeshFamily=value=>[DISCRETE_MESH_FAMILY,DISCRETE_CONSTRAINED_MESH_FAMILY].includes(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),key=row=>row.bodyId+'/'+row.solidId;
const sorted=value=>[...new Set(value)].sort(),hash=value=>/^[a-f0-9]{64}$/.test(value||'');
const check=value=>{if(!value)throw Object.assign(Error('离散网格的来源分区、原始 Solid 或双向归属不完整。'),{code:'MESH_DISCRETE_PROJECTION_INVALID'});};
/** Structural cross-check only. The caller must independently authenticate the
 * original CAD snapshot and native result before selecting this family. */
export function validateDiscreteMeshFamily(mesh,source){
  const inventory=mesh?.sourceInventory,ownership=mesh?.render?.ownership,boundary=mesh?.boundaryMapping;
  const family=inventory?.basis,constrained=family===DISCRETE_CONSTRAINED_MESH_FAMILY;
  check(inventory?.version===2&&isDiscreteMeshFamily(family)&&ownership?.mode===family&&boundary?.version===2&&boundary.backend===family);
  check(inventory.provenance?.version===1&&['sourceSnapshotSha256','partitionSha256','nativeResultSha256'].every(field=>hash(inventory.provenance[field]))&&same(inventory.provenance,ownership.provenance)&&same(inventory.provenance,boundary.provenance));
  const bodies=new Set(source?.bodies?.filter(body=>body.kind==='solid').map(body=>body.bodyId)||[]);
  check((constrained?source.bodies.every(body=>['solid','sheet'].includes(body.kind)):bodies.size===source?.bodies?.length)&&bodies.size>0&&Array.isArray(inventory.sourceSolids)&&inventory.sourceSolids.length>0&&Array.isArray(inventory.cells)&&inventory.cells.length>0);
  const sheetFaces=new Set();
  if(constrained){
    check(Array.isArray(inventory.sourceSheetFaces)&&inventory.sourceSheetFaces.length>0);const allBodies=new Set(source.bodies.map(b=>b.bodyId));
    for(const row of inventory.sourceSheetFaces){const id=row.bodyId+'/'+row.cadFaceId;check(allBodies.has(row.bodyId)&&!sheetFaces.has(id)&&boundary.sourceFaces.some(f=>f.source.bodyId===row.bodyId&&f.source.cadFaceId===row.cadFaceId));sheetFaces.add(id);}
    check(source.bodies.filter(b=>b.kind==='sheet').every(b=>inventory.sourceSheetFaces.some(f=>f.bodyId===b.bodyId)));
  }else check(inventory.sourceSheetFaces===undefined);
  const solidKeys=new Set();inventory.sourceSolids.forEach((row,index)=>{check(row.sourceSolidIndex===index&&bodies.has(row.bodyId)&&typeof row.solidId==='string'&&row.solidId.length>0&&!solidKeys.has(key(row)));solidKeys.add(key(row));});
  check(same(sorted(inventory.sourceSolids.map(row=>row.bodyId)),sorted(bodies)));
  const cellOwners=new Map(),usedSolids=new Set();
  inventory.cells.forEach((cell,index)=>{
    check(cell.cellIndex===index&&Array.isArray(cell.sourceSolidIndexes)&&cell.sourceSolidIndexes.length>0&&same(cell.sourceSolidIndexes,[...new Set(cell.sourceSolidIndexes)].sort((a,b)=>a-b))&&cell.sourceSolidIndexes.every(i=>Number.isSafeInteger(i)&&i>=0&&i<inventory.sourceSolids.length));
    for(const i of cell.sourceSolidIndexes)usedSolids.add(i);
    const bodyIds=sorted(cell.sourceSolidIndexes.map(i=>inventory.sourceSolids[i].bodyId));check(same(cell.bodyIds,bodyIds));cellOwners.set(index,bodyIds);
  });check(usedSolids.size===inventory.sourceSolids.length);
  check(Array.isArray(ownership.assignments)&&Array.isArray(mesh.render.groups));const assigned=new Set(),grouped=new Set();
  for(const row of ownership.assignments){
    const cell=inventory.cells[row.partitionCellIndex],id=row.partitionCellIndex+'/'+row.bodyId;
    check(cell&&row.volumeTag===cell.cellIndex+1&&row.preparedSolidIndex===undefined&&cellOwners.get(cell.cellIndex).includes(row.bodyId)&&!assigned.has(id));
    const ids=cell.sourceSolidIndexes.filter(i=>inventory.sourceSolids[i].bodyId===row.bodyId).map(i=>inventory.sourceSolids[i].solidId).sort();
    check(same(row.sourceSolidIds,ids));assigned.add(id);
  }
  const surfaceGroups=new Set();
  for(const group of mesh.render.groups){
    if(constrained&&group.kind==='face'){
      const surface=boundary.surfaces.find(s=>s.meshFaceId===group.meshFaceId),id=group.meshFaceId+'/'+group.bodyId;
      check(surface&&!surfaceGroups.has(id)&&group.wireKey==='wire-2-'+surface.surfaceTag);
      const expected=sorted(surface.sources.filter(s=>s.bodyId===group.bodyId&&sheetFaces.has(s.bodyId+'/'+s.cadFaceId)).map(s=>s.cadFaceId));
      check(expected.length>0&&same(group.cadFaceIds,expected));surfaceGroups.add(id);continue;
    }
    check(group.kind==='solid');const cell=inventory.cells[group.partitionCellIndex],id=group.partitionCellIndex+'/'+group.bodyId;
    check(cell&&group.solidId==='solid-'+(cell.cellIndex+1)&&group.solidIndex===undefined&&cellOwners.get(cell.cellIndex).includes(group.bodyId)&&!grouped.has(id));
    const ids=cell.sourceSolidIndexes.filter(i=>inventory.sourceSolids[i].bodyId===group.bodyId).map(i=>inventory.sourceSolids[i].solidId).sort();check(same(group.sourceSolidIds,ids));grouped.add(id);
  }
  const expected=[...cellOwners].flatMap(([index,ids])=>ids.map(id=>index+'/'+id));check(expected.length===assigned.size&&expected.length===grouped.size&&expected.every(id=>assigned.has(id)&&grouped.has(id)));
  if(constrained){const wanted=boundary.surfaces.flatMap(surface=>sorted(surface.sources.filter(s=>sheetFaces.has(s.bodyId+'/'+s.cadFaceId)).map(s=>s.bodyId)).map(bodyId=>surface.meshFaceId+'/'+bodyId));check(wanted.length===surfaceGroups.size&&wanted.every(id=>surfaceGroups.has(id)));}
  return inventory;
}
