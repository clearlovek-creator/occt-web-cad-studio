import crypto from 'node:crypto';
import {normalizeDiscreteTetraSettings,CAD_DISCRETE_TETRA_SOURCE_BYTES,CAD_DISCRETE_TETRA_RESULT_BYTES} from '../shared/discrete-tetra-task.mjs';
import {captureMeshSource,assessMeshSource} from '../shared/mesh-source.mjs';
import {captureProjectDiscreteSource,validateProjectDiscreteSourceSnapshot} from './discrete-surface-source.mjs';
import {captureCadMeshMaterials,validateCadMeshMaterials,resolveCadCellMaterials} from './cad-mesh-materials.mjs';
import {assertVolumePartitionInput,assertConstrainedVolumeInput} from './volume-partition-protocol.mjs';
import {assertDiscreteTetraInput,assertDiscreteTetraResult,DISCRETE_TETRA_PROTOCOL as P} from './discrete-tetra-protocol.mjs';
import {assertNativeMemoryGuard,meshMemoryPolicy} from './native-resource-policy.mjs';
import {assertOptimizationCheckpointInput,assertCheckpointOptimizationResult,MESH_CHECKPOINT_PROTOCOL as CP} from './mesh-checkpoint-protocol.mjs';
import {buildConstrainedSurfacePatches} from './constrained-surface-patches.mjs';
import {assertPatchedDiscreteTetraInput,assertPatchedDiscreteTetraResult,PATCHED_DISCRETE_TETRA_PROTOCOL as PP} from './patched-tetra-protocol.mjs';
import {assertPatchedOptimizationInput,assertPatchedOptimizationResult,PATCHED_MESH_CHECKPOINT_PROTOCOL as PCP} from './patched-checkpoint-protocol.mjs';

const SOURCE_BASIS='cad-discrete-tetra-source-v1',RESULT_BASIS='cad-source-bound-partition-tetra-v1';
export const CAD_CONSTRAINED_TETRA_SOURCE_BASIS='cad-discrete-constrained-tetra-source-v1';
export const CAD_CONSTRAINED_TETRA_RESULT_BASIS='cad-source-bound-constrained-tetra-v1';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,names)=>plain(value)&&Object.keys(value).length===names.length&&Object.keys(value).every(key=>names.includes(key));
const fault=(code,message,details)=>Object.assign(Error(message),{code,retryableByModel:false,...(details&&{details})});
const invalid=()=>fault('MESH_DISCRETE_BINDING_INVALID','离散体网格的工程来源、材料、输入或退出证明不一致，未接纳结果。');
const cancelled=signal=>{if(signal?.aborted)throw fault('MESH_CANCELLED','离散体网格已取消，没有接纳迟到结果。');};
const bounded=(value,limit)=>{const wire=JSON.stringify(value);if(Buffer.byteLength(wire)>limit)throw fault('MESH_DISCRETE_ARTIFACT_LIMIT','完整离散体网格材料超过预算，未截断保存。');return wire;};
const sourceInput=snapshot=>({...snapshot.cad.bundle.input,options:{...snapshot.settings.repair}});
const tetraInput=(snapshot,domain)=>({domain,meshSize:snapshot.settings.meshSize,quality:{...snapshot.settings.quality},...(snapshot.settings.optimization&&{optimization:{...snapshot.settings.optimization}})});
export const isConstrainedCadTetraSource=snapshot=>snapshot?.version===2&&snapshot.basis===CAD_CONSTRAINED_TETRA_SOURCE_BASIS;
export function cadPatchedTetraInput(snapshot,domain){
  if(!isConstrainedCadTetraSource(snapshot))throw invalid();
  const input=tetraInput(snapshot,domain);return {...input,patchPlan:buildConstrainedSurfacePatches(input,{sourceInput:sourceInput(snapshot)})};
}

/** Captures geometry and used material definitions within the SAME document
 * action. Not a caller-supplied mesh import or a display-tessellation fallback. */
