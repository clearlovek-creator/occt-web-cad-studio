import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectMeshTaskStore} from '../app/model/project-mesh-task-store.ts';
import {parseMeshCatalog,meshCatalogReason} from '../app/model/mesh-catalog.ts';
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const status=(state='unavailable',attemptId=A)=>({version:1,state,attemptId,canRetry:state==='unavailable',stored:state==='ready'?0:null,...(state==='unavailable'?{code:'MESH_CATALOG_ID_CONFLICT'}:{})});
const json=(value,http=200)=>new Response(JSON.stringify(value),{status:http});
const failure=catalog=>json({ok:false,code:catalog.code||'MESH_CATALOG_RECOVERING',error:'历史尚未就绪',meshCatalog:catalog},503);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,fetchImpl){const store=new ProjectMeshTaskStore({documentId:'one',apiRoot:'/api',fetchImpl,catalogPollMs:1});t.after(store.stop);store.start();return store;}
test('catalog protocol rejects unsupported versions, false capacity and invalid recovery identities',()=>{
  assert.equal(parseMeshCatalog(status()).canRetry,true);
  for(const value of [null,[],{...status(),version:2},{...status(),attemptId:'bad'},{...status(),stored:0},{...status('ready'),stored:null},{...status('ready'),canRetry:true},{...status(),code:undefined}])assert.throws(()=>parseMeshCatalog(value));
  assert.match(meshCatalogReason('MESH_CATALOG_ID_CONFLICT'),/不会自动选择或覆盖/);assert.match(meshCatalogReason('MESH_CATALOG_LIMIT'),/不会放宽额度/);
});
test('a failed catalog stays unavailable without reporting empty success or automatically posting a retry',async t=>{
  let posts=0;const store=fixture(t,async(_url,init)=>{if(init.method==='POST')posts++;return failure(status());});await store.refresh();assert.equal(store.getSnapshot().catalog.state,'unavailable');assert.equal(store.getSnapshot().catalog.stored,null);assert.equal(store.getSnapshot().loading,false);await tick();assert.equal(posts,0);
});
test('startup recovery is observed read-only and its eventual ready list has known capacity',async t=>{
  let ready=false,posts=0;const store=fixture(t,async(url,init)=>{if(init.method==='POST')posts++;if(url.endsWith('/mesh/catalog')){ready=true;return json({ok:true,meshCatalog:status('ready')});}return ready?json({ok:true,jobs:[],meshCatalog:status('ready')}):failure(status('recovering'));});
  await store.refresh();assert.equal(store.getSnapshot().catalog.state,'ready');assert.equal(store.getSnapshot().catalog.stored,0);assert.equal(posts,0);
});
test('manual recovery posts the exact failed identity once and preserves setup without creating geometry',async t=>{
  const catalog={...status('ready',B),stored:1},job={jobId:'retained',documentId:'one',state:'cancelled',revision:1,visible:false,selection:{kind:'all'},createdAt:'2026-11-17T00:00:00Z'};
  let ready=false,posts=0;const store=fixture(t,async(url,init)=>{
    if(init.method==='POST'){posts++;assert.equal(url,'/api/mesh/catalog/recover');assert.deepEqual(JSON.parse(init.body),{failedAttemptId:A});ready=true;return json({ok:true,meshCatalog:catalog});}
    return ready?json({ok:true,jobs:[job],meshCatalog:catalog}):failure(status());
  });await store.refresh();store.subscribe(()=>{if(store.getSnapshot().historyKnown)assert.equal(store.getSnapshot().jobs.length,1,'Known list and rows must publish atomically');});store.setSetupQualityThreshold('0.35');await store.recoverCatalog();assert.equal(posts,1);assert.equal(store.getSnapshot().catalog.attemptId,B);assert.equal(store.getSnapshot().setupQualityThreshold,'0.35');assert.equal(store.getSnapshot().catalogRecoveryPending,false);assert.equal(store.getSnapshot().busy,false);
});
test('duplicate user actions share the same in-flight recovery request',async t=>{
  let posts=0,release;const gate=new Promise(resolve=>release=resolve);let ready=false;
  const store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posts++;await gate;ready=true;return json({ok:true,meshCatalog:status('ready',B)});}return ready?json({ok:true,jobs:[],meshCatalog:status('ready',B)}):failure(status());});
  await store.refresh();const a=store.recoverCatalog(),b=store.recoverCatalog();await tick();assert.equal(posts,1);release();await Promise.all([a,b]);assert.equal(posts,1);
});
test('a lost accepted recovery reply triggers only read-only status reconciliation',async t=>{
  let ready=false,posts=0,checks=0;const store=fixture(t,async(url,init)=>{
    if(init.method==='POST'){posts++;ready=true;throw Error('Accepted reply lost');}if(url.endsWith('/mesh/catalog')){checks++;return json({ok:true,meshCatalog:status('ready',B)});}return ready?json({ok:true,jobs:[],meshCatalog:status('ready',B)}):failure(status());
  });await store.refresh();await store.recoverCatalog();assert.equal(posts,1);assert.equal(checks,1);assert.equal(store.getSnapshot().catalog.state,'ready');assert.equal(store.getSnapshot().catalogUncertain,false);
});
test('an unconfirmed retry remains check-only until a later manual status read succeeds',async t=>{
  let posted=false,network=false,posts=0;const store=fixture(t,async(url,init)=>{
    if(init.method==='POST'){posts++;posted=true;throw Error('Lost reply');}if(url.endsWith('/mesh/catalog')){if(!network)throw Error('Status unreachable');return json({ok:true,meshCatalog:status('ready',B)});}return posted&&network?json({ok:true,jobs:[],meshCatalog:status('ready',B)}):failure(status());
  });await store.refresh();await store.recoverCatalog();assert.equal(store.getSnapshot().catalogUncertain,true);network=true;await store.recoverCatalog();assert.equal(posts,1);assert.equal(store.getSnapshot().catalog.state,'ready');assert.equal(store.getSnapshot().catalogUncertain,false);assert.equal(store.getSnapshot().error,'');
});
test('a later failed attempt requires another explicit action rather than automatic reposting',async t=>{
  let posts=0,attempt=A;const store=fixture(t,async(url,init)=>{if(init.method==='POST'){posts++;attempt=B;return failure(status('unavailable',B));}if(url.endsWith('/mesh/catalog'))return json({ok:true,meshCatalog:status('unavailable',attempt)});return failure(status('unavailable',attempt));});
  await store.refresh();await store.recoverCatalog();assert.equal(posts,1);assert.equal(store.getSnapshot().catalog.attemptId,B);assert.equal(store.getSnapshot().catalog.state,'unavailable');await tick();assert.equal(posts,1);
});
test('stopped or ready workspace callbacks never post recovery commands',async t=>{
  let posts=0;const store=fixture(t,async(_url,init)=>{if(init.method==='POST')posts++;return json({ok:true,jobs:[]});});await store.refresh();await store.recoverCatalog();store.stop();await store.recoverCatalog();assert.equal(posts,0);
});
test('a late recovery reply from an earlier workspace generation cannot replace current state',async t=>{
  let posted=false,release;const gate=new Promise(resolve=>release=resolve);const store=fixture(t,async(_url,init)=>{if(init.method==='POST'){posted=true;return gate;}return failure(status());});await store.refresh();const pending=store.recoverCatalog();await tick();assert.equal(posted,true);store.stop();store.start();await store.refresh();release(json({ok:true,meshCatalog:status('ready',B)}));await pending;assert.equal(store.getSnapshot().catalog.attemptId,A);assert.equal(store.getSnapshot().catalog.state,'unavailable');assert.equal(store.getSnapshot().busy,false);
});
test('stopping from a recovery observer aborts its wait and dispatches no late status requests',async t=>{
  let reads=0,store;store=new ProjectMeshTaskStore({documentId:'one',apiRoot:'/api',catalogPollMs:1,fetchImpl:async()=>{reads++;return failure(status('recovering'));}});t.after(store.stop);store.subscribe(()=>{if(store.getSnapshot().catalog.state==='recovering')store.stop();});store.start();await store.refresh();await tick();assert.equal(reads,1);
});
test('backend recovery success followed by list failure never claims a known empty history or successful reload',async t=>{
  let ready=false,network=false,posts=0;const store=fixture(t,async(url,init)=>{
    if(init.method==='POST'){posts++;ready=true;return json({ok:true,meshCatalog:status('ready',B)});}
    if(url.endsWith('/mesh/catalog'))return json({ok:true,meshCatalog:status('ready',B)});
    if(ready&&!network)throw Error('List response lost after recovery');
    return ready?json({ok:true,jobs:[],meshCatalog:status('ready',B)}):failure(status());
  });await store.refresh();await store.recoverCatalog();assert.equal(store.getSnapshot().catalogRecovered,false);assert.equal(store.getSnapshot().historyKnown,false);assert.equal(store.getSnapshot().catalogUncertain,true);
  network=true;await store.recoverCatalog();assert.equal(posts,1);assert.equal(store.getSnapshot().historyKnown,true);assert.equal(store.getSnapshot().catalogRecovered,true);
});
