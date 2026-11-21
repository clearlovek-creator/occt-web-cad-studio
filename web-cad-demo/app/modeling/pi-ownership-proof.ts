export type PiOwnership={state:'absent'|'empty'|'legacy'|'bound';sessionId:string;documentId:string;historyDigest?:string;fileCount?:number;totalBytes?:number;ownerToken?:string;adoption?:string;createdAt?:string;preview?:{version:1;messages:{role:'user'|'assistant';text:string;timestamp?:string;truncated:boolean}[];omittedMessages:number;skippedLines:number;limited:boolean}};
const hash=/^[a-f0-9]{64}$/;
export function normalizePiOwnership(value:unknown,sessionId:string,documentId:string):PiOwnership{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('归属回复无效。');const item=value as PiOwnership;
  if(item.sessionId!==sessionId||item.documentId!==documentId||!['absent','empty','legacy','bound'].includes(item.state))throw Error('归属回复不属于当前工程和会话。');
  if(item.state==='bound'&&(typeof item.ownerToken!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item.ownerToken)||!['new','explicit-legacy'].includes(String(item.adoption))||typeof item.createdAt!=='string'||!Number.isFinite(Date.parse(item.createdAt))||item.adoption==='explicit-legacy'&&!hash.test(item.historyDigest||'')))throw Error('归属证明不完整。');
  if(item.state==='legacy'){
    const p=item.preview;if(!hash.test(item.historyDigest||'')||!Number.isSafeInteger(item.fileCount)||Number(item.fileCount)<1||Number(item.fileCount)>256||!Number.isSafeInteger(item.totalBytes)||Number(item.totalBytes)<0||Number(item.totalBytes)>256*1024*1024||!p||p.version!==1||!Array.isArray(p.messages)||p.messages.length>12||!Number.isSafeInteger(p.omittedMessages)||p.omittedMessages<0||!Number.isSafeInteger(p.skippedLines)||p.skippedLines<0||typeof p.limited!=='boolean'||p.messages.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>1000||typeof m.truncated!=='boolean'||m.timestamp!==undefined&&(typeof m.timestamp!=='string'||m.timestamp.length>100||!Number.isFinite(Date.parse(m.timestamp)))))throw Error('旧会话核对材料无效或超出预算。');
  }
  return structuredClone(item);
}
export function piOwnerProof(value:PiOwnership){
  const owner=normalizePiOwnership(value,value.sessionId,value.documentId);
  if(owner.state!=='bound')throw Error('后台尚未确认会话归属，不能修复本地记录。');
  return {state:'bound' as const,sessionId:owner.sessionId,documentId:owner.documentId,ownerToken:owner.ownerToken!,createdAt:owner.createdAt!,adoption:owner.adoption!,...(owner.adoption==='explicit-legacy'?{historyDigest:owner.historyDigest!}:{})};
}
