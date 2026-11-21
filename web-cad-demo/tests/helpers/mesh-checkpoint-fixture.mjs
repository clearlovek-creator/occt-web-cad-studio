import {verifiedDomain,tetraResult,tetraHealth,volumeInput} from './discrete-tetra-fixture.mjs';
import {MESH_CHECKPOINT_PROTOCOL as P} from '../../gateway/mesh-checkpoint-protocol.mjs';
export {volumeInput};
export const checkpointInput=()=>({domain:verifiedDomain(),meshSize:1,quality:{version:1,mode:'strict',threshold:.2,maxBadFraction:0},optimization:{version:1,method:'gmsh',iterations:1,acceptance:'non-regressing'}});
const raw=result=>Object.fromEntries(Object.entries(result).filter(([name])=>!['protocolVersion','requestId','service','operation'].includes(name)));
export function checkpointHealth(requestId='health'){const health=tetraHealth(requestId);health.capabilities.meshCheckpoint={...P};return health;}
export function checkpointResult(requestId='checkpoint'){
  const input=checkpointInput(),baseline=raw(tetraResult('baseline',{...input.quality,mode:'diagnostic'})),tags=baseline.points.map((_,i)=>i+1),entities=[],curves=new Map();let element=0;
  for(let i=0;i<tags.length;i++)entities.push({dimension:0,tag:i+1,boundary:[],nodes:[i+1],coordinates:[...baseline.points[i]],parameters:[],types:[15],elements:[[ ++element ]],vertices:[[i+1]]});
  for(const triangle of input.domain.triangles)for(let i=0;i<3;i++){const pair=[triangle[i]+1,triangle[(i+1)%3]+1].sort((a,b)=>a-b),key=pair.join(',');if(!curves.has(key))curves.set(key,{tag:curves.size+1,pair});}
  for(const {tag,pair}of curves.values())entities.push({dimension:1,tag,boundary:[...pair],nodes:[],coordinates:[],parameters:[],types:[1],elements:[[ ++element ]],vertices:[[...pair]]});
  for(let i=0;i<input.domain.triangles.length;i++){const triangle=input.domain.triangles[i].map(n=>n+1),boundary=triangle.map((n,j)=>curves.get([n,triangle[(j+1)%3]].sort((a,b)=>a-b).join(',')).tag).sort((a,b)=>a-b);entities.push({dimension:2,tag:i+1,boundary,nodes:[],coordinates:[],parameters:[],types:[2],elements:[[ ++element ]],vertices:[[...triangle]]});}
  const tets=baseline.cells[0].tetrahedra.map(row=>row.map(n=>n+1));entities.push({dimension:3,tag:1,boundary:input.domain.triangles.map((_,i)=>i+1),nodes:[],coordinates:[],parameters:[],types:[4],elements:[tets.map(()=>++element)],vertices:[tets.flat()]});
  return {ok:true,protocolVersion:1,requestId,service:'gmsh-mesh-worker',operation:'mesh.discrete-checkpoint',basis:P.basis,gmshVersion:P.gmshVersion,generationInput:structuredClone(input),baseline,checkpoint:{version:1,basis:P.snapshotBasis,worldOrigin:[0,0,0],pointNodeTags:tags,entities},normalMeshAdmitted:false,processResources:{...input.domain.processResources},algorithm:{version:1,basis:P.basis,gmshVersion:P.gmshVersion,apiVersion:P.apiVersion,license:P.license},execution:{basis:'single-process-exit-confirmed-v1',exitCode:0,automaticReplay:false}};
}
export function optimizedCheckpointResult(requestId='optimized'){
  const input=checkpointInput(),mesh=raw(tetraResult()),quality=structuredClone(mesh.quality);mesh.optimization={requested:true,method:input.optimization.method,iterations:input.optimization.iterations,acceptance:'non-regressing',disposition:'optimized',originalMeshRestoredExactly:false,boundaryUnchanged:true,before:structuredClone(quality),candidate:structuredClone(quality),after:structuredClone(quality),regressedCells:[],globalRegressed:false};
  return {ok:true,protocolVersion:1,requestId,service:'gmsh-mesh-worker',operation:'mesh.discrete-optimize',basis:P.optimizationBasis,gmshVersion:P.gmshVersion,mesh,pointNodeTags:mesh.points.map((_,i)=>i+1),restoredExactly:true,normalMeshAdmitted:false};
}