export async function captureProjectDiscreteTetraSource({settings,allowSheets=false,...capture}){
  const normalized=normalizeDiscreteTetraSettings(settings),materials=[];cancelled(capture.signal);
  if(typeof capture.command!=='function')throw invalid();
  const cad=await captureProjectDiscreteSource({...capture,options:normalized.source,command:async(operation,fields)=>{
    const response=await capture.command(operation,fields);
    if(operation==='document.summary'&&response?.ok===true)materials.push(captureCadMeshMaterials(response,captureMeshSource(response,capture.documentId)));
    return response;
  }});
  cancelled(capture.signal);
  if(materials.length!==2||!same(materials[0],materials[1]))throw fault('MESH_MATERIAL_SOURCE_CHANGED','捕获期间材料赋值或定义已变化，没有采用混合工程来源。');
  const constrained=allowSheets&&cad.bundle.inventory.faces.some(face=>face.uses.some(use=>use.solidId===''));
  const snapshot={version:constrained?2:1,basis:constrained?CAD_CONSTRAINED_TETRA_SOURCE_BASIS:SOURCE_BASIS,cad,materials:materials[0],settings:normalized};
  return validateCadDiscreteTetraSnapshot(snapshot);
}
// Internal trusted capture only, not an API option supplied by the browser.
// Only trusted service capture may choose this family; it is not an API option.
export const captureProjectConstrainedTetraSource=options=>captureProjectDiscreteTetraSource({...options,allowSheets:true});

export function validateCadDiscreteTetraSnapshot(snapshot){
  const constrained=isConstrainedCadTetraSource(snapshot);
  if(!fields(snapshot,['version','basis','cad','materials','settings'])||!constrained&&(snapshot.version!==1||snapshot.basis!==SOURCE_BASIS))throw invalid();
  const settings=normalizeDiscreteTetraSettings(snapshot.settings);if(!same(settings,snapshot.settings))throw invalid();
  validateProjectDiscreteSourceSnapshot(snapshot.cad,snapshot.cad?.source,settings.source);
  validateCadMeshMaterials(snapshot.materials,snapshot.cad.source);
  // A planar Sheet may have only two triangles. Diagnose the unsupported CAD
  // domain before the generic closed-volume minimum of four triangles.
  const sheets=snapshot.cad.bundle.inventory.faces.some(face=>face.uses.some(use=>use.solidId===''));
  if(sheets&&!constrained)throw fault('VOLUME_FREE_SHEET_UNSUPPORTED','当前离散体域剖分不支持开放 Sheet；没有忽略该几何，也未启动体域分区或四面体进程。');
  if(constrained&&!sheets)throw invalid();
  if(constrained&&!snapshot.cad.bundle.inventory.solids.length)throw fault('VOLUME_SOLID_REQUIRED','四面体剖分需要至少一个真实闭合实体，开放面不会被提升为体积。');
  (constrained?assertConstrainedVolumeInput:assertVolumePartitionInput)(sourceInput(snapshot));
  bounded(snapshot,CAD_DISCRETE_TETRA_SOURCE_BYTES);return snapshot;
}

function assertTetraExecution(output,basis=P.basis){
  const a=output.algorithm,e=output.execution;
  if(a?.version!==1||a.basis!==basis||a.gmshVersion!==P.gmshVersion||a.apiVersion!==P.apiVersion||a.license!==P.license||e?.basis!=='single-process-exit-confirmed-v1'||e.exitCode!==0||e.automaticReplay!==false)throw invalid();
  if([PP.basis,PCP.optimizationBasis].includes(basis)&&a.patchTopologyBasis!==PP.patchTopologyBasis)throw invalid();
  if(basis===PCP.optimizationBasis&&(a.snapshotBasis!==PCP.snapshotBasis||a.embeddedRelationships!==true||a.generationInputBinding!==PCP.generationInputBinding))throw invalid();
  const policy=meshMemoryPolicy({MESH_WORKER_MEMORY_LIMIT_BYTES:String(output.processResources?.processLimitBytes)});
  assertNativeMemoryGuard({ok:true,protocolVersion:1,service:'gmsh-mesh-worker',capabilities:{version:1,processResources:output.processResources}},policy,'gmsh-mesh-worker');
}

