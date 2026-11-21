import {DiscreteSurfaceError,DISCRETE_SURFACE_PROTOCOL,assertDiscreteHandshake,assertDiscreteResult} from './discrete-surface-protocol.mjs';

export const VOLUME_PARTITION_PROTOCOL=Object.freeze({
  version:1,basis:'exact-nef-membership-partition-shared-refined-boundary-v1',
  cgalVersion:'6.1.2',license:'GPL-3.0-or-later',units:'mm',
  maxInputTriangles:4096,maxOutputTriangles:20000,maxPoints:60000,
  maxSourceSolids:6,maxRegions:32,maxCells:128,maxClassificationPairs:100000,
  maxRequestBytes:8*1024**2,maxResponseBytes:64*1024**2,
  oneJobPerProcess:true,normalMeshAdmitted:false,tetrahedralReady:false,
  sourceIdentityAuthority:'caller-supplied-solid-labels-not-cad-certificates',
});
export const VOLUME_CONSTRAINT_PROTOCOL=Object.freeze({...VOLUME_PARTITION_PROTOCOL,basis:'exact-nef-membership-with-open-sheet-constraints-v1',constraintBasis:'exact-triangle-closed-cell-membership-v1'});
const P=VOLUME_PARTITION_PROTOCOL;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const finite=(value,min=0)=>typeof value==='number'&&Number.isFinite(value)&&value>min;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(value);
const invalid=code=>new DiscreteSurfaceError(code||'VOLUME_PROTOCOL_INVALID','体域分区的协议、来源、连通边界或体积无法核对；未接纳结果。');
const check=value=>{if(!value)throw invalid();};
const near=(a,b,tolerance=1e-8)=>check(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tolerance*Math.max(1e-30,Math.abs(b)));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sortedIndexes=(array,length)=>Array.isArray(array)&&array.length>0&&array.every((n,i)=>integer(n,0,length-1)&&(i===0||n>array[i-1]));

export function assertVolumePartitionInput(input,{allowSheets=false}={}){
  try{
    const fail=()=>{throw invalid('VOLUME_REQUEST_INVALID');};
    if(!plain(input)||Object.keys(input).some(key=>!['units','points','triangles','sources','options'].includes(key))||input.units!=='mm'||!Array.isArray(input.points)||!integer(input.points.length,4,P.maxPoints)||!Array.isArray(input.triangles)||!integer(input.triangles.length,4,P.maxInputTriangles)||!Array.isArray(input.sources)||input.sources.length!==input.triangles.length)fail();
    for(const point of input.points)if(!Array.isArray(point)||point.length!==3||point.some(n=>typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e12))fail();
    const solids=new Set();
    for(let i=0;i<input.triangles.length;i++){
      const triangle=input.triangles[i],source=input.sources[i];
      if(!Array.isArray(triangle)||triangle.length!==3||triangle.some(n=>!integer(n,0,input.points.length-1))||!plain(source)||Object.keys(source).some(key=>!['bodyId','faceId','solidId'].includes(key))||!id(source.bodyId)||!id(source.faceId))fail();
      if(source.solidId===undefined){if(allowSheets)continue;throw invalid('VOLUME_FREE_SHEET_UNSUPPORTED');}
      if(!id(source.solidId))fail();
      solids.add(source.bodyId+'/'+source.solidId);
    }
    if(solids.size>P.maxSourceSolids)throw invalid('VOLUME_SOLID_LIMIT');
    if(allowSheets&&solids.size===0)throw invalid('VOLUME_SOLID_REQUIRED');
    if(input.options!==undefined){
      const o=input.options;
      if(!plain(o)||Object.keys(o).some(key=>!['snapGridSize','iterations','tolerance'].includes(key))||o.snapGridSize!==undefined&&!integer(o.snapGridSize,30,51)||o.iterations!==undefined&&!integer(o.iterations,1,10)||o.tolerance!==undefined&&(!finite(o.tolerance)||o.tolerance<1e-12||o.tolerance>1e-3))fail();
    }
    return input;
  }catch(error){if(error instanceof DiscreteSurfaceError)throw error;throw invalid('VOLUME_REQUEST_INVALID');}
}
export const assertConstrainedVolumeInput=input=>assertVolumePartitionInput(input,{allowSheets:true});

