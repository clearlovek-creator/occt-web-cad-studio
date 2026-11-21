import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDiscreteTetraInput,assertDiscreteTetraInput,assertDiscreteTetraResult,assertConstrainedDiscreteTetraInput,assertConstrainedDiscreteTetraHandshake,assertConstrainedDiscreteTetraResult,CONSTRAINED_DISCRETE_TETRA_PROTOCOL as P} from '../gateway/discrete-tetra-protocol.mjs';
import {VOLUME_CONSTRAINT_PROTOCOL as V} from '../gateway/volume-partition-protocol.mjs';
import {volumeInput,verifiedDomain,tetraHealth,tetraResult} from './helpers/discrete-tetra-fixture.mjs';

function fixture(exterior=false){
  const source=volumeInput(),domain=verifiedDomain(),output=tetraResult();
  const triangle=exterior?[8,9,10]:[0,2,6];
  if(exterior){const points=[[0,0,3],[1,0,3],[0,1,3]];source.points.push(...points);domain.points.push(...structuredClone(points));output.points.push(...structuredClone(points));}
  const label={bodyId:'sheet-1',faceId:'sheet-face'};source.triangles.push(triangle);source.sources.push(label);domain.triangles.push([...triangle]);domain.sources.push({...label});domain.sourceTriangleIds.push([12]);domain.triangleCellUses.push([]);domain.triangleRegionUses.push([]);
  domain.basis=V.basis;domain.operation='volume.partition-constrained';domain.algorithm.basis=V.basis;
  for(const key of ['inputTriangles','distinctInputTriangles','outputTriangles','sourceReferences'])domain.surfaceReport[key]=13;
  const constraint={kind:exterior?'exterior':'embedded',cellIndexes:exterior?[]:[0]};
  domain.constraints={version:1,basis:V.constraintBasis,triangles:domain.triangles.map((_,i)=>i===12?constraint:{kind:'boundary',cellIndexes:[]}),report:{embeddedTriangles:exterior?0:1,exteriorTriangles:exterior?1:0,boundarySheetTriangles:0,sheetSourceFaces:1}};
  output.operation='mesh.discrete-constrained-tetra';output.basis=P.basis;output.sources=structuredClone(domain.sources);
  output.boundaries.forEach((row,i)=>row.constraint=structuredClone(domain.constraints.triangles[i]));output.boundaries.push({sourceBoundaryTriangle:12,triangles:[[...triangle]],cellUses:[],sourceTriangleIds:[12],constraint:structuredClone(constraint)});
  Object.assign(output.report,{nodeCount:output.points.length,surfaceTriangleCount:13,embeddedTriangleCount:exterior?0:1,exteriorTriangleCount:exterior?1:0});
  const input=normalizeDiscreteTetraInput({domain}),health=tetraHealth();health.capabilities.constrainedDiscreteTetra={...P};return {source,input,output,health};
}

test('constrained tetra input requires exact Sheet classification and its own process proof without weakening legacy input',()=>{
  const f=fixture();assert.equal(assertConstrainedDiscreteTetraInput(f.input,{sourceInput:f.source}),f.input);assert.throws(()=>assertDiscreteTetraInput(f.input,{sourceInput:f.source}),{code:'MESH_DOMAIN_UNQUALIFIED'});
  for(const mutate of [d=>delete d.constraints,d=>d.algorithm.basis='guessed',d=>d.execution.exitCode=1,d=>d.processResources.enforced=false,d=>d.constraints.triangles[12].cellIndexes=[1]]){const x=fixture();mutate(x.input.domain);assert.throws(()=>assertConstrainedDiscreteTetraInput(x.input,{sourceInput:x.source}),{code:'MESH_DOMAIN_UNQUALIFIED'});}
});
test('constrained tetra capability is independent of old closed-domain capability and pins all limits',()=>{
  const f=fixture();assert.equal(assertConstrainedDiscreteTetraHandshake(f.health).basis,P.basis);assert.throws(()=>assertConstrainedDiscreteTetraHandshake(tetraHealth()));
  for(const key of Object.keys(P)){const x=fixture();x.health.capabilities.constrainedDiscreteTetra[key]=null;assert.throws(()=>assertConstrainedDiscreteTetraHandshake(x.health));}
});
test('an embedded open triangle is an actual common tetrahedron face with two opposite uses in one cell',()=>{
  const f=fixture();assert.equal(assertConstrainedDiscreteTetraResult(f.output,f.input,'tetra'),f.output);assert.throws(()=>assertDiscreteTetraResult(f.output,f.input,'tetra'));
  assert.equal(f.output.cells[0].volume,8);assert.equal(f.output.boundaries[12].cellUses.length,0);assert.equal(f.output.report.normalMeshAdmitted,false);
});
test('an exterior Sheet remains a surface result with no invented solid or tetrahedron ownership',()=>{
  const f=fixture(true);assertConstrainedDiscreteTetraInput(f.input,{sourceInput:f.source});assertConstrainedDiscreteTetraResult(f.output,f.input,'tetra');assert.equal(f.output.sourceSolids.length,1);assert.equal(f.output.cells.length,1);assert.equal(f.output.report.boundaryTriangleCount,12);assert.equal(f.output.report.exteriorTriangleCount,1);
});
const mutations={
  'missing embedded surface':r=>r.boundaries.pop(),
  'invented classification':r=>r.boundaries[12].constraint.kind='exterior',
  'fake containing cell':r=>r.boundaries[12].constraint.cellIndexes=[1],
  'duplicate surface facet':r=>{r.boundaries[12].triangles.push([0,2,6]);r.report.surfaceTriangleCount++;r.report.embeddedTriangleCount++;},
  'position-only matching without shared node identity':r=>{r.points.push([...r.points[0]]);r.report.nodeCount++;r.boundaries[12].triangles=[[8,2,6]];},
  'shifted source coverage':r=>r.boundaries[12].sourceTriangleIds=[0],
  'wrong source label':r=>r.sources[12].faceId='foreign',
  'false surface total':r=>r.report.surfaceTriangleCount++,
  'false embedded total':r=>r.report.embeddedTriangleCount++,
  'unqualified operation':r=>r.operation='mesh.discrete-tetra',
  'wrong output family':r=>r.basis='shared-discrete-connected-cells-gmsh-tetra-v1',
};
for(const [name,mutate]of Object.entries(mutations))test('constrained tetra rejects '+name,()=>{const f=fixture();mutate(f.output);assert.throws(()=>assertConstrainedDiscreteTetraResult(f.output,f.input,'tetra'),{code:'MESH_PROTOCOL_INVALID'});});
