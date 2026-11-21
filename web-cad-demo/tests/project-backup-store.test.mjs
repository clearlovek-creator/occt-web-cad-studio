import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {ProjectBackupStore} from '../gateway/project-backup-store.mjs';
import {normalizeProjectSaveInput,projectSaveCanonical} from '../shared/project-save-input.mjs';
const input=()=>({protocolVersion:1,operation:'project.save',documentId:'default',requestId:randomUUID(),baseRevision:12,baseStateToken:'a'.repeat(64),baseStateSequence:5});
const checkpoint={revision:12,stateToken:'a'.repeat(64),stateSequence:5,workspaceToken:'b'.repeat(64)};
function fixture(options={}){const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-project-backup-')),store=new ProjectBackupStore(data,{maxFileBytes:1024*1024,maxTotalBytes:4*1024*1024,...options});return {data,store,clean(){assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-project-backup-/);fs.rmSync(data,{recursive:true,force:true});}};}
async function publish(f,bytes=Buffer.from('original exact engineering backup')){const taskId=randomUUID(),lease=f.store.reserve(taskId),request=input();try{return {taskId,request,result:await f.store.publish(lease,request,bytes,checkpoint,{name:'工业工程'})};}finally{f.store.release(lease);}}
async function bytesFrom(download){try{const chunks=[];for await(const chunk of download.chunks())chunks.push(chunk);return Buffer.concat(chunks);}finally{download.close();}}

test('save input is normalized deterministically and rejects paths, caller task IDs and malformed baseline stamps',()=>{
 const valid=input();assert.deepEqual(normalizeProjectSaveInput(valid),valid);assert.equal(projectSaveCanonical({...valid,baseRevision:12}),projectSaveCanonical(valid));for(const bad of [{...valid,path:'secret'},{...valid,taskId:randomUUID()},{...valid,operation:'primitive.box'},{...valid,baseRevision:NaN},{...valid,baseStateSequence:-1},{...valid,baseStateToken:'x'},{...valid,requestId:'unsafe\n'}])assert.throws(()=>normalizeProjectSaveInput(bad));
});
test('published receipt and exact bytes survive a restart and repeated downloads without creating another artifact',async()=>{
 const f=fixture();try{const bytes=Buffer.alloc(200000,71),saved=await publish(f,bytes);assert.equal(saved.result.projectBackup.fileName,'工业工程.cadproj');assert.equal(saved.result.projectBackup.sha256,createHash('sha256').update(bytes).digest('hex'));const restarted=new ProjectBackupStore(f.data,{maxFileBytes:1024*1024,maxTotalBytes:4*1024*1024});assert.deepEqual(restarted.read(saved.taskId,'default').result,saved.result);for(let i=0;i<2;i++)assert.deepEqual(await bytesFrom(await restarted.openDownload(saved.taskId,'default')),bytes);assert.equal(restarted.status().entries,1);assert.equal(restarted.status().downloads,0);assert.throws(()=>restarted.reserve(saved.taskId),{code:'PROJECT_BACKUP_EXISTS'});assert.throws(()=>restarted.read(saved.taskId,'other'),{code:'PROJECT_BACKUP_NOT_FOUND'});}finally{f.clean();}
});
test('admission reserves the complete artifact budget, retains interrupted materials and never automatically deletes unknown entries',async()=>{
 const f=fixture({maxTotalBytes:1100000,maxEntries:1});try{const id=randomUUID(),lease=f.store.reserve(id);assert.throws(()=>f.store.reserve(randomUUID()),{code:'PROJECT_BACKUP_CAPACITY'});fs.writeFileSync(path.join(lease.directory,'backup.cadproj'),'partial');f.store.release(lease);const again=new ProjectBackupStore(f.data,{maxFileBytes:1024*1024,maxTotalBytes:1100000,maxEntries:1});assert.equal(again.status().entries,1);assert.equal(again.read(id),null);assert.throws(()=>again.reserve(randomUUID()),{code:'PROJECT_BACKUP_CAPACITY'});fs.mkdirSync(path.join(again.root,'unknown'));assert.equal(again.status().available,false);assert.throws(()=>again.reserve(randomUUID()),{code:'PROJECT_BACKUP_STORE_UNAVAILABLE'});assert.equal(fs.readFileSync(path.join(lease.directory,'backup.cadproj'),'utf8'),'partial');}finally{f.clean();}
});
test('an unused empty lease is released but a nonempty or replaced private directory is retained',()=>{
 const f=fixture();try{const first=f.store.reserve(randomUUID());f.store.release(first);assert.equal(fs.existsSync(first.directory),false);const second=f.store.reserve(randomUUID());fs.renameSync(second.directory,second.directory+'.preserved');fs.mkdirSync(second.directory);assert.throws(()=>f.store.release(second),{code:'PROJECT_BACKUP_CHANGED'});assert.equal(fs.existsSync(second.directory),true);assert.equal(fs.existsSync(second.directory+'.preserved'),true);}finally{f.clean();}
});
test('same-length payload changes are rejected before download without returning a newly generated replacement',async()=>{
 const f=fixture();try{const saved=await publish(f,Buffer.alloc(200000,4)),file=path.join(f.store.directory(saved.taskId),'backup.cadproj');fs.writeFileSync(file,Buffer.alloc(200000,5));await assert.rejects(f.store.openDownload(saved.taskId,'default'),{code:'PROJECT_BACKUP_CHANGED'});assert.equal(f.store.status().entries,1);assert.deepEqual(f.store.read(saved.taskId).result,saved.result);assert.equal(f.store.status().downloads,0);}finally{f.clean();}
});
test('late payload changes withhold the last chunk so a corrupt stream cannot complete its declared byte count',async()=>{
 const f=fixture();try{const saved=await publish(f,Buffer.alloc(300000,4)),download=await f.store.openDownload(saved.taskId,'default'),iterator=download.chunks(),first=await iterator.next();assert.equal(first.done,false);fs.writeFileSync(path.join(f.store.directory(saved.taskId),'backup.cadproj'),Buffer.alloc(300000,5));let received=first.value.length;await assert.rejects(async()=>{for(;;){const row=await iterator.next();if(row.done)break;received+=row.value.length;}},{code:'PROJECT_BACKUP_CHANGED'});assert.ok(received<300000);assert.equal(f.store.status().downloads,0);}finally{f.clean();}
});
test('download ownership blocks deletion until the stream closes; explicit deletion touches neither task records nor geometry',async()=>{
 const f=fixture();try{const saved=await publish(f),download=await f.store.openDownload(saved.taskId,'default');await assert.rejects(f.store.remove(saved.taskId,'default'),{code:'PROJECT_BACKUP_BUSY'});download.close();assert.equal(f.store.status().downloads,0);assert.deepEqual(await f.store.remove(saved.taskId,'default'),{deleted:true,taskId:saved.taskId,documentId:'default'});assert.equal(f.store.read(saved.taskId),null);await assert.rejects(f.store.openDownload(saved.taskId,'default'),{code:'PROJECT_BACKUP_NOT_FOUND'});assert.deepEqual(fs.readdirSync(f.data),['project-backups']);}finally{f.clean();}
});
test('invalid or tampered receipts never become durable task outcomes and remain available for diagnosis',async()=>{
 const f=fixture();try{const saved=await publish(f),file=path.join(f.store.directory(saved.taskId),'receipt.json'),value=JSON.parse(fs.readFileSync(file,'utf8'));value.result.revision++;fs.writeFileSync(file,JSON.stringify(value));assert.throws(()=>f.store.read(saved.taskId),{code:'PROJECT_BACKUP_RECEIPT_INVALID'});assert.ok(fs.existsSync(file));assert.ok(fs.existsSync(path.join(f.store.directory(saved.taskId),'backup.cadproj')));}finally{f.clean();}
});
test('publication failure preserves the pending original bytes but cannot return a successful receipt after restart',async()=>{
 const f=fixture(),rename=fs.renameSync;try{const taskId=randomUUID(),lease=f.store.reserve(taskId),bytes=Buffer.alloc(200000,8);fs.renameSync=(source,target)=>{if(source===lease.directory)throw Error('test-only publish fault');return rename(source,target);};try{await assert.rejects(f.store.publish(lease,input(),bytes,checkpoint),/publish fault/);}finally{fs.renameSync=rename;f.store.release(lease);}assert.equal(f.store.read(taskId),null);assert.deepEqual(fs.readFileSync(path.join(lease.directory,'backup.cadproj')),bytes);assert.equal(new ProjectBackupStore(f.data).read(taskId),null);}finally{fs.renameSync=rename;f.clean();}
});
test('shared hard links are not accepted as a backup or silently deleted',async()=>{
 const f=fixture();try{const saved=await publish(f),file=path.join(f.store.directory(saved.taskId),'backup.cadproj');fs.linkSync(file,path.join(f.data,'retained-hard-link'));await assert.rejects(f.store.openDownload(saved.taskId,'default'),{code:'PROJECT_BACKUP_CHANGED'});await assert.rejects(f.store.remove(saved.taskId,'default'),{code:'PROJECT_BACKUP_CHANGED'});assert.equal(fs.existsSync(file),true);}finally{f.clean();}
});
test('simultaneous download handles are bounded and releasing one restores only its own capacity',async()=>{
 const f=fixture({maxDownloads:1});try{const saved=await publish(f),first=await f.store.openDownload(saved.taskId,'default');await assert.rejects(f.store.openDownload(saved.taskId,'default'),{code:'PROJECT_BACKUP_DOWNLOAD_CAPACITY'});assert.equal(f.store.status().downloads,1);first.close();first.close();const next=await f.store.openDownload(saved.taskId,'default');assert.equal(f.store.status().downloads,1);next.close();assert.equal(f.store.status().downloads,0);}finally{f.clean();}
});
