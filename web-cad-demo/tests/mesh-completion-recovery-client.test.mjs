import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectMeshTaskStore} from '../app/model/project-mesh-task-store.ts';
import {parseMeshRecoveryRequest,parseMeshRecoveryInfo} from '../shared/mesh-completion-recovery.mjs';
const TOKEN='a'.repeat(64),ID='00000000-0000-4000-8000-000000000001';
const base=()=>({jobId:'retained',documentId:'one',state:'failed',errorCode:'MESH_COMPLETION_UNCOMMITTED',error:'Original result retained',revision:1,visible:false,selection:{kind:'all'},createdAt:'2026-11-17T00:00:00Z',completionRecovery:{version:1,state:'available',failedStateToken:TOKEN}});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
const list=jobs=>json({ok:true,jobs,meshCatalog:{version:1,state:'ready',attemptId:ID,stored:jobs.length,canRetry:false}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,fetchImpl){const store=new ProjectMeshTaskStore({documentId:'one',apiRoot:'/api',fetchImpl,pollMs:100000});t.after(store.stop);store.start();return store;}
test('recovery protocol is bounded and rejects unsupported or identity-free states',()=>{
  assert.deepEqual(parseMeshRecoveryRequest({requestId:ID,failedStateToken:TOKEN}),{requestId:ID,failedStateToken:TOKEN});
  for(const value of [{},{requestId:ID,failedStateToken:TOKEN,operation:'mesh.create'},Object.assign(Object.create({requestId:ID,failedStateToken:TOKEN}),{a:1,b:2})])assert.throws(()=>parseMeshRecoveryRequest(value));
  for(const value of [{...base().completionRecovery,version:2},{...base().completionRecovery,state:'checking'},{...base().completionRecovery,error:'x'.repeat(301)}])assert.throws(()=>parseMeshRecoveryInfo(value));
});
test('manual recovery sends one bound request, preserves settings and never creates a new mesh',async t=>{
  let job=base(),posts=0;const store=fixture(t,async(url,init)=>{if(init.method==='POST'){posts++;assert.equal(url,'/api/mesh/jobs/retained/recover-completion');const input=parseMeshRecoveryRequest(JSON.parse(init.body));job={...job,completionRecovery:{version:1,state:'checking',...input}};return json({ok:true,meshJob:job},202);}return list([job]);});
  await store.refresh();assert.equal(posts,0);store.setSetupQualityThreshold('0.35');await store.recoverCompletion('retained');assert.equal(posts,1);assert.equal(store.getSnapshot().jobs[0].completionRecovery.state,'checking');assert.equal(store.getSnapshot().setupQualityThreshold,'0.35');assert.equal(store.getSnapshot().busy,false);
});
test('duplicate clicks share a single accepted recovery request',async t=>{
  let job=base(),posts=0,release;const hold=new Promise(resolve=>release=resolve),store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;const input=JSON.parse(init.body);await hold;job={...job,completionRecovery:{version:1,state:'checking',...input}};return json({ok:true,meshJob:job},202);}return list([job]);});await store.refresh();const a=store.recoverCompletion('retained'),b=store.recoverCompletion('retained');await tick();assert.equal(posts,1);release();await Promise.all([a,b]);assert.equal(posts,1);
});
test('a lost accepted reply is reconciled read-only instead of reposting',async t=>{
  let job=base(),posts=0,reads=0;const store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;job={...job,completionRecovery:{version:1,state:'checking',...JSON.parse(init.body)}};throw Error('Lost accepted reply');}reads++;return list([job]);});await store.refresh();await store.recoverCompletion('retained');assert.equal(posts,1);assert.ok(reads>=2);assert.equal(store.getSnapshot().jobs[0].completionRecovery.state,'checking');assert.equal(store.getSnapshot().completionActions.retained,undefined);
});
test('an unreadable lost reply allows only status checks until the actual list is observed',async t=>{
  let posts=0,unreadable=false;const store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;unreadable=true;throw Error('Lost reply');}if(unreadable)throw Error('Failed to fetch');return list([base()]);});await store.refresh();await store.recoverCompletion('retained');assert.equal(store.getSnapshot().completionActions.retained.state,'uncertain');assert.equal(store.getSnapshot().historyKnown,false);assert.doesNotMatch(store.getSnapshot().error,/Failed to fetch/);await store.recoverCompletion('retained');assert.equal(posts,1);unreadable=false;await store.checkCompletionRecovery('retained');assert.equal(posts,1);assert.equal(store.getSnapshot().completionActions.retained.state,'failed');
});
test('late replies from a stopped owner cannot overwrite the restarted workspace state',async t=>{
  let posts=0,release;const hold=new Promise(resolve=>release=resolve),store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;const input=JSON.parse(init.body);await hold;return json({ok:true,meshJob:{...base(),completionRecovery:{version:1,state:'checking',...input}}},202);}return list([base()]);});await store.refresh();const pending=store.recoverCompletion('retained');await tick();store.stop();store.start();await store.refresh();release();await pending;assert.equal(posts,1);assert.equal(store.getSnapshot().jobs[0].completionRecovery.state,'available');assert.deepEqual(store.getSnapshot().completionActions,{});
});
test('malformed recovery identities do not replace the last verified list',async t=>{
  let malformed=false;const store=fixture(t,async()=>list([{...base(),completionRecovery:malformed?{...base().completionRecovery,version:9}:base().completionRecovery}]));await store.refresh();const before=store.getSnapshot().jobs;malformed=true;await store.refresh();assert.deepEqual(store.getSnapshot().jobs,before);assert.match(store.getSnapshot().error,/恢复/);
});
test('a verified recovered task clears only its own old failed-result message',async t=>{
  let job={...base(),preparationSummary:{reportAvailable:true,status:'ready',bodyCount:1,errorCount:0,warningCount:0,solidCount:1,faceCount:6}};
  const store=fixture(t,async(url,init)=>{if(init.method==='POST'){job={...job,state:'complete',error:undefined,errorCode:undefined,completionRecovery:{version:1,state:'complete',...JSON.parse(init.body)}};return json({ok:true,meshJob:job});}if(url.endsWith('/mesh/jobs/retained'))return json({ok:true,meshJob:job,mesh:{dimension:3,nodeCount:4,elementCount:1},preparation:{diagnostics:{},preview:null}});return list([job]);});await store.refresh();assert.equal(store.getSnapshot().error,'Original result retained');await store.recoverCompletion('retained');assert.equal(store.getSnapshot().jobs[0].state,'complete');assert.equal(store.getSnapshot().error,'');
});
