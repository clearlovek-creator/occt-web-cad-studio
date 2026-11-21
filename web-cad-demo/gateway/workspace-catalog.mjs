import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {historyRecoveryWarning} from "./history-store.mjs";
const validId=/^[A-Za-z0-9_-]{1,64}$/;
const digest=value=>crypto.createHash("sha256").update(value).digest("hex");

export class WorkspaceCatalog {
  constructor({dataDir,historyStore,propertySchemaStore,meshStrategyStore,getLoadState=()=>({state:'unloaded',phase:'waiting'})}) {
    this.directory=path.join(dataDir,"projects");this.historyStore=historyStore;this.propertySchemaStore=propertySchemaStore;this.meshStrategyStore=meshStrategyStore;this.getLoadState=getLoadState;this.records=new Map();this.tokens=new Map();fs.mkdirSync(this.directory,{recursive:true});
    for(const file of fs.readdirSync(this.directory))if(/^[A-Za-z0-9_-]{1,64}\.json$/.test(file)){
      const item=JSON.parse(fs.readFileSync(path.join(this.directory,file),"utf8"));
      if(item.version!==1 || !validId.test(item.documentId) || file!==`${item.documentId}.json` || typeof item.name!=="string" || !item.name.trim() || item.name.length>120)throw new Error(`Invalid workspace metadata: ${file}`);
      this.records.set(item.documentId,item);
    }
  }
  known(id){return validId.test(id) && (id==="default" || this.records.has(id) || this.historyStore.hasDocument(id)&&Boolean(this.historyStore.get(id).current || this.historyStore.get(id).restoreError));}
  write(item){
    const target=path.join(this.directory,`${item.documentId}.json`),temporary=`${target}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(temporary,JSON.stringify(item),"utf8");try{fs.renameSync(temporary,target);}catch(error){fs.rmSync(temporary,{force:true});throw error;}
    this.records.set(item.documentId,item);
  }
  record(id){
    if(!this.known(id)){const error=new Error("该恢复工程不存在或未找到持久化快照，请从工程列表选择或打开工程文件。");error.code="WORKSPACE_NOT_FOUND";throw error;}
    if(!this.records.has(id)){
      const now=new Date().toISOString(),history=this.historyStore.get(id);
      this.write({version:1,documentId:id,name:id==="default" ? "未命名工程" : `恢复工程 ${id.slice(-10)}`,createdAt:history.events[0]?.timestamp || now,updatedAt:history.events.at(-1)?.timestamp || now,lastGeneratedToken:null,lastGeneratedAt:null});
    }
    return this.records.get(id);
  }
  token(id){
    const record=this.record(id),history=this.historyStore.get(id),schema=this.propertySchemaStore.get(id);
    const strategies=this.meshStrategyStore?.list(id);const key=`${history.current}|${schema.updatedAt}|${this.propertySchemaStore.contentVersion(id)}|${strategies?JSON.stringify(strategies):''}|${record.name}`;
    const cached=this.tokens.get(id);if(cached?.key===key)return cached.token;
    const geometry=history.current && fs.existsSync(history.current) ? digest(fs.readFileSync(history.current)) : "empty";
    const token=digest(JSON.stringify({geometry,types:schema.types,instances:schema.instances,name:record.name,...(strategies?.strategies.length?{meshStrategies:strategies}:{})}));this.tokens.set(id,{key,token});return token;
  }
  get(id){
    const record=this.record(id),history=this.historyStore.get(id),load=this.getLoadState(id);let token;
    try{token=this.token(id);}catch(error){
      if(!['PROPERTY_SCHEMA_CORRUPT','MESH_STRATEGY_CORRUPT'].includes(error.code))throw error;
      let certified=false;try{certified=!history.restoreError&&load.state!=='failed'&&Boolean(history.current&&this.historyStore.isValidSnapshot(id,history.current)&&this.historyStore.readProjectData(id,history.current));}catch{ /* No complete evidence: keep this project unavailable. */ }
      return {...record,load,token:null,hasChangesSinceExport:true,recoverable:certified,recoveryError:certified?null:error.message,recoveryWarning:certified?`${error.code==='MESH_STRATEGY_CORRUPT'?'网格方案':'属性'}文件不可读；打开时将从绑定的完整检查点恢复，并保留原文件。`:null};
    }
    return {...record,token,load,hasChangesSinceExport:record.lastGeneratedToken!==token,recoverable:!history.restoreError && load.state!=='failed' && (id==="default" || Boolean(history.current && this.historyStore.isValidSnapshot(id,history.current))),recoveryError:history.restoreError || (load.state==='failed'?load.error:null) || null,recoveryWarning:historyRecoveryWarning(history),updatedAt:history.events.at(-1)?.timestamp > record.updatedAt ? history.events.at(-1).timestamp : record.updatedAt};
  }
  rename(id,name){
    if(typeof name!=="string" || !name.trim() || name.trim().length>120 || /[\x00-\x1f]/.test(name))throw new Error("工程名称须为 1 至 120 个字符，不能包含控制字符。");
    this.write({...this.record(id),name:name.trim(),updatedAt:new Date().toISOString()});return this.get(id);
  }
  markGenerated(id,token){
    if(!/^[a-f0-9]{64}$/.test(token))throw new Error("Invalid project content token.");
    this.write({...this.record(id),lastGeneratedToken:token,lastGeneratedAt:new Date().toISOString()});return this.get(id);
  }
  touch(id){this.write({...this.record(id),updatedAt:new Date().toISOString()});return this.get(id);}
  list(query=""){
    const ids=new Set([...this.records.keys(),...this.historyStore.documentIds().filter(id=>{const history=this.historyStore.get(id);return history.current || history.restoreError;})]);
    const needle=String(query).trim().slice(0,240).toLowerCase();
    const updated=id=>[this.records.get(id)?.updatedAt || "",this.historyStore.get(id).events.at(-1)?.timestamp || ""].sort().at(-1);
    return [...ids].filter(id=>`${this.records.get(id)?.name || (id==="default" ? "未命名工程" : `恢复工程 ${id.slice(-10)}`)} ${id}`.toLowerCase().includes(needle)).sort((a,b)=>updated(b).localeCompare(updated(a))).slice(0,200).map(id=>this.get(id));
  }
}