export function assertVolumePartitionHandshake(health){
  assertDiscreteHandshake(health);
  const actual=health?.capabilities?.volumePartition;
  if(!plain(actual)||Object.entries(P).some(([key,value])=>actual[key]!==value))throw invalid();
  return {version:P.version,basis:P.basis,cgalVersion:P.cgalVersion,license:P.license};
}
export function assertConstrainedVolumeHandshake(health){
  assertDiscreteHandshake(health);
  const actual=health?.capabilities?.constrainedVolumePartition;
  if(!plain(actual)||Object.entries(VOLUME_CONSTRAINT_PROTOCOL).some(([key,value])=>actual[key]!==value))throw invalid();
  const {version,basis,cgalVersion,license}=VOLUME_CONSTRAINT_PROTOCOL;return {version,basis,cgalVersion,license};
}

function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function subtract(a,b){return a.map((x,i)=>x-b[i]);}
function dot(a,b){return a.reduce((sum,x,i)=>sum+x*b[i],0);}
function distanceToTriangle(point,a,b,c){
  const normal=cross(subtract(b,a),subtract(c,a)),square=dot(normal,normal);check(finite(square));
  const signed=dot(subtract(point,a),normal),projected=point.map((x,i)=>x-normal[i]*signed/square);
  const triangle=[a,b,c];let inside=true,distance=Infinity;
  for(let i=0;i<3;i++){
    const start=triangle[i],end=triangle[(i+1)%3],edge=subtract(end,start);
    if(dot(cross(edge,subtract(projected,start)),normal)<-1e-12*square)inside=false;
    const length=dot(edge,edge);check(finite(length));
    const t=Math.max(0,Math.min(1,dot(subtract(point,start),edge)/length));
    distance=Math.min(distance,Math.hypot(...point.map((x,j)=>x-start[j]-t*edge[j])));
  }
  return inside?Math.abs(signed)/Math.sqrt(square):distance;
}
function triangleVolume(points,triangle,orientation,origin){
  const [a,b,c]=triangle.map(i=>subtract(points[i],origin));
  return orientation*dot(a,cross(b,c))/6;
}
function sourceCoverage(result,input){
  const areas=input.triangles.map(triangle=>{const [a,b,c]=triangle.map(i=>input.points[i]);return Math.hypot(...cross(subtract(b,a),subtract(c,a)))/2;}),covered=areas.map(()=>0);
  const tolerance=input.options?.tolerance??1e-7;
  for(let i=0;i<result.triangles.length;i++){
    const [a,b,c]=result.triangles[i].map(n=>result.points[n]);
    const area=Math.hypot(...cross(subtract(b,a),subtract(c,a)))/2;check(finite(area));
    for(const source of result.sourceTriangleIds[i]){
      const [x,y,z]=input.triangles[source].map(n=>input.points[n]),normal=cross(subtract(y,x),subtract(z,x)),length=Math.hypot(...normal);
      check(finite(length));
      for(const point of [a,b,c])check(Math.abs(dot(subtract(point,x),normal))/length<=tolerance*1.0001&&distanceToTriangle(point,x,y,z)<=tolerance*1.0001);
      covered[source]+=area;
    }
  }
  const removed=new Set(result.surfaceReport.removedDegenerateInputTriangles);
  for(let i=0;i<areas.length;i++)if(removed.has(i))check(covered[i]===0);else near(covered[i],areas[i],2e-6);
}

