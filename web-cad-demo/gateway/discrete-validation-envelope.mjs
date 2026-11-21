import crypto from 'node:crypto';
import {serialize,deserialize} from 'node:v8';
import {isMarkedAsUntransferable} from 'node:worker_threads';
export const DISCRETE_VALIDATION_BYTES=80*1024**2+8192;
const byteLimit=operation=>['mesh.discrete-checkpoint','mesh.discrete-optimize','mesh.discrete-patched-checkpoint','mesh.discrete-patched-optimize'].includes(operation)?272*1024**2:DISCRETE_VALIDATION_BYTES;
const fault=()=>Object.assign(Error('离散校验回复没有绑定本次输入、结果和阶段，未接纳结果。'),{code:'MESH_VALIDATION_PROTOCOL_INVALID',retryableByModel:false});
export const discreteValidationHash=packet=>crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex');
export function discreteValidationPacket(fields){
  let wire;try{wire=JSON.stringify({version:1,...fields});}catch{throw fault();}
  if(Buffer.byteLength(wire)>byteLimit(fields.operation))throw Object.assign(Error('离散校验材料超过传输预算。'),{code:'MESH_VALIDATION_LIMIT'});
  return {packet:JSON.parse(wire),sha256:crypto.createHash('sha256').update(wire).digest('hex')};
}
const binaryFormat='web-cad-native-validation-binary';
export function discreteValidationBinary(fields){
  let bytes;try{bytes=serialize({version:1,...fields});}catch{throw fault();}
  if(bytes.length>byteLimit(fields.operation))throw Object.assign(Error('离散校验二进制快照超过传输预算。'),{code:'MESH_VALIDATION_LIMIT'});
  // Dedicated, fixed-length storage. Never transfer a slab shared by other
  // Buffers; the artifact worker becomes the sole owner at actual dispatch.
  let data;
  if(bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength&&!isMarkedAsUntransferable(bytes.buffer)&&bytes.buffer.resizable!==true)data=bytes.buffer;
  else{data=new ArrayBuffer(bytes.length);new Uint8Array(data).set(bytes);}
  return {packet:{format:binaryFormat,version:1,codec:'node-v8-snapshot-v1',phase:fields.phase,operation:fields.operation,requestId:fields.requestId,bytes:bytes.length,data},sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
export function discreteValidationTransferList(packet){
  if(packet?.format===undefined)return [];
  if(packet.format!==binaryFormat||Object.keys(packet).some(key=>!['format','version','codec','phase','operation','requestId','bytes','data'].includes(key))||packet.version!==1||packet.codec!=='node-v8-snapshot-v1'||!(packet.data instanceof ArrayBuffer)||isMarkedAsUntransferable(packet.data)||packet.data.resizable===true||!Number.isSafeInteger(packet.bytes)||packet.bytes<1||packet.bytes>byteLimit(packet.operation)||packet.data.byteLength!==packet.bytes)throw fault();
  return [packet.data];
}
export function decodeDiscreteValidationBinary(envelope){
  discreteValidationTransferList(envelope);if(envelope?.format!==binaryFormat)throw fault();
  const bytes=Buffer.from(envelope.data),sha256=crypto.createHash('sha256').update(bytes).digest('hex');let packet;
  try{packet=deserialize(bytes);}catch{throw fault();}
  if(packet?.phase!==envelope.phase||packet.operation!==envelope.operation||packet.requestId!==envelope.requestId)throw fault();
  return {packet,sha256};
}
export function assertDiscreteValidationReceipt(receipt,packet,sha256){
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||Object.keys(receipt).some(key=>!['basis','phase','operation','requestId','sha256','failure'].includes(key))||receipt.basis!=='discrete-native-validation-v1'||receipt.phase!==packet.phase||receipt.operation!==packet.operation||receipt.requestId!==packet.requestId||receipt.sha256!==sha256)throw fault();
  if(packet.phase==='failure'){
    const f=receipt.failure;if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).some(key=>!['code','message','details'].includes(key))||typeof f.code!=='string'||!/^[A-Z][A-Z0-9_]{1,79}$/.test(f.code)||typeof f.message!=='string'||f.message.length>1024||Buffer.byteLength(JSON.stringify(f))>257*1024)throw fault();
  }else if(receipt.failure!==undefined)throw fault();return receipt;
}
