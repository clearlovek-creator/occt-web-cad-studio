import {volumeInput,volumeHealth,volumeResult} from './volume-partition-fixture.mjs';
import {VOLUME_PARTITION_PROTOCOL as V} from '../../gateway/volume-partition-protocol.mjs';
import {DISCRETE_TETRA_PROTOCOL as P} from '../../gateway/discrete-tetra-protocol.mjs';
export {volumeInput};
export function verifiedDomain(){const d=volumeResult();d.processResources={...volumeHealth().capabilities.processResources};d.algorithm={version:1,basis:V.basis,cgalVersion:V.cgalVersion,license:V.license};d.execution={basis:'single-process-exit-confirmed-v1',exitCode:0,automaticReplay:false};return d;}
export function tetraHealth(requestId='health'){return {ok:true,protocolVersion:1,requestId,service:'gmsh-mesh-worker',capabilities:{version:1,processResources:{...volumeHealth().capabilities.processResources},discreteTetra:{...P}}};}
export function tetraResult(requestId='tetra',policy={version:1,mode:'strict',threshold:.2,maxBadFraction:0}){
  const d=verifiedDomain(),q=3/Math.sqrt(15),tetrahedra=[[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6],[0,5,1,6]],bad=q<policy.threshold?6:0;
  const stats={tetraCount:6,lowQualityCount:bad,lowQualityFraction:bad/6,minimumSICN:q,meetsRequestedQuality:bad/6<=policy.maxBadFraction};
  return {ok:true,protocolVersion:1,requestId,service:'gmsh-mesh-worker',operation:'mesh.discrete-tetra',basis:P.basis,gmshVersion:P.gmshVersion,points:d.points,cells:[{cellIndex:0,regionIndex:0,sourceSolidIndexes:[0],tetrahedra,qualities:tetrahedra.map(()=>q),volume:8}],boundaries:d.triangles.map((triangle,i)=>({sourceBoundaryTriangle:i,triangles:[triangle],cellUses:d.triangleCellUses[i],sourceTriangleIds:d.sourceTriangleIds[i]})),sourceSolids:d.sourceSolids,sources:d.sources,report:{tetraCount:6,nodeCount:8,boundaryTriangleCount:12,volume:8,minimumSICN:q,normalMeshAdmitted:false,materialPriorityAssigned:false},quality:{version:1,metric:'coordinate-derived-linear-tet-SICN-v1',mode:policy.mode,threshold:policy.threshold,maxBadFraction:policy.maxBadFraction,maxEngineMetricDifference:0,...stats,perCell:[{cellIndex:0,...stats}]},optimization:{requested:false}};
}
