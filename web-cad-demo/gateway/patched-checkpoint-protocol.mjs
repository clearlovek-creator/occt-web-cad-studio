// SPDX-License-Identifier: GPL-3.0-or-later
import {isDeepStrictEqual as same} from 'node:util';
import {DiscreteTetraError,normalizeDiscreteTetraInput} from './discrete-tetra-protocol.mjs';
import {PATCHED_DISCRETE_TETRA_PROTOCOL as T,assertPatchedDiscreteTetraInput,assertPatchedDiscreteTetraResult,patchedDiscreteTetraFailure} from './patched-tetra-protocol.mjs';
import {MESH_CHECKPOINT_PROTOCOL,validateMeshCheckpoint,assertCheckpointBaselineQuality} from './mesh-checkpoint-protocol.mjs';
import {assertNativeMemoryGuard,meshMemoryPolicy} from './native-resource-policy.mjs';

export const PATCHED_MESH_CHECKPOINT_PROTOCOL=Object.freeze({...MESH_CHECKPOINT_PROTOCOL,
  basis:'gmsh-patched-mesh-checkpoint-v1',optimizationBasis:'gmsh-patched-checkpoint-optimization-v1',
  snapshotBasis:'bounded-gmsh-embedded-entity-mesh-v2',snapshotVersion:2,
  patchTopologyBasis:T.patchTopologyBasis,inputMeshBasis:T.basis,embeddedRelationships:true,
  generationInputBinding:'original-json-wire-v1',
});
const P=PATCHED_MESH_CHECKPOINT_PROTOCOL;
const fault=()=>new DiscreteTetraError('MESH_CHECKPOINT_INVALID','含交线的网格检查点与原实体、面片、节点、分类或嵌入关系不一致；未采用快照。');
const check=value=>{if(!value)throw fault();};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fields=(v,names)=>check(plain(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k)));
const sortedTags=tags=>Array.isArray(tags)&&tags.every((n,i)=>Number.isSafeInteger(n)&&n>=1&&n<=P.maxTag&&(i===0||n>tags[i-1]));
const orientedKey=nodes=>{const i=nodes.indexOf(Math.min(...nodes));return [0,1,2].map(j=>nodes[(i+j)%3]).join(',');};
const rawFields=['ok','basis','gmshVersion','patchTopologyBasis','patchDomainSha256','patchSourceInputSha256','points','cells','patches','quality','optimization','sourceSolids','sources','report'];
const rawEnvelope=(mesh,id)=>({...mesh,protocolVersion:1,requestId:id,service:'gmsh-mesh-worker',operation:'mesh.discrete-patched-tetra'});
const preserve=error=>{if(['MESH_CHECKPOINT_INVALID','MESH_CHECKPOINT_LIMIT','MESH_COVERAGE_LIMIT'].includes(error?.code))throw error;throw fault();};
function envelope(result,id,operation,basis,names){
  check(plain(result)&&Object.keys(result).every(k=>['ok','protocolVersion','requestId','service','operation','basis','gmshVersion','normalMeshAdmitted','algorithm','processResources','execution',...names].includes(k)));
  check(result.ok===true&&result.protocolVersion===1&&result.requestId===id&&result.service==='gmsh-mesh-worker'&&result.operation===operation&&result.basis===basis&&result.gmshVersion===P.gmshVersion&&result.normalMeshAdmitted===false);
}
export const normalizePatchedCheckpointInput=input=>normalizeDiscreteTetraInput(input);
export function patchedCheckpointRequest(input){const generationInput=normalizePatchedCheckpointInput(input);return {generationInput,generationInputWire:JSON.stringify(generationInput)};}
export function checkpointGenerationInput(saved){
  check(typeof saved?.generationInputWire==='string'&&Buffer.byteLength(saved.generationInputWire)<=T.maxRequestBytes);
  let input;try{input=JSON.parse(saved.generationInputWire);}catch{throw fault();}check(plain(input)&&JSON.stringify(input)===saved.generationInputWire&&same(input,saved.generationInput));return input;
}
export function patchedCheckpointBaselineInput(input){const {optimization,...base}=input;void optimization;return {...base,quality:{...base.quality,mode:'diagnostic'}};}
export function assertPatchedCheckpointInput(input,context){assertPatchedDiscreteTetraInput(input,context);check(input.optimization!==undefined);return input;}
export function assertPatchedCheckpointRequest(input,context){fields(input,['generationInput','generationInputWire']);const fixed=checkpointGenerationInput(input);assertPatchedCheckpointInput(fixed,context);return input;}
export function assertPatchedCheckpointHandshake(health,{optimization=false}={}){
  const c=health?.capabilities?.patchedMeshCheckpoint;
  check(health?.ok===true&&health.protocolVersion===1&&health.service==='gmsh-mesh-worker'&&health.capabilities?.version===1&&plain(c)&&Object.entries(P).every(([key,value])=>c[key]===value));
  return {version:1,basis:optimization?P.optimizationBasis:P.basis,gmshVersion:P.gmshVersion,apiVersion:P.apiVersion,license:P.license,snapshotBasis:P.snapshotBasis,patchTopologyBasis:P.patchTopologyBasis,embeddedRelationships:true,generationInputBinding:P.generationInputBinding};
}
export function assertPatchedCheckpointResult(result,input,requestId){
  try{
    envelope(result,requestId,'mesh.discrete-patched-checkpoint',P.basis,['generationInput','generationInputWire','baseline','checkpoint']);
    const bound=checkpointGenerationInput(result),request=Object.hasOwn(input,'generationInputWire')?input:null;check(same(bound,request?request.generationInput:input));if(request)check(result.generationInputWire===request.generationInputWire);fields(result.baseline,rawFields);
    assertPatchedDiscreteTetraResult(rawEnvelope(result.baseline,requestId),patchedCheckpointBaselineInput(bound),requestId);
    validateMeshCheckpoint(result.checkpoint,result.baseline,bound,{patched:true});return result;
  }catch(error){preserve(error);}
}
export function assertPatchedOptimizationInput(input,context){
  fields(input,['generationInput','checkpointResult']);const saved=input.checkpointResult,bound=checkpointGenerationInput(saved);check(same(input.generationInput,bound));assertPatchedCheckpointInput(bound,context);
  assertPatchedCheckpointResult(saved,bound,saved?.requestId);
  const a=saved.algorithm,e=saved.execution;
  check(a?.version===1&&a.basis===P.basis&&a.gmshVersion===P.gmshVersion&&a.apiVersion===P.apiVersion&&a.license===P.license&&a.snapshotBasis===P.snapshotBasis&&a.patchTopologyBasis===P.patchTopologyBasis&&a.embeddedRelationships===true&&a.generationInputBinding===P.generationInputBinding&&e?.basis==='single-process-exit-confirmed-v1'&&e.exitCode===0&&e.automaticReplay===false);
  const policy=meshMemoryPolicy({MESH_WORKER_MEMORY_LIMIT_BYTES:String(saved.processResources?.processLimitBytes)});assertNativeMemoryGuard({ok:true,protocolVersion:1,service:'gmsh-mesh-worker',capabilities:{version:1,processResources:saved.processResources}},policy,'gmsh-mesh-worker');return input;
}
export function assertPatchedOptimizationResult(result,input,requestId){
  try{
    envelope(result,requestId,'mesh.discrete-patched-optimize',P.optimizationBasis,['mesh','pointNodeTags','restoredExactly','embeddedTopologyUnchanged']);check(result.restoredExactly===true&&result.embeddedTopologyUnchanged===true);fields(result.mesh,rawFields);
    assertPatchedDiscreteTetraResult(rawEnvelope(result.mesh,requestId),input.generationInput,requestId);
    check(sortedTags(result.pointNodeTags)&&result.pointNodeTags.length===result.mesh.points.length);
    const saved=input.checkpointResult,oldTags=saved.checkpoint.pointNodeTags,actual=new Map(result.pointNodeTags.map((tag,i)=>[tag,result.mesh.points[i]]));
    assertCheckpointBaselineQuality(result.mesh.optimization.before,saved.baseline.quality,input.generationInput.quality);
    check(result.mesh.patches.length===saved.baseline.patches.length);
    for(let p=0;p<saved.baseline.patches.length;p++){
      const old=saved.baseline.patches[p].triangles.map(t=>t.map(i=>oldTags[i])),next=result.mesh.patches[p].triangles.map(t=>t.map(i=>result.pointNodeTags[i]));check(old.length===next.length);
      check(same([...new Set(old.map(orientedKey))].sort(),[...new Set(next.map(orientedKey))].sort()));
      for(const triangle of saved.baseline.patches[p].triangles)for(const i of triangle)check(same(actual.get(oldTags[i]),saved.baseline.points[i]));
    }
    return result;
  }catch(error){preserve(error);}
}
export function patchedOptimizationFailure(result,input){
  if(result.code==='MESH_QUALITY_REJECTED'){
    const error=patchedDiscreteTetraFailure({...result,operation:'mesh.discrete-patched-tetra'},input.generationInput);assertCheckpointBaselineQuality(result.optimization.before,input.checkpointResult.baseline.quality,input.generationInput.quality);return error;
  }
  check(!['mesh','checkpoint','baseline','points','cells','boundaries','patches'].some(k=>result[k]!==undefined));return new DiscreteTetraError(result.code,result.error.slice(0,1024));
}
