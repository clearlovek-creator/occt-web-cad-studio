import {normalizeDiscreteTetraSettings,type DiscreteTetraSettings} from '../../shared/discrete-tetra-task.mjs';

export type TetraOptimizationMethod='gmsh'|'netgen'|'relocate';
export const tetraOptimizationMethodLabel:Record<TetraOptimizationMethod,string>={gmsh:'Gmsh 质量优化',netgen:'Netgen 优化',relocate:'节点重定位'};
export type TetraDraft={meshSize:string;linearDeflection:string;qualityThreshold:string;optimization:boolean;optimizationMethod:TetraOptimizationMethod};
export const defaultTetraDraft=():TetraDraft=>({meshSize:'1',linearDeflection:'0.05',qualityThreshold:'0.2',optimization:false,optimizationMethod:'gmsh'});
export function tetraSettingsFromDraft(draft:TetraDraft):DiscreteTetraSettings{
  if([draft.meshSize,draft.linearDeflection,draft.qualityThreshold].some(value=>!value.trim()))throw Error('请填写目标尺寸、离散偏差和质量阈值。');
  if(draft.optimization&&!Object.hasOwn(tetraOptimizationMethodLabel,draft.optimizationMethod))throw Error('请选择支持的后优化方法。');
  try{return normalizeDiscreteTetraSettings({meshSize:Number(draft.meshSize),source:{linearDeflection:Number(draft.linearDeflection),maxTriangles:4096},quality:{version:1,mode:'strict',threshold:Number(draft.qualityThreshold),maxBadFraction:0},...(draft.optimization?{optimization:{version:1,method:draft.optimizationMethod,iterations:3,acceptance:'non-regressing'}}:{})});}
  catch{throw Error('目标尺寸须为 0.000001–1000000 mm，离散偏差须为 0.000001–1000 mm，质量阈值须为 0–1。');}
}
export type TetraSummary={version:1;basis:'cad-source-bound-partition-tetra-v1'|'cad-source-bound-constrained-tetra-v1';bodyCount:number;faceCount:number;solidCount:number;cellCount:number;tetraCount:number;nodeCount:number;unassignedCellCount:number;quality:{minimumSICN:number;lowQualityCount:number;meetsRequestedQuality:boolean};normalMeshAdmitted:false;appliedToCad:false};
export type TetraDerivation={version:1;state:'available'|'working'|'ready'|'unverified'|'invalid'|'complete'|'failed'|'cancelled';sourceToken:string|null;canStart:boolean;requestId?:string;code?:string;error?:string;defaultVisible:false};
export type TetraAction={operation:'derive'|'discard';requestId:string;sourceToken:string;state:'submitting'|'uncertain'|'failed';error?:string};
export function parseTetraDerivation(value:unknown):TetraDerivation{
  const row=value as TetraDerivation;
  if(!row||row.version!==1||!['available','working','ready','unverified','invalid','complete','failed','cancelled'].includes(row.state)||row.sourceToken!==null&&!/^[a-f0-9]{64}$/.test(row.sourceToken)||typeof row.canStart!=='boolean'||row.defaultVisible!==false||row.requestId!==undefined&&!/^[a-f0-9-]{36}$/.test(row.requestId))throw Error('交叉修复任务的结果准备状态无效，未采用。');
  return structuredClone(row);
}
export function parseTetraSummary(value:unknown):TetraSummary{
  const row=value as TetraSummary;
  if(!row||row.version!==1||!['cad-source-bound-partition-tetra-v1','cad-source-bound-constrained-tetra-v1'].includes(row.basis)||row.normalMeshAdmitted!==false||row.appliedToCad!==false||!['bodyCount','faceCount','solidCount','cellCount','tetraCount','nodeCount'].every(key=>Number.isSafeInteger(row[key as keyof TetraSummary])&&Number(row[key as keyof TetraSummary])>0)||!Number.isSafeInteger(row.unassignedCellCount)||row.unassignedCellCount<0||row.unassignedCellCount>row.cellCount||!row.quality||!Number.isFinite(row.quality.minimumSICN)||row.quality.minimumSICN<=0||row.quality.minimumSICN>1+1e-12||typeof row.quality.meetsRequestedQuality!=='boolean'||!Number.isSafeInteger(row.quality.lowQualityCount)||row.quality.lowQualityCount<0||row.quality.lowQualityCount>row.tetraCount)throw Error('交叉修复四面体概要无效，未采用。');
  return structuredClone(row);
}
export const tetraDerivationLabel:Record<TetraDerivation['state'],string>={available:'原始剖分已完成',working:'正在准备显示与导出',ready:'显示与导出已就绪',unverified:'结果待重新核验',invalid:'派生文件校验失败',complete:'准备已结束，待核验',failed:'结果准备失败',cancelled:'结果准备已取消'};
