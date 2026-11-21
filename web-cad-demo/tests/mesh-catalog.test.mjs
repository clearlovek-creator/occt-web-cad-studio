import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
import {scanMeshCatalog,meshCatalogLimits,MESH_CATALOG_LIMITS} from '../gateway/mesh-catalog.mjs';
import {MeshArtifactPool} from '../gateway/mesh-artifact-pool.mjs';
import {ProjectMeshService,isProjectMeshRoute} from '../gateway/project-mesh-service.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-catalog-')),store=new MeshJobStore(root);
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-mesh-catalog-/);fs.rmSync(root,{recursive:true,force:true});});
  let sequence=0;
  function add(extra={}){const job={jobId:'mesh-00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'),documentId:'test',state:'cancelled',createdAt:'2026-11-17T00:00:00.000Z',...extra};store.save(job);return job;}
  const file=job=>path.join(store.directory(job),'metadata.json');
  return {root,store,add,file};
}
test('catalog recovery preserves every valid project, hides results and records complete scan counters',t=>{
  const f=fixture(t),a=f.add(),b=f.add({documentId:'another'});f.add({state:'deleted'});
  const value=f.store.loadCatalog();assert.equal(value.jobs.length,2);assert.deepEqual(new Set(value.jobs.map(j=>j.jobId)),new Set([a.jobId,b.jobId]));
  assert.ok(value.jobs.every(j=>j.visible===false&&j.recovered===true));assert.equal(value.stats.records,3);assert.equal(value.stats.deleted,1);assert.ok(value.stats.metadataBytes>0);
});
test('a complete catalog interrupts unfinished work without replaying or altering terminal records',t=>{
  const f=fixture(t),active=f.add({state:'queued'}),terminal=f.add(),before=fs.readFileSync(f.file(terminal));
  const result=f.store.loadCatalog();assert.equal(result.jobs.find(j=>j.jobId===active.jobId).state,'interrupted');assert.equal(JSON.parse(fs.readFileSync(f.file(active))).errorCode,'MESH_SERVICE_INTERRUPTED');assert.deepEqual(fs.readFileSync(f.file(terminal)),before);
});
test('a total metadata limit cannot persist partial interruption or return a truncated catalog',t=>{
  const f=fixture(t),a=f.add({state:'queued'}),b=f.add(),before=[a,b].map(j=>fs.readFileSync(f.file(j)));
  assert.throws(()=>f.store.loadCatalog({limits:{maxMetadataBytes:before[0].length}}),{code:'MESH_CATALOG_LIMIT'});
  [a,b].forEach((j,i)=>assert.deepEqual(fs.readFileSync(f.file(j)),before[i]));
});
test('record, task and raw directory entry budgets fail closed, including unknown files',t=>{
  const f=fixture(t);f.add();f.add();fs.writeFileSync(path.join(f.store.root,'unknown-file'),'evidence');
  for(const limits of [{maxRecordBytes:10},{maxJobs:1},{maxEntries:1}])assert.throws(()=>f.store.loadCatalog({limits}),{code:'MESH_CATALOG_LIMIT'});
  assert.equal(fs.readFileSync(path.join(f.store.root,'unknown-file'),'utf8'),'evidence');
});
test('elapsed scan budget is measured across parsing and validation rather than just directory reads',t=>{
  const f=fixture(t);f.add();let tick=0;
  assert.throws(()=>f.store.loadCatalog({limits:{maxScanMs:1},clock:()=>++tick}),{code:'MESH_CATALOG_LIMIT'});
});
test('duplicate job identities across projects never silently overwrite another project',t=>{
  const f=fixture(t),a=f.add({state:'queued'});f.add({jobId:a.jobId,documentId:'another'});const before=fs.readFileSync(f.file(a));
  assert.throws(()=>f.store.loadCatalog(),{code:'MESH_CATALOG_ID_CONFLICT'});assert.deepEqual(fs.readFileSync(f.file(a)),before);
});
test('invalid UTF-8 and malformed JSON remain visible under their actual project without rewriting evidence',t=>{
  const f=fixture(t),a=f.add(),b=f.add({documentId:'other'});fs.writeFileSync(f.file(a),Buffer.from([0xff,0xfe]));fs.writeFileSync(f.file(b),'not json');
  const value=f.store.loadCatalog();assert.equal(value.stats.corrupt,2);assert.ok(value.jobs.every(j=>j.errorCode==='MESH_METADATA_CORRUPT'));assert.deepEqual(fs.readFileSync(f.file(a)),Buffer.from([0xff,0xfe]));assert.equal(fs.readFileSync(f.file(b),'utf8'),'not json');
});
test('hard-linked metadata is retained as untrusted instead of being rewritten through its alias',t=>{
  const f=fixture(t),job=f.add({state:'queued'}),alias=path.join(f.root,'retained-copy');fs.linkSync(f.file(job),alias);const before=fs.readFileSync(alias);
  const result=f.store.loadCatalog();assert.equal(result.jobs[0].errorCode,'MESH_METADATA_CORRUPT');assert.deepEqual(fs.readFileSync(alias),before);
});
test('linked project directories are never traversed',t=>{
  const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.store.root,'linked'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.store.loadCatalog(),{code:'MESH_CATALOG_UNSAFE'});assert.deepEqual(fs.readdirSync(outside),[]);
});
test('replacing a job directory during record reading invalidates the entire scan',t=>{
  const f=fixture(t),job=f.add(),directory=f.store.directory(job);let moved=false;
  assert.throws(()=>scanMeshCatalog({root:f.store.root,readRecord:(file,_max,onBytes)=>{const bytes=fs.readFileSync(file);onBytes(bytes.length);const value=JSON.parse(bytes);if(!moved){moved=true;fs.renameSync(directory,path.join(path.dirname(directory),'retained-original'));fs.mkdirSync(directory);}return value;},validateRecord:()=>{}}),{code:'MESH_CATALOG_UNSAFE'});
});
test('the metadata budget charges the actual opened bytes before parsing, not an earlier file size',t=>{
  const f=fixture(t),job=f.add(),file=f.file(job),before=fs.readFileSync(file);
  assert.throws(()=>scanMeshCatalog({root:f.store.root,limits:{maxMetadataBytes:before.length},readRecord:(name,_max,onBytes)=>{fs.appendFileSync(name,' '.repeat(100));const bytes=fs.readFileSync(name);onBytes(bytes.length);return JSON.parse(bytes);},validateRecord:()=>{throw Error('Over-budget material must not reach validation');}}),{code:'MESH_CATALOG_LIMIT'});
  assert.equal(fs.readFileSync(file).length,before.length+100);
});
test('catalog policy only permits bounded positive known options, including prototype-name keys',()=>{
  assert.deepEqual(meshCatalogLimits(),MESH_CATALOG_LIMITS);
  for(const value of [{maxJobs:0},{maxJobs:10001},{maxScanMs:NaN},{unknown:1},{toString:1},null,[]])assert.throws(()=>meshCatalogLimits(value),{code:'MESH_CATALOG_CONFIG_INVALID'});
});
test('online recovery actually loads in a worker rather than invoking the main-thread Store loader',async t=>{
  const f=fixture(t),a=f.add(),b=f.add({documentId:'another'}),original=MeshJobStore.prototype.loadCatalog;
  MeshJobStore.prototype.loadCatalog=()=>{throw Error('Main-thread loading is forbidden in this test');};
  const service=new ProjectMeshService({dataDir:f.root,command:async()=>({ok:true}),serializeDocument:async(_id,action)=>action()});
  try{assert.equal(service.catalogStatus().state,'recovering');assert.equal(service.catalogStatus().stored,null);await service.ready;assert.equal(service.catalogStatus().state,'ready');assert.deepEqual(new Set(service.jobs.keys()),new Set([a.jobId,b.jobId]));}
  finally{MeshJobStore.prototype.loadCatalog=original;await service.close();}
});
test('catalog failure blocks listing, creation and file-tool fallback without any CAD call or deletion',async t=>{
  const f=fixture(t),job=f.add(),before=fs.readFileSync(f.file(job));let calls=0;
  const service=new ProjectMeshService({dataDir:f.root,catalogLimits:{maxMetadataBytes:1},command:async()=>{calls++;},serializeDocument:async(_id,action)=>action()});
  try{await service.ready;assert.equal(service.catalogStatus().state,'unavailable');assert.equal(service.catalogStatus().stored,null);
    for(const response of [await service.handle('GET','/api/documents/test/mesh/jobs'),await service.create('test',{}),await service.outputAccess('unknown.msh')]){assert.equal(response.status,503);assert.equal(response.payload.code,'MESH_CATALOG_LIMIT');assert.equal(response.payload.jobs,undefined);}
    assert.equal(calls,0);assert.deepEqual(fs.readFileSync(f.file(job)),before);
  }finally{await service.close();}
});
test('a catalog reply is not published before actual worker exit and new work cannot use an empty interim map',async t=>{
  const f=fixture(t),workers=[],pool=new MeshArtifactPool({dataDir:f.root,workerFactory:(_url,options)=>{const worker=new EventEmitter();worker.options=options;worker.terminate=async()=>1;workers.push(worker);return worker;}});let calls=0;
  const service=new ProjectMeshService({dataDir:f.root,artifactPool:pool,command:async()=>{calls++;return {ok:true,bodyCount:0};},serializeDocument:async(_id,action)=>action()});
  try{let ended=false;const creating=service.create('test',{}).then(result=>{ended=true;return result;});
    workers[0].emit('message',{id:workers[0].options.workerData.id,ok:true,value:{jobs:[],stats:{records:0}},replyBytes:20});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(ended,false);assert.equal(calls,0);assert.equal(service.catalogStatus().stored,null);
    workers[0].emit('exit',0);await creating;assert.equal(service.catalogStatus().state,'ready');assert.equal(calls,1);
  }finally{await service.close();}
});
test('shutdown waits for the exact catalog worker exit and never publishes its late reply',async t=>{
  const f=fixture(t),workers=[],pool=new MeshArtifactPool({dataDir:f.root,workerFactory:(_url,options)=>{const worker=new EventEmitter();worker.options=options;worker.terminate=async()=>{worker.terminated=true;return 1;};workers.push(worker);return worker;}});
  const service=new ProjectMeshService({dataDir:f.root,artifactPool:pool});let stopped=false;
  const closing=service.close().then(()=>stopped=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);assert.equal(workers[0].terminated,true);
  workers[0].emit('message',{id:workers[0].options.workerData.id,ok:true,value:{jobs:[{jobId:'late'}],stats:{records:1}}});workers[0].emit('exit',0);await closing;
  assert.equal(stopped,true);assert.equal(service.jobs.size,0);assert.equal(service.catalogStatus().state,'stopped');
});

