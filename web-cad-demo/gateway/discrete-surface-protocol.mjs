export const DISCRETE_SURFACE_PROTOCOL=Object.freeze({service:'cad-discrete-surface-worker',version:1,cgalVersion:'6.1.2',basis:'exact-autorefinement-then-iterative-snap-v1',license:'GPL-3.0-or-later',maxInputTriangles:20000,maxOutputTriangles:200000,maxPoints:600000,maxSourceReferences:1000000,maxRequestBytes:8*1024**2,maxResponseBytes:64*1024**2});
export class DiscreteSurfaceError extends Error{
  constructor(code,message){super(message);this.name='DiscreteSurfaceError';this.code=code;this.retryable=false;this.retryableByModel=false;}
}
const invalid=()=>new DiscreteSurfaceError('SURFACE_PROTOCOL_INVALID','表面重构回复与已核对的协议、输入或来源不一致；未接纳结果。');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const sameSources=(left,right)=>Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((item,i)=>{
  const other=right[i];if(!item||!other||typeof item!=='object'||typeof other!=='object'||Array.isArray(item)||Array.isArray(other))return false;
  const keys=Object.keys(item).sort();return JSON.stringify(keys)===JSON.stringify(Object.keys(other).sort())&&keys.every(key=>item[key]===other[key]);
});
export function assertDiscreteHandshake(health){
  const p=DISCRETE_SURFACE_PROTOCOL,s=health?.capabilities?.surfaceRefinement;
  if(health?.ok!==true||health.protocolVersion!==p.version||health.service!==p.service||health.capabilities?.version!==1||!s||s.version!==1||s.basis!==p.basis||s.cgalVersion!==p.cgalVersion||s.license!==p.license||s.volumeDomainReconstruction!==false||s.oneJobPerProcess!==true)throw invalid();
  for(const key of ['maxInputTriangles','maxOutputTriangles','maxPoints','maxSourceReferences','maxRequestBytes','maxResponseBytes'])if(s[key]!==p[key])throw invalid();
  return {version:1,basis:s.basis,cgalVersion:s.cgalVersion,license:s.license};
}
export function assertDiscreteResult(result,input,requestId){
  const p=DISCRETE_SURFACE_PROTOCOL,report=result?.report;
  if(result?.ok!==true||result.protocolVersion!==p.version||result.requestId!==requestId||result.service!==p.service||result.operation!=='surface.refine'||result.basis!==p.basis||result.cgalVersion!==p.cgalVersion||result.units!=='mm'||!report)throw invalid();
  if(!Array.isArray(result.points)||!integer(result.points.length,3,p.maxPoints)||!Array.isArray(result.triangles)||!integer(result.triangles.length,1,p.maxOutputTriangles)||!Array.isArray(result.sourceTriangleIds)||result.sourceTriangleIds.length!==result.triangles.length||!sameSources(result.sources,input.sources))throw invalid();
  for(const point of result.points)if(!Array.isArray(point)||point.length!==3||point.some(n=>typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e12))throw invalid();
  let references=0;const represented=new Set();
  for(let i=0;i<result.triangles.length;i++){
    const triangle=result.triangles[i],owners=result.sourceTriangleIds[i];
    if(!Array.isArray(triangle)||triangle.length!==3||new Set(triangle).size!==3||triangle.some(n=>!integer(n,0,result.points.length-1))||!Array.isArray(owners)||!owners.length)throw invalid();
    references+=owners.length;if(references>p.maxSourceReferences)throw invalid();
    for(let j=0;j<owners.length;j++){const source=owners[j];if(!integer(source,0,input.triangles.length-1)||j>0&&source<=owners[j-1])throw invalid();represented.add(source);}
  }
  const removed=report.removedDegenerateInputTriangles;
  if(!Array.isArray(removed)||removed.some((n,i)=>!integer(n,0,input.triangles.length-1)||i>0&&n<=removed[i-1]||represented.has(n))||represented.size+removed.length!==input.triangles.length)throw invalid();
  const tolerance=input.options?.tolerance??1e-7;
  if(report.inputTriangles!==input.triangles.length||!integer(report.distinctInputTriangles,1,input.triangles.length)||report.outputTriangles!==result.triangles.length||report.sourceReferences!==references||typeof report.inputHadCrossings!=='boolean'||report.outputHasCrossings!==false||report.tetrahedralReady!==false||report.volumeDomainReconstruction!=='not-performed'||report.sourceIdentityAuthority!=='caller-supplied-discrete-labels-not-cad-certificates'||report.tolerance!==tolerance||report.snapGridSize!==(input.options?.snapGridSize??40)||report.iterationLimit!==(input.options?.iterations??5)||!Number.isFinite(report.maxSourceDeviation)||report.maxSourceDeviation<0||report.maxSourceDeviation>tolerance||!Number.isFinite(report.maxRelativeSourceAreaError)||report.maxRelativeSourceAreaError<0||report.maxRelativeSourceAreaError>2e-6)throw invalid();
  return result;
}
