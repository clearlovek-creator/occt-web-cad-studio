import {captureMeshSource} from './mesh-source.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bytes=value=>new TextEncoder().encode(value).byteLength;
const invalid=()=>Object.assign(Error('工程材料赋值或定义不完整，未猜测材料、忽略冲突或采用部分清单。'),{code:'MESH_MATERIAL_SOURCE_INVALID',retryableByModel:false});
export function canonicalMeshMaterial(value,depth=0){
  if(depth>12)throw invalid();
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value))return value.map(item=>canonicalMeshMaterial(item,depth+1));
  if(!plain(value))throw invalid();
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalMeshMaterial(value[key],depth+1)]));
}
export const isMeshMaterialName=value=>typeof value==='string'&&bytes(value)<=128&&!/[\x00-\x1f\x7f,]/.test(value);

/** Shared, bounded material projection. Presentation-only edits and unused definitions
 * do not invalidate a mesh; assignments and definitions actually used by it do. */
export function captureMeshMaterialSource(view,source=captureMeshSource(view)){
  if(!Array.isArray(view?.materials)||view.materials.length>10000||!Array.isArray(view?.bodyMetadata)||view.bodyMetadata.length!==source.bodies.length)throw invalid();
  const definitions=new Map();
  for(const record of view.materials){if(!plain(record)||!isMeshMaterialName(record.name)||!record.name||definitions.has(record.name))throw invalid();definitions.set(record.name,record);}
  const metadata=new Map(view.bodyMetadata.map(body=>[body.bodyId,body]));if(metadata.size!==source.bodies.length)throw invalid();
  const used=new Set(),bodies=source.bodies.map(body=>{
    const current=metadata.get(body.bodyId);if(!current||!isMeshMaterialName(current.material))throw invalid();
    if(current.material){if(!definitions.has(current.material))throw invalid();used.add(current.material);}
    return {bodyId:body.bodyId,material:current.material||null};
  });
  const materials=[...used].sort().map(name=>({name,definition:canonicalMeshMaterial(definitions.get(name))}));
  const value={version:1,basis:'cad-body-material-snapshot-v1',bodies,materials};
  if(bytes(JSON.stringify(value))>2*1024**2)throw invalid();
  return value;
}

export function assessMeshMaterialSource(binding,view,source){
  try{
    if(!plain(binding)||binding.version!==1||binding.basis!=='cad-body-material-snapshot-v1'||!Array.isArray(binding.bodies)||!Array.isArray(binding.materials)||!source)throw invalid();
    const expected={version:binding.version,basis:binding.basis,bodies:binding.bodies,materials:binding.materials};
    if(JSON.stringify(canonicalMeshMaterial(captureMeshMaterialSource(view,source)))!==JSON.stringify(canonicalMeshMaterial(expected)))return {status:'stale',reason:'材料赋值或使用中的材料定义已变化，结果保持隐藏。',changedBodyIds:[]};
    return {status:'current',reason:'几何与材料来源均有效。',changedBodyIds:[]};
  }catch{return {status:'unverified',reason:'材料来源无法完整核对，结果保持隐藏。',changedBodyIds:[]};}
}
