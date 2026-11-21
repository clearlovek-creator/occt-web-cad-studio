import {volumeInput,volumeResult,volumeHealth} from './volume-partition-fixture.mjs';
import {VOLUME_CONSTRAINT_PROTOCOL as P} from '../../gateway/volume-partition-protocol.mjs';
export function constrainedInput(){
  const input=volumeInput();input.points.push([.25,.25,1],[1.75,.25,1],[1.75,1.75,1],[.25,1.75,1]);
  input.triangles.push([8,9,10],[8,10,11]);input.sources.push(...Array.from({length:2},()=>({bodyId:'sheet-1',faceId:'sheet-face-1'})));return input;
}
export function constrainedHealth(requestId='health'){
  const health=volumeHealth(requestId);health.capabilities.constrainedVolumePartition={...P};return health;
}
export function constrainedResult(requestId='partition'){
  const input=constrainedInput(),result=volumeResult(requestId);
  result.operation='volume.partition-constrained';result.basis=P.basis;
  result.points=structuredClone(input.points);result.triangles=structuredClone(input.triangles);result.sources=structuredClone(input.sources);
  result.sourceTriangleIds.push([12],[13]);result.triangleCellUses.push([],[]);result.triangleRegionUses.push([],[]);
  for(const field of ['inputTriangles','distinctInputTriangles','outputTriangles','sourceReferences'])result.surfaceReport[field]=14;
  result.constraints={version:1,basis:P.constraintBasis,triangles:input.triangles.map((_,i)=>i<12?{kind:'boundary',cellIndexes:[]}:{kind:'embedded',cellIndexes:[0]}),report:{embeddedTriangles:2,exteriorTriangles:0,boundarySheetTriangles:0,sheetSourceFaces:1}};
  return result;
}
