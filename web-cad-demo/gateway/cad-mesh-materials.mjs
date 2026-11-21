import crypto from 'node:crypto';
import {captureMeshSource} from '../shared/mesh-source.mjs';
import {canonicalMeshMaterial as canonical,isMeshMaterialName as materialName,captureMeshMaterialSource} from '../shared/mesh-material-source.mjs';
const MAX_BYTES=2*1024**2;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fault=()=>Object.assign(Error('工程材料赋值或定义不完整，未猜测材料、忽略冲突或采用部分清单。'),{code:'MESH_MATERIAL_SOURCE_INVALID',retryableByModel:false});
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fields=(value,names)=>plain(value)&&Object.keys(value).length===names.length&&Object.keys(value).every(key=>names.includes(key));

export function captureCadMeshMaterials(view,source=captureMeshSource(view)){
  const value=captureMeshMaterialSource(view,source);
  return {...value,sha256:hash(value)};
}

export function validateCadMeshMaterials(value,source){
  if(!fields(value,['version','basis','bodies','materials','sha256'])||value.version!==1||value.basis!=='cad-body-material-snapshot-v1'||!Array.isArray(value.bodies)||!Array.isArray(value.materials)||value.bodies.length!==source.bodies.length||value.materials.length>source.bodies.length||Buffer.byteLength(JSON.stringify(value))>MAX_BYTES)throw fault();
  const view={documentId:source.documentId,bodyMetadata:value.bodies.map((body,i)=>{
    if(!fields(body,['bodyId','material'])||body.bodyId!==source.bodies[i]?.bodyId||body.material!==null&&(!materialName(body.material)||!body.material))throw fault();
    return {...source.bodies[i],material:body.material||''};
  }),materials:value.materials.map(material=>{
    if(!fields(material,['name','definition'])||!plain(material.definition)||material.name!==material.definition.name)throw fault();return material.definition;
  })};
  const actual=captureCadMeshMaterials(view,source);
  if(hash(actual)!==hash(value))throw fault();return value;
}

export function resolveCadCellMaterials(snapshot,domain){
  validateCadMeshMaterials(snapshot.materials,snapshot.cad.source);
  const inventory=new Set(snapshot.cad.bundle.inventory.solids.map(solid=>JSON.stringify([solid.bodyId,solid.solidId]))),byBody=new Map(snapshot.materials.bodies.map(body=>[body.bodyId,body.material]));
  if(domain.sourceSolids.length!==inventory.size||domain.sourceSolids.some(solid=>!inventory.delete(JSON.stringify([solid.bodyId,solid.solidId])))||inventory.size)throw fault();
  const cells=domain.cells.map((cell,cellIndex)=>{
    const sources=cell.sourceSolidIndexes.map(index=>{const solid=domain.sourceSolids[index];if(!solid||!byBody.has(solid.bodyId))throw fault();return {bodyId:solid.bodyId,solidId:solid.solidId,material:byBody.get(solid.bodyId)};});
    const distinct=[...new Set(sources.map(solid=>solid.material))];
    return {cellIndex,sourceSolidIndexes:[...cell.sourceSolidIndexes],sources,resolution:distinct.length>1?'conflict':distinct[0]===null?'unassigned':'consistent',material:distinct.length===1?distinct[0]:null};
  });
  return {version:1,basis:'exact-cell-membership-consistent-cad-material-v1',policy:'require-consistent',conflictCellCount:cells.filter(cell=>cell.resolution==='conflict').length,unassignedCellCount:cells.filter(cell=>cell.resolution==='unassigned').length,cells,materialPriorityAssigned:false};
}
