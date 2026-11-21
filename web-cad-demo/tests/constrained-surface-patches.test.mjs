import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConstrainedSurfacePatches,assertConstrainedSurfacePatches} from '../gateway/constrained-surface-patches.mjs';
import {normalizeDiscreteTetraInput} from '../gateway/discrete-tetra-protocol.mjs';
import {VOLUME_CONSTRAINT_PROTOCOL as V} from '../gateway/volume-partition-protocol.mjs';
import {volumeInput,verifiedDomain} from './helpers/discrete-tetra-fixture.mjs';

const rectangle={points:[[.25,.25,1],[1.75,.25,1],[1.75,1.75,1],[.25,1.75,1]],triangles:[[0,1,2],[0,2,3]]};
function fixture(sheet=rectangle,{differentFaces=false,reverse=false,transform}={}){
  const source=volumeInput(),domain=verifiedDomain();
  for(const point of sheet.points)source.points.push([...point]);
  for(let i=0;i<sheet.triangles.length;i++){
    const triangle=sheet.triangles[i].map(n=>n+8);if(reverse&&i%2)[triangle[1],triangle[2]]=[triangle[2],triangle[1]];
    source.triangles.push(triangle);source.sources.push({bodyId:'sheet',faceId:sheet.faceIds?.[i]??(differentFaces?'face-'+i:'sheet-face')});
  }
  domain.points=structuredClone(source.points);domain.triangles=structuredClone(source.triangles);domain.sources=structuredClone(source.sources);
  domain.sourceTriangleIds=source.triangles.map((_,i)=>[i]);
  for(let i=12;i<source.triangles.length;i++){domain.triangleCellUses.push([]);domain.triangleRegionUses.push([]);}
  domain.basis=V.basis;domain.operation='volume.partition-constrained';domain.algorithm.basis=V.basis;
  const count=source.triangles.length;
  for(const key of ['inputTriangles','distinctInputTriangles','outputTriangles','sourceReferences'])domain.surfaceReport[key]=count;
  domain.constraints={version:1,basis:V.constraintBasis,triangles:source.triangles.map((_,i)=>i<12?{kind:'boundary',cellIndexes:[]}:{kind:'embedded',cellIndexes:[0]}),report:{embeddedTriangles:count-12,exteriorTriangles:0,boundarySheetTriangles:0,sheetSourceFaces:new Set(source.sources.slice(12).map(s=>s.faceId)).size}};
  if(transform){
    source.points=source.points.map(transform.point);domain.points=domain.points.map(transform.point);
    for(const s of domain.sourceSolids){s.volume*=transform.determinant;s.partitionVolume*=transform.determinant;}
    for(const s of domain.regions){s.volume*=transform.determinant;s.exactPartitionVolume*=transform.determinant;}
    for(const c of domain.cells){c.volume*=transform.determinant;for(const s of c.shells)s.signedVolume*=transform.determinant;}
    domain.report.unionVolume*=transform.determinant;
  }
  return {input:normalizeDiscreteTetraInput({domain}),context:{sourceInput:source}};
}
const sheetPatches=plan=>plan.patches.filter(p=>p.constraint.kind==='embedded');

