import {piOwnerProof,type PiOwnership} from './pi-ownership-proof.ts';
export type PiOwnerStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type PiOwnerBackupSummary={id:string;createdAt:string;characters:number};
type OwnerProof=ReturnType<typeof piOwnerProof>;
type Backup={id:string;createdAt:string;originalValue:string;originalSha256:string;owner:OwnerProof};
type Catalog={format:'web-cad-pi-local-owner-backups';version:1;apiRoot:string;sessionId:string;documentId:string;originalKey:string;records:Backup[]};
const RAW_LIMIT=65536,CATALOG_LIMIT=512*1024,COUNT_LIMIT=8;
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
/** Hash a JSON string, preserving distinct unpaired UTF-16 surrogates from DOM storage. */
async function digest(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');}
export class PiOwnerLocalBackups{
  readonly key:string;
  private storage:PiOwnerStorage;private originalKey:string;private apiRoot:string;private sessionId:string;private documentId:string;
  constructor(storage:PiOwnerStorage,originalKey:string,apiRoot:string,sessionId:string,documentId:string){this.storage=storage;this.originalKey=originalKey;this.apiRoot=apiRoot;this.sessionId=sessionId;this.documentId=documentId;this.key=originalKey+':backups';}
  private read():{bytes:string|null;catalog:Catalog}{
    const bytes=this.storage.getItem(this.key),empty:Catalog={format:'web-cad-pi-local-owner-backups',version:1,apiRoot:this.apiRoot,sessionId:this.sessionId,documentId:this.documentId,originalKey:this.originalKey,records:[]};
    if(bytes===null)return {bytes,catalog:empty};
    if(bytes.length>CATALOG_LIMIT)throw Error('本地恢复备份超过预算，原记录已保留，未覆盖。');
    let value:unknown;try{value=JSON.parse(bytes);}catch{throw Error('本地恢复备份不可解析，原备份与待恢复记录均未覆盖。');}
    if(!object(value)||!exact(value,['format','version','apiRoot','sessionId','documentId','originalKey','records'])||value.format!==empty.format||value.version!==1||value.apiRoot!==this.apiRoot||value.sessionId!==this.sessionId||value.documentId!==this.documentId||value.originalKey!==this.originalKey||!Array.isArray(value.records)||value.records.length>COUNT_LIMIT)throw Error('本地恢复备份身份或格式异常，未覆盖。');
    const ids=new Set<string>();
    for(const item of value.records){
      if(!object(item)||!exact(item,['id','createdAt','originalValue','originalSha256','owner'])||typeof item.id!=='string'||!/^[a-f0-9]{64}$/.test(item.id)||ids.has(item.id)||typeof item.createdAt!=='string'||!Number.isFinite(Date.parse(item.createdAt))||typeof item.originalValue!=='string'||item.originalValue.length>RAW_LIMIT||typeof item.originalSha256!=='string'||!/^[a-f0-9]{64}$/.test(item.originalSha256)||!object(item.owner))throw Error('本地恢复备份内容异常，未覆盖。');
      const owner=piOwnerProof(item.owner as PiOwnership);if(owner.sessionId!==this.sessionId||owner.documentId!==this.documentId||JSON.stringify(owner)!==JSON.stringify(item.owner))throw Error('本地恢复备份归属不匹配，未覆盖。');ids.add(item.id);
    }
    return {bytes,catalog:value as unknown as Catalog};
  }
  list():PiOwnerBackupSummary[]{return this.read().catalog.records.map(({id,createdAt,originalValue})=>({id,createdAt,characters:originalValue.length}));}
  private async verify(catalog:Catalog){for(const item of catalog.records){if(await digest(item.originalValue)!==item.originalSha256||await digest({apiRoot:this.apiRoot,sessionId:this.sessionId,documentId:this.documentId,originalValue:item.originalValue,owner:item.owner})!==item.id)throw Error('本地恢复备份摘要不一致，原材料已保留，未采用。');}}
  /** Preparation is read-only. Caller must hold the matching browser storage lock through publish/clear. */
  async prepare(originalValue:string,owner:PiOwnership){
    if(originalValue.length>RAW_LIMIT)throw Error('异常记录超过 65536 字符的安全备份预算，请离线保留原材料；未清除。');
    const proof=piOwnerProof(owner);if(proof.sessionId!==this.sessionId||proof.documentId!==this.documentId)throw Error('本地恢复备份的工程或会话不匹配。');const before=this.read();await this.verify(before.catalog);
    const id=await digest({apiRoot:this.apiRoot,sessionId:this.sessionId,documentId:this.documentId,originalValue,owner:proof}),existing=before.catalog.records.find(item=>item.id===id);
    const item:Backup=existing??{id,createdAt:new Date().toISOString(),originalValue,originalSha256:await digest(originalValue),owner:proof};
    if(!existing&&before.catalog.records.length>=COUNT_LIMIT)throw Error('本地恢复备份已达到 8 份上限，原材料已保留；请先离线归档，不会自动删除旧备份。');
    const catalog={...before.catalog,records:existing?before.catalog.records:[...before.catalog.records,item]},bytes=JSON.stringify(catalog);if(bytes.length>CATALOG_LIMIT)throw Error('本地恢复备份总量超过预算，原材料未清除。');
    return {alreadyPreserved:Boolean(existing),publish:()=>{if(this.storage.getItem(this.key)!==before.bytes)throw Error('其他页面已改变本地备份，未覆盖或清除原记录。');if(bytes!==before.bytes)this.storage.setItem(this.key,bytes);if(this.storage.getItem(this.key)!==bytes)throw Error('本地恢复备份未能读回验证，未清除原记录。');},summary:{id:item.id,createdAt:item.createdAt,characters:originalValue.length}};
  }
  async export(id:string){
    const before=this.read();await this.verify(before.catalog);const item=before.catalog.records.find(row=>row.id===id);if(!item)throw Error('指定本地恢复备份不存在。');if(this.storage.getItem(this.key)!==before.bytes)throw Error('本地备份读取期间变化，未导出旧回复。');
    return JSON.stringify({format:'web-cad-pi-local-owner-backup',version:1,apiRoot:this.apiRoot,sessionId:this.sessionId,documentId:this.documentId,originalKey:this.originalKey,record:item},null,2);
  }
}
const held=new Set<string>();
/** Product writers share a Web Lock across tabs. The non-browser branch is for isolated clients/tests only. */
export async function withPiOwnerStorageLock<T>(key:string,action:()=>Promise<T>):Promise<T>{
  if(typeof window!=='undefined'){
    if(!globalThis.navigator?.locks)throw Error('当前浏览器不支持跨页面恢复保护，请使用支持 Web Locks 的浏览器；原记录未修改。');
    return navigator.locks.request('web-cad-pi-owner:'+key,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('另一个页面正在核对本地恢复记录，请稍后再试。');return action();});
  }
  if(held.has(key))throw Error('另一个页面正在核对本地恢复记录，请稍后再试。');held.add(key);try{return await action();}finally{held.delete(key);}
}
