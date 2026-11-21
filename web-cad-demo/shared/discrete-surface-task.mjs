import {normalizeDiscreteSourceOptions} from './discrete-surface-source.mjs';
export const SURFACE_TASK_KIND='surface-reconstruction';
export const SURFACE_SOURCE_BYTES=20*1024**2;
export const SURFACE_RESULT_BYTES=96*1024**2;
const invalid=()=>Object.assign(Error('表面重构仅接受明确的工程来源离散策略和交叉修复策略，不能附带文件路径、标签、尺寸方案或体网格设置。'),{code:'SURFACE_TASK_OPTIONS_INVALID'});
export function normalizeSurfaceTaskSettings(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['version','source','repair'].includes(key))||value.version!==undefined&&value.version!==1)throw invalid();
  const raw=value.repair===undefined?{}:value.repair;if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['snapGridSize','iterations','tolerance'].includes(key)))throw invalid();
  const repair={snapGridSize:40,iterations:5,tolerance:1e-7,...raw};
  if(!Number.isSafeInteger(repair.snapGridSize)||repair.snapGridSize<30||repair.snapGridSize>51||!Number.isSafeInteger(repair.iterations)||repair.iterations<1||repair.iterations>10||typeof repair.tolerance!=='number'||!Number.isFinite(repair.tolerance)||repair.tolerance<1e-12||repair.tolerance>1e-3)throw invalid();
  return {version:1,source:normalizeDiscreteSourceOptions(value.source),repair};
}
