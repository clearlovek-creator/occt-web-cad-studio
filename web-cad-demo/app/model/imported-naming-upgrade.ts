export type NamingUpgradeStamp={documentId:string;revision:number;stateToken:string;stateSequence?:number|null};
export type NamingUpgradeReport={version:1;preview:boolean;sourceCount:number;bodyCount:number;historicalOutputCount:number;referenceCount:number;archivedSourceCount:number;archivedProofCount:number;archivedReferenceCount:number;geometryUnchanged:true;topologyIdentitiesUnchanged:true;changed:boolean};
export type NamingUpgradeReceipt={stamp:NamingUpgradeStamp;report:NamingUpgradeReport};
export type ImportedFeatureSummary={id:string;type:string;numberParameters?:Record<string,number>;stringParameters?:Record<string,string>};
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const count=(value:unknown,max=10000):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=max;
export function sameNamingUpgradeState(a:NamingUpgradeStamp,b:{documentId:string;revision:number|null;stateToken:string|null;stateSequence?:number|null}){
  return a.documentId===b.documentId&&a.revision===b.revision&&a.stateToken===b.stateToken&&(a.stateSequence==null||b.stateSequence==null||a.stateSequence===b.stateSequence);
}
export function parseNamingUpgradeReceipt(value:unknown,owner:NamingUpgradeStamp,preview:boolean):NamingUpgradeReceipt{
  const invalid=()=>new Error('引用升级回执不完整或不属于本次工程状态，请核对工程；不要重新发起新的升级请求。');
  if(!object(value)||value.ok!==true||value.documentId!==owner.documentId||!count(value.revision,Number.MAX_SAFE_INTEGER)||typeof value.stateToken!=='string'||!/^[a-f0-9]{64}$/.test(value.stateToken)||!count(value.stateSequence,Number.MAX_SAFE_INTEGER)||!object(value.importedNamingUpgrade))throw invalid();
  const r=value.importedNamingUpgrade;
  if(r.version!==1||r.preview!==preview||r.geometryUnchanged!==true||r.topologyIdentitiesUnchanged!==true||typeof r.changed!=='boolean'||!count(r.sourceCount)||!count(r.bodyCount,1000000)||!count(r.historicalOutputCount)||!count(r.referenceCount)||r.changed!==(!preview&&r.sourceCount>0)||value.revision!==owner.revision+(r.changed?1:0)||value.bodyCount!==r.bodyCount)throw invalid();
  if((preview||!r.changed)&&value.stateToken!==owner.stateToken||r.changed&&(value.stateToken===owner.stateToken||owner.stateSequence!=null&&Number(value.stateSequence)<=owner.stateSequence))throw invalid();
  if(preview&&owner.stateSequence!=null&&value.stateSequence!==owner.stateSequence)throw invalid();
  const archived=[r.archivedSourceCount,r.archivedProofCount,r.archivedReferenceCount],hasArchive=archived.some(value=>value!==undefined);
  if(hasArchive&&(!count(archived[0],64)||!count(archived[1],256)||!count(archived[2],640000)||!archived[0]&&Boolean(archived[1]||archived[2])||!r.sourceCount&&archived.some(Boolean)))throw invalid();
  return {stamp:{documentId:owner.documentId,revision:value.revision,stateToken:value.stateToken,stateSequence:Number(value.stateSequence)},report:{version:1,preview,sourceCount:r.sourceCount,bodyCount:r.bodyCount,historicalOutputCount:r.historicalOutputCount,referenceCount:r.referenceCount,archivedSourceCount:Number(archived[0]??0),archivedProofCount:Number(archived[1]??0),archivedReferenceCount:Number(archived[2]??0),geometryUnchanged:true,topologyIdentitiesUnchanged:true,changed:r.changed}};
}
export function namingUpgradeArchivePolicy(value:unknown):'unsupported'|'none'|'exact-recertification-v1'{
  if(!object(value)||value.ok!==true||!object(value.capabilities)||!object(value.capabilities.nativeGeometry))return 'unsupported';
  const native=value.capabilities.nativeGeometry;
  if(native.version!==1||native.source!=='native-handshake'||native.ready!==true||typeof native.workerInstance!=='string'||!/^[a-f0-9-]{36}$/.test(native.workerInstance)||!object(native.features))return 'unsupported';
  const imported=native.features['immutable-step-topology-v1'];
  if(!object(imported)||imported.version!==1||imported.basis!=='immutable-step-brep-v1'||imported.sourceFingerprintAlgorithm!=='sha256-chain-1m-v1'||!object(imported.upgrade)||imported.upgrade.version!==1||imported.upgrade.basis!=='unchanged-dual-replay-v1')return 'unsupported';
  const upgrade=imported.upgrade;
  if(upgrade.archivedRecovery===false)return 'none';
  return upgrade.archivedRecovery==='exact-recertification-v1'&&count(upgrade.maxArchivedSources,64)&&Number(upgrade.maxArchivedSources)>0&&count(upgrade.maxArchivedProofs,256)&&Number(upgrade.maxArchivedProofs)>0?'exact-recertification-v1':'unsupported';
}
export function namingUpgradeCapability(value:unknown):boolean{return namingUpgradeArchivePolicy(value)!=='unsupported';}
export function parseNamingUpgradeUndo(value:unknown,owner:NamingUpgradeStamp):NamingUpgradeStamp{
  if(!object(value)||value.ok!==true||value.documentId!==owner.documentId||value.revision!==owner.revision-1||typeof value.stateToken!=='string'||!/^[a-f0-9]{64}$/.test(value.stateToken)||value.stateToken===owner.stateToken||!count(value.stateSequence,Number.MAX_SAFE_INTEGER)||owner.stateSequence!=null&&Number(value.stateSequence)<=owner.stateSequence)throw Error('撤销回执尚未确认，请核对工程，不要重复发起新的撤销。');
  return {documentId:owner.documentId,revision:Number(value.revision),stateToken:value.stateToken,stateSequence:Number(value.stateSequence)};
}
export function namingUpgradeAdvice(code:string|undefined){
  switch(code){
    case 'IMPORT_NAMING_UPGRADE_ARCHIVED_REFERENCES':return {title:'归档引用尚不能升级',text:'工程含被抑制或归档的拓扑恢复证据，当前尚不支持重新认证。原记录保持不变；不要仅为升级而删除这些记录。'};
    case 'IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED':return {title:'归档输出证据不一致',text:'当前输入或生成参数无法精确重建原归档输出。整次升级未提交，原恢复证据保留；请检查对应特征历史，不要删除记录或强行恢复属性。'};
    case 'IMPORT_NAMING_UPGRADE_ARCHIVE_LIMIT':return {title:'归档验证超过处理上限',text:'本次未提交任何升级。支持最多 64 个归档来源、256 份输出证据，单份含原记录不超过 17 MiB、总计不超过 64 MiB；请保留工程，不要为绕过上限删除恢复记录。'};
    case 'INVALID_SUSPENDED_TOPOLOGY':return {title:'归档恢复记录需要检查',text:'恢复记录格式、所有权或审计摘要无效。升级未提交；请保留工程和原记录，以便检查，不会丢弃记录后继续升级。'};
    case 'IMPORT_NAMING_UPGRADE_REFERENCE_MISSING':return {title:'历史选择缺少证据',text:'部分特征只保存了面或边编号。请在特征历史中检查原输入并显式重选；系统不会根据最终外形猜测。'};
    case 'IMPORT_NAMING_UPGRADE_SOURCE_UNVERIFIED':return {title:'原始来源未经认证',text:'该旧导入没有完整的来源版本或内容指纹。请先检查来源；同名文件或当前文件不能代替历史证明。'};
    case 'STEP_REPLAY_SOURCE_MISSING':case 'STEP_REPLAY_SOURCE_CHANGED':return {title:'STEP 来源需要核对',text:'保留来源缺失或内容发生变化。请在来源检查中核对并恢复原始文件，不要用相似文件替换。'};
    case 'PROJECT_STATE_CONFLICT':case 'STALE_REVISION':case 'REVISION_CONFLICT':return {title:'工程已变化',text:'旧验证已失效。请先核对当前工程，再重新验证；不会把旧选择套到新工程上。'};
    case 'IMPORT_NAMING_UPGRADE_GEOMETRY_CHANGED':case 'IMPORT_NAMING_UPGRADE_COORDINATE_CHANGED':return {title:'无法证明几何保持不变',text:'历史重放、当前几何或关联坐标框架不一致。请先检查特征与坐标系，升级未被接受。'};
    case 'WORKER_CAPABILITY_UNAVAILABLE':return {title:'当前后台不支持升级',text:'请使用经过验收的兼容后台。支持 STEP 导入不代表支持旧工程引用升级。'};
    default:return {title:'验证或升级未完成',text:'请保留工程，检查下面的诊断后再处理。不会自动重试或改用面/边编号。'};
  }
}
export function namingUpgradeOutcomeUnknown(code:string|undefined){return !code||['NETWORK_ERROR','INVALID_RESPONSE','WORKER_TIMEOUT','OCCT_FAILURE','INTERNAL_ERROR','TRANSACTION_ROLLBACK_FAILED','PROJECT_RECOVERY_REQUIRED','PROJECT_ROLLBACK_FAILED','SERVICE_STOPPING'].includes(code);}