/** Pure artifact validation, used again after persistence. Does not rerun CGAL
 * or Gmsh, and does not grant normal mesh/render/MSH admission. */
export function validateCadDiscreteTetraResult(result,snapshot,{checkpoint}={}){
  validateCadDiscreteTetraSnapshot(snapshot);
  const constrained=isConstrainedCadTetraSource(snapshot);
  if(!fields(result,['version','basis','sourceSnapshotSha256','partition','output','cellMaterials','normalMeshAdmitted','appliedToCad',...(constrained?['patchPlan']:[])])||!(constrained?[3,4].includes(result.version): [1,2].includes(result.version))||result.basis!==(constrained?CAD_CONSTRAINED_TETRA_RESULT_BASIS:RESULT_BASIS)||result.sourceSnapshotSha256!==hash(snapshot)||result.normalMeshAdmitted!==false||result.appliedToCad!==false)throw invalid();
  const input={...tetraInput(snapshot,result.partition),...(constrained?{patchPlan:result.patchPlan}:{})};(constrained?assertPatchedDiscreteTetraInput:assertDiscreteTetraInput)(input,{sourceInput:sourceInput(snapshot)});
  const materials=resolveCadCellMaterials(snapshot,result.partition);
  if(materials.conflictCellCount||!same(materials,result.cellMaterials))throw invalid();
  if(constrained&&result.version===4){
    if(!checkpoint?.result||checkpoint.sourceSnapshotSha256!==hash(snapshot))throw invalid();
    const command={generationInput:input,checkpointResult:checkpoint.result};assertPatchedOptimizationInput(command,{sourceInput:sourceInput(snapshot)});assertPatchedOptimizationResult(result.output,command,result.output?.requestId);assertTetraExecution(result.output,PCP.optimizationBasis);
  }else if(constrained){
    if(checkpoint!==undefined)throw invalid();assertPatchedDiscreteTetraResult(result.output,input,result.output?.requestId);assertTetraExecution(result.output,PP.basis);
  }else if(result.version===2){
    if(!checkpoint?.result||checkpoint.sourceSnapshotSha256!==hash(snapshot))throw invalid();
    const command={generationInput:input,checkpointResult:checkpoint.result};assertOptimizationCheckpointInput(command,{sourceInput:sourceInput(snapshot)});assertCheckpointOptimizationResult(result.output,command,result.output?.requestId);assertTetraExecution(result.output,CP.optimizationBasis);
  }else{if(checkpoint!==undefined)throw invalid();assertDiscreteTetraResult(result.output,input,result.output?.requestId);assertTetraExecution(result.output);}
  bounded(result,CAD_DISCRETE_TETRA_RESULT_BYTES);const mesh=cadTetraMesh(result);
  return {version:1,basis:constrained?CAD_CONSTRAINED_TETRA_RESULT_BASIS:RESULT_BASIS,bodyCount:snapshot.cad.source.bodies.length,faceCount:snapshot.cad.bundle.inventory.faces.length,solidCount:snapshot.cad.bundle.inventory.solids.length,cellCount:result.partition.cells.length,tetraCount:mesh.report.tetraCount,nodeCount:mesh.points.length,quality:mesh.quality,unassignedCellCount:materials.unassignedCellCount,normalMeshAdmitted:false,appliedToCad:false};
}
export const cadTetraMesh=result=>[2,4].includes(result.version)?result.output.mesh:result.output;
export const isConstrainedCadTetraResult=result=>[3,4].includes(result?.version)&&result.basis===CAD_CONSTRAINED_TETRA_RESULT_BASIS;
export function cadTetraSurfaceRows(result){
  const output=cadTetraMesh(result);if(!isConstrainedCadTetraResult(result))return output.boundaries;
  return output.patches.map((row,i)=>({...row,sourceTriangleIds:[...new Set(result.patchPlan.patches[i].triangleIndexes.flatMap(t=>result.partition.sourceTriangleIds[t]))].sort((a,b)=>a-b),normalReference:{triangleIndex:row.sourceTriangleIndexes[0],orientation:row.sourceTriangleOrientations[0]}}));
}

