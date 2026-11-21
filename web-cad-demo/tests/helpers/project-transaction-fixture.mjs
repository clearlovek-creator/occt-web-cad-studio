import fs from 'node:fs';
import path from 'node:path';
import {PropertySchemaStore} from '../../gateway/property-schema-store.mjs';
import {PersistentHistoryStore} from '../../gateway/history-store.mjs';
import {ProjectTransactionService} from '../../gateway/project-transaction-service.mjs';

export function transactionFixture(root){
  const schemas=new PropertySchemaStore(root),history=new PersistentHistoryStore(root,{projectData:{capture:id=>schemas.list(id),validate:value=>schemas.validateSnapshot(value)},onWarning:()=>{}});
  let model={revision:1,name:'Baseline'},restores=0,failRestore=false;
  const command=async(operation,fields)=>{
    if(operation==='document.snapshot'){fs.mkdirSync(path.dirname(fields.parameters.path),{recursive:true});fs.writeFileSync(fields.parameters.path,'BINFILE'+JSON.stringify(model));return {ok:true};}
    if(operation==='document.restore'){if(failRestore)throw new Error('injected restore failure');restores++;model=JSON.parse(fs.readFileSync(fields.parameters.path,'utf8').slice(7));return {ok:true,...model};}
    return {ok:true,...model};
  };
  const transactions=new ProjectTransactionService({dataDir:root,historyStore:history,propertySchemaStore:schemas,command,onWarning:()=>{}});
  const commit=async(id,event='test-change')=>{const before=history.get(id),next=history.snapshotPath(id);await command('document.snapshot',{documentId:id,parameters:{path:next}});history.commit(id,{current:next,undo:[...before.undo,before.current].filter(Boolean),redo:[],events:[...(before.events||[]),{eventId:event,operation:event}]});};
  return {root,schemas,history,transactions,command,commit,setModel:value=>{model=value;},model:()=>model,restores:()=>restores,failRestore:value=>{failRestore=value;}};
}
