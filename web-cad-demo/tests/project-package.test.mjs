import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {gzipSync} from "node:zlib";
import test from "node:test";
import {encodeProjectPackage,decodeProjectPackage,collectProjectSources} from "../gateway/project-package.mjs";
import {PropertySchemaStore} from "../gateway/property-schema-store.mjs";
import {PersistentHistoryStore} from "../gateway/history-store.mjs";
import {ProjectFileService} from "../gateway/project-file-service.mjs";
const geometry=Buffer.from("BINFILE"+"x".repeat(100));
const schema={schemaVersion:1,types:[],instances:[]};
const encode=(patch={})=>encodeProjectPackage({geometry,propertySchema:schema,sources:[],documentId:"test",revision:1,...patch});
function rewrite(bytes,change) {const decoded=decodeProjectPackage(bytes);const raw={format:"web-cad-project",version:1,geometry:{size:geometry.length,sha256:createHash("sha256").update(geometry).digest("hex"),data:geometry.toString("base64")},propertySchema:decoded.propertySchema,sources:[]};change(raw);const json=Buffer.from(JSON.stringify(raw));return Buffer.concat([Buffer.from("WEBCADPROJECT\n"),createHash("sha256").update(json).digest(),gzipSync(json)]);}
function scratch() {return fs.mkdtempSync(path.join(os.tmpdir(),"cad-project-unit-"));}
function clean(root){const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith("cad-project-unit-"));fs.rmSync(resolved,{recursive:true,force:true});}

test("project package round-trips binary geometry, typed data and sources; legacy XBF stays readable",()=>{
  const bytes=encode({sources:[{featureId:"feature-1",fileName:"source.step",bytes:Buffer.from("ISO-10303-21;")}]});
  const result=decodeProjectPackage(bytes);assert.deepEqual(result.geometry,geometry);assert.deepEqual(result.propertySchema,schema);assert.equal(result.sources[0].featureId,"feature-1");assert.equal(result.sources[0].bytes.toString(),"ISO-10303-21;");assert.equal(decodeProjectPackage(geometry).legacy,true);
});
test("damaged, oversized, unsupported and path-traversal project files are rejected",()=>{
  const bytes=encode();const damaged=Buffer.from(bytes);damaged[15]^=1;assert.throws(()=>decodeProjectPackage(damaged),/完整性校验/);
  assert.throws(()=>decodeProjectPackage(bytes,{maxUnpackedBytes:40}),/无法解压/);
  assert.throws(()=>decodeProjectPackage(rewrite(bytes,value=>value.version=99)),/不支持/);
  assert.throws(()=>decodeProjectPackage(rewrite(bytes,value=>value.sources=[{featureId:"feature-1",fileName:"../secret.step"}])) ,/名称无效/);
  assert.throws(()=>decodeProjectPackage(rewrite(bytes,value=>value.geometry.size=10)),/数据校验/);
});
test("STEP sources must exist inside managed imports/assets, never arbitrary snapshot paths",()=>{
  const root=scratch();try{
    fs.mkdirSync(path.join(root,"imports"));const source=path.join(root,"imports","part.step");fs.writeFileSync(source,"ISO-10303-21;");
    const feature={id:"feature-1",type:"import.step",stringParameters:{sourcePath:source}};
    assert.equal(collectProjectSources([feature],root).length,1);
    assert.throws(()=>collectProjectSources([{...feature,numberParameters:{decompositionVersion:2}}],root),error=>error.code==='PROJECT_SOURCE_PROOF_INVALID');
    assert.throws(()=>collectProjectSources([feature],root,{maxSourceBytes:1}),/总量/);
    const outside=path.join(root,"private.step");fs.writeFileSync(outside,"private");
    assert.throws(()=>collectProjectSources([{...feature,stringParameters:{sourcePath:outside}}],root),/拒绝读取/);
    fs.rmSync(source);assert.throws(()=>collectProjectSources([feature],root),/来源丢失/);
  }finally{clean(root);}
});
test("project property snapshots preserve IDs and values and reject broken references before replacement",()=>{
  const root=scratch();try{
    const store=new PropertySchemaStore(root);const type=store.createType("original",{key:"Setup",fields:[{key:"enabled",type:"bool"}]});
    const instance=store.createInstance("original",{typeId:type.typeId,value:{enabled:true},name:"设置"});
    store.replaceSnapshot("copy",store.list("original"));assert.equal(store.list("copy").instances[0].instanceId,instance.instanceId);
    const broken=store.list("original");broken.instances[0].value.enabled="true";
    assert.throws(()=>store.replaceSnapshot("copy",broken),/boolean/);assert.equal(store.list("copy").instances[0].value.enabled,true);
    broken.instances[0].typeId="missing";assert.throws(()=>store.validateSnapshot(broken),/existing type/);
  }finally{clean(root);}
});
test("an interrupted project open restores both the old history and typed schema on recovery",()=>{
  const root=scratch();try{
    const history=new PersistentHistoryStore(root), props=new PropertySchemaStore(root), id="recovery";
    const first=history.snapshotPath(id);fs.mkdirSync(path.dirname(first),{recursive:true});fs.writeFileSync(first,geometry);history.commit(id,{current:first,undo:[],redo:[]});
    const old=history.get(id), oldSchema=props.list(id);const next=history.snapshotPath(id);fs.writeFileSync(next,geometry);history.commit(id,{current:next,undo:[],redo:[]},{cleanup:false});props.createType(id,{key:"Changed",fields:[]});
    const service=new ProjectFileService({dataDir:root,historyStore:history,propertySchemaStore:props,command:()=>{},onWarning:()=>{}});
    const assetDirectory=fs.mkdtempSync(path.join(service.assets,`${id}-`)), rollbackPath=path.join(service.transactions,`rollback-${id}-test.xbf`);fs.writeFileSync(rollbackPath,geometry);
    fs.writeFileSync(path.join(service.transactions,`${id}.pending.json`),JSON.stringify({version:1,phase:"prepared",documentId:id,assetDirectory,rollbackPath,beforeHistory:old,beforeSchema:oldSchema}));
    service.recover();assert.equal(history.get(id).current,first);assert.equal(props.list(id).types.length,0);assert.equal(fs.existsSync(assetDirectory),false);
    service.recover();assert.equal(history.get(id).current,first);
  }finally{clean(root);}
});

