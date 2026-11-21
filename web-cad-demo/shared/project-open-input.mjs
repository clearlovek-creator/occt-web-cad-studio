const documentPattern=/^[A-Za-z0-9_-]{1,64}$/;
const requestPattern=/^[A-Za-z0-9._:-]{1,160}$/;
const tokenPattern=/^[a-f0-9]{64}$/;
const keys=['protocolVersion','operation','documentId','sourceDocumentId','requestId','fileName','expectedBytes','sourceRevision','sourceStateToken','sourceStateSequence'];
/** Private file bytes and filesystem paths are never part of task metadata. */
export function normalizeProjectOpenInput(value,maxBytes=1024**3){
  const invalid=()=>{throw new TypeError('工程打开任务需要有效的来源/新目标工程、请求身份、文件名、精确字节数及来源状态。');};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||value.protocolVersion!==1||value.operation!=='project.open'||typeof value.documentId!=='string'||!documentPattern.test(value.documentId)||typeof value.sourceDocumentId!=='string'||!documentPattern.test(value.sourceDocumentId)||value.sourceDocumentId===value.documentId||typeof value.requestId!=='string'||!requestPattern.test(value.requestId)||typeof value.fileName!=='string'||!value.fileName.trim()||value.fileName.length>240||/[\x00-\x1f\x7f/\\]/.test(value.fileName)||!Number.isSafeInteger(value.expectedBytes)||value.expectedBytes<1||value.expectedBytes>maxBytes)invalid();
  for(const key of ['sourceRevision','sourceStateSequence'])if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||value[key]<0))invalid();
  if(value.sourceStateToken!==undefined&&(typeof value.sourceStateToken!=='string'||!tokenPattern.test(value.sourceStateToken)))invalid();
  return {protocolVersion:1,operation:'project.open',documentId:value.documentId,sourceDocumentId:value.sourceDocumentId,requestId:value.requestId,fileName:value.fileName,expectedBytes:value.expectedBytes,...(value.sourceRevision!==undefined?{sourceRevision:value.sourceRevision}:{}),...(value.sourceStateToken!==undefined?{sourceStateToken:value.sourceStateToken}:{}),...(value.sourceStateSequence!==undefined?{sourceStateSequence:value.sourceStateSequence}:{})};
}
export function projectOpenCanonical(value){return JSON.stringify(normalizeProjectOpenInput(value));}
/** Validate the public attachment binding separately from the target's task DTO. */
export function normalizeProjectOpenTask(value,task,sourceDocumentId,expectedInput){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||typeof value.canUpload!=='boolean'||value.taskId!==task?.taskId||task?.operation!=='project.open')throw new TypeError('工程文件任务的附件身份无效。');
  const {version,taskId,canUpload,...raw}=value,input=normalizeProjectOpenInput(raw);
  const expected=expectedInput===undefined?undefined:Object.fromEntries(keys.filter(key=>expectedInput[key]!==undefined).map(key=>[key,expectedInput[key]]));
  if(input.documentId!==task.documentId||input.requestId!==task.requestKey||sourceDocumentId!==undefined&&input.sourceDocumentId!==sourceDocumentId||expected!==undefined&&projectOpenCanonical(input)!==projectOpenCanonical(expected)||canUpload&&(task.phase!=='reserved'||task.cancelRequested))throw new TypeError('工程文件任务与来源工程或原始附件不一致。');
  return {version,taskId,...input,canUpload};
}
