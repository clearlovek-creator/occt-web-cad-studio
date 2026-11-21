export type MeshCatalogSnapshot={state:'unknown'|'recovering'|'ready'|'unavailable'|'stopped';attemptId:string|null;canRetry:boolean;stored:number|null;code?:string};
export const unknownMeshCatalog=():MeshCatalogSnapshot=>({state:'unknown',attemptId:null,canRetry:false,stored:null});
export function parseMeshCatalog(value:unknown):MeshCatalogSnapshot{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('网格历史状态响应无效。');
  const row=value as Record<string,unknown>,states=['recovering','ready','unavailable','stopped'];
  if(row.version!==1||typeof row.state!=='string'||!states.includes(row.state)||typeof row.attemptId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.attemptId)||row.canRetry!==(row.state==='unavailable'))throw Error('网格历史状态版本或身份无效，未采用结果。');
  if(row.state==='ready'? !Number.isSafeInteger(row.stored)||(row.stored as number)<0||(row.stored as number)>10000:row.stored!==null)throw Error('网格历史容量响应无效，未将未知容量当成零。');
  if(row.state==='unavailable'&&(typeof row.code!=='string'||!/^MESH_CATALOG_[A-Z_]{1,64}$/.test(row.code)))throw Error('网格历史错误状态不完整。');
  return {state:row.state as MeshCatalogSnapshot['state'],attemptId:row.attemptId,canRetry:row.canRetry as boolean,stored:row.stored as number|null,...(row.state==='unavailable'?{code:row.code as string}:{})};
}
export function meshCatalogReason(code?:string){
  if(code==='MESH_CATALOG_ID_CONFLICT')return '不同工程中存在同名任务记录。请先核对数据来源，再重新读取；系统不会自动选择或覆盖任何一份。';
  if(code==='MESH_CATALOG_LIMIT')return '历史记录数量、文件大小或读取时间超过保护额度。请先检查数据容量；重新读取不会放宽额度或删除旧记录。';
  if(code==='MESH_CATALOG_UNSAFE')return '历史目录包含链接或已被替换。请先恢复安全的目录关系，系统不会跟随链接或清理原文件。';
  return '网格历史暂时无法完整读取。可在检查服务或文件访问状态后重新读取，原工程和网格结果均保留。';
}
