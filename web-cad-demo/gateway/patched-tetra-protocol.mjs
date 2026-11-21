// SPDX-License-Identifier: GPL-3.0-or-later
import {isDeepStrictEqual as same} from 'node:util';
import {CONSTRAINED_DISCRETE_TETRA_PROTOCOL,DiscreteTetraError,validateDiscreteTetraCellComplex,validateDiscreteTetraQualityReports} from './discrete-tetra-protocol.mjs';
import {CONSTRAINED_SURFACE_PATCH_PROTOCOL,assertConstrainedSurfacePatches} from './constrained-surface-patches.mjs';

export const PATCHED_DISCRETE_TETRA_PROTOCOL=Object.freeze({...CONSTRAINED_DISCRETE_TETRA_PROTOCOL,
  basis:'shared-source-face-patch-gmsh-tetra-v1',patchTopologyBasis:CONSTRAINED_SURFACE_PATCH_PROTOCOL.basis,
  maxCoveragePairs:5000000,maxCoverageIndexVisits:20000000,
});
const P=PATCHED_DISCRETE_TETRA_PROTOCOL;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=()=>new DiscreteTetraError('MESH_PROTOCOL_INVALID','面片四面体的来源、覆盖、交线、体用途或质量无法核对；未接纳网格。');
const check=value=>{if(!value)throw fail();};
const fields=(v,keys)=>check(plain(v)&&Object.keys(v).every(k=>keys.includes(k)));
const integer=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<max;
const sub=(a,b)=>a.map((v,i)=>v-b[i]),dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const key=a=>[...a].sort((a,b)=>a-b).join(',');
const near=(a,b,t=1e-6)=>check(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=t*Math.max(Math.abs(b),1e-30));
const orient=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const area=polygon=>Math.abs(polygon.reduce((s,a,i)=>s+a[0]*polygon[(i+1)%polygon.length][1]-a[1]*polygon[(i+1)%polygon.length][0],0))/2;

export function assertPatchedDiscreteTetraInput(input,context){
  try{
    fields(input,['domain','meshSize','quality','optimization','patchPlan']);
    check(Buffer.byteLength(JSON.stringify(input))<=P.maxRequestBytes);
    const {patchPlan,...base}=input;assertConstrainedSurfacePatches(patchPlan,base,context);return input;
  }catch(error){if(error?.code==='MESH_DOMAIN_UNQUALIFIED'||error?.code==='MESH_PATCH_INVALID')throw error;throw new DiscreteTetraError('MESH_INPUT_INVALID','面片四面体请求或固定拓扑不符合协议；未启动进程。');}
}
export function assertPatchedDiscreteTetraHandshake(health){
  const actual=health?.capabilities?.patchedDiscreteTetra;
  check(health?.ok===true&&health.protocolVersion===1&&health.service==='gmsh-mesh-worker'&&health.capabilities?.version===1&&plain(actual)&&Object.entries(P).every(([k,v])=>actual[k]===v));
  return {version:1,basis:P.basis,gmshVersion:P.gmshVersion,apiVersion:P.apiVersion,license:P.license,patchTopologyBasis:P.patchTopologyBasis};
}

