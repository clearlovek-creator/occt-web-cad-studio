// SPDX-License-Identifier: GPL-3.0-or-later
// Derived, conservative topology for the existing constrained volume domain.
// This does not admit a mesh, move a point or establish CAD identity.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertConstrainedDiscreteTetraInput,DiscreteTetraError} from './discrete-tetra-protocol.mjs';

export const CONSTRAINED_SURFACE_PATCH_PROTOCOL=Object.freeze({
  version:1,basis:'exact-dyadic-source-face-planar-patches-v1',
  maxResultBytes:16*1024**2,normalMeshAdmitted:false,
});
const P=CONSTRAINED_SURFACE_PATCH_PROTOCOL;
const check=(value,message)=>{if(!value)throw new DiscreteTetraError('MESH_PATCH_INVALID',message);};
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0n);
const zero=v=>v.every(x=>x===0n);
const edgeKey=(a,b)=>Math.min(a,b)+','+Math.max(a,b);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gcd=(a,b)=>{a=a<0n?-a:a;b=b<0n?-b:b;while(b){[a,b]=[b,a%b];}return a;};
const compareText=(a,b)=>a<b?-1:a>b?1:0;

// A finite binary64 value is an exact integer times a power of two. Do not
// use normal-angle/coordinate tolerances: a tiny real crease must survive.
function dyadic(value){
  if(value===0)return [0n,0];
  const buffer=new ArrayBuffer(8),view=new DataView(buffer);view.setFloat64(0,value);
  const bits=view.getBigUint64(0),exponent=Number((bits>>52n)&2047n),fraction=bits&((1n<<52n)-1n);
  const significand=(exponent?fraction+(1n<<52n):fraction)*(bits>>63n?-1n:1n);
  return [significand,exponent?exponent-1075:-1074];
}
function exactPoints(points){
  const rows=points.map(p=>p.map(dyadic));let exponent=0;
  for(const row of rows)for(const [n,e]of row)if(n!==0n)exponent=Math.min(exponent,e);
  return {exponent,points:rows.map(p=>p.map(([n,e])=>n===0n?0n:n<<BigInt(e-exponent)))};
}
function planeFor(points,triangle){
  const [a,b,c]=triangle.map(i=>points[i]),normal=cross(sub(b,a),sub(c,a));
  check(!zero(normal),'A patch source triangle is exactly degenerate.');
  const orientation=normal.find(x=>x!==0n)>0n?1:-1;
  const coefficients=[...normal,-dot(normal,a)],divisor=coefficients.reduce(gcd,0n)*BigInt(orientation);
  const plane=coefficients.map(x=>x/divisor);
  return {plane,orientation,key:plane.join(',')};
}
function faceInventory(domain,triangleIndex){
  const labels=new Map();
  for(const i of domain.sourceTriangleIds[triangleIndex]){
    const s=domain.sources[i],key=JSON.stringify([s.bodyId,s.faceId,s.solidId??null]);
    labels.set(key,s.solidId===undefined?{bodyId:s.bodyId,faceId:s.faceId}:{bodyId:s.bodyId,faceId:s.faceId,solidId:s.solidId});
  }
  return [...labels].sort(([a],[b])=>compareText(a,b)).map(([,s])=>s);
}
function canonicalTriangle(triangle,orientation){return orientation===1?[...triangle]:[triangle[0],triangle[2],triangle[1]];}
function rotateSmallest(loop){const i=loop.indexOf(Math.min(...loop));return [...loop.slice(i),...loop.slice(0,i)];}

