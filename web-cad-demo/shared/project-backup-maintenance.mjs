const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ENTRY=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.pending)?$/;
const DOC=/^[A-Za-z0-9_-]{1,64}$/;
const HASH=/^[a-f0-9]{64}$/;
const object=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const fail=()=>{throw new TypeError('备份维护清单的身份、内容或状态无效，未授权清理。');};
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function normalizeBackupMaintenance(value,documentId){
  if(!object(value,['reviewId','documentId','entryId','state','snapshotDigest','createdAt','expiresAt','expired','running','files','outcome'])||!UUID.test(value.reviewId)||!DOC.test(documentId)||value.documentId!==documentId||!ENTRY.test(value.entryId)||!['reviewed','prepared','isolated','completed'].includes(value.state)||!HASH.test(value.snapshotDigest)||!iso(value.createdAt)||!iso(value.expiresAt)||Date.parse(value.expiresAt)<=Date.parse(value.createdAt)||Date.parse(value.expiresAt)-Date.parse(value.createdAt)>86400000||typeof value.expired!=='boolean'||typeof value.running!=='boolean'||value.state!=='reviewed'&&value.expired||value.state==='completed'&&value.running||!Array.isArray(value.files)||value.files.length>2)fail();
  if(value.state==='completed'?!['removed','already-absent'].includes(value.outcome):value.outcome!==undefined)fail();
  const files=value.files.map(file=>{if(!object(file,['name','bytes','sha256'])||!['backup.cadproj','receipt.json'].includes(file.name)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>(file.name==='receipt.json'?32768:1024**3)||!HASH.test(file.sha256))fail();return {name:file.name,bytes:file.bytes,sha256:file.sha256};});if(new Set(files.map(file=>file.name)).size!==files.length)fail();
  return {reviewId:value.reviewId,documentId,entryId:value.entryId,state:value.state,snapshotDigest:value.snapshotDigest,createdAt:value.createdAt,expiresAt:value.expiresAt,expired:value.expired,running:value.running,files,...(value.state==='completed'?{outcome:value.outcome}:{})};
}
export function normalizeBackupMaintenanceResponse(value,documentId,reviewId){
  if(!object(value,['ok','version','maintenance'])||value.ok!==true||value.version!==1)fail();const record=normalizeBackupMaintenance(value.maintenance,documentId);if(reviewId!==undefined&&record.reviewId!==reviewId)fail();return {ok:true,version:1,maintenance:record};
}
export function normalizeBackupMaintenanceList(value,documentId){
  if(!object(value,['ok','version','documentId','records','unreadableRecords'])||value.ok!==true||value.version!==1||value.documentId!==documentId||!Array.isArray(value.records)||value.records.length>512||!Number.isSafeInteger(value.unreadableRecords)||value.unreadableRecords<0||value.unreadableRecords>512)fail();const records=value.records.map(record=>normalizeBackupMaintenance(record,documentId));if(new Set(records.map(record=>record.reviewId)).size!==records.length)fail();return {ok:true,version:1,documentId,records,unreadableRecords:value.unreadableRecords};
}
