const documentId=/^[A-Za-z0-9_-]{1,64}$/,requestId=/^[A-Za-z0-9._:-]{1,160}$/;
const keys=['protocolVersion','operation','documentId','sourceDocumentId','requestId','name','sourceRevision','sourceStateToken','sourceStateSequence'];
export function normalizeProjectCreateInput(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||value.protocolVersion!==1||value.operation!=='project.create'||typeof value.documentId!=='string'||!documentId.test(value.documentId)||typeof value.sourceDocumentId!=='string'||!documentId.test(value.sourceDocumentId)||value.documentId===value.sourceDocumentId||typeof value.requestId!=='string'||!requestId.test(value.requestId)||typeof value.name!=='string'||!value.name.trim()||value.name.length>120||/[\x00-\x1f\x7f]/.test(value.name)||!Number.isSafeInteger(value.sourceRevision)||value.sourceRevision<0||!Number.isSafeInteger(value.sourceStateSequence)||value.sourceStateSequence<0||typeof value.sourceStateToken!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceStateToken))throw new TypeError('新建任务需要独立的新目标、原工程、请求身份、名称及完整来源状态。');
  return {protocolVersion:1,operation:'project.create',documentId:value.documentId,sourceDocumentId:value.sourceDocumentId,requestId:value.requestId,name:value.name.trim(),sourceRevision:value.sourceRevision,sourceStateToken:value.sourceStateToken,sourceStateSequence:value.sourceStateSequence};
}
export const projectCreateCanonical=value=>JSON.stringify(normalizeProjectCreateInput(value));
export function normalizeProjectCreateTask(value,task,sourceDocumentId,expectedInput){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||typeof value.canCreate!=='boolean'||value.taskId!==task?.taskId||task?.operation!=='project.create')throw new TypeError('新建工程任务绑定无效。');
  const {version,taskId,canCreate,...raw}=value,input=normalizeProjectCreateInput(raw);
  const expected=expectedInput===undefined?undefined:Object.fromEntries(keys.filter(key=>expectedInput[key]!==undefined).map(key=>[key,expectedInput[key]]));
  if(input.documentId!==task.documentId||input.requestId!==task.requestKey||sourceDocumentId!==undefined&&input.sourceDocumentId!==sourceDocumentId||expected!==undefined&&projectCreateCanonical(input)!==projectCreateCanonical(expected)||canCreate&&(task.phase!=='reserved'||task.cancelRequested))throw new TypeError('新建工程任务与来源状态或原请求不一致。');
  return {version,taskId,...input,canCreate};
}
/** The original empty-project receipt is evidence of a commit, not a current view. */
export function normalizeProjectCreateReceipt(value,task,expectedInput){
  const invalid=()=>{throw new TypeError('新建工程回执缺少原任务绑定、有效状态或完整空工程证明；请核对原任务，不要再次创建。');};
  if(!expectedInput||!value||typeof value!=='object'||Array.isArray(value)||value.ok!==true||task?.phase!=='succeeded'||task.operation!=='project.create'||value.documentId!==task.documentId||value.requestId!==task.requestKey||!Number.isSafeInteger(value.revision)||value.revision<0||!Number.isSafeInteger(value.stateSequence)||value.stateSequence<0||typeof value.stateToken!=='string'||!/^[a-f0-9]{64}$/.test(value.stateToken)||task.revision!==undefined&&task.revision!==value.revision||task.stateToken!==undefined&&task.stateToken!==value.stateToken)invalid();
  const projectCreate=normalizeProjectCreateTask(value.projectCreate,task,expectedInput?.sourceDocumentId,expectedInput);
  if(projectCreate.canCreate||value.bodyCount!==0||value.featureCount!==0||!['features','bodies','bodyMetadata','variables','propertyRecords'].every(key=>Array.isArray(value[key])&&value[key].length===0)||!['faceCount','edgeCount','triangleCount'].every(key=>value.stats?.[key]===0)||!Array.isArray(value.coordinateSystems)||!Array.isArray(value.materials)||!['types','instances'].every(key=>Array.isArray(value.propertySchema?.[key])&&value.propertySchema[key].length===0))invalid();
  return {...value,projectCreate};
}