function validate(result,input,requestId,allowSheets=false){
  assertVolumePartitionInput(input,{allowSheets});
  check(result?.ok===true&&result.protocolVersion===1&&result.requestId===requestId&&result.service===DISCRETE_SURFACE_PROTOCOL.service&&result.operation===(allowSheets?'volume.partition-constrained':'volume.partition')&&result.basis===(allowSheets?VOLUME_CONSTRAINT_PROTOCOL.basis:P.basis)&&result.cgalVersion===P.cgalVersion&&result.units==='mm');
  check(allowSheets||result.constraints===undefined);
  // The nested report describes the shared surface stage, not volume admission.
  // Reuse its existing bounded payload validator after checking the enclosing operation.
  assertDiscreteResult({...result,operation:'surface.refine',basis:DISCRETE_SURFACE_PROTOCOL.basis,report:result.surfaceReport},input,requestId);
  check(result.points.length<=P.maxPoints&&result.triangles.length<=P.maxOutputTriangles);
  const uniquePoints=new Set(result.points.map(point=>point.join(',')));check(uniquePoints.size===result.points.length);
  const uniqueTriangles=new Set(result.triangles.map(triangle=>[...triangle].sort((a,b)=>a-b).join(',')));check(uniqueTriangles.size===result.triangles.length);
  sourceCoverage(result,input);
  const labels=[];const labelKeys=new Set();
  for(const source of input.sources){if(source.solidId===undefined)continue;const key=source.bodyId+'/'+source.solidId;if(!labelKeys.has(key)){labelKeys.add(key);labels.push({bodyId:source.bodyId,solidId:source.solidId});}}
  check(Array.isArray(result.sourceSolids)&&result.sourceSolids.length===labels.length);
  for(let i=0;i<labels.length;i++){const row=result.sourceSolids[i];check(plain(row)&&row.bodyId===labels[i].bodyId&&row.solidId===labels[i].solidId&&finite(row.volume));near(row.partitionVolume,row.volume);}
  check(Array.isArray(result.regions)&&integer(result.regions.length,1,P.maxRegions)&&Array.isArray(result.cells)&&integer(result.cells.length,1,P.maxCells)&&result.triangles.length*result.cells.length<=P.maxClassificationPairs);
  const memberships=new Set();
  for(const region of result.regions){check(plain(region)&&region.closed===true&&sortedIndexes(region.sourceSolidIndexes,labels.length)&&finite(region.volume)&&finite(region.exactPartitionVolume)&&integer(region.connectedVolumeCount,1,P.maxCells));near(region.volume,region.exactPartitionVolume);const key=region.sourceSolidIndexes.join(',');check(!memberships.has(key));memberships.add(key);}
  const uses=result.cells.map(()=>new Map()),regionVolumes=result.regions.map(()=>0),regionCounts=result.regions.map(()=>0);
  check(Array.isArray(result.triangleCellUses)&&result.triangleCellUses.length===result.triangles.length&&Array.isArray(result.triangleRegionUses)&&result.triangleRegionUses.length===result.triangles.length);
  for(const cell of result.cells)check(plain(cell)&&integer(cell.regionIndex,0,result.regions.length-1)&&same(cell.sourceSolidIndexes,result.regions[cell.regionIndex].sourceSolidIndexes)&&cell.closed===true&&finite(cell.volume)&&Array.isArray(cell.shells)&&integer(cell.shells.length,1,P.maxCells));
  let shared=0,embedded=0,exterior=0,boundarySheets=0;
  const constraints=result.constraints;
  if(allowSheets)check(plain(constraints)&&Object.keys(constraints).length===4&&constraints.version===1&&constraints.basis===VOLUME_CONSTRAINT_PROTOCOL.constraintBasis&&Array.isArray(constraints.triangles)&&constraints.triangles.length===result.triangles.length);
  for(let i=0;i<result.triangles.length;i++){
    const row=result.triangleCellUses[i];check(Array.isArray(row)&&(row.length===1||row.length===2||allowSheets&&row.length===0));const seen=new Set();let direction=0;
    if(allowSheets){
      const constraint=constraints.triangles[i],refs=result.sourceTriangleIds[i].map(j=>input.sources[j]),sheet=refs.some(source=>source.solidId===undefined),solid=refs.some(source=>source.solidId!==undefined);
      check(plain(constraint)&&Object.keys(constraint).length===2&&Array.isArray(constraint.cellIndexes));
      if(row.length){check(constraint.kind==='boundary'&&constraint.cellIndexes.length===0&&solid);if(sheet)boundarySheets++;}
      else{check(sheet&&!solid);if(constraint.kind==='embedded'){check(constraint.cellIndexes.length===1&&integer(constraint.cellIndexes[0],0,result.cells.length-1));embedded++;}else{check(constraint.kind==='exterior'&&constraint.cellIndexes.length===0);exterior++;}}
    }
    for(const use of row){check(plain(use)&&Object.keys(use).length===2&&integer(use.cellIndex,0,result.cells.length-1)&&(use.orientation===1||use.orientation===-1)&&!seen.has(use.cellIndex));seen.add(use.cellIndex);direction+=use.orientation;uses[use.cellIndex].set(i,use.orientation);}
    if(row.length===2){check(direction===0);shared++;}
    const mapped=row.map(use=>({regionIndex:result.cells[use.cellIndex].regionIndex,orientation:use.orientation})).sort((a,b)=>a.regionIndex-b.regionIndex),other=result.triangleRegionUses[i];
    check(Array.isArray(other)&&other.length===mapped.length&&new Set(mapped.map(use=>use.regionIndex)).size===mapped.length);
    for(const use of other)check(plain(use)&&Object.keys(use).length===2&&integer(use.regionIndex,0,result.regions.length-1)&&(use.orientation===1||use.orientation===-1));
    const ordered=[...other].sort((a,b)=>a.regionIndex-b.regionIndex);
    check(mapped.every((use,j)=>use.regionIndex===ordered[j].regionIndex&&use.orientation===ordered[j].orientation));
  }
  for(let c=0;c<result.cells.length;c++){
    const cell=result.cells[c],consumed=new Set(),cellEdges=new Set();let volume=0;
    check(cell.shells[0].outer===true&&cell.shells.filter(shell=>shell.outer===true).length===1);
    const origin=result.points[result.triangles[uses[c].keys().next().value]?.[0]];check(Array.isArray(origin));
    for(const shell of cell.shells){
      check(plain(shell)&&typeof shell.outer==='boolean'&&Array.isArray(shell.triangleIndexes)&&integer(shell.triangleIndexes.length,4,P.maxOutputTriangles));
      const edges=new Map(),adjacency=new Map();let signed=0;
      for(const i of shell.triangleIndexes){
        check(integer(i,0,result.triangles.length-1)&&uses[c].has(i)&&!consumed.has(i));consumed.add(i);
        signed+=triangleVolume(result.points,result.triangles[i],uses[c].get(i),origin);
        const triangle=[...result.triangles[i]];if(uses[c].get(i)<0)[triangle[1],triangle[2]]=[triangle[2],triangle[1]];
        for(let k=0;k<3;k++){const a=triangle[k],b=triangle[(k+1)%3],key=Math.min(a,b)+','+Math.max(a,b),row=edges.get(key)||[];row.push({triangle:i,sign:a<b?1:-1});edges.set(key,row);}
      }
      for(const [key,row]of edges){check(row.length===2&&row[0].sign+row[1].sign===0&&!cellEdges.has(key));cellEdges.add(key);for(const [a,b]of [[row[0].triangle,row[1].triangle],[row[1].triangle,row[0].triangle]]){const list=adjacency.get(a)||[];list.push(b);adjacency.set(a,list);}}
      const seen=new Set(),pending=[shell.triangleIndexes[0]];
      while(pending.length){const i=pending.pop();if(seen.has(i))continue;seen.add(i);for(const next of adjacency.get(i)||[])if(!seen.has(next))pending.push(next);}
      check(seen.size===shell.triangleIndexes.length&&(signed>0)===shell.outer&&signed!==0);near(signed,shell.signedVolume);volume+=signed;
    }
    check(consumed.size===uses[c].size);near(volume,cell.volume);regionVolumes[cell.regionIndex]+=volume;regionCounts[cell.regionIndex]++;
  }
  const sourceVolumes=labels.map(()=>0);let union=0;
  for(let r=0;r<result.regions.length;r++){const region=result.regions[r];near(regionVolumes[r],region.volume);check(regionCounts[r]===region.connectedVolumeCount);union+=region.volume;for(const source of region.sourceSolidIndexes)sourceVolumes[source]+=region.volume;}
  for(let i=0;i<labels.length;i++)near(sourceVolumes[i],result.sourceSolids[i].volume);
  const report=result.report;
  check(plain(report)&&report.regionCount===result.regions.length&&report.cellCount===result.cells.length&&report.sharedInterfaceTriangles===shared&&report.exactSetCoverage===true&&report.pairwiseVolumeDisjoint===true&&report.allRegionBoundariesClosed===true&&report.connectedCellsIndividuallyExported===true&&report.normalMeshAdmitted===false&&report.tetrahedralReady===false&&report.sourceIdentityAuthority===P.sourceIdentityAuthority&&Number.isFinite(report.maxRelativeRegionVolumeError)&&report.maxRelativeRegionVolumeError>=0&&report.maxRelativeRegionVolumeError<=1e-8);
  near(union,report.unionVolume);
  if(allowSheets){const summary=constraints.report,sheetFaces=new Set(input.sources.filter(source=>source.solidId===undefined).map(source=>source.bodyId+'/'+source.faceId));check(plain(summary)&&Object.keys(summary).length===4&&summary.embeddedTriangles===embedded&&summary.exteriorTriangles===exterior&&summary.boundarySheetTriangles===boundarySheets&&summary.sheetSourceFaces===sheetFaces.size);}
  return result;
}

export function assertVolumePartitionResult(result,input,requestId){
  try{return validate(result,input,requestId);}catch(error){if(error?.code==='VOLUME_PROTOCOL_INVALID')throw error;throw invalid();}
}
export function assertConstrainedVolumeResult(result,input,requestId){
  try{return validate(result,input,requestId,true);}catch(error){if(error?.code==='VOLUME_PROTOCOL_INVALID')throw error;throw invalid();}
}
