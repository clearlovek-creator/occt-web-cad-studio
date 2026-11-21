import {normalizeSurfaceTaskSettings} from './discrete-surface-task.mjs';

export const DISCRETE_TETRA_TASK_KIND='discrete-tetra';
export const CAD_DISCRETE_TETRA_SOURCE_BYTES=22*1024**2;
export const CAD_DISCRETE_TETRA_RESULT_BYTES=128*1024**2;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const number=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const invalid=()=>Object.assign(Error('离散体网格设置无效；必须使用全部工程几何、明确的质量策略和一致材料规则，不能附带路径或自造归属。'),{code:'MESH_DISCRETE_SETTINGS_INVALID'});

export function normalizeDiscreteTetraSettings(value={}){
  if(!plain(value)||Object.keys(value).some(key=>!['version','source','repair','meshSize','quality','optimization','materialPolicy'].includes(key))||value.version!==undefined&&value.version!==1)throw invalid();
  const source=value.source===undefined?{maxTriangles:4096}:plain(value.source)?{maxTriangles:4096,...value.source}:value.source;
  const surface=normalizeSurfaceTaskSettings({source,...value.repair!==undefined&&{repair:value.repair}});
  if(surface.source.maxTriangles>4096)throw invalid();
  const meshSize=value.meshSize===undefined?1:value.meshSize,q=value.quality===undefined?{version:1,mode:'strict',threshold:.2,maxBadFraction:0}:value.quality;
  if(!number(meshSize,1e-6,1e6)||!plain(q)||Object.keys(q).some(key=>!['version','mode','threshold','maxBadFraction'].includes(key))||q.version!==1||!['strict','diagnostic'].includes(q.mode)||!number(q.threshold,0,1)||!number(q.maxBadFraction,0,1)||value.materialPolicy!==undefined&&value.materialPolicy!=='require-consistent')throw invalid();
  let optimization;
  if(value.optimization!==undefined){
    const o=value.optimization;
    if(!plain(o)||Object.keys(o).some(key=>!['version','method','iterations','acceptance'].includes(key))||o.version!==1||!['gmsh','netgen','relocate'].includes(o.method)||!Number.isSafeInteger(o.iterations)||o.iterations<1||o.iterations>5||o.acceptance!==undefined&&o.acceptance!=='non-regressing')throw invalid();
    optimization={version:1,method:o.method,iterations:o.iterations,acceptance:'non-regressing'};
  }
  return {...surface,meshSize,quality:{...q},...(optimization&&{optimization}),materialPolicy:'require-consistent'};
}