test("a history commit I/O failure rolls geometry and typed properties back together",async()=>{
  const root=scratch();try{
    const history=new PersistentHistoryStore(root),props=new PropertySchemaStore(root),id="rollback";
    props.createType(id,{key:"Original",fields:[]});
    const old=history.snapshotPath(id);fs.mkdirSync(path.dirname(old),{recursive:true});fs.writeFileSync(old,geometry);history.commit(id,{current:old,undo:[],redo:[]});
    const nextGeometry=Buffer.from("BINFILE"+"n".repeat(100));let current=geometry;
    const command=async(operation,{parameters})=>{
      if(operation==="document.snapshot")fs.writeFileSync(parameters.path,current);
      if(operation==="document.restore")current=fs.readFileSync(parameters.path);
      return {ok:true,revision:1,bodyCount:1};
    };
    const commit=history.commit.bind(history);let failed=false;
    history.commit=(doc,next,options)=>{if(next.current!==old && !failed){failed=true;throw new Error("disk commit failed");}return commit(doc,next,options);};
    const service=new ProjectFileService({dataDir:root,historyStore:history,propertySchemaStore:props,command,inspectSources:async()=>({metadataComplete:true,sources:[]})});
    await assert.rejects(service.open(id,encode({geometry:nextGeometry})),/disk commit failed/);
    assert.deepEqual(current,geometry);assert.equal(props.list(id).types[0].key,"Original");assert.equal(history.get(id).current,old);
    assert.equal(fs.readdirSync(service.transactions).some(name=>name.endsWith(".pending.json")),false);
  }finally{clean(root);}
});

test('portable legacy sources remain explicitly uncertified while a new source cannot lose its required proof',async()=>{
  const root=scratch();try{
    const history=new PersistentHistoryStore(root),props=new PropertySchemaStore(root),id='legacy_proof';let restored=0;
    const command=async(operation,{parameters})=>{if(operation==='document.snapshot')fs.writeFileSync(parameters.path,geometry);if(operation==='document.restore')restored++;return {ok:true,revision:1,bodyCount:1,sourceBindingsApplied:1};};
    let version=1;const service=new ProjectFileService({dataDir:root,historyStore:history,propertySchemaStore:props,command,inspectSources:async()=>({metadataComplete:true,sources:[{featureId:'feature-1',decompositionVersion:version}]})});
    const bytes=encode({sources:[{featureId:'feature-1',fileName:'original.step',bytes:Buffer.from('ISO-10303-21;')}]});
    const result=await service.open(id,bytes);assert.ok(result.warnings.some(message=>message.includes('不能认证为原始来源')));assert.equal(restored,1);
    version=2;await assert.rejects(service.open(id,bytes),error=>error.code==='PROJECT_SOURCE_PROOF_INVALID');assert.equal(restored,1,'The missing-proof failure must happen before live restore');
  }finally{clean(root);}
});
