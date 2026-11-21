import test from 'node:test';
import assert from 'node:assert/strict';
import {exactTripleSign,tetrahedraOverlap,LinearTetraSpatial,MESH_SPATIAL_LIMITS} from '../gateway/mesh-spatial.mjs';
import {tetraStrip} from './helpers/tetra-strip.mjs';
const unit=[[0,0,0],[1,0,0],[0,1,0],[0,0,1]];
const move=(tet,delta,scale=1)=>tet.map(p=>p.map((n,i)=>n*scale+delta[i]));
const sign=(a,b,c,d)=>exactTripleSign(a,b,a,c,a,d);
function check(tets,options){
  const positions=tets.flat(2),spatial=new LinearTetraSpatial(tets.length,n=>positions[n],options);
  tets.forEach((_,i)=>spatial.add({elementId:String(i+1),elementType:4,order:1,corners:[0,1,2,3].map(n=>n+4*i)}));
  return spatial.finish();
}
test('exact predicates preserve signs through overflow, underflow, reflection and exact coplanarity',()=>{
  for(const scale of [Number.MIN_VALUE,2**-500,1,2**500,1e308]){
    const tet=unit.map(p=>p.map(n=>n*scale));
    assert.equal(sign(...tet),1);assert.equal(sign(tet[0],tet[2],tet[1],tet[3]),-1);
    assert.equal(sign(tet[0],tet[1],tet[2],tet[2]),0);
  }
  const shifted=move(unit,[2**50,2**50,2**50]);assert.equal(sign(...shifted),1);
  const epsilon=2**-52,near=[[0,0,0],[1,1,1],[1,1+epsilon,1],[1,1,1+epsilon]];
  assert.equal(sign(...near),1);assert.equal(sign(near[0],near[2],near[1],near[3]),-1);
});
test('SAT rejects containment and interlocking cells, but accepts face, edge and vertex contacts',()=>{
  assert.equal(tetrahedraOverlap(unit,move(unit,[.1,.1,.1],.2)),true);
  const starA=[[1,1,1],[-1,-1,1],[-1,1,-1],[1,-1,-1]],starB=[[-1,-1,-1],[1,-1,1],[1,1,-1],[-1,1,1]];
  assert.equal(tetrahedraOverlap(starA,starB),true);
  for(const other of [move(unit,[1,0,0]),unit.map(p=>[p[0],p[1],-p[2]]),unit.map(p=>[-p[0],-p[1],p[2]]),move(unit,[3,3,3])]){
    assert.equal(tetrahedraOverlap(unit,other),false);assert.equal(tetrahedraOverlap(other,unit),false);
  }
});
test('exact touching is not rounded into overlap and representable tiny penetration is not discarded by a tolerance',()=>{
  const upper=unit.map(p=>[p[0],p[1],-p[2]]);
  assert.equal(tetrahedraOverlap(unit,upper),false);
  assert.equal(tetrahedraOverlap(unit,move(upper,[0,0,Number.MIN_VALUE])),true);
  assert.equal(tetrahedraOverlap(unit,move(upper,[0,0,-Number.MIN_VALUE])),false);
});
test('BVH reports each unordered overlap once, retains bounded exact display IDs and does not confuse shared coordinates with shared topology',()=>{
  const report=check([unit,move(unit,[.1,.1,.1],.2),move(unit,[10,0,0])]);
  assert.equal(report.overlapPairCount,1);assert.equal(report.checkedTetraCount,3);
  assert.deepEqual(report.samples[0].elementIds,['1','2']);assert.deepEqual(report.samples[0].corners[0],unit.flat());
  assert.equal(report.status,'complete');assert.ok(report.resources.nodeVisits>0);
  const positions=unit.flat(),spatial=new LinearTetraSpatial(1,n=>positions[n]);spatial.add({elementId:'9'.repeat(10000),elementType:4,order:1,corners:[0,1,2,3]});
  assert.equal(spatial.blocks[0].ids[0].length,80);assert.equal(spatial.blocks[0].flags[0],1);
});
test('a conforming tetrahedral strip has no false overlaps after BVH spatial reordering',()=>{
  const {positions,cells}=tetraStrip(600,{elementType:4,order:1}),spatial=new LinearTetraSpatial(cells.length,n=>positions[n]);
  for(const cell of [...cells].reverse())spatial.add(cell);
  const report=spatial.finish();assert.equal(report.overlapPairCount,0);assert.equal(report.checkedTetraCount,600);assert.ok(report.resources.candidatePairs<600*20);
});
test('partial curved or invalid cells are explicit and cannot create a fabricated successful spatial coverage count',()=>{
  const points=unit.flat(),spatial=new LinearTetraSpatial(3,n=>points[n]);
  spatial.add({elementId:'1',elementType:11,order:2,corners:[0,1,2,3]});
  spatial.add({elementId:'2',elementType:4,order:1,corners:[0,1,1,3]});
  spatial.add({elementId:'3',elementType:4,order:1,corners:[0,1,2,99]});
  const report=spatial.finish();assert.equal(report.status,'partial');assert.equal(report.checkedTetraCount,0);assert.equal(report.skippedHighOrderCount,1);assert.equal(report.invalidGeometryCount,2);
});
test('memory, traversal, pair and exact-arithmetic budgets fail closed with a resource code',()=>{
  assert.throws(()=>new LinearTetraSpatial(MESH_SPATIAL_LIMITS.cells+1,()=>0),{code:'MESH_ARTIFACT_LIMIT'});
  assert.throws(()=>new LinearTetraSpatial(2,n=>unit.flat()[n],{bytes:1}).add({elementId:'1',elementType:4,order:1,corners:[0,1,2,3]}),{code:'MESH_ARTIFACT_LIMIT'});
  assert.throws(()=>check([unit,unit,unit],{pairs:1}),{code:'MESH_ARTIFACT_LIMIT'});
  assert.throws(()=>check([unit,unit],{nodeVisits:1}),{code:'MESH_ARTIFACT_LIMIT'});
  assert.throws(()=>check([unit,unit],{predicates:1}),{code:'MESH_ARTIFACT_LIMIT'});
  const skew=move(unit,[.1,.1,.1]);assert.throws(()=>check([skew,skew],{exactPredicates:1}),{code:'MESH_ARTIFACT_LIMIT'});
});