function controlledRecovery(t){
  const f=fixture(t),workers=[],pool=new MeshArtifactPool({dataDir:f.root,workerFactory:(_url,options)=>{
    const worker=new EventEmitter();worker.options=options;worker.terminal=false;worker.terminate=async()=>{worker.terminated=true;return 1;};workers.push(worker);return worker;
  }}),service=new ProjectMeshService({dataDir:f.root,artifactPool:pool});
  const finish=(worker,ok=true)=>{worker.emit('message',{id:worker.options.workerData.id,...(ok?{ok:true,value:{jobs:[],stats:{records:0}},replyBytes:20}:{ok:false,code:'MESH_CATALOG_LIMIT',error:'Controlled catalog failure'})});worker.terminal=true;worker.emit('exit',0);};
  t.after(async()=>{for(const worker of workers)if(!worker.terminal){worker.terminal=true;worker.emit('exit',1);}await service.close();});
  return {...f,workers,service,finish};
}
test('catalog status is immediate, versioned and does not wait for an active recovery worker',async t=>{
  const f=controlledRecovery(t),response=await f.service.handle('GET','/api/mesh/catalog');
  assert.equal(response.status,200);assert.equal(response.payload.meshCatalog.version,1);assert.equal(response.payload.meshCatalog.state,'recovering');assert.equal(response.payload.meshCatalog.canRetry,false);assert.equal(response.payload.meshCatalog.stored,null);assert.equal(f.workers.length,1);
  const list=await f.service.handle('GET','/api/documents/test/mesh/jobs');assert.equal(list.status,503);assert.equal(list.payload.code,'MESH_CATALOG_RECOVERING');assert.equal(list.payload.jobs,undefined);
  assert.equal(isProjectMeshRoute('GET','/api/mesh/catalog'),true);assert.equal(isProjectMeshRoute('POST','/api/mesh/catalog/recover'),true);assert.equal(isProjectMeshRoute('GET','/api/mesh/catalog/recover'),false);
});
test('only an exact failed attempt can start recovery and duplicate accepted requests share that attempt',async t=>{
  const f=controlledRecovery(t);f.finish(f.workers[0],false);await f.service.ready;const failed=f.service.catalogStatus().attemptId;
  const first=await f.service.handle('POST','/api/mesh/catalog/recover',{failedAttemptId:failed});assert.equal(first.status,202);assert.equal(f.workers.length,2);assert.notEqual(first.payload.meshCatalog.attemptId,failed);
  const duplicate=await f.service.handle('POST','/api/mesh/catalog/recover',{failedAttemptId:failed});assert.equal(duplicate.status,202);assert.equal(duplicate.payload.meshCatalog.attemptId,first.payload.meshCatalog.attemptId);assert.equal(f.workers.length,2);
  f.finish(f.workers[1]);await f.service.ready;const late=await f.service.handle('POST','/api/mesh/catalog/recover',{failedAttemptId:failed});assert.equal(late.status,200);assert.equal(late.payload.meshCatalog.state,'ready');assert.equal(f.workers.length,2);
});
test('a delayed retry for an earlier failure cannot launch a third worker after the new attempt also failed',async t=>{
  const f=controlledRecovery(t);f.finish(f.workers[0],false);await f.service.ready;const first=f.service.catalogStatus().attemptId;f.service.retryCatalog({failedAttemptId:first});f.finish(f.workers[1],false);await f.service.ready;
  const current=f.service.catalogStatus().attemptId,stale=f.service.retryCatalog({failedAttemptId:first});assert.equal(stale.status,409);assert.equal(stale.payload.code,'MESH_CATALOG_ATTEMPT_CHANGED');assert.equal(f.workers.length,2);
  assert.equal(f.service.retryCatalog({failedAttemptId:current}).status,202);assert.equal(f.workers.length,3);
});
test('ready history and running modeling jobs are not rescanned by recovery endpoints',async t=>{
  const f=controlledRecovery(t);f.finish(f.workers[0]);await f.service.ready;const active={jobId:'active',state:'running'};f.service.jobs.set('active',active);
  const refused=f.service.retryCatalog({failedAttemptId:f.service.catalogStatus().attemptId});assert.equal(refused.status,409);assert.equal(refused.payload.code,'MESH_CATALOG_NOT_RETRYABLE');assert.equal(f.workers.length,1);assert.equal(f.service.jobs.get('active'),active);f.service.jobs.delete('active');
});
test('recovery input cannot raise budgets, omit identity or reinterpret an unrelated attempt',async t=>{
  const f=controlledRecovery(t);f.finish(f.workers[0],false);await f.service.ready;const attempt=f.service.catalogStatus().attemptId;
  for(const input of [null,[],{}, {failedAttemptId:attempt,maxJobs:20000},{failedAttemptId:4},{failedAttemptId:'bad'}])assert.equal(f.service.retryCatalog(input).status,400);
  assert.equal(f.service.retryCatalog({failedAttemptId:'00000000-0000-0000-0000-000000000000'}).status,409);assert.equal(f.workers.length,1);
});
test('an actual corrected catalog can be recovered without restarting and neither conflicting record is discarded',async t=>{
  const f=fixture(t),a=f.add(),b=f.add({jobId:a.jobId,documentId:'another'}),bytesA=fs.readFileSync(f.file(a)),bytesB=fs.readFileSync(f.file(b));
  const service=new ProjectMeshService({dataDir:f.root});
  try{await service.ready;assert.equal(service.catalogStatus().state,'unavailable');const failed=service.catalogStatus().attemptId;
    const source=f.store.directory(b),target=path.join(f.root,'retained-conflict');assert.ok(source.startsWith(f.root+path.sep)&&target.startsWith(f.root+path.sep));fs.renameSync(source,target);
    const response=await service.handle('POST','/api/mesh/catalog/recover',{failedAttemptId:failed});assert.equal(response.status,202);await service.ready;assert.equal(service.catalogStatus().state,'ready');assert.equal(service.jobs.size,1);assert.deepEqual(fs.readFileSync(f.file(a)),bytesA);assert.deepEqual(fs.readFileSync(path.join(target,'metadata.json')),bytesB);
  }finally{await service.close();}
});
test('noncritical recovered source cleanup failures are counted without invalidating saved mesh records',async t=>{
  const f=fixture(t);f.add();t.mock.method(fs.promises,'rm',async()=>{throw Object.assign(Error('Controlled cleanup failure'),{code:'EACCES'});});
  const service=new ProjectMeshService({dataDir:f.root});try{await service.ready;assert.equal(service.catalogStatus().state,'ready');assert.equal(service.catalogStatus().stats.cleanupFailures,2);assert.equal(service.jobs.size,1);}finally{await service.close();}
});