function derive(domain,sourceInput){
  const exact=exactPoints(domain.points),points=exact.points;
  const rows=domain.triangles.map((triangle,i)=>{
    const plane=planeFor(points,triangle),sourceFaces=faceInventory(domain,i);
    const cellUses=domain.triangleCellUses[i].map(u=>({cellIndex:u.cellIndex,orientation:u.orientation*plane.orientation})).sort((a,b)=>a.cellIndex-b.cellIndex);
    const constraint=structuredClone(domain.constraints.triangles[i]);
    return {...plane,sourceFaces,cellUses,constraint,triangle:canonicalTriangle(triangle,plane.orientation),
      signature:JSON.stringify([plane.key,sourceFaces,cellUses,constraint.kind,[...constraint.cellIndexes].sort((a,b)=>a-b)])};
  });
  const sourceEdges=new Map();
  for(let i=0;i<rows.length;i++)for(let j=0;j<3;j++){
    const a=rows[i].triangle[j],b=rows[i].triangle[(j+1)%3],key=edgeKey(a,b);
    if(!sourceEdges.has(key))sourceEdges.set(key,{vertices:[Math.min(a,b),Math.max(a,b)],uses:[]});
    sourceEdges.get(key).uses.push({triangleIndex:i,direction:a<b?1:-1});
  }
  const parents=rows.map((_,i)=>i);
  const find=i=>{let r=i;while(parents[r]!==r)r=parents[r];while(i!==r){const n=parents[i];parents[i]=r;i=n;}return r;};
  for(const edge of sourceEdges.values()){
    const compatible=new Map();
    for(const use of edge.uses){const key=rows[use.triangleIndex].signature;if(!compatible.has(key))compatible.set(key,[]);compatible.get(key).push(use);}
    for(const uses of compatible.values()){
      check(uses.length<=2,'A source Face has a non-manifold planar edge.');
      if(uses.length===2){
        check(uses[0].direction+uses[1].direction===0,'Planar source triangles overlap or disagree in orientation.');
        const a=find(uses[0].triangleIndex),b=find(uses[1].triangleIndex);parents[Math.max(a,b)]=Math.min(a,b);
      }
    }
  }
  const groups=new Map();for(let i=0;i<rows.length;i++){const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(i);}
  const patches=[...groups.values()].map(triangleIndexes=>{
    const first=rows[triangleIndexes[0]];
    return {triangleIndexes,triangleOrientations:triangleIndexes.map(i=>rows[i].orientation),
      sourceFaces:first.sourceFaces,cellUses:first.cellUses,constraint:first.constraint,plane:first.plane.map(String),loops:[],embeddedEdgeIndexes:[]};
  });
  const trianglePatches=new Array(rows.length);patches.forEach((p,i)=>p.triangleIndexes.forEach(t=>trianglePatches[t]=i));
  const boundaries=patches.map(()=>[]),constraints=new Map();let removedInteriorEdges=0;
  for(const [key,edge]of sourceEdges){
    const uses=new Map();for(const use of edge.uses){const p=trianglePatches[use.triangleIndex];if(!uses.has(p))uses.set(p,[]);uses.get(p).push(use);}
    const patchUses=[];
    for(const [patchIndex,list]of uses){
      check(list.length<=2,'A planar patch has a non-manifold edge.');
      if(list.length===1){
        patchUses.push({patchIndex,kind:'boundary'});const [a,b]=edge.vertices;
        boundaries[patchIndex].push(list[0].direction===1?[a,b]:[b,a]);
      }else{
        check(list[0].direction+list[1].direction===0,'An interior patch edge does not cancel exactly.');
        // A crossing that ends inside a Face does not disconnect that Face.
        // Keep it as an embedded curve even when both sides join elsewhere.
        if(uses.size>1)patchUses.push({patchIndex,kind:'embedded'});
      }
    }
    if(patchUses.length){patchUses.sort((a,b)=>a.patchIndex-b.patchIndex);constraints.set(key,{...edge,patchUses,signature:JSON.stringify(patchUses)});}
    else removedInteriorEdges++;
  }
  const neighbours=new Map();
  for(const [key,edge]of constraints)for(const v of edge.vertices){if(!neighbours.has(v))neighbours.set(v,[]);neighbours.get(v).push(key);}
  const redundant=new Set();
  for(const [v,keys]of neighbours){
    if(keys.length!==2)continue;
    const [a,b]=keys.map(key=>constraints.get(key));if(a.signature!==b.signature)continue;
    const other=edge=>edge.vertices.find(n=>n!==v),u=sub(points[other(a)],points[v]),w=sub(points[other(b)],points[v]);
    if(zero(cross(u,w))&&dot(u,w)<0n)redundant.add(v);
  }
  const edges=[],consumed=new Set(),edgeUses=new Map();
  // Start at a non-redundant endpoint. Every finite straight component has
  // endpoints; a closed collinear component would have zero area.
  for(const [key,first]of constraints){
    if(consumed.has(key))continue;
    let start=first.vertices.find(v=>!redundant.has(v));
    if(start===undefined)continue;
    let current=start,currentKey=key;const chain=[],vertices=[start];
    while(true){
      check(!consumed.has(currentKey),'Constraint chains are cyclic or duplicate.');consumed.add(currentKey);
      const edge=constraints.get(currentKey),next=edge.vertices.find(v=>v!==current);chain.push([current,next]);vertices.push(next);
      if(!redundant.has(next))break;
      currentKey=neighbours.get(next).find(k=>k!==currentKey);current=next;
    }
    // Canonical edge orientation is independent of source triangle order.
    if(vertices[0]>vertices.at(-1)){vertices.reverse();chain.reverse();for(const pair of chain)pair.reverse();}
    const edgeIndex=edges.length;
    edges.push({vertices:[vertices[0],vertices.at(-1)],sourceEdges:chain,patchUses:first.patchUses});
    for(const pair of chain)edgeUses.set(edgeKey(...pair),{edgeIndex,direction:pair[0]<pair[1]?1:-1});
    for(const use of first.patchUses)if(use.kind==='embedded')patches[use.patchIndex].embeddedEdgeIndexes.push(edgeIndex);
  }
  check(consumed.size===constraints.size,'Constraint chains contain an unrepresented closed or degenerate component.');
  let loopCount=0;
  for(let p=0;p<patches.length;p++){
    const outgoing=new Map(),incoming=new Set();
    for(const [a,b]of boundaries[p]){check(!outgoing.has(a)&&!incoming.has(b),'A patch boundary branches or touches itself.');outgoing.set(a,b);incoming.add(b);}
    check(outgoing.size>=3&&[...outgoing.keys()].every(v=>incoming.has(v)),'A patch boundary is not closed.');
    const visited=new Set(),loops=[];let loopArea=0n;
    const normal=patches[p].plane.slice(0,3).map(BigInt);
    for(const first of outgoing.keys()){
      if(visited.has(first))continue;
      const loop=[];let v=first;
      do{check(!visited.has(v)&&outgoing.has(v),'A patch boundary is not a simple closed loop.');visited.add(v);loop.push(v);v=outgoing.get(v);}while(v!==first);
      const area=loop.reduce((sum,a,i)=>sum+dot(cross(points[a],points[loop[(i+1)%loop.length]]),normal),0n);
      check(area!==0n,'A patch boundary encloses zero exact area.');loopArea+=area;
      const kept=rotateSmallest(loop.filter(i=>!redundant.has(i)));check(kept.length>=3,'A patch lost its corner vertices.');
      const curveUses=[];
      for(let i=0;i<loop.length;i++){
        const a=loop[i],b=loop[(i+1)%loop.length];if(redundant.has(a))continue;
        const use=edgeUses.get(edgeKey(a,b));check(use!==undefined,'A patch boundary lacks an explicit constraint chain.');
        curveUses.push({vertex:a,use:(a<b?1:-1)*use.direction*(use.edgeIndex+1)});
      }
      const pivot=curveUses.findIndex(row=>row.vertex===kept[0]);
      loops.push({outer:area>0n,pointIndexes:kept,edgeUses:[...curveUses.slice(pivot),...curveUses.slice(0,pivot)].map(row=>row.use)});
    }
    const triangleArea=patches[p].triangleIndexes.reduce((sum,i)=>{
      const [a,b,c]=rows[i].triangle.map(n=>points[n]);return sum+dot(cross(sub(b,a),sub(c,a)),normal);
    },0n);
    check(loopArea===triangleArea&&triangleArea>0n&&loops.filter(row=>row.outer).length===1,'Patch loops do not exactly conserve their source triangles.');
    loops.sort((a,b)=>Number(b.outer)-Number(a.outer)||a.pointIndexes[0]-b.pointIndexes[0]);
    patches[p].loops=loops;loopCount+=loops.length;
  }
  const result={version:P.version,basis:P.basis,domainSha256:hash(domain),sourceInputSha256:hash(sourceInput),coordinateExponent:exact.exponent,
    patches,edges,trianglePatches,report:{inputTriangles:rows.length,patchCount:patches.length,loopCount,
      removedInteriorEdges,removedCollinearVertices:redundant.size,preservedConstraintEdges:constraints.size,outputConstraintEdges:edges.length,
      embeddedCurveUses:patches.reduce((n,p)=>n+p.embeddedEdgeIndexes.length,0),exactPlanarCoverage:true,normalMeshAdmitted:false}};
  check(Buffer.byteLength(JSON.stringify(result))<=P.maxResultBytes,'Patch topology exceeds its explicit result byte budget.');
  return result;
}

export function buildConstrainedSurfacePatches(input,context){
  assertConstrainedDiscreteTetraInput(input,context);
  return derive(input.domain,context.sourceInput);
}

export function assertConstrainedSurfacePatches(result,input,context){
  check(result!==null&&typeof result==='object'&&Buffer.byteLength(JSON.stringify(result))<=P.maxResultBytes,'Patch result exceeds its budget or is not an object.');
  const expected=buildConstrainedSurfacePatches(input,context);
  check(isDeepStrictEqual(result,expected),'Patch provenance, exact coverage or preserved constraints do not match the source domain.');
  return result;
}