function clippedArea(subject,clip){
  let polygon=subject;const sign=Math.sign(orient(...clip));check(sign!==0);
  for(let side=0;side<3&&polygon.length;side++){
    const a=clip[side],b=clip[(side+1)%3],old=polygon;polygon=[];
    for(let i=0;i<old.length;i++){
      const p=old[i],q=old[(i+1)%old.length],u=sign*orient(a,b,p),v=sign*orient(a,b,q);
      if(u>=0)polygon.push(p);
      if(u<0&&v>0||u>0&&v<0){const t=u/(u-v);polygon.push(p.map((n,i)=>n+t*(q[i]-n)));}
    }
  }
  return polygon.length>=3?area(polygon):0;
}
const bounds=points=>({min:[0,1].map(i=>Math.min(...points.map(p=>p[i]))),max:[0,1].map(i=>Math.max(...points.map(p=>p[i])))});
const overlaps=(a,b)=>a.min.every((v,i)=>v<=b.max[i]&&a.max[i]>=b.min[i]);
// Bounding boxes only prune impossible intersections; they never choose an
// owner or certify coverage. Every retained pair is geometrically clipped.
function indexFor(rows){
  const build=items=>{
    const box={min:[0,1].map(i=>items.reduce((n,r)=>Math.min(n,r.box.min[i]),Infinity)),max:[0,1].map(i=>items.reduce((n,r)=>Math.max(n,r.box.max[i]),-Infinity))};
    if(items.length<=8)return {...box,items};
    const axis=box.max[0]-box.min[0]>=box.max[1]-box.min[1]?0:1;
    items.sort((a,b)=>(a.box.min[axis]+a.box.max[axis])-(b.box.min[axis]+b.box.max[axis])||a.id-b.id);
    const middle=Math.floor(items.length/2);return {...box,children:[build(items.slice(0,middle)),build(items.slice(middle))]};
  };
  return rows.length?build(rows):null;
}
function query(index,box,work){
  const result=[],pending=index?[index]:[];
  while(pending.length){
    if(++work.visits>P.maxCoverageIndexVisits)throw new DiscreteTetraError('MESH_COVERAGE_LIMIT','面片覆盖索引工作量超过固定预算；未接纳网格。');
    const node=pending.pop();if(!overlaps(node,box))continue;
    if(node.items){for(const row of node.items)if(overlaps(row.box,box))result.push(row);}
    else pending.push(...node.children);
  }
  return result;
}
function onLine(p,a,b){
  const u=sub(b,a),v=sub(p,a),square=dot(u,u);check(Number.isFinite(square)&&square>0);
  const t=dot(v,u)/square;return Math.hypot(...cross(u,v))/Math.sqrt(square)<=1e-8&&t>=-1e-8&&t<=1+1e-8;
}
function surfaces(result,input,complex){
  const {domain:d,patchPlan:plan}=input,{points}=result,{faces}=complex;
  check(Array.isArray(result.patches)&&result.patches.length===plan.patches.length);
  const consumed=faces.map(()=>new Set()),surfaceFaces=new Set(),curveMeshes=plan.edges.map(()=>new Map()),work={pairs:0,visits:0};
  let surfaceCount=0,boundaryCount=0,embeddedCount=0,exteriorCount=0;
  for(let p=0;p<plan.patches.length;p++){
    const patch=plan.patches[p],row=result.patches[p];
    fields(row,['patchIndex','triangles','cellUses','sourceFaces','sourceTriangleIndexes','sourceTriangleOrientations','constraint']);
    check(row.patchIndex===p&&same(row.cellUses,patch.cellUses)&&same(row.sourceFaces,patch.sourceFaces)&&same(row.sourceTriangleIndexes,patch.triangleIndexes)&&same(row.sourceTriangleOrientations,patch.triangleOrientations)&&same(row.constraint,patch.constraint)&&Array.isArray(row.triangles)&&row.triangles.length>0);
    surfaceCount+=row.triangles.length;check(surfaceCount<=P.maxBoundaryTriangles);
    const kind=patch.constraint.kind;if(kind==='boundary')boundaryCount+=row.triangles.length;else if(kind==='embedded')embeddedCount+=row.triangles.length;else{check(kind==='exterior');exteriorCount+=row.triangles.length;}
    const originals=patch.triangleIndexes.map(i=>d.triangles[i].map(n=>d.points[n])),origin=originals[0][0];
    const normal=cross(sub(originals[0][1],origin),sub(originals[0][2],origin)).map(v=>v*patch.triangleOrientations[0]),normalLength=Math.hypot(...normal);check(Number.isFinite(normalLength)&&normalLength>0);
    const axis=normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))),axes=[0,1,2].filter(i=>i!==axis);
    const scale=originals.reduce((s,t)=>t.reduce((v,p)=>Math.max(v,...axes.map(i=>Math.abs(p[i]-origin[i]))),s),0);check(Number.isFinite(scale)&&scale>0);
    const project=point=>axes.map(i=>(point[i]-origin[i])/scale),sourceTriangles=originals.map(t=>t.map(project)),coverage=sourceTriangles.map(()=>0);
    const sourceIndex=indexFor(sourceTriangles.map((triangle,id)=>({id,triangle,box:bounds(triangle)}))),meshEdges=new Map(),adjacency=row.triangles.map(()=>[]);
    const expected=new Map();for(const loop of patch.loops)for(const use of loop.edgeUses){const id=Math.abs(use)-1;check(!expected.has(id));expected.set(id,{kind:'boundary',direction:Math.sign(use)});}for(const id of patch.embeddedEdgeIndexes){check(!expected.has(id));expected.set(id,{kind:'embedded'});}
    const curveIndex=indexFor([...expected.keys()].map(id=>{const box=bounds(plan.edges[id].vertices.map(i=>project(d.points[i])));for(let j=0;j<2;j++){box.min[j]-=1e-8/scale;box.max[j]+=1e-8/scale;}return {id,box};})),lengths=new Map([...expected.keys()].map(i=>[i,0]));
    for(let t=0;t<row.triangles.length;t++){
      const triangle=row.triangles[t];check(Array.isArray(triangle)&&triangle.length===3&&new Set(triangle).size===3&&triangle.every(n=>integer(n,points.length)));
      const id=key(triangle);check(!surfaceFaces.has(id));surfaceFaces.add(id);
      const xyz=triangle.map(i=>points[i]),n=cross(sub(xyz[1],xyz[0]),sub(xyz[2],xyz[0]));check(dot(n,normal)>0);
      for(const point of xyz)check(Math.abs(dot(sub(point,origin),normal))/normalLength<=1e-8);
      const projected=xyz.map(project),targetArea=area(projected);check(Number.isFinite(targetArea)&&targetArea>0);let covered=0;
      for(const source of query(sourceIndex,bounds(projected),work)){
        if(++work.pairs>P.maxCoveragePairs)throw new DiscreteTetraError('MESH_COVERAGE_LIMIT','面片精确覆盖候选超过固定预算；未接纳网格。');
        const clipped=clippedArea(projected,source.triangle);coverage[source.id]+=clipped;covered+=clipped;
      }
      near(covered,targetArea);
      if(kind==='embedded'){
        const c=patch.constraint.cellIndexes[0],uses=faces[c]?.get(id);check(uses?.length===2);
        for(let peer=0;peer<faces.length;peer++)if(peer!==c)check(!faces[peer].has(id));
      }else if(kind==='exterior'){for(const cell of faces)check(!cell.has(id));}
      else{
        const owners=new Set();for(const use of patch.cellUses){const c=use.cellIndex,list=faces[c]?.get(id);check(list?.length===1&&!consumed[c].has(id));consumed[c].add(id);owners.add(c);const [a,b,z]=list[0].nodes.map(i=>points[i]);check(dot(cross(sub(b,a),sub(z,a)),normal)*use.orientation>0);}
        for(let c=0;c<faces.length;c++)if(!owners.has(c))check(!faces[c].has(id));
      }
      for(let i=0;i<3;i++){
        const a=triangle[i],b=triangle[(i+1)%3],k=key([a,b]),uses=meshEdges.get(k)||[];check(uses.length<2);
        if(uses.length){check(uses[0].a===b&&uses[0].b===a);adjacency[t].push(uses[0].triangle);adjacency[uses[0].triangle].push(t);}
        uses.push({a,b,triangle:t});meshEdges.set(k,uses);
      }
    }
    coverage.forEach((v,i)=>near(v,area(sourceTriangles[i])));
    const visited=new Set(),pending=[0];while(pending.length){const n=pending.pop();if(visited.has(n))continue;visited.add(n);pending.push(...adjacency[n].filter(i=>!visited.has(i)));}check(visited.size===row.triangles.length);
    for(const [k,uses]of meshEdges){
      const {a:u,b:v}=uses[0],a=points[u],b=points[v];let matched=false;
      for(const candidate of query(curveIndex,bounds([project(a),project(b)]),work)){
        const e=candidate.id,[x,y]=plan.edges[e].vertices.map(i=>d.points[i]);if(!onLine(a,x,y)||!onLine(b,x,y))continue;
        const use=expected.get(e);check(uses.length===(use.kind==='boundary'?1:2));if(use.kind==='boundary')check(dot(sub(b,a),sub(y,x))*use.direction>0);
        lengths.set(e,lengths.get(e)+Math.hypot(...sub(b,a)));if(!curveMeshes[e].has(p))curveMeshes[e].set(p,new Set());curveMeshes[e].get(p).add(k);matched=true;break;
      }
      if(uses.length===1)check(matched);
    }
    for(const [e,length]of lengths){const [a,b]=plan.edges[e].vertices.map(i=>d.points[i]);near(length,Math.hypot(...sub(b,a)));}
  }
  for(let c=0;c<faces.length;c++)for(const [id,list]of faces[c])if(list.length===1)check(consumed[c].has(id));
  for(let e=0;e<plan.edges.length;e++){
    const meshes=curveMeshes[e];check(meshes.size===plan.edges[e].patchUses.length);const sets=[...meshes.values()].map(s=>[...s].sort());for(const set of sets.slice(1))check(same(set,sets[0]));
  }
  return {surfaceCount,boundaryCount,embeddedCount,exteriorCount};
}
export function assertPatchedDiscreteTetraResult(result,input,requestId){
  try{
    fields(result,['ok','protocolVersion','requestId','service','operation','basis','gmshVersion','patchTopologyBasis','patchDomainSha256','patchSourceInputSha256','points','cells','patches','sourceSolids','sources','quality','optimization','report','algorithm','processResources','execution']);
    const plan=input.patchPlan;check(result.ok===true&&result.protocolVersion===1&&result.requestId===requestId&&result.service==='gmsh-mesh-worker'&&result.operation==='mesh.discrete-patched-tetra'&&result.basis===P.basis&&result.gmshVersion===P.gmshVersion&&result.patchTopologyBasis===P.patchTopologyBasis&&result.patchDomainSha256===plan.domainSha256&&result.patchSourceInputSha256===plan.sourceInputSha256);
    const complex=validateDiscreteTetraCellComplex(result,input),counts=surfaces(result,input,complex),r=result.report;
    fields(r,['tetraCount','nodeCount','patchCount','boundaryTriangleCount','surfaceTriangleCount','embeddedTriangleCount','exteriorTriangleCount','volume','minimumSICN','normalMeshAdmitted','materialPriorityAssigned']);
    check(r.tetraCount===complex.total&&r.nodeCount===result.points.length&&r.patchCount===plan.patches.length&&r.boundaryTriangleCount===counts.boundaryCount&&r.surfaceTriangleCount===counts.surfaceCount&&r.embeddedTriangleCount===counts.embeddedCount&&r.exteriorTriangleCount===counts.exteriorCount&&r.normalMeshAdmitted===false&&r.materialPriorityAssigned===false);near(r.volume,complex.volume);near(complex.volume,input.domain.report.unionVolume);near(r.minimumSICN,complex.minimum,2e-10);
    validateDiscreteTetraQualityReports(result,input,complex.metrics);if(input.quality.mode==='strict')check(result.quality.meetsRequestedQuality===true);return result;
  }catch(error){if(error?.code==='MESH_COVERAGE_LIMIT')throw error;throw fail();}
}
export function patchedDiscreteTetraFailure(result,input){
  if(['points','cells','boundaries','patches','mesh'].some(k=>result[k]!==undefined))throw fail();
  if(result.code!=='MESH_QUALITY_REJECTED')return new DiscreteTetraError(result.code,result.error.slice(0,1024));
  try{
    check(result.operation==='mesh.discrete-patched-tetra'&&input.quality.mode==='strict');validateDiscreteTetraQualityReports(result,input);check(result.quality.meetsRequestedQuality===false);
    const details={quality:result.quality,optimization:result.optimization};check(Buffer.byteLength(JSON.stringify(details))<=256*1024);return new DiscreteTetraError(result.code,result.error.slice(0,1024),details);
  }catch{throw fail();}
}
