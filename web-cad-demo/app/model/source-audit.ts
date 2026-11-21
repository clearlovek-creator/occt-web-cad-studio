export type SourceReference={featureId:string;documentId?:string;scope:'current'|'undo'|'redo'|'recovery'|'quarantine'|'retained';checkpoint:string;status:string;featureState:string};
export type SourceAsset={assetId:string;fileName:string;status:string;bytes?:number;sha256?:string;referenceCount:number;currentReferences:number;undoReferences:number;redoReferences:number;recoveryReferences?:number;quarantineReferences?:number;retainedReferences?:number;projectCount?:number;projects?:string[];references:SourceReference[];code?:string;retainedOnly?:boolean;operationId?:string;materialRole?:string;materialLabel?:string};
export type SourceAudit={jobId:string;documentId:string;state:string;phase:string;createdAt:string;finishedAt?:string;revision?:number;stateToken?:string;completedCheckpoints:number;totalCheckpoints:number;coverageComplete:boolean;integrityOK:boolean;stale:boolean;scope:'current-undo-redo'|'storage';catalogEntries?:number;cleanupAvailable:false;assets:SourceAsset[];issues:{code:string;message:string;checkpoint?:string}[];code?:string;error?:string};
const states=['queued','running','stopping','complete','failed','cancelled'];
const assetStates=['verified','legacy-unverified','changed','unverified','missing','untrusted','unreadable','unreferenced'];
export const sourceStatusLabel=(status:string)=>({verified:'内容已验证','legacy-unverified':'旧来源未认证',changed:'内容已变化',unverified:'证据无效',missing:'文件缺失',untrusted:'路径不受信任',unreadable:'无法读取',unreferenced:'未发现引用'}[status]||'待核对');
export const activeSourceAudit=(audit:SourceAudit|null)=>Boolean(audit&&['queued','running','stopping'].includes(audit.state));
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('来源检查响应结构无效。');return value as Record<string,unknown>;}
const string=(value:unknown,max=512)=>typeof value==='string'&&value.length<=max;
const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
export function parseSourceAudit(payload:unknown,documentId:string):SourceAudit|null{
  const value=record(payload);if(value.ok!==true||value.documentId!==documentId)throw Error(typeof value.error==='string'?value.error:'来源检查回复不属于当前工程。');
  if(value.audit===null)return null;
  const audit=record(value.audit);
  const storage=documentId==='@storage',scope=storage?'storage':'current-undo-redo';
  const overBudget=Number(audit.totalCheckpoints)>(storage?2048:128)&&!(audit.state==='failed'&&audit.code==='SOURCE_AUDIT_LIMIT');
  if(audit.documentId!==documentId||!string(audit.jobId,100)||!states.includes(String(audit.state))||!string(audit.phase,100)||!string(audit.createdAt,64)||!Number.isFinite(Date.parse(String(audit.createdAt)))||!count(audit.completedCheckpoints)||!count(audit.totalCheckpoints)||overBudget||Number(audit.completedCheckpoints)>Number(audit.totalCheckpoints)||audit.scope!==scope||audit.cleanupAvailable!==false||!['coverageComplete','integrityOK','stale'].every(key=>typeof audit[key]==='boolean')||!Array.isArray(audit.assets)||audit.assets.length>(storage?2000:1000)||!Array.isArray(audit.issues)||audit.issues.length>30)throw Error('来源检查报告结构无效，未展示未经核对的数据。');
  const ids=new Set();
  for(const raw of audit.assets){const row=record(raw);if(!string(row.assetId,96)||ids.has(row.assetId)||!string(row.fileName,240)||!assetStates.includes(String(row.status))||!['referenceCount','currentReferences','undoReferences','redoReferences'].every(key=>count(row[key]))||!Array.isArray(row.references)||row.references.length>20||(row.bytes!==undefined&&!count(row.bytes))||(row.sha256!==undefined&&(!string(row.sha256,64)||!/^[a-f0-9]{64}$/.test(String(row.sha256)))))throw Error('来源文件记录无效。');ids.add(row.assetId);
    if(row.retainedOnly!==undefined&&typeof row.retainedOnly!=='boolean'||row.operationId!==undefined&&!/^restore-[a-f0-9-]{36}$/.test(String(row.operationId))||row.materialRole!==undefined&&!string(row.materialRole,100)||row.materialLabel!==undefined&&!string(row.materialLabel,160))throw Error('恢复材料归属记录无效。');
    const extras=['recoveryReferences','quarantineReferences','retainedReferences'];if(extras.some(key=>row[key]!==undefined&&!count(row[key])))throw Error('存储引用数量无效。');
    if((row.code!==undefined&&!string(row.code,100))||Number(row.referenceCount)!==Number(row.currentReferences)+Number(row.undoReferences)+Number(row.redoReferences)+extras.reduce((sum,key)=>sum+Number(row[key]||0),0)||row.references.length>Number(row.referenceCount))throw Error('来源引用数量不一致。');
    if(row.projects!==undefined&&(!Array.isArray(row.projects)||row.projects.length>20||!count(row.projectCount)||Number(row.projectCount)<row.projects.length||row.projects.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id))))throw Error('来源工程归属记录无效。');
    for(const rawRef of row.references){const ref=record(rawRef);if(!string(ref.featureId,96)||!(storage?['current','undo','redo','recovery','quarantine','retained']:['current','undo','redo']).includes(String(ref.scope))||!string(ref.checkpoint,240)||!assetStates.includes(String(ref.status))||!string(ref.featureState,512)||(ref.documentId!==undefined&&(typeof ref.documentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(ref.documentId))))throw Error('来源依赖明细无效。');}
  }
  for(const raw of audit.issues){const issue=record(raw);if(!string(issue.code,100)||!string(issue.message,1000)||(issue.checkpoint!==undefined&&!string(issue.checkpoint,240)))throw Error('来源诊断记录无效。');}
  if((audit.code!==undefined&&!string(audit.code,100))||(audit.error!==undefined&&!string(audit.error,1000))||(audit.finishedAt!==undefined&&(!string(audit.finishedAt,64)||!Number.isFinite(Date.parse(String(audit.finishedAt))))))throw Error('来源检查终态记录无效。');
  if(audit.stateToken!==undefined&&!/^[a-f0-9]{64}$/.test(String(audit.stateToken)))throw Error('来源检查缺少有效工程身份。');
  if(audit.revision!==undefined&&!count(audit.revision))throw Error('来源检查模型修订版无效。');
  if(audit.catalogEntries!==undefined&&!count(audit.catalogEntries))throw Error('存储清点数量无效。');
  return audit as SourceAudit;
}
