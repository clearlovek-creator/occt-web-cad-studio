const keys=['protocolVersion','operation','documentId','requestId'];
/** A read has no source workspace and never transfers a conversation. */
export function normalizeWorkspaceRead(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key))||value.protocolVersion!==1||value.operation!=='project.read'||typeof value.documentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value.documentId)||typeof value.requestId!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(value.requestId))throw new TypeError('工程读取需要准确的工程与请求身份。');
  return Object.fromEntries(keys.map(key=>[key,value[key]]));
}
export function normalizeWorkspaceReadProof(value,expected){
  const actual=normalizeWorkspaceRead(value),original=normalizeWorkspaceRead(expected);
  if(JSON.stringify(actual)!==JSON.stringify(original))throw new TypeError('工程读取回复不属于原工程与请求，未采用。');
  return actual;
}
