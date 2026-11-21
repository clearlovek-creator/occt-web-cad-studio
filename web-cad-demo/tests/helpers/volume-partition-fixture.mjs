import {DISCRETE_SURFACE_PROTOCOL as S} from '../../gateway/discrete-surface-protocol.mjs';
import {VOLUME_PARTITION_PROTOCOL as V} from '../../gateway/volume-partition-protocol.mjs';
export function volumeInput(){
  const triangles=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,4,7],[0,7,3],[1,2,6],[1,6,5],[0,1,5],[0,5,4],[3,7,6],[3,6,2]];
  return {units:'mm',points:[[0,0,0],[2,0,0],[2,2,0],[0,2,0],[0,0,2],[2,0,2],[2,2,2],[0,2,2]],triangles,sources:triangles.map((_,i)=>({bodyId:'body-1',faceId:'face-'+Math.floor(i/2),solidId:'solid-1'}))};
}
export function volumeHealth(requestId='health'){
  return {ok:true,protocolVersion:1,requestId,service:S.service,capabilities:{version:1,processResources:{version:1,basis:'windows-job-commit-v1',processLimitBytes:2*1024**3,jobLimitBytes:2*1024**3,enforced:true,failurePolicy:'retire-on-memory-event-or-allocator-failure-v1'},surfaceRefinement:{...S,version:1,volumeDomainReconstruction:false,oneJobPerProcess:true},volumePartition:{...V}}};
}
export function volumeResult(requestId='partition',input=volumeInput()){
  const result={ok:true,protocolVersion:1,requestId,service:S.service,operation:'volume.partition',basis:V.basis,cgalVersion:'6.1.2',units:'mm',points:structuredClone(input.points),triangles:structuredClone(input.triangles),sources:structuredClone(input.sources),sourceTriangleIds:input.triangles.map((_,i)=>[i]),sourceSolids:[{bodyId:'body-1',solidId:'solid-1',volume:8,partitionVolume:8}],regions:[{sourceSolidIndexes:[0],volume:8,exactPartitionVolume:8,connectedVolumeCount:1,closed:true}],cells:[{regionIndex:0,sourceSolidIndexes:[0],volume:8,closed:true,shells:[{outer:true,signedVolume:8,triangleIndexes:input.triangles.map((_,i)=>i)}]}],triangleRegionUses:input.triangles.map(()=>[{regionIndex:0,orientation:1}]),triangleCellUses:input.triangles.map(()=>[{cellIndex:0,orientation:1}])};
  result.surfaceReport={inputTriangles:12,distinctInputTriangles:12,outputTriangles:12,inputHadCrossings:false,outputHasCrossings:false,sourceReferences:12,maxSourceDeviation:0,maxRelativeSourceAreaError:0,tolerance:1e-7,snapGridSize:40,iterationLimit:5,removedDegenerateInputTriangles:[],volumeDomainReconstruction:'not-performed',tetrahedralReady:false,sourceIdentityAuthority:'caller-supplied-discrete-labels-not-cad-certificates'};
  result.report={allRegionBoundariesClosed:true,regionCount:1,cellCount:1,connectedCellsIndividuallyExported:true,exactSetCoverage:true,maxRelativeRegionVolumeError:0,normalMeshAdmitted:false,pairwiseVolumeDisjoint:true,sharedInterfaceTriangles:0,sourceIdentityAuthority:V.sourceIdentityAuthority,tetrahedralReady:false,unionVolume:8};
  return result;
}