test('same-Face planar tessellation becomes one patch, preserving six real cube Faces',()=>{
  const f=fixture(),before=JSON.stringify(f),p=buildConstrainedSurfacePatches(f.input,f.context);
  assert.equal(p.patches.length,7);assert.equal(p.report.removedInteriorEdges,7);assert.equal(p.report.normalMeshAdmitted,false);
  const [sheet]=sheetPatches(p);assert.deepEqual(sheet.triangleIndexes,[12,13]);assert.equal(sheet.loops.length,1);assert.equal(sheet.loops[0].pointIndexes.length,4);
  assert.deepEqual(sheet.sourceFaces,[{bodyId:'sheet',faceId:'sheet-face'}]);assert.deepEqual(sheet.constraint,{kind:'embedded',cellIndexes:[0]});
  assertConstrainedSurfacePatches(p,f.input,f.context);assert.equal(JSON.stringify(f),before);
});
test('coplanar but different source Faces retain their shared real edge',()=>{
  const f=fixture(rectangle,{differentFaces:true}),p=buildConstrainedSurfacePatches(f.input,f.context);
  assert.equal(sheetPatches(p).length,2);assert.equal(p.report.removedInteriorEdges,6);
  assert.ok(p.edges.some(e=>e.vertices.join(',')==='8,10'&&e.patchUses.length===2));
});
test('mixed input triangle winding is normalized without changing cell-side orientation',()=>{
  const f=fixture(rectangle,{reverse:true}),p=buildConstrainedSurfacePatches(f.input,f.context),[sheet]=sheetPatches(p);
  assert.equal(sheetPatches(p).length,1);assert.deepEqual(sheet.triangleOrientations,[1,-1]);assert.equal(sheet.loops[0].pointIndexes.length,4);
});
test('arbitrarily oriented dyadic planes merge without axis-specific tests',()=>{
  const f=fixture(rectangle,{transform:{point:([x,y,z])=>[x+y/2,y+z/4,z+x/8],determinant:65/64}}),p=buildConstrainedSurfacePatches(f.input,f.context);
  const [sheet]=sheetPatches(p);assert.equal(sheetPatches(p).length,1);assert.equal(sheet.loops[0].pointIndexes.length,4);assert.equal(sheet.plane.slice(0,3).every(n=>BigInt(n)!==0n),true);
});
test('a real tiny non-coplanarity is not erased by an angle tolerance',()=>{
  const bent=structuredClone(rectangle);bent.points[3][2]+=2**-40;
  const f=fixture(bent),p=buildConstrainedSurfacePatches(f.input,f.context);assert.equal(sheetPatches(p).length,2);
});
test('a planar annulus keeps an oppositely oriented inner loop, not a filled hole',()=>{
  const ring={points:[...rectangle.points,[.75,.75,1],[1.25,.75,1],[1.25,1.25,1],[.75,1.25,1]],triangles:[]};
  for(let i=0;i<4;i++){const j=(i+1)%4;ring.triangles.push([i,j,4+j],[i,4+j,4+i]);}
  const f=fixture(ring),p=buildConstrainedSurfacePatches(f.input,f.context),[sheet]=sheetPatches(p);
  assert.equal(sheetPatches(p).length,1);assert.deepEqual(sheet.loops.map(l=>l.outer),[true,false]);assert.deepEqual(sheet.loops.map(l=>l.pointIndexes.length),[4,4]);
});
test('disconnected regions of the same source Face remain distinct patches',()=>{
  const two={points:[[.25,.25,1],[.75,.25,1],[.25,.75,1],[1.25,1.25,1],[1.75,1.25,1],[1.25,1.75,1]],triangles:[[0,1,2],[3,4,5]]};
  const f=fixture(two),p=buildConstrainedSurfacePatches(f.input,f.context);assert.equal(sheetPatches(p).length,2);
});
test('only exact collinear boundary subdivisions are removed; their chain evidence is retained',()=>{
  const split={points:[[.25,.25,1],[1,.25,1],[1.75,.25,1],[1.75,1.75,1],[.25,1.75,1],[1,1,1]],triangles:[[0,1,5],[1,2,5],[2,3,5],[3,4,5],[4,0,5]]};
  const f=fixture(split),p=buildConstrainedSurfacePatches(f.input,f.context),[sheet]=sheetPatches(p);
  assert.equal(sheet.loops[0].pointIndexes.length,4);assert.equal(p.report.removedCollinearVertices,1);
  assert.ok(p.edges.some(e=>e.sourceEdges.length===2&&e.sourceEdges.flat().includes(9)));
});
test('a tiny bend in a boundary remains an explicit corner',()=>{
  const split={points:[[.25,.25,1],[1,.25-2**-40,1],[1.75,.25,1],[1.75,1.75,1],[.25,1.75,1],[1,1,1]],triangles:[[0,1,5],[1,2,5],[2,3,5],[3,4,5],[4,0,5]]};
  const f=fixture(split),p=buildConstrainedSurfacePatches(f.input,f.context);assert.equal(sheetPatches(p)[0].loops[0].pointIndexes.length,5);assert.equal(p.report.removedCollinearVertices,0);
});
test('crossing Sheet intersection survives as a shared embedded curve even when each Face remains connected',()=>{
  const crossing={points:[[.25,.25,1],[1,.25,1],[1.75,.25,1],[1.75,1.75,1],[1,1.75,1],[.25,1.75,1],[1,.25,.25],[1,1.75,.25],[1,.25,1.75],[1,1.75,1.75]],
    triangles:[[0,1,4],[0,4,5],[1,2,3],[1,3,4],[6,7,4],[6,4,1],[1,4,9],[1,9,8]],faceIds:['horizontal','horizontal','horizontal','horizontal','vertical','vertical','vertical','vertical']};
  const f=fixture(crossing),p=buildConstrainedSurfacePatches(f.input,f.context),sheets=sheetPatches(p);
  assert.equal(sheets.length,2);assert.equal(p.report.embeddedCurveUses,2);assert.deepEqual(sheets[0].embeddedEdgeIndexes,sheets[1].embeddedEdgeIndexes);
  const edge=p.edges[sheets[0].embeddedEdgeIndexes[0]];assert.deepEqual(edge.vertices,[9,12]);assert.deepEqual(edge.patchUses.map(u=>u.kind),['embedded','embedded']);
  assert.ok(sheets.every(s=>s.loops[0].pointIndexes.length===6));
});
test('exact patch output is deterministic and remains bound to native proof and source identity',()=>{
  const f=fixture(),p=buildConstrainedSurfacePatches(f.input,f.context);assert.deepEqual(buildConstrainedSurfacePatches(f.input,f.context),p);
  const bad=structuredClone(f);bad.input.domain.execution.exitCode=2;
  assert.throws(()=>buildConstrainedSurfacePatches(bad.input,bad.context),{code:'MESH_DOMAIN_UNQUALIFIED'});
  const renamed=fixture();renamed.input.domain.sources[12].faceId='foreign';assert.throws(()=>assertConstrainedSurfacePatches(p,renamed.input,renamed.context));
});
const mutations={
  'missing source triangle':p=>p.patches.at(-1).triangleIndexes.pop(),
  'lost source Face':p=>p.patches.at(-1).sourceFaces=[],
  'filled hole or lost loop':p=>p.patches.at(-1).loops=[],
  'forged exact plane':p=>p.patches.at(-1).plane[0]='123',
  'changed volume owner':p=>p.patches.at(-1).constraint.cellIndexes=[1],
  'missing retained edge':p=>p.edges.pop(),
  'changed edge chain':p=>p.edges.at(-1).sourceEdges[0].reverse(),
  'false coverage report':p=>p.report.exactPlanarCoverage=false,
  'normal mesh admission':p=>p.report.normalMeshAdmitted=true,
  'wrong domain digest':p=>p.domainSha256='0'.repeat(64),
  'unrecognized extra field':p=>p.arbitrary=true,
};
for(const [name,mutate]of Object.entries(mutations))test('patch verifier rejects '+name,()=>{
  const f=fixture(),p=buildConstrainedSurfacePatches(f.input,f.context);mutate(p);
  assert.throws(()=>assertConstrainedSurfacePatches(p,f.input,f.context),{code:'MESH_PATCH_INVALID'});
});
