const keys=['protocolVersion','operation','documentId','sourceDocumentId','requestId','sourceRevision','sourceStateToken','sourceStateSequence'];
/** Null baseline is reserved for escaping a workspace whose model has not loaded. */
export function normalizeWorkspaceActivation(value){
  const invalid=()=>{throw new TypeError('工程切换需要准确的来源、目标、请求身份和完整来源状态。');};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key))||value.protocolVersion!==1||value.operation!=='project.activate'||typeof value.documentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value.documentId)||typeof value.sourceDocumentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value.sourceDocumentId)||typeof value.requestId!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(value.requestId))invalid();
  const empty=value.sourceRevision===null&&value.sourceStateToken===null&&value.sourceStateSequence===null;
  if(!empty&&(!Number.isSafeInteger(value.sourceRevision)||value.sourceRevision<0||!Number.isSafeInteger(value.sourceStateSequence)||value.sourceStateSequence<0||typeof value.sourceStateToken!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceStateToken)))invalid();
  return Object.fromEntries(keys.map(key=>[key,value[key]]));
}
export function normalizeWorkspaceActivationProof(value,expected){
  const actual=normalizeWorkspaceActivation(value),original=normalizeWorkspaceActivation(expected);
  if(JSON.stringify(actual)!==JSON.stringify(original))throw new TypeError('工程切换回复不属于原来源、目标和请求，未采用。');
  return actual;
}
