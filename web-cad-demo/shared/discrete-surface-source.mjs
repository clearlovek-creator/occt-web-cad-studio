export const DISCRETE_SOURCE_CAPABILITY='cad-discrete-surface-source-v1';
export const DISCRETE_SOURCE=Object.freeze({version:1,basis:'occt-private-copy-all-body-face-solid-v1',fingerprint:'sha256-brep-v3-normalized-no-triangulation-v1',maxBodies:512,maxFaces:10000,maxSolids:4096,maxTriangles:20000,maxInputBytes:8*1024**2,maxBundleBytes:16*1024**2,volumeDomainReconstruction:false});
export function discreteSourceDeclaration(value){return value&&Object.keys(DISCRETE_SOURCE).every(key=>value[key]===DISCRETE_SOURCE[key])?{...DISCRETE_SOURCE}:null;}
const invalid=()=>Object.assign(Error('表面来源导出只接受明确的线性偏差、角度偏差和三角面额度；不能缩小完整工程范围。'),{code:'SURFACE_EXPORT_OPTIONS_INVALID'});
export function normalizeDiscreteSourceOptions(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['linearDeflection','angularDeflection','maxTriangles'].includes(key)))throw invalid();
  const result={linearDeflection:0.05,angularDeflection:0.15,maxTriangles:20000,...value};
  for(const [key,min,max]of [['linearDeflection',1e-6,1000],['angularDeflection',0.01,0.5],['maxTriangles',1,20000]])if(typeof result[key]!=='number'||!Number.isFinite(result[key])||result[key]<min||result[key]>max)throw invalid();
  if(!Number.isSafeInteger(result.maxTriangles))throw invalid();return result;
}
