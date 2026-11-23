const fields=['protocolVersion','operation','documentId','requestId','baseRevision','baseStateToken','baseStateSequence','copyName'];
export function normalizeProjectSaveInput(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key))||value.protocolVersion!==1||value.operation!=='project.save'||typeof value.documentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value.documentId)||typeof value.requestId!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(value.requestId))throw new TypeError('工程保存任务身份无效。');
  for(const key of ['baseRevision','baseStateSequence'])if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||value[key]<0))throw new TypeError('工程保存基线版本无效。');
  if(value.baseStateToken!==undefined&&(typeof value.baseStateToken!=='string'||!/^[a-f0-9]{64}$/.test(value.baseStateToken)))throw new TypeError('工程保存基线标识无效。');
  const {copyName}=value;
  if(copyName!==undefined&&(typeof copyName!=='string'||!copyName.trim()||copyName.trim()==='未命名工程'||copyName.length>120||/[\x00-\x1f\x7f]/.test(copyName)))throw new TypeError('副本名称须为 1 至 120 个字符，不能包含控制字符。');
  return {protocolVersion:1,operation:'project.save',documentId:value.documentId,requestId:value.requestId,...(value.baseRevision===undefined?{}:{baseRevision:value.baseRevision}),...(value.baseStateToken===undefined?{}:{baseStateToken:value.baseStateToken}),...(value.baseStateSequence===undefined?{}:{baseStateSequence:value.baseStateSequence}),...(copyName===undefined?{}:{copyName:copyName.trim()})};
}
export function projectSaveCanonical(value){return JSON.stringify(normalizeProjectSaveInput(value));}
export function normalizeProjectSaveTask(value,task,expectedInput){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||value.taskId!==task?.taskId||typeof value.canGenerate!=='boolean'||task?.operation!=='project.save')throw new TypeError('工程保存任务的登记身份无效。');
  const {version,taskId,canGenerate,...raw}=value,input=normalizeProjectSaveInput(raw);
  if(input.documentId!==task.documentId||input.requestId!==task.requestKey||canGenerate&&(task.phase!=='reserved'||task.cancelRequested)||expectedInput!==undefined&&projectSaveCanonical(input)!==projectSaveCanonical(Object.fromEntries(fields.filter(key=>expectedInput[key]!==undefined).map(key=>[key,expectedInput[key]]))))throw new TypeError('工程保存任务与原请求或基线不一致。');
  return {version,taskId,...input,canGenerate};
}
export function normalizeStoredProjectBackupReceipt(value,documentId,taskId){
  const invalid=()=>{throw new TypeError('备份回执与原保存任务、工程版本或文件身份不一致。');};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['ok','documentId','requestId','revision','stateToken','stateSequence','projectBackup'].includes(key))||value.ok!==true||typeof documentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(documentId)||typeof taskId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(taskId)||value.documentId!==documentId||typeof value.requestId!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(value.requestId)||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.stateToken!=='string'||!/^[a-f0-9]{64}$/.test(value.stateToken)||!Number.isSafeInteger(value.stateSequence)||value.stateSequence<0)invalid();
  const backup=value.projectBackup;
  if(!backup||typeof backup!=='object'||Array.isArray(backup)||Object.keys(backup).some(key=>!['version','taskId','fileName','bytes','sha256','workspaceToken','createdAt','downloadPath'].includes(key))||backup.version!==1||backup.taskId!==taskId||typeof backup.fileName!=='string'||backup.fileName.length>128||!backup.fileName.endsWith('.cadproj')||!backup.fileName.slice(0,-8).trim()||/[<>:"/\\|?*\x00-\x1f\x7f]/.test(backup.fileName)||!Number.isSafeInteger(backup.bytes)||backup.bytes<1||backup.bytes>1024**3||typeof backup.sha256!=='string'||!/^[a-f0-9]{64}$/.test(backup.sha256)||typeof backup.workspaceToken!=='string'||!/^[a-f0-9]{64}$/.test(backup.workspaceToken)||typeof backup.createdAt!=='string'||!Number.isFinite(Date.parse(backup.createdAt))||backup.downloadPath!==`/api/documents/${documentId}/project/backups/${taskId}/download`)invalid();
  return {ok:true,documentId:value.documentId,requestId:value.requestId,revision:value.revision,stateToken:value.stateToken,stateSequence:value.stateSequence,projectBackup:{version:1,taskId:backup.taskId,fileName:backup.fileName,bytes:backup.bytes,sha256:backup.sha256,workspaceToken:backup.workspaceToken,createdAt:backup.createdAt,downloadPath:backup.downloadPath}};
}
export function normalizeProjectBackupReceipt(value,task,expectedInput){
  const invalid=()=>{throw new TypeError('备份回执与原保存任务、工程版本或文件身份不一致。');};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['ok','documentId','requestId','revision','stateToken','stateSequence','projectBackup','modelingTask','projectSave','projectSaveNotice'].includes(key))||task?.operation!=='project.save'||task.phase!=='succeeded'||value.requestId!==task.requestKey)invalid();
  const stored=Object.fromEntries(['ok','documentId','requestId','revision','stateToken','stateSequence','projectBackup'].map(key=>[key,value[key]]));
  const receipt=normalizeStoredProjectBackupReceipt(stored,task.documentId,task.taskId);
  if(expectedInput){const input=normalizeProjectSaveInput(Object.fromEntries(fields.filter(key=>expectedInput[key]!==undefined).map(key=>[key,expectedInput[key]])));if(input.documentId!==value.documentId||input.requestId!==value.requestId||input.baseRevision!==undefined&&input.baseRevision!==value.revision||input.baseStateToken!==undefined&&input.baseStateToken!==value.stateToken||input.baseStateSequence!==undefined&&input.baseStateSequence!==value.stateSequence)invalid();}
  if(task.revision!==undefined&&task.revision!==value.revision||task.stateToken!==undefined&&task.stateToken!==value.stateToken)invalid();
  return receipt;
}
