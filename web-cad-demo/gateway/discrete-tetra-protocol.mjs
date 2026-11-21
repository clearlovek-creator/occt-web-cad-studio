import {MeshWorkerError} from './mesh-worker-client.mjs';
import {assertVolumePartitionResult,assertConstrainedVolumeResult,VOLUME_PARTITION_PROTOCOL as V,VOLUME_CONSTRAINT_PROTOCOL as VC} from './volume-partition-protocol.mjs';
import {discreteMemoryPolicy,assertNativeMemoryGuard} from './native-resource-policy.mjs';

export const DISCRETE_TETRA_PROTOCOL=Object.freeze({
  version:1,basis:'shared-discrete-connected-cells-gmsh-tetra-v1',gmshVersion:'4.15.2',apiVersion:'4.15.2',license:'GPL-3.0-or-later',
  maxInputPoints:60000,maxInputTriangles:20000,maxCells:128,maxOutputPoints:100000,maxTetrahedra:200000,maxBoundaryTriangles:200000,
  maxRequestBytes:8*1024**2,maxResponseBytes:64*1024**2,qualityPolicyVersion:1,maxOptimizationIterations:5,
  oneJobPerProcess:true,normalMeshAdmitted:false,materialPriorityAssigned:false,userConfigLoaded:false,
});
const P=DISCRETE_TETRA_PROTOCOL;
export const CONSTRAINED_DISCRETE_TETRA_PROTOCOL=Object.freeze({...P,basis:'shared-constrained-discrete-cells-gmsh-tetra-v1',inputDomainBasis:VC.basis,constraintBasis:VC.constraintBasis});
const CP=CONSTRAINED_DISCRETE_TETRA_PROTOCOL;
export class DiscreteTetraError extends MeshWorkerError{
  constructor(code,message,details){super(code,message);this.name='DiscreteTetraError';this.retryableByModel=false;if(details!==undefined)this.details=details;}
}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const number=value=>typeof value==='number'&&Number.isFinite(value);
const fault=(code='MESH_PROTOCOL_INVALID')=>new DiscreteTetraError(code,'离散四面体的输入、公共界面、来源、体积或质量无法核对；未接纳网格。');
const check=value=>{if(!value)throw fault();};
const near=(a,b,tolerance=1e-6)=>check(number(a)&&number(b)&&Math.abs(a-b)<=tolerance*Math.max(1e-30,Math.abs(b)));
function equal(a,b){
  if(a===b)return true;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
  if(!plain(a)||!plain(b))return false;
  const keys=Object.keys(a).sort(),other=Object.keys(b).sort();return keys.length===other.length&&keys.every((key,i)=>key===other[i]&&equal(a[key],b[key]));
}
function fields(value,allowed){check(plain(value)&&Object.keys(value).every(key=>allowed.includes(key)));}
export function normalizeDiscreteTetraInput(input){
  if(!plain(input))return input;
  return {...input,meshSize:input.meshSize===undefined?1:input.meshSize,quality:input.quality===undefined?{version:1,mode:'strict',threshold:.2,maxBadFraction:0}:input.quality};
}
function controls(input){
  try{fields(input,['domain','meshSize','optimization','quality']);}catch{throw fault('MESH_INPUT_INVALID');}
  if(!number(input.meshSize)||input.meshSize<1e-6||input.meshSize>1e6)throw fault('MESH_SIZE_INVALID');
  try{
    const q=input.quality;fields(q,['version','mode','threshold','maxBadFraction']);
    check(q.version===1&&['strict','diagnostic'].includes(q.mode)&&number(q.threshold)&&q.threshold>=0&&q.threshold<=1&&number(q.maxBadFraction)&&q.maxBadFraction>=0&&q.maxBadFraction<=1);
    if(input.optimization!==undefined){const o=input.optimization;fields(o,['version','method','iterations','acceptance']);check(o.version===1&&['gmsh','netgen','relocate'].includes(o.method)&&integer(o.iterations,1,5)&&(o.acceptance===undefined||['non-regressing','diagnostic'].includes(o.acceptance)));}
  }catch{throw fault('MESH_POLICY_INVALID');}
}
function assertTetraInput(input,context,constrained){
  controls(input);
  try{
    const wire=JSON.stringify(context?.sourceInput);if(typeof wire!=='string'||Buffer.byteLength(wire)>P.maxRequestBytes)throw fault('MESH_DOMAIN_UNQUALIFIED');
    context.sourceInput=JSON.parse(wire);
    const d=input.domain;(constrained?assertConstrainedVolumeResult:assertVolumePartitionResult)(d,context.sourceInput,d?.requestId);
    check(d.execution?.basis==='single-process-exit-confirmed-v1'&&d.execution.exitCode===0&&d.execution.automaticReplay===false&&d.algorithm?.version===1&&d.algorithm.basis===(constrained?VC:V).basis&&d.algorithm.cgalVersion===V.cgalVersion&&d.algorithm.license===V.license);
    const resource=d.processResources,policy=discreteMemoryPolicy({DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:String(resource?.processLimitBytes)});
    assertNativeMemoryGuard({ok:true,protocolVersion:1,service:'cad-discrete-surface-worker',capabilities:{version:1,processResources:resource}},policy,'cad-discrete-surface-worker');
    return input;
  }catch(error){if(error?.code==='MESH_DOMAIN_UNQUALIFIED')throw error;throw fault('MESH_DOMAIN_UNQUALIFIED');}
}
export function assertDiscreteTetraInput(input,context){return assertTetraInput(input,context,false);}
export function assertConstrainedDiscreteTetraInput(input,context){return assertTetraInput(input,context,true);}
export function assertDiscreteTetraHandshake(health){
  const value=health?.capabilities?.discreteTetra;
  check(health?.ok===true&&health.protocolVersion===1&&health.service==='gmsh-mesh-worker'&&health.capabilities?.version===1&&plain(value)&&Object.entries(P).every(([key,expected])=>value[key]===expected));
  return {version:1,basis:P.basis,gmshVersion:P.gmshVersion,apiVersion:P.apiVersion,license:P.license};
}
export function assertConstrainedDiscreteTetraHandshake(health){
  const value=health?.capabilities?.constrainedDiscreteTetra;
  check(health?.ok===true&&health.protocolVersion===1&&health.service==='gmsh-mesh-worker'&&health.capabilities?.version===1&&plain(value)&&Object.entries(CP).every(([key,expected])=>value[key]===expected));
  return {version:1,basis:CP.basis,gmshVersion:CP.gmshVersion,apiVersion:CP.apiVersion,license:CP.license};
}
const subtract=(a,b)=>a.map((x,i)=>x-b[i]);
const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const key=nodes=>[...nodes].sort((a,b)=>a-b).join(',');
const opposite=(a,b)=>b.some((_,i)=>b[i]===a[0]&&b[(i+1)%3]===a[2]&&b[(i+2)%3]===a[1]);
export function discreteTetraMetrics(a,b,c,d){
  const delta=[subtract(b,a),subtract(c,a),subtract(d,a)],scale=delta.reduce((m,p)=>p.reduce((n,x)=>Math.max(n,Math.abs(x)),m),0);check(number(scale)&&scale>0);
  const [u,v,w]=delta.map(p=>p.map(x=>x/scale)),x=u,y=v.map((t,i)=>(2*t-u[i])/Math.sqrt(3)),z=w.map((t,i)=>Math.sqrt(1.5)*(t-(u[i]+v[i])/3));
  const cofactors=[cross(y,z),cross(z,x),cross(x,y)];
  const quality=3*dot(x,cofactors[0])/Math.sqrt((dot(x,x)+dot(y,y)+dot(z,z))*cofactors.reduce((sum,p)=>sum+dot(p,p),0));
  const volume=dot(delta[0],cross(delta[1],delta[2]))/6;
  check(number(quality)&&quality>0&&quality<=1+1e-12&&number(volume)&&volume>0);return {quality,volume};
}
function inside(point,triangle,normal){
  const axis=normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))),axes=[0,1,2].filter(i=>i!==axis),project=p=>axes.map(i=>p[i]),[a,b,c]=triangle.map(project),q=project(point);
  const orient=(u,v,w)=>(v[0]-u[0])*(w[1]-u[1])-(v[1]-u[1])*(w[0]-u[0]),area=orient(a,b,c);check(number(area)&&area!==0);
  const weights=[orient(q,b,c)/area,orient(a,q,c)/area,orient(a,b,q)/area];check(weights.every(w=>number(w)&&w>=-1e-7&&w<=1+1e-7));
}
function qualitySummary(summary,policy,cells,metrics){
  check(plain(summary)&&summary.version===1&&summary.metric==='coordinate-derived-linear-tet-SICN-v1'&&summary.mode===policy.mode&&summary.threshold===policy.threshold&&summary.maxBadFraction===policy.maxBadFraction&&Array.isArray(summary.perCell)&&summary.perCell.length===cells&&number(summary.maxEngineMetricDifference)&&summary.maxEngineMetricDifference>=0&&summary.maxEngineMetricDifference<=2e-10);
  let total=0,bad=0,minimum=1,passes=true;
  for(let i=0;i<cells;i++){
    const row=summary.perCell[i];check(plain(row)&&row.cellIndex===i&&integer(row.tetraCount,1,P.maxTetrahedra)&&integer(row.lowQualityCount,0,row.tetraCount)&&number(row.minimumSICN)&&row.minimumSICN>0&&row.minimumSICN<=1+1e-12);
    check(number(row.lowQualityFraction)&&Math.abs(row.lowQualityFraction-row.lowQualityCount/row.tetraCount)<=1e-12&&row.meetsRequestedQuality===(row.lowQualityFraction<=policy.maxBadFraction));
    if(metrics){const m=metrics[i];check(row.tetraCount===m.count&&row.lowQualityCount===m.bad&&Math.abs(row.minimumSICN-m.minimum)<=2e-10);}
    total+=row.tetraCount;bad+=row.lowQualityCount;minimum=Math.min(minimum,row.minimumSICN);passes=passes&&row.meetsRequestedQuality;
  }
  check(total<=P.maxTetrahedra&&summary.tetraCount===total&&summary.lowQualityCount===bad&&number(summary.minimumSICN)&&Math.abs(summary.minimumSICN-minimum)<=2e-10&&number(summary.lowQualityFraction)&&Math.abs(summary.lowQualityFraction-bad/total)<=1e-12&&summary.meetsRequestedQuality===(passes&&summary.lowQualityFraction<=policy.maxBadFraction));
}
export function assertDiscreteTetraQualitySummary(summary,policy,cells){
  try{check(integer(cells,1,P.maxCells));qualitySummary(summary,policy,cells);return summary;}catch{throw fault();}
}
function optimizationReport(actual,input,final){
  check(plain(actual)&&actual.requested===Boolean(input.optimization));
  if(!input.optimization){check(Object.keys(actual).length===1);return;}
  const expected=input.optimization,cells=input.domain.cells.length;
  check(actual.method===expected.method&&actual.iterations===expected.iterations&&actual.acceptance===(expected.acceptance||'non-regressing')&&actual.boundaryUnchanged===true);
  for(const value of [actual.before,actual.candidate,actual.after])qualitySummary(value,input.quality,cells);
  check(equal(actual.after,final));
  const regressed=actual.candidate.perCell.flatMap((row,i)=>row.minimumSICN+2e-10<actual.before.perCell[i].minimumSICN||row.lowQualityFraction>actual.before.perCell[i].lowQualityFraction+1e-12?[i]:[]);
  const global=actual.candidate.minimumSICN+2e-10<actual.before.minimumSICN||actual.candidate.lowQualityFraction>actual.before.lowQualityFraction+1e-12;
  check(equal(actual.regressedCells,regressed)&&actual.globalRegressed===global);
  const retained=actual.acceptance==='non-regressing'&&(global||regressed.length>0);
  check(actual.disposition===(retained?'retained-original':'optimized')&&actual.originalMeshRestoredExactly===retained&&equal(actual.after,retained?actual.before:actual.candidate));
}
// Shared numerical/topological core; operation-specific surface provenance is
// checked separately. The returned Maps are private validation state, not wire data.
export function validateDiscreteTetraCellComplex(result,input){
  const d=input.domain,policy=input.quality;
  check(Array.isArray(result.points)&&integer(result.points.length,4,P.maxOutputPoints)&&result.points.every(p=>Array.isArray(p)&&p.length===3&&p.every(x=>number(x)&&Math.abs(x)<=1e12))&&Array.isArray(result.cells)&&result.cells.length===d.cells.length&&equal(result.sourceSolids,d.sourceSolids)&&equal(result.sources,d.sources));
  const allTets=new Set(),faces=result.cells.map(()=>new Map()),metrics=[];let total=0,volume=0,minimum=1;
  for(let c=0;c<result.cells.length;c++){
    const cell=result.cells[c];check(plain(cell)&&cell.cellIndex===c&&cell.regionIndex===d.cells[c].regionIndex&&equal(cell.sourceSolidIndexes,d.cells[c].sourceSolidIndexes)&&Array.isArray(cell.tetrahedra)&&integer(cell.tetrahedra.length,1,P.maxTetrahedra)&&Array.isArray(cell.qualities)&&cell.qualities.length===cell.tetrahedra.length);
    total+=cell.tetrahedra.length;check(total<=P.maxTetrahedra);
    const adjacency=cell.tetrahedra.map(()=>[]),stats={count:cell.tetrahedra.length,bad:0,minimum:1};let cellVolume=0;
    for(let i=0;i<cell.tetrahedra.length;i++){
      const tet=cell.tetrahedra[i];check(Array.isArray(tet)&&tet.length===4&&new Set(tet).size===4&&tet.every(n=>integer(n,0,result.points.length-1))&&!allTets.has(key(tet)));allTets.add(key(tet));
      const value=discreteTetraMetrics(...tet.map(n=>result.points[n])),reported=cell.qualities[i];check(number(reported)&&Math.abs(value.quality-reported)<=2e-10);
      cellVolume+=value.volume;stats.bad+=value.quality<policy.threshold;stats.minimum=Math.min(stats.minimum,value.quality);
      for(const order of [[1,2,3],[0,3,2],[0,1,3],[0,2,1]]){
        const triangle=order.map(n=>tet[n]),id=key(triangle),uses=faces[c].get(id)||[];check(uses.length<2);
        if(uses.length){check(opposite(uses[0].nodes,triangle));adjacency[i].push(uses[0].tet);adjacency[uses[0].tet].push(i);}
        uses.push({nodes:triangle,tet:i});faces[c].set(id,uses);
      }
    }
    const seen=new Set(),pending=[0];while(pending.length){const i=pending.pop();if(seen.has(i))continue;seen.add(i);for(const peer of adjacency[i])if(!seen.has(peer))pending.push(peer);}
    check(seen.size===cell.tetrahedra.length);near(cellVolume,cell.volume);near(cellVolume,d.cells[c].volume);volume+=cellVolume;minimum=Math.min(minimum,stats.minimum);metrics.push(stats);
  }
  return {faces,metrics,total,volume,minimum};
}
export function validateDiscreteTetraQualityReports(result,input,metrics){
  qualitySummary(result.quality,input.quality,input.domain.cells.length,metrics);optimizationReport(result.optimization,input,result.quality);
}
function validate(result,input,requestId,constrained=false){
  const d=input.domain,policy=input.quality;
  check(result?.ok===true&&result.protocolVersion===1&&result.requestId===requestId&&result.service==='gmsh-mesh-worker'&&result.operation===(constrained?'mesh.discrete-constrained-tetra':'mesh.discrete-tetra')&&result.basis===(constrained?CP:P).basis&&result.gmshVersion===P.gmshVersion);
  const {faces,metrics,total,volume,minimum}=validateDiscreteTetraCellComplex(result,input);
  check(Array.isArray(result.boundaries)&&result.boundaries.length===d.triangles.length);const consumed=faces.map(()=>new Set()),surfacesSeen=new Set();let boundaries=0,surfaces=0,embedded=0,exterior=0;
  for(let i=0;i<result.boundaries.length;i++){
    const row=result.boundaries[i];check(plain(row)&&row.sourceBoundaryTriangle===i&&equal(row.cellUses,d.triangleCellUses[i])&&equal(row.sourceTriangleIds,d.sourceTriangleIds[i])&&Array.isArray(row.triangles)&&row.triangles.length>0);
    const constraint=constrained?d.constraints.triangles[i]:{kind:'boundary',cellIndexes:[]};
    if(constrained)check(equal(row.constraint,constraint));
    surfaces+=row.triangles.length;check(surfaces<=P.maxBoundaryTriangles);
    if(constraint.kind==='boundary')boundaries+=row.triangles.length;else if(constraint.kind==='embedded')embedded+=row.triangles.length;else{check(constraint.kind==='exterior');exterior+=row.triangles.length;}
    const original=d.triangles[i].map(n=>d.points[n]),normal=cross(subtract(original[1],original[0]),subtract(original[2],original[0])),normalSize=Math.hypot(...normal);check(number(normalSize)&&normalSize>0);let area=0;
    for(const triangle of row.triangles){
      check(Array.isArray(triangle)&&triangle.length===3&&new Set(triangle).size===3&&triangle.every(n=>integer(n,0,result.points.length-1)));
      const points=triangle.map(n=>result.points[n]),normalOut=cross(subtract(points[1],points[0]),subtract(points[2],points[0])),triangleArea=Math.hypot(...normalOut)/2;check(number(triangleArea)&&triangleArea>0);area+=triangleArea;
      for(const point of points){check(Math.abs(dot(subtract(point,original[0]),normal))/normalSize<=1e-8);inside(point,original,normal);}
      const id=key(triangle);
      if(constrained){
        check(!surfacesSeen.has(id));surfacesSeen.add(id);
        if(constraint.kind==='embedded'){
          const c=constraint.cellIndexes[0],list=faces[c]?.get(id);check(list?.length===2&&opposite(list[0].nodes,list[1].nodes));
          for(let peer=0;peer<faces.length;peer++)if(peer!==c)check(!faces[peer].has(id));
        }else if(constraint.kind==='exterior')for(const cell of faces)check(!cell.has(id));
      }
      for(const use of row.cellUses){
        const list=faces[use.cellIndex].get(id);check(list?.length===1&&!consumed[use.cellIndex].has(id));consumed[use.cellIndex].add(id);
        const [a,b,c]=list[0].nodes.map(n=>result.points[n]);check(dot(cross(subtract(b,a),subtract(c,a)),normal)*use.orientation>0);
      }
      if(row.cellUses.length===2)check(opposite(faces[row.cellUses[0].cellIndex].get(id)[0].nodes,faces[row.cellUses[1].cellIndex].get(id)[0].nodes));
    }
    near(area,normalSize/2);
  }
  for(let c=0;c<faces.length;c++)for(const [id,uses]of faces[c])if(uses.length===1)check(consumed[c].has(id));
  near(volume,d.report.unionVolume);const report=result.report;
  check(plain(report)&&report.tetraCount===total&&report.nodeCount===result.points.length&&report.boundaryTriangleCount===boundaries&&report.normalMeshAdmitted===false&&report.materialPriorityAssigned===false);near(report.volume,volume);check(number(report.minimumSICN)&&Math.abs(report.minimumSICN-minimum)<=2e-10);
  if(constrained)check(report.surfaceTriangleCount===surfaces&&report.embeddedTriangleCount===embedded&&report.exteriorTriangleCount===exterior);
  validateDiscreteTetraQualityReports(result,input,metrics);if(policy.mode==='strict')check(result.quality.meetsRequestedQuality===true);
  return result;
}
export function assertDiscreteTetraResult(result,input,requestId){
  try{return validate(result,input,requestId);}catch{throw fault();}
}
export function assertConstrainedDiscreteTetraResult(result,input,requestId){
  try{return validate(result,input,requestId,true);}catch{throw fault();}
}
function tetraFailure(result,input,constrained){
  if(['points','cells','boundaries','mesh'].some(key=>result[key]!==undefined))throw fault();
  if(result.code!=='MESH_QUALITY_REJECTED')return new DiscreteTetraError(result.code,result.error.slice(0,1024));
  try{
    check(input.quality.mode==='strict'&&result.operation===(constrained?'mesh.discrete-constrained-tetra':'mesh.discrete-tetra'));qualitySummary(result.quality,input.quality,input.domain.cells.length);check(result.quality.meetsRequestedQuality===false);optimizationReport(result.optimization,input,result.quality);
    const details={quality:result.quality,optimization:result.optimization};check(Buffer.byteLength(JSON.stringify(details))<=256*1024);
    return new DiscreteTetraError(result.code,result.error.slice(0,1024),details);
  }catch{throw fault();}
}
export function discreteTetraFailure(result,input){return tetraFailure(result,input,false);}
export function constrainedDiscreteTetraFailure(result,input){return tetraFailure(result,input,true);}
