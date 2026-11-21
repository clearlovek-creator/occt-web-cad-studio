import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';
import {normalizeProjectBackupCatalog,normalizeProjectBackupMetadata} from '../shared/project-backup-catalog.mjs';
function clean(data){assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-backup-catalog-api-/);fs.rmSync(data,{recursive:true,force:true});}
async function backup(f){const state=await f.cad('document.summary'),command={protocolVersion:1,operation:'project.save',documentId:'default',requestId:randomUUID(),baseRevision:state.revision,baseStateToken:state.stateToken,baseStateSequence:state.stateSequence};const reserved=await f.post('/documents/default/project/save/tasks',{command});assert.equal(reserved.status,201,JSON.stringify(reserved));const taskId=reserved.value.modelingTask.taskId,saved=await f.post('/documents/default/project/save',{command},{'X-Cad-Task-Id':taskId,'X-Request-Id':command.requestId});assert.equal(saved.status,200,JSON.stringify(saved));return {taskId,result:saved.value};}
test('real HTTP archive survives task cleanup, later modeling and restart; metadata and downloads never invoke native generation',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-backup-catalog-api-'));let f;
 try{
  f=await gatedGeometryGateway(data);await f.cad('primitive.box',{width:10,depth:20,height:30});const saved=await backup(f);const cleanup=await fetch(f.api+'/documents/default/modeling-tasks',{method:'DELETE'});assert.equal(cleanup.status,200);assert.ok((await cleanup.json()).cleanup.deleted>=1);assert.equal((await f.get('/documents/default/modeling-tasks')).tasks.length,0);
  await f.cad('primitive.sphere',{radius:4,x:50});const current=await f.cad('document.summary');assert.equal(await f.stop(),0);f=null;f=await gatedGeometryGateway(data);
  const at=f.events.length,page=normalizeProjectBackupCatalog(await f.get('/documents/default/project/backups?limit=20'),'default');assert.equal(page.total,1);assert.equal(page.entries[0].taskId,saved.taskId);assert.equal(page.entries[0].receipt.revision,saved.result.revision);assert.notEqual(page.entries[0].receipt.revision,current.revision);
  const metadata=normalizeProjectBackupMetadata(await f.get('/documents/default/project/backups/'+saved.taskId),'default',saved.taskId);assert.equal(metadata.state,'available');assert.equal(metadata.integrity,'not-checked');const download=await fetch(new URL(saved.result.projectBackup.downloadPath,f.api)),bytes=Buffer.from(await download.arrayBuffer());assert.equal(download.status,200);assert.equal(createHash('sha256').update(bytes).digest('hex'),saved.result.projectBackup.sha256);assert.equal(f.events.slice(at).some(event=>event.type==='fixture.native-request'),false);
  const foreign=await fetch(f.api+'/documents/foreign/project/backups/'+saved.taskId);assert.equal(foreign.status,404);assert.equal((await f.get('/documents/foreign/project/backups')).entries.length,0);
  const removed=await fetch(f.api+'/documents/default/project/backups/'+saved.taskId,{method:'DELETE'});assert.deepEqual(await removed.json(),{ok:true,deleted:true,taskId:saved.taskId,documentId:'default'});assert.equal((await f.get('/documents/default/project/backups')).total,0);assert.equal((await fetch(f.api+'/documents/default/project/backups/'+saved.taskId)).status,404);const after=await f.cad('document.summary');for(const key of ['revision','stateToken','stateSequence','features','variables','materials','bodyMetadata'])assert.deepEqual(after[key],current[key],key);
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
test('archive HTTP rejects hostile origins, duplicate/unknown pagination, and isolates retained diagnostics without deleting material',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-backup-catalog-api-'));let f;
 try{
  f=await gatedGeometryGateway(data);await f.cad('primitive.box',{width:3,depth:4,height:5});const saved=await backup(f),root=path.join(data,'project-backups');fs.mkdirSync(path.join(root,'private-unknown-material'));fs.mkdirSync(path.join(root,randomUUID()+'.pending'));
  for(const suffix of ['?limit=0','?limit=101','?limit=1&limit=2','?path=secret','?after=bad'])assert.equal((await fetch(f.api+'/documents/default/project/backups'+suffix)).status,400,suffix);
  for(const suffix of ['', '/'+saved.taskId])assert.equal((await fetch(f.api+'/documents/default/project/backups'+suffix,{headers:{Origin:'https://foreign.invalid'}})).status,403);
  let page=await f.get('/documents/default/project/backups');assert.equal(page.entries[0].state,'available');assert.equal(page.storage.unattributedEntries,2);assert.ok(!JSON.stringify(page).includes('private-unknown-material'));assert.ok(!JSON.stringify(page).includes(data));
  const file=path.join(root,saved.taskId,'backup.cadproj');fs.truncateSync(file,1);page=await f.get('/documents/default/project/backups');assert.equal(page.entries[0].state,'unavailable');assert.equal(page.entries[0].canDelete,false);const deletion=await fetch(f.api+'/documents/default/project/backups/'+saved.taskId,{method:'DELETE'});assert.equal(deletion.status,503);assert.ok(fs.existsSync(file));assert.ok(fs.existsSync(path.join(root,'private-unknown-material')));
 }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
