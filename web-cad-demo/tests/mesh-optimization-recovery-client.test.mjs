import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectMeshTaskStore} from '../app/model/project-mesh-task-store.ts';
import {OptimizationRecoveryJournal} from '../app/model/mesh-optimization-recovery.ts';
import {parseOptimizationRecoveryRequest,parseOptimizationRecoveryInfo,parseOptimizationAttempt} from '../shared/mesh-optimization-recovery.mjs';
const ID='00000000-0000-4000-8000-000000000001',ORIGIN='mesh-'+ID,ATTEMPT='mesh-00000000-0000-4000-8000-000000000002',TOKEN='a'.repeat(64),CP='b'.repeat(64),KEY='webcad.mesh-optimization-recovery.v1:one';
const request=()=>({requestId:ID,failedStateToken:TOKEN,checkpointToken:CP});
const info=()=>({version:1,state:'available',failedStateToken:TOKEN,checkpointToken:CP,canStart:true,automaticReplay:false,newAttempt:true});
const base=()=>({jobId:ORIGIN,documentId:'one',kind:'discrete-tetra',state:'failed',error:'Optimizer stopped',revision:1,visible:false,selection:{kind:'all'},createdAt:'2026-11-20T00:00:00Z',freshness:{status:'current'},derivation:{version:1,state:'available',sourceToken:null,canStart:false,defaultVisible:false},optimizationRecovery:info()});
const attempt=input=>({...base(),jobId:ATTEMPT,state:'running',error:undefined,optimizationRecovery:undefined,optimizationAttempt:{version:1,...input,originKind:'native',originHandle:ORIGIN,originJobId:ORIGIN,originDocumentId:'one',checkpointJobId:ORIGIN,originRecordSha256:'c'.repeat(64)}});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
const list=jobs=>json({ok:true,jobs,meshCatalog:{version:1,state:'ready',attemptId:ID,stored:jobs.length,canRetry:false}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function memory(){const data=new Map();return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};}
function saved(storage,input=request()){storage.setItem(KEY,JSON.stringify({version:1,documentId:'one',requests:[{originJobId:ORIGIN,...input}]}));}
function fixture(t,fetchImpl,storage=memory()){const store=new ProjectMeshTaskStore({documentId:'one',apiRoot:'/api',fetchImpl,recoveryStorage:storage,pollMs:100000});t.after(store.stop);store.start();return store;}

test('optimization wire contracts reject coercion, extra fields and replay claims',()=>{
  assert.deepEqual(parseOptimizationRecoveryRequest(request()),request());assert.deepEqual(parseOptimizationRecoveryInfo(info()),info());assert.deepEqual(parseOptimizationAttempt(attempt(request()).optimizationAttempt),attempt(request()).optimizationAttempt);
  for(const value of [{...request(),checkpointToken:Array(64).fill('b')},{...request(),requestId:{toString:()=>ID}},{...request(),algorithm:'netgen'},{...request(),failedStateToken:['a'.repeat(64)]}])assert.throws(()=>parseOptimizationRecoveryRequest(value));
  assert.throws(()=>parseOptimizationRecoveryInfo({...info(),automaticReplay:true}));assert.throws(()=>parseOptimizationRecoveryInfo({...info(),canStart:'true'}));assert.throws(()=>parseOptimizationAttempt({...attempt(request()).optimizationAttempt,originDocumentId:['one']}));
});
test('journal retains unresolved identity and refuses corruption, wrong scope or replacement',()=>{
  const storage=memory(),journal=new OptimizationRecoveryJournal('one',storage);journal.save({[ORIGIN]:{...request(),state:'submitting'}});assert.equal(journal.read()[ORIGIN].state,'uncertain');const before=storage.getItem(KEY);assert.throws(()=>journal.save({[ORIGIN]:{...request(),checkpointToken:'d'.repeat(64),state:'submitting'}}));assert.equal(storage.getItem(KEY),before);
  journal.save({[ORIGIN]:{...request(),state:'accepted',attemptJobId:ATTEMPT}});assert.equal(storage.getItem(KEY),null);
  for(const raw of ['{invalid',JSON.stringify({version:1,documentId:'two',requests:[]}),JSON.stringify({version:1,documentId:'one',requests:[{originJobId:ORIGIN,...request(),path:'x'}]})]){storage.setItem(KEY,raw);assert.throws(()=>journal.read());assert.throws(()=>journal.save({}));assert.equal(storage.getItem(KEY),raw);}
});
test('explicit recovery posts once, retains origin and selects a new hidden attempt without derivation',async t=>{
  const storage=memory();let jobs=[base()],posts=0;const results=[];
  const store=fixture(t,async(url,init)=>{if(init.method==='POST'){posts++;assert.equal(url,'/api/mesh/jobs/'+ORIGIN+'/resume-optimization');const input=parseOptimizationRecoveryRequest(JSON.parse(init.body));assert.deepEqual(new OptimizationRecoveryJournal('one',storage).read()[ORIGIN].requestId,input.requestId);const next=attempt(input);jobs=[next,...jobs];return json({ok:true,meshJob:next},202);}return list(jobs);},storage);store.setOnResult(value=>results.push(value));
  await store.refresh();store.setSetupQualityThreshold('0.35');await store.resumeOptimization(ORIGIN);assert.equal(posts,1);assert.equal(store.getSnapshot().selectedTetraId,ATTEMPT);assert.equal(store.getSnapshot().jobs.find(row=>row.jobId===ORIGIN).state,'failed');assert.equal(store.getSnapshot().optimizationActions[ORIGIN].state,'accepted');assert.equal(storage.getItem(KEY),null);assert.equal(store.getSnapshot().setupQualityThreshold,'0.35');assert.equal(store.getSnapshot().selectedJobId,null);assert.deepEqual(results,[]);
});
test('duplicate recovery clicks share a single pending registration',async t=>{
  let posts=0,release,jobs=[base()];const hold=new Promise(resolve=>release=resolve),store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;await hold;const next=attempt(JSON.parse(init.body));jobs=[next,...jobs];return json({ok:true,meshJob:next},202);}return list(jobs);});await store.refresh();const a=store.resumeOptimization(ORIGIN),b=store.resumeOptimization(ORIGIN);await tick();assert.equal(posts,1);release();await Promise.all([a,b]);assert.equal(posts,1);
});
test('an older completed raw result cannot steal selection from a newly accepted optimization attempt',async t=>{
  const old={...base(),jobId:'mesh-00000000-0000-4000-8000-000000000009',state:'complete',error:undefined,optimizationRecovery:undefined};let jobs=[base(),old];const store=fixture(t,async(url,init)=>{if(init.method==='POST'){const next=attempt(JSON.parse(init.body));jobs=[next,...jobs];return json({ok:true,meshJob:next},202);}if(url.endsWith('/mesh/jobs/'+old.jobId))return json({ok:true,meshJob:old});return list(jobs);});await store.refresh();await store.resumeOptimization(ORIGIN);assert.equal(store.getSnapshot().selectedTetraId,ATTEMPT);await store.refresh();assert.equal(store.getSnapshot().selectedTetraId,ATTEMPT);assert.equal(store.getSnapshot().selectedJobId,null);
});
test('lost accepted reply reconciles exact attempt read-only without reposting',async t=>{
  let posts=0,jobs=[base()];const storage=memory(),store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;jobs=[attempt(JSON.parse(init.body)),...jobs];throw Error('Lost reply');}return list(jobs);},storage);await store.refresh();await store.resumeOptimization(ORIGIN);assert.equal(store.getSnapshot().optimizationActions[ORIGIN].state,'accepted');assert.equal(storage.getItem(KEY),null);await store.checkOptimizationRecovery(ORIGIN);assert.equal(posts,1);
});
test('list absence never proves a lost recovery was not executed, including after restart',async t=>{
  let posts=0;const storage=memory(),fetchImpl=async(_url,init)=>{if(init.method==='POST'){posts++;throw Error('Lost reply before visible registration');}return list([base()]);},store=fixture(t,fetchImpl,storage);await store.refresh();await store.resumeOptimization(ORIGIN);const first=store.getSnapshot().optimizationActions[ORIGIN].requestId;assert.equal(store.getSnapshot().optimizationActions[ORIGIN].state,'uncertain');await store.resumeOptimization(ORIGIN);assert.equal(posts,1);store.stop();const restored=fixture(t,fetchImpl,storage);await restored.refresh();assert.equal(restored.getSnapshot().optimizationActions[ORIGIN].requestId,first);await restored.resumeOptimization(ORIGIN);assert.equal(posts,1);assert.equal(restored.getSnapshot().optimizationActions[ORIGIN].state,'uncertain');
});
test('unreadable task list preserves pending recovery identity and old verified history',async t=>{
  let offline=false,posts=0;const store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;offline=true;throw Error('Lost reply');}if(offline)throw Error('offline');return list([base()]);});await store.refresh();await store.resumeOptimization(ORIGIN);assert.equal(store.getSnapshot().historyKnown,false);assert.equal(store.getSnapshot().jobs.length,1);await store.resumeOptimization(ORIGIN);assert.equal(posts,1);assert.equal(store.getSnapshot().optimizationActions[ORIGIN].state,'uncertain');
});
test('late replies cannot overwrite a restarted workspace or clear its pending journal',async t=>{
  let release,posts=0;const hold=new Promise(resolve=>release=resolve),storage=memory(),store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;const input=JSON.parse(init.body);await hold;return json({ok:true,meshJob:attempt(input)},202);}return list([base()]);},storage);await store.refresh();const pending=store.resumeOptimization(ORIGIN);await tick();store.stop();store.start();await store.refresh();release();await pending;assert.equal(posts,1);assert.equal(store.getSnapshot().selectedTetraId,null);assert.equal(store.getSnapshot().optimizationActions[ORIGIN].state,'uncertain');assert.ok(storage.getItem(KEY));
});
test('a known negative response permits a later explicit action but never auto-retries',async t=>{
  let posts=0;const storage=memory(),store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;return json({ok:false,code:'MESH_TASK_CAPACITY',error:'容量不足'},409);}return list([base()]);},storage);await store.refresh();await store.resumeOptimization(ORIGIN);assert.equal(posts,1);assert.equal(store.getSnapshot().optimizationActions[ORIGIN].state,'failed');assert.equal(storage.getItem(KEY),null);await store.refresh();assert.equal(posts,1);await store.resumeOptimization(ORIGIN);assert.equal(posts,2);
});
test('wrong-document or mismatched registration replies are not adopted',async t=>{
  let posts=0;const store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;return json({ok:true,meshJob:{...attempt(JSON.parse(init.body)),documentId:'two'}},202);}return list([base()]);});await store.refresh();await store.resumeOptimization(ORIGIN);assert.equal(store.getSnapshot().optimizationActions[ORIGIN].state,'uncertain');assert.equal(store.getSnapshot().jobs.length,1);await store.resumeOptimization(ORIGIN);assert.equal(posts,1);
});
test('mismatched or duplicated attempt identities retain the last verified list and pending journal',async t=>{
  let jobs=[base()];const storage=memory();saved(storage);const store=fixture(t,async()=>list(jobs),storage);await store.refresh();for(const bad of [[{...attempt(request()),optimizationAttempt:{...attempt(request()).optimizationAttempt,checkpointToken:'d'.repeat(64)}},base()],[attempt(request()),{...attempt(request()),jobId:'mesh-00000000-0000-4000-8000-000000000003'},base()]]){jobs=bad;await store.refresh();assert.equal(store.getSnapshot().historyKnown,false);assert.equal(store.getSnapshot().jobs.length,1);assert.equal(store.getSnapshot().optimizationActions[ORIGIN].state,'uncertain');assert.ok(storage.getItem(KEY));}
});
test('storage denial prevents a POST and preserves pre-existing identity',async t=>{
  let posts=0;const storage=memory();storage.setItem=()=>{throw Error('storage denied');};const store=fixture(t,async(_url,init)=>{if(init.method==='POST')posts++;return list([base()]);},storage);await store.refresh();await store.resumeOptimization(ORIGIN);assert.equal(posts,0);assert.match(store.getSnapshot().optimizationJournalError,/保存/);assert.equal(store.getSnapshot().optimizationActions[ORIGIN],undefined);
});
test('a different pending identity discovered before POST is retained and checked, never replaced',async t=>{
  let posts=0;const storage=memory(),store=fixture(t,async(_url,init)=>{if(init.method==='POST')posts++;return list([base()]);},storage);await store.refresh();saved(storage);const before=storage.getItem(KEY);await store.resumeOptimization(ORIGIN);assert.equal(posts,0);assert.equal(storage.getItem(KEY),before);assert.equal(store.getSnapshot().optimizationActions[ORIGIN].requestId,ID);await store.checkOptimizationRecovery(ORIGIN);assert.equal(store.getSnapshot().optimizationJournalError,'');assert.equal(store.getSnapshot().optimizationActions[ORIGIN].state,'uncertain');assert.equal(posts,0);
});
test('accepted attempt remains known when local journal cleanup fails',async t=>{
  let jobs=[base()],posts=0;const storage=memory();storage.removeItem=()=>{throw Error('cleanup denied');};const store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;const next=attempt(JSON.parse(init.body));jobs=[next,...jobs];return json({ok:true,meshJob:next},202);}return list(jobs);},storage);await store.refresh();await store.resumeOptimization(ORIGIN);assert.equal(store.getSnapshot().optimizationActions[ORIGIN].state,'accepted');assert.ok(store.getSnapshot().optimizationJournalError);await store.resumeOptimization(ORIGIN);assert.equal(posts,1);assert.ok(storage.getItem(KEY));
});
test('stale source and active task cannot start another recovery',async t=>{
  let posts=0,jobs=[{...base(),freshness:{status:'stale'}}];const store=fixture(t,async(_url,init)=>{if(init.method==='POST')posts++;return list(jobs);});await store.refresh();await store.resumeOptimization(ORIGIN);jobs=[attempt(request()),base()];await store.refresh();await store.resumeOptimization(ORIGIN);assert.equal(posts,0);
});