// Independent integer SAT oracle: explicitly constructs exact axes/projections,
// rather than calling production orientation, extrema or filtered predicates.
const subtract=(a,b)=>a.map((v,i)=>v-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0n);
function integerOracle(a,b){
  a=a.map(p=>p.map(BigInt));b=b.map(p=>p.map(BigInt));
  const volume=t=>dot(cross(subtract(t[1],t[0]),subtract(t[2],t[0])),subtract(t[3],t[0]));
  if(volume(a)===0n||volume(b)===0n)return false;
  const edges=t=>[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]].map(([i,j])=>subtract(t[j],t[i]));
  const normals=t=>[[0,1,2],[0,1,3],[0,2,3],[1,2,3]].map(([i,j,k])=>cross(subtract(t[j],t[i]),subtract(t[k],t[i])));
  const axes=[...normals(a),...normals(b),...edges(a).flatMap(u=>edges(b).map(v=>cross(u,v)))];
  for(const axis of axes){
    if(axis.every(v=>v===0n))continue;
    const pa=a.map(p=>dot(axis,p)),pb=b.map(p=>dot(axis,p));
    const min=values=>values.reduce((v,n)=>n<v?n:v),max=values=>values.reduce((v,n)=>n>v?n:v);
    if(max(pa)<=min(pb)||max(pb)<=min(pa))return false;
  }
  return true;
}
test('filtered SAT agrees with an independent exact-axis oracle for 2000 deterministic integer pairs and transformed copies',()=>{
  let seed=194731;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%17-8;};
  let edgeAxisSeparation=0;
  for(let i=0;i<2000;i++){
    const a=Array.from({length:4},()=>[random(),random(),random()]),b=Array.from({length:4},()=>[random(),random(),random()]),expected=integerOracle(a,b);
    assert.equal(tetrahedraOverlap(a,b),expected,JSON.stringify({a,b}));
    if(i%20===0)for(const scale of [2**-400,2**400])assert.equal(tetrahedraOverlap(move(a,[0,0,0],scale),move(b,[0,0,0],scale)),expected);
    if(!expected)edgeAxisSeparation++;
  }
  assert.ok(edgeAxisSeparation>100);
});
test('BVH output equals exhaustive exact SAT, including equal centers and adversarial input order',()=>{
  const tets=[...Array.from({length:50},(_,i)=>move(unit,[i%5,Math.floor(i/5),0])),...Array.from({length:6},(_,i)=>move(unit,[i*.125,.125,.125],.5))].reverse();
  let expected=0;for(let i=0;i<tets.length;i++)for(let j=i+1;j<tets.length;j++)if(tetrahedraOverlap(tets[i],tets[j]))expected++;
  const report=check(tets);assert.equal(report.overlapPairCount,expected);assert.equal(report.samples.length,8);
});
