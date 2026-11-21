export type RestorationProof={status:'file';size:number;sha256:string;fingerprint:string;algorithm:'sha256-chain-1m-v1'};
export type RestorationHealth={blocked:boolean;active:{operationId:string;action:string}|null;diagnostic?:{code:string;error:string;operationId?:string}};
export type SourceRestoration={version:1;operationId:string;documentId:string;scope:'storage'|'current-undo-redo';state:string;phase:string;fileName:string;createdAt:string;updatedAt:string;referenceCount:number;projects:string[];before:RestorationProof|{status:'missing'}|null;candidate:RestorationProof|null;changed:boolean|null;errorCode:string|null;requestErrorCode:string|null;requestError:string|null;recovery:string|null;supersededBy:string|null;blocking:boolean;serviceBusy:boolean;serviceBlocked:boolean;uploadComplete:boolean;canCommit:boolean;canRollback:boolean;canRevalidate:boolean;canAbandon:boolean;canReview:boolean;materials:{role:string;label:string;available:boolean}[]};
export type RestorationBinding={documentId:string;scope:'storage'|'current-undo-redo';auditJobId:string;assetId:string;fileName:string};
export const restorationId=(value:unknown):value is string=>typeof value==='string'&&/^restore-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('来源恢复响应结构无效。');return value as Record<string,unknown>;};
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max;
const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const date=(value:unknown)=>text(value,64)&&Number.isFinite(Date.parse(String(value)));
const document=(value:unknown)=>typeof value==='string'&&(value==='@storage'||/^[A-Za-z0-9_-]{1,64}$/.test(value));
const states=['prepared','activating','committed','reverting','rolled-back','attention','abandoned','receiving','validating','committing','rolling-back','reviewing','revalidating','abandoning','settled','failed','interrupted'];
export const restorationStateLabel=(value:string)=>({prepared:'候选已验证，尚未恢复',activating:'正在替换来源',committed:'来源已恢复',reverting:'正在回退', 'rolled-back':'已回退来源',attention:'事务待人工复核',abandoned:'已放弃，材料保留',receiving:'正在接收文件',validating:'正在核对完整引用',committing:'正在恢复来源','rolling-back':'正在回退来源',reviewing:'正在重新核对',revalidating:'正在重新校验',abandoning:'正在放弃',settled:'处理已结束',failed:'校验或操作未完成',interrupted:'处理曾中断',upload:'正在上传原始文件',prepare:'正在核对完整引用',commit:'正在恢复来源',rollback:'正在回退来源',review:'正在重新核对',revalidate:'正在重新校验',abandon:'正在放弃'}[value]||'状态待核对');
function proof(value:unknown,missing:boolean):RestorationProof|{status:'missing'}|null{
  if(value===null)return null;const item=record(value);if(missing&&item.status==='missing')return {status:'missing'};
  if(item.status!=='file'||!count(item.size)||item.algorithm!=='sha256-chain-1m-v1'||![item.sha256,item.fingerprint].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw Error('来源恢复内容证明无效。');
  return item as RestorationProof;
}
export function parseRestorationHealth(value:unknown):RestorationHealth{
  const item=record(value);if(typeof item.blocked!=='boolean')throw Error('来源事务健康状态无效。');
  if(item.active!==null){const active=record(item.active);if(!restorationId(active.operationId)||!['upload','prepare','commit','rollback','revalidate','review','abandon'].includes(String(active.action)))throw Error('来源活动任务身份无效。');}
  if(item.diagnostic!==undefined){const diagnostic=record(item.diagnostic);if(!text(diagnostic.code,100)||!text(diagnostic.error,600)||diagnostic.operationId!==undefined&&!restorationId(diagnostic.operationId))throw Error('来源事务诊断无效。');}
  return item as RestorationHealth;
}
export function parseRestoration(value:unknown,documentId:string,operationId?:string):SourceRestoration{
  const item=record(value);
  if(item.version!==1||!restorationId(item.operationId)||operationId!==undefined&&item.operationId!==operationId||!document(item.documentId)||!['storage','current-undo-redo'].includes(String(item.scope))||!states.includes(String(item.state))||!text(item.phase,64)||!text(item.fileName,240)||!date(item.createdAt)||!date(item.updatedAt)||!count(item.referenceCount)||Number(item.referenceCount)>100000||!Array.isArray(item.projects)||item.projects.length>2048||item.projects.some(value=>typeof value!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value)))throw Error('来源恢复记录身份或状态无效。');
  if(documentId!=='@storage'&&item.documentId!==documentId&&!item.projects.includes(documentId))throw Error('来源恢复回复不属于当前查看工程。');
  for(const key of ['blocking','serviceBusy','serviceBlocked','uploadComplete','canCommit','canRollback','canRevalidate','canAbandon','canReview'])if(typeof item[key]!=='boolean')throw Error('来源恢复操作能力无效。');
  if(item.changed!==null&&typeof item.changed!=='boolean')throw Error('来源恢复结果标记无效。');
  for(const [key,max] of [['errorCode',100],['requestErrorCode',100],['requestError',600],['recovery',1000]] as const)if(item[key]!==null&&!text(item[key],max))throw Error('来源恢复诊断字段无效。');
  if(item.supersededBy!==null&&!restorationId(item.supersededBy))throw Error('来源恢复顺序身份无效。');
  proof(item.before,true);proof(item.candidate,false);
  if(!Array.isArray(item.materials)||item.materials.length>34)throw Error('来源恢复材料列表超出预算。');
  const roles=new Set();for(const raw of item.materials){const material=record(raw);if(typeof material.role!=='string'||! /^(?:candidate|before|retained-(?:[1-9]|1[0-6])|recovery-(?:[1-9]|1[0-6]))$/.test(material.role)||roles.has(material.role)||!text(material.label,160)||typeof material.available!=='boolean')throw Error('来源恢复材料角色无效。');roles.add(material.role);}
  return item as SourceRestoration;
}
export function parseRestorationList(value:unknown,documentId:string){
  const payload=record(value);if(payload.ok!==true||!Array.isArray(payload.items)||payload.items.length>50||!count(payload.total)||!count(payload.offset)||!count(payload.limit)||Number(payload.limit)<1||Number(payload.limit)>50||payload.items.length>Number(payload.limit))throw Error('来源恢复历史响应无效。');
  const items=payload.items.map(item=>parseRestoration(item,documentId));if(new Set(items.map(item=>item.operationId)).size!==items.length)throw Error('来源恢复历史含重复身份。');
  return {items,total:Number(payload.total),offset:Number(payload.offset),limit:Number(payload.limit),health:parseRestorationHealth(payload.health)};
}
