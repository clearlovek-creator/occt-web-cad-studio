import {patchedTetraFixture} from './patched-tetra-fixture.mjs';
import {PATCHED_MESH_CHECKPOINT_PROTOCOL as P} from '../../gateway/patched-checkpoint-protocol.mjs';
const raw=mesh=>Object.fromEntries(Object.entries(mesh).filter(([k])=>!['protocolVersion','requestId','service','operation'].includes(k)));
export function patchedCheckpointFixture({sheet='embedded'}={}){
  const f=patchedTetraFixture({sheet}),input=structuredClone(f.input);input.optimization={version:1,method:'gmsh',iterations:1,acceptance:'non-regressing'};
  const baseline=raw(structuredClone(f.output));baseline.quality.mode='diagnostic';baseline.optimization={requested:false};
  const tags=baseline.points.map((_,i)=>i+1),plan=input.patchPlan,entities=[],used=[...new Set(plan.edges.flatMap(e=>e.vertices))].sort((a,b)=>a-b),origin=input.domain.points[0];let element=0;
  for(const i of used)entities.push({dimension:0,tag:i+1,boundary:[],embedded:[],nodes:[i+1],coordinates:baseline.points[i].map((v,j)=>v-origin[j]),parameters:[],types:[15],elements:[[++element]],vertices:[[i+1]]});
  for(let i=0;i<plan.edges.length;i++){const pair=plan.edges[i].vertices.map(n=>n+1);entities.push({dimension:1,tag:i+1,boundary:[...pair],embedded:[],nodes:[],coordinates:[],parameters:[],types:[1],elements:[[++element]],vertices:[[...pair]]});}
  for(let i=0;i<plan.patches.length;i++){
    const patch=plan.patches[i],triangles=baseline.patches[i].triangles.map(row=>row.map(n=>n+1));
    entities.push({dimension:2,tag:i+1,boundary:patch.loops.flatMap(loop=>loop.edgeUses).sort((a,b)=>a-b),embedded:patch.embeddedEdgeIndexes.map(e=>[1,e+1]),nodes:[],coordinates:[],parameters:[],types:[2],elements:[triangles.map(()=>++element)],vertices:[triangles.flat()]});
  }
  for(let c=0;c<baseline.cells.length;c++){
    const tets=baseline.cells[c].tetrahedra.map(row=>row.map(n=>n+1));entities.push({dimension:3,tag:c+1,boundary:plan.patches.flatMap((p,i)=>p.cellUses.filter(u=>u.cellIndex===c).map(u=>(i+1)*u.orientation)).sort((a,b)=>a-b),embedded:plan.patches.flatMap((p,i)=>p.constraint.kind==='embedded'&&p.constraint.cellIndexes[0]===c?[[2,i+1]]:[]),nodes:[],coordinates:[],parameters:[],types:[4],elements:[tets.map(()=>++element)],vertices:[tets.flat()]});
  }
  const checkpoint={version:2,basis:P.snapshotBasis,worldOrigin:[...origin],pointNodeTags:tags,entities},saved={ok:true,protocolVersion:1,requestId:'saved',service:'gmsh-mesh-worker',operation:'mesh.discrete-patched-checkpoint',basis:P.basis,gmshVersion:P.gmshVersion,generationInput:structuredClone(input),generationInputWire:JSON.stringify(input),baseline,checkpoint,normalMeshAdmitted:false,processResources:structuredClone(input.domain.processResources),algorithm:{version:1,basis:P.basis,gmshVersion:P.gmshVersion,apiVersion:P.apiVersion,license:P.license,snapshotBasis:P.snapshotBasis,patchTopologyBasis:P.patchTopologyBasis,embeddedRelationships:true,generationInputBinding:P.generationInputBinding},execution:{basis:'single-process-exit-confirmed-v1',exitCode:0,automaticReplay:false}};
  const mesh=raw(structuredClone(f.output)),q=structuredClone(mesh.quality);mesh.optimization={requested:true,method:'gmsh',iterations:1,acceptance:'non-regressing',disposition:'optimized',originalMeshRestoredExactly:false,boundaryUnchanged:true,before:structuredClone(q),candidate:structuredClone(q),after:structuredClone(q),regressedCells:[],globalRegressed:false};
  const output={ok:true,protocolVersion:1,requestId:'optimized',service:'gmsh-mesh-worker',operation:'mesh.discrete-patched-optimize',basis:P.optimizationBasis,gmshVersion:P.gmshVersion,mesh,pointNodeTags:tags,restoredExactly:true,embeddedTopologyUnchanged:true,normalMeshAdmitted:false},health={ok:true,protocolVersion:1,requestId:'health',service:'gmsh-mesh-worker',capabilities:{version:1,processResources:structuredClone(input.domain.processResources),patchedMeshCheckpoint:{...P}}};
  return {source:f.source,input,saved,output,health,optimizationInput:{generationInput:input,checkpointResult:saved}};
}
