import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import {WorkspaceCatalog} from "../gateway/workspace-catalog.mjs";
import {PersistentHistoryStore} from "../gateway/history-store.mjs";
import {PropertySchemaStore} from "../gateway/property-schema-store.mjs";

test("workspace catalog persists names and tracks geometry and typed-data changes independently of native revision",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cad-workspaces-"));
  try{
    const history=new PersistentHistoryStore(root),schemas=new PropertySchemaStore(root),catalog=new WorkspaceCatalog({dataDir:root,historyStore:history,propertySchemaStore:schemas});
    const first=catalog.get("default");assert.equal(first.name,"未命名工程");assert.equal(first.hasChangesSinceExport,true);
    const renamed=catalog.rename("default","天线前处理工程");catalog.markGenerated("default",renamed.token);assert.equal(catalog.get("default").hasChangesSinceExport,false);
    const type=schemas.createType("default",{key:"Setup",fields:[{key:"frequency",type:"double"}]});
    assert.equal(catalog.get("default").hasChangesSinceExport,true);catalog.markGenerated("default",catalog.token("default"));
    const sameTime=schemas.get("default").updatedAt;
    schemas.createInstance("default",{typeId:type.typeId,value:{frequency:3}});assert.equal(catalog.get("default").hasChangesSinceExport,true);
    schemas.get("default").updatedAt=sameTime;assert.equal(catalog.get("default").hasChangesSinceExport,true,"Same-millisecond typed edits must invalidate the content token");
    const token=catalog.token("default");const snapshot=history.snapshotPath("default");fs.mkdirSync(path.dirname(snapshot),{recursive:true});fs.writeFileSync(snapshot,"BINFILE"+"x".repeat(100));history.commit("default",{current:snapshot,undo:[],redo:[]});
    catalog.markGenerated("default",token);assert.equal(catalog.get("default").hasChangesSinceExport,true,"An older export cannot mark newer geometry as backed up");
    const reopened=new WorkspaceCatalog({dataDir:root,historyStore:history,propertySchemaStore:schemas});assert.equal(reopened.get("default").name,"天线前处理工程");assert.equal(reopened.list().length,1);
    assert.throws(()=>catalog.get("missing"),/不存在/);assert.throws(()=>catalog.rename("default","  "),/工程名称/);
  }finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith("cad-workspaces-"));fs.rmSync(resolved,{recursive:true,force:true});}
});

test("invalid current snapshots are preserved for recovery instead of deleted by automatic repair",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cad-workspaces-"));try{
    const history=new PersistentHistoryStore(root),file=history.snapshotPath("damaged");fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,"BINFILE"+"x".repeat(100));history.commit("damaged",{current:file,undo:[],redo:[]});
    fs.writeFileSync(file,"damaged-but-preserved");const repaired=history.repair("damaged");assert.match(repaired.restoreError,/保留原文件/);assert.equal(fs.readFileSync(file,"utf8"),"damaged-but-preserved");
  }finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith("cad-workspaces-"));fs.rmSync(resolved,{recursive:true,force:true});}
});

test("corrupt history manifests stay visible as unavailable instead of being silently replaced by an empty project",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cad-workspaces-"));try{
    const directory=path.join(root,"history","broken");fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,"manifest.json"),"{broken");
    const history=new PersistentHistoryStore(root,{onWarning:()=>{}}),schemas=new PropertySchemaStore(root),catalog=new WorkspaceCatalog({dataDir:root,historyStore:history,propertySchemaStore:schemas});
    assert.match(history.get("broken").restoreError,/清单无效/);assert.equal(catalog.get("broken").recoverable,false);assert.ok(catalog.list().some(item=>item.documentId==="broken"));assert.equal(fs.readFileSync(path.join(directory,"manifest.json"),"utf8"),"{broken");
  }finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith("cad-workspaces-"));fs.rmSync(resolved,{recursive:true,force:true});}
});

test("search covers older workspaces beyond the initial 200 displayed entries",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cad-workspaces-"));try{
    const history=new PersistentHistoryStore(root),schemas=new PropertySchemaStore(root),catalog=new WorkspaceCatalog({dataDir:root,historyStore:history,propertySchemaStore:schemas});
    for(let index=0;index<210;index++)catalog.records.set(`project-${index}`,{version:1,documentId:`project-${index}`,name:index===0 ? "最早工程" : `工作区 ${index}`,createdAt:new Date(index*1000).toISOString(),updatedAt:new Date(index*1000).toISOString(),lastGeneratedToken:null,lastGeneratedAt:null});
    assert.equal(catalog.list().length,200);assert.ok(!catalog.list().some(item=>item.documentId==="project-0"));assert.equal(catalog.list("最早工程")[0].documentId,"project-0");
  }finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith("cad-workspaces-"));fs.rmSync(resolved,{recursive:true,force:true});}
});

test('a damaged legacy property record makes only its own project unavailable, not the entire project catalog',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-workspaces-'));
  try{
    const history=new PersistentHistoryStore(root),schemas=new PropertySchemaStore(root),catalog=new WorkspaceCatalog({dataDir:root,historyStore:history,propertySchemaStore:schemas});
    for(const id of ['good','damaged']){const current=history.snapshotPath(id);fs.writeFileSync(current,'BINFILE'+'x'.repeat(100));history.commit(id,{current,undo:[],redo:[]});schemas.createType(id,{key:'Setup'});catalog.record(id);}
    fs.writeFileSync(schemas.filePath('damaged'),'{ corrupt');const reloadedSchemas=new PropertySchemaStore(root),reloaded=new WorkspaceCatalog({dataDir:root,historyStore:history,propertySchemaStore:reloadedSchemas}),items=reloaded.list();
    assert.equal(items.length,2);assert.equal(items.find(item=>item.documentId==='good').recoverable,true);assert.equal(items.find(item=>item.documentId==='damaged').recoverable,false);assert.equal(items.find(item=>item.documentId==='damaged').token,null);assert.match(items.find(item=>item.documentId==='damaged').recoveryError,/属性数据损坏/);
  }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});

test('a removed workspace stays out of recovery after catalog reload',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-workspaces-'));
  try{
    const historyStore=new PersistentHistoryStore(root),propertySchemaStore=new PropertySchemaStore(root);
    const options={dataDir:root,historyStore,propertySchemaStore};
    const catalog=new WorkspaceCatalog(options);
    const snapshot=historyStore.snapshotPath('removed');
    fs.writeFileSync(snapshot,'BINFILE'+'x'.repeat(100));
    historyStore.commit('removed',{current:snapshot,undo:[],redo:[]});
    const previous=catalog.get('removed');
    const current=catalog.rename('removed','Workspace to remove');
    assert.throws(()=>catalog.remove('removed',previous),{code:'WORKSPACE_DELETE_CHANGED'});
    catalog.remove('removed',current);
    const reopened=new WorkspaceCatalog(options);
    assert.equal(reopened.known('removed'),false);
    assert.equal(reopened.list('removed').length,0);
    assert.ok(fs.existsSync(snapshot));
    assert.equal(reopened.known('default'),true);
  }finally{
    const resolved=path.resolve(root);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved),/^cad-workspaces-/);
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
