import {volumeInput,verifiedDomain,tetraResult,tetraHealth} from './discrete-tetra-fixture.mjs';
import {VOLUME_CONSTRAINT_PROTOCOL as V} from '../../gateway/volume-partition-protocol.mjs';
import {PATCHED_DISCRETE_TETRA_PROTOCOL as P} from '../../gateway/patched-tetra-protocol.mjs';
import {buildConstrainedSurfacePatches} from '../../gateway/constrained-surface-patches.mjs';
import {normalizeDiscreteTetraInput} from '../../gateway/discrete-tetra-protocol.mjs';
const sub=(a,b)=>a.map((v,i)=>v-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
export function patchedTetraFixture({reflected=false,sheet,offset}={}){
  const source=volumeInput(),domain=verifiedDomain(),legacy=tetraResult();
  domain.basis=V.basis;domain.operation='volume.partition-constrained';domain.algorithm.basis=V.basis;
  if(sheet){
    const exterior=sheet==='exterior',triangle=exterior?[8,9,10]:[0,2,6];
    if(exterior){source.points.push([0,0,3],[1,0,3],[0,1,3]);domain.points=structuredClone(source.points);legacy.points=structuredClone(source.points);}
    source.triangles.push(triangle);source.sources.push({bodyId:'sheet',faceId:'sheet-face'});domain.triangles.push([...triangle]);domain.sources.push({...source.sources.at(-1)});domain.sourceTriangleIds.push([12]);domain.triangleCellUses.push([]);domain.triangleRegionUses.push([]);
    for(const key of ['inputTriangles','distinctInputTriangles','outputTriangles','sourceReferences'])domain.surfaceReport[key]=13;
    legacy.boundaries.push({sourceBoundaryTriangle:12,triangles:[[...triangle]]});
  }
  domain.constraints={version:1,basis:V.constraintBasis,triangles:domain.triangles.map((_,i)=>i<12?{kind:'boundary',cellIndexes:[]}:{kind:sheet==='exterior'?'exterior':'embedded',cellIndexes:sheet==='exterior'?[]:[0]}),report:{embeddedTriangles:sheet==='embedded'?1:0,exteriorTriangles:sheet==='exterior'?1:0,boundarySheetTriangles:0,sheetSourceFaces:sheet?1:0}};
  if(offset)for(const object of [source,domain,legacy])object.points=object.points.map(p=>p.map((v,i)=>v+offset[i]));
  const input=normalizeDiscreteTetraInput({domain}),patchPlan=buildConstrainedSurfacePatches(input,{sourceInput:source});input.patchPlan=patchPlan;
  const patches=patchPlan.patches.map((p,i)=>({patchIndex:i,sourceTriangleIndexes:p.triangleIndexes,sourceTriangleOrientations:p.triangleOrientations,sourceFaces:p.sourceFaces,cellUses:p.cellUses,constraint:p.constraint,triangles:p.triangleIndexes.flatMap((index,j)=>legacy.boundaries[index].triangles.map(t=>p.triangleOrientations[j]===1?[...t]:[t[0],t[2],t[1]]))}));
  if(reflected){
    const map=[1,0,3,2,5,4,7,6];legacy.cells[0].tetrahedra=legacy.cells[0].tetrahedra.map(t=>{const n=t.map(i=>map[i]);return [n[1],n[0],n[2],n[3]];});
    const faces=new Map();for(const tet of legacy.cells[0].tetrahedra)for(const order of [[1,2,3],[0,3,2],[0,1,3],[0,2,1]]){const t=order.map(i=>tet[i]),key=[...t].sort().join(',');if(!faces.has(key))faces.set(key,[]);faces.get(key).push(t);}
    patches.forEach(p=>p.triangles=[]);
    for(const [triangle]of [...faces.values()].filter(uses=>uses.length===1)){
      const points=triangle.map(i=>domain.points[i]),p=patchPlan.patches.findIndex(p=>{const a=p.plane.map(Number);return points.every(point=>dot(a.slice(0,3),point.map(v=>v/2**patchPlan.coordinateExponent))+a[3]===0);});
      const normal=patchPlan.patches[p].plane.slice(0,3).map(Number);patches[p].triangles.push(dot(cross(sub(points[1],points[0]),sub(points[2],points[0])),normal)>0?triangle:[triangle[0],triangle[2],triangle[1]]);
    }
  }
  const output={ok:true,protocolVersion:1,requestId:'tetra',service:'gmsh-mesh-worker',operation:'mesh.discrete-patched-tetra',basis:P.basis,gmshVersion:P.gmshVersion,patchTopologyBasis:P.patchTopologyBasis,patchDomainSha256:patchPlan.domainSha256,patchSourceInputSha256:patchPlan.sourceInputSha256,points:legacy.points,cells:legacy.cells,patches,sourceSolids:domain.sourceSolids,sources:domain.sources,quality:legacy.quality,optimization:legacy.optimization,report:{...legacy.report,nodeCount:legacy.points.length,patchCount:patches.length,surfaceTriangleCount:sheet?13:12,embeddedTriangleCount:sheet==='embedded'?1:0,exteriorTriangleCount:sheet==='exterior'?1:0}};
  const health=tetraHealth();health.capabilities.patchedDiscreteTetra={...P};return {source,input,output,health};
}
