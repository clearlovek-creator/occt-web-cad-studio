import type {MeshFaceSource,MeshJobDescriptor} from './mesh.ts';
export type SurfaceSummary={version:1;basis:string;bodyCount:number;faceCount:number;solidCount:number;inputTriangles:number;outputTriangles:number;points:number;inputHadCrossings:boolean;outputHasCrossings:false;removedDegenerateTriangles:number;maxSourceDeviation:number;maxRelativeSourceAreaError:number;estimateExceedsRequestedFaceCount:number;distanceBoundCertified:false;normalMeshAdmitted:false;tetrahedralReady:false;appliedToCad:false};
export type SurfaceTaskResult={ok:true;meshJob:MeshJobDescriptor;surfaceSummary:SurfaceSummary};
export type SurfaceReportFace={source:MeshFaceSource;kind:string;inputTriangles:number;outputTriangles:number;sharedOutputTriangles:number;solidIds:string[];useCount:number;mesherDeflection:number;estimateExceedsRequested:boolean};
export type SurfaceReport={version:1;basis:string;summary:SurfaceSummary;total:number;offset:number;limit:number;faces:SurfaceReportFace[];normalMeshAdmitted:false;tetrahedralReady:false;appliedToCad:false;sourceCurrent:boolean};
const invalid=()=>Error('表面重构报告身份、分页或来源信息无效，未采用结果。');
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const number=(v:unknown,max:number):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max;
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
export function parseSurfaceSummary(value:unknown):SurfaceSummary{
  if(!object(value)||value.version!==1||value.basis!=='cad-source-bound-discrete-surface-v1'||!integer(value.bodyCount,1,512)||!integer(value.faceCount,1,10000)||!integer(value.solidCount,0,4096)||!integer(value.inputTriangles,1,20000)||!integer(value.outputTriangles,1,200000)||!integer(value.points,3,600000)||typeof value.inputHadCrossings!=='boolean'||value.outputHasCrossings!==false||!integer(value.removedDegenerateTriangles,0,value.inputTriangles)||!integer(value.estimateExceedsRequestedFaceCount,0,value.faceCount)||!number(value.maxSourceDeviation,.001)||!number(value.maxRelativeSourceAreaError,2e-6)||['distanceBoundCertified','normalMeshAdmitted','tetrahedralReady','appliedToCad'].some(key=>value[key]!==false))throw invalid();
  return value as SurfaceSummary;
}
export function parseSurfaceReport(value:unknown,jobId:string,documentId:string):SurfaceReport{
  if(!object(value)||value.ok!==true||!object(value.meshJob)||value.meshJob.jobId!==jobId||value.meshJob.documentId!==documentId||value.meshJob.kind!=='surface-reconstruction'||value.meshJob.state!=='complete'||!object(value.surfaceReport))throw invalid();const r=value.surfaceReport;
  parseSurfaceSummary(r.summary);
  if(r.version!==1||r.basis!=='certified-source-face-summary-v1'||!integer(r.total,0,10000)||!integer(r.offset,0,10000)||!integer(r.limit,1,25)||!Array.isArray(r.faces)||r.faces.length>r.limit||r.faces.length!==Math.min(r.limit,Math.max(0,r.total-r.offset))||['normalMeshAdmitted','tetrahedralReady','appliedToCad'].some(key=>r[key]!==false))throw invalid();
  const seen=new Set();for(const row of r.faces){
    if(!object(row)||!object(row.source))throw invalid();const source=row.source;
    if(!id(source.bodyId)||!id(source.cadFaceId)||!['bodyIdentity','topologyIdentity'].every(key=>typeof source[key]==='string'&&/^[a-f0-9]{32}$/.test(source[key] as string))||!integer(source.topologyRevision,0,Number.MAX_SAFE_INTEGER)||!['solid','sheet'].includes(String(row.kind))||!integer(row.inputTriangles,1,20000)||!integer(row.outputTriangles,0,200000)||!integer(row.sharedOutputTriangles,0,row.outputTriangles)||!integer(row.useCount,1,64)||!number(row.mesherDeflection,1e12)||typeof row.estimateExceedsRequested!=='boolean'||!Array.isArray(row.solidIds)||row.solidIds.length>64||!row.solidIds.every(id)||new Set(row.solidIds).size!==row.solidIds.length)throw invalid();const key=source.bodyId+'\0'+source.cadFaceId;if(seen.has(key))throw invalid();seen.add(key);
  }
  return {...r,sourceCurrent:object(value.meshJob.freshness)&&value.meshJob.freshness.status==='current'} as SurfaceReport;
}
