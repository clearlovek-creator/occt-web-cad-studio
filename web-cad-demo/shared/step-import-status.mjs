export const STEP_IMPORT_PHASES=['receiving','queued','preparing','converting','committing','complete','failed','interrupted','unknown'];
export const activeStepImport=phase=>STEP_IMPORT_PHASES.indexOf(phase)>=0&&STEP_IMPORT_PHASES.indexOf(phase)<5;
export function stepImportReport(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const result={version:1};
  for(const key of ['decompositionVersion','rootCount','emptyRootCount','bodyCount','solidCount','sheetCount','wireCount','otherCount','invalidBodyCount','ambiguousSubshapeMetadata'])if(Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=1000000)result[key]=value[key];
  if(typeof value.modelLengthUnit==='string')result.modelLengthUnit=value.modelLengthUnit.slice(0,40);
  if(Array.isArray(value.sourceLengthUnits))result.sourceLengthUnits=value.sourceLengthUnits.filter(item=>typeof item==='string').slice(0,20).map(item=>item.slice(0,80));
  for(const key of ['assemblyHierarchyRetained','applicationRepairApplied'])if(typeof value[key]==='boolean')result[key]=value[key];
  if(typeof value.translatorShapeProcessing==='string')result.translatorShapeProcessing=value.translatorShapeProcessing.slice(0,80);
  return result;
}
export function normalizeStepImportStatus(value,documentId,requestId){
  if(value===null)return null;
  if(!value||typeof value!=='object'||value.version!==1||value.documentId!==documentId||typeof value.requestId!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(value.requestId)||requestId&&value.requestId!==requestId||!STEP_IMPORT_PHASES.includes(value.phase)||!Number.isSafeInteger(value.sequence)||value.sequence<0||typeof value.fileName!=='string'||value.fileName.length>240||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt)))throw new Error('STEP 导入状态不符合当前工程和请求协议。');
  const result={version:1,documentId,requestId:value.requestId,fileName:value.fileName,phase:value.phase,sequence:value.sequence,createdAt:value.createdAt,updatedAt:value.updatedAt,report:stepImportReport(value.report)};
  if(value.taskId!==undefined){if(typeof value.taskId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.taskId))throw new Error('STEP 导入关联任务身份无效。');result.taskId=value.taskId;}
  for(const key of ['bytes','revision'])if(Number.isSafeInteger(value[key])&&value[key]>=0)result[key]=value[key];
  if(typeof value.stateToken==='string'&&/^[a-f0-9]{64}$/.test(value.stateToken))result.stateToken=value.stateToken;
  for(const key of ['code','error'])if(typeof value[key]==='string')result[key]=value[key].slice(0,key==='code'?100:1000);
  for(const key of ['unchanged','recovered','reportDurable'])if(typeof value[key]==='boolean')result[key]=value[key];
  return result;
}