/** Construction only. The managed artifact boundary validates this value
 * against source, partition, quality and actual native execution before seal. */
export function assembleCadDiscreteTetraResult(snapshot,partition,output,{isolated=false,patchPlan}={}){
  const constrained=isConstrainedCadTetraSource(snapshot);if(constrained&&!patchPlan)throw invalid();
  return {version:constrained?isolated?4:3:isolated?2:1,basis:constrained?CAD_CONSTRAINED_TETRA_RESULT_BASIS:RESULT_BASIS,sourceSnapshotSha256:hash(snapshot),partition,output,...(constrained?{patchPlan}:{}),cellMaterials:resolveCadCellMaterials(snapshot,partition),normalMeshAdmitted:false,appliedToCad:false};
}

/** Existing single-job clients own process lifetime. This coordinator binds
 * their verified outputs to the immutable actual-CAD snapshot, with no replay. */
export async function executeCadDiscreteTetra({snapshot,partitionClient,tetraClient,signal}){
  cancelled(signal);
  const fixed=validateCadDiscreteTetraSnapshot(JSON.parse(bounded(snapshot,CAD_DISCRETE_TETRA_SOURCE_BYTES))),snapshotHash=hash(fixed),input=sourceInput(fixed),inputHash=hash(input);
  const constrained=isConstrainedCadTetraSource(fixed),partitionMethod=constrained?'partitionConstrained':'partition',tetraMethod=constrained?'tetrahedralizePatched':'tetrahedralize';
  if(typeof partitionClient?.[partitionMethod]!=='function'||typeof tetraClient?.[tetraMethod]!=='function')throw invalid();
  const partition=await partitionClient[partitionMethod](input,{signal});cancelled(signal);
  if(hash(fixed)!==snapshotHash||hash(input)!==inputHash)throw invalid();
  const command=constrained?cadPatchedTetraInput(fixed,partition):tetraInput(fixed,partition);(constrained?assertPatchedDiscreteTetraInput:assertDiscreteTetraInput)(command,{sourceInput:input});
  const cellMaterials=resolveCadCellMaterials(fixed,partition);
  if(cellMaterials.conflictCellCount)throw fault('MESH_MATERIAL_CONFLICT','交叠体域包含不一致的材料赋值，已停止体网格生成；请先明确材料归属。',cellMaterials);
  const commandHash=hash(command),output=await tetraClient[tetraMethod](command,{sourceInput:input,signal});cancelled(signal);
  if(hash(fixed)!==snapshotHash||hash(input)!==inputHash||hash(command)!==commandHash)throw invalid();
  const result=assembleCadDiscreteTetraResult(fixed,partition,output,{...(constrained?{patchPlan:command.patchPlan}:{})});
  validateCadDiscreteTetraResult(result,fixed);return result;
}

export function assessCadDiscreteTetraSource(snapshot,view){
  validateCadDiscreteTetraSnapshot(snapshot);const geometry=assessMeshSource(snapshot.cad.source,view,snapshot.cad.source.documentId);
  if(geometry.status!=='current')return {...geometry,basis:'geometry-and-used-materials-v1'};
  let current;try{current=captureCadMeshMaterials(view,captureMeshSource(view));}catch{return {status:'unverified',reason:'当前材料清单无法完整验证，离散体网格保持隐藏。',changedBodyIds:[],basis:'geometry-and-used-materials-v1'};}
  if(current.sha256!==snapshot.materials.sha256)return {status:'stale',reason:'材料赋值或使用中的材料定义已变化，请重新核对剖分结果。',changedBodyIds:[],basis:'geometry-and-used-materials-v1'};
  return {...geometry,basis:'geometry-and-used-materials-v1'};
}
