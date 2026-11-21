import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectMeshTaskStore} from '../app/model/project-mesh-task-store.ts';
import {MESH_QUERY_TIMEOUTS} from '../shared/mesh-query-timeouts.mjs';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const job=(jobId,state='complete',documentId='one')=>({jobId,state,documentId,revision:1,visible:false,selection:{kind:'all'},createdAt:new Date().toISOString()});
const result=id=>({ok:true,meshJob:{...job(id),visible:true,requestedVisible:true},mesh:{dimension:3,nodeCount:4,elementCount:1}});
test('mesh setup and strategy selection live in the workspace owner, are detached and do not submit jobs',async t=>{let posts=0;const store=new ProjectMeshTaskStore({documentId:'one',apiRoot:'/api',fetchImpl:async(_url,init)=>{if(init?.method==='POST')posts++;return json({ok:true,jobs:[]});}});store.start();t.after(store.stop);await store.refresh();const row={strategyId:'mesh-strategy-00000000-0000-4000-8000-000000000001',name:'Fine',revision:1,createdAt:'2026-11-17T00:00:00Z',updatedAt:'2026-11-17T00:00:00Z',definitionHash:'f'.repeat(64),state:'current',staleRuleIds:[],options:{repairMode:'strict',qualityThreshold:.4,sizing:{version:1,globalSize:2,rules:[]}}};store.loadStrategy(row,{});row.options.sizing.globalSize=99;assert.equal(store.getSnapshot().setupRepairMode,'strict');assert.equal(store.getSnapshot().setupQualityThreshold,'0.4');assert.equal(store.getSnapshot().sizingDraft.globalSize,'2');store.setSetupQualityThreshold('0.25');const unsubscribe=store.subscribe(()=>{});unsubscribe();await store.refresh();assert.equal(store.getSnapshot().setupQualityThreshold,'0.25');assert.equal(store.getSnapshot().selectedStrategy.options.sizing.globalSize,2);store.setSelectedStrategy(null);assert.equal(store.getSnapshot().sizingDraft.globalSize,'2');assert.equal(posts,0);});
function fixture(t,fetchImpl){const seen=[],store=new ProjectMeshTaskStore({documentId:'one',apiRoot:'http://fixture/api',fetchImpl,pollMs:60000});store.setOnResult(value=>seen.push(value));store.start();t.after(store.stop);return{store,seen};}
test('workspace task owner retains a detached sizing draft across control-panel subscriptions without network writes or cross-document adoption',async t=>{let posts=0;const f=fixture(t,async(_url,options)=>{if(options.method==='POST')posts++;return json({ok:true,jobs:[]});});await f.store.refresh();const draft={documentId:'one',enabled:true,globalSize:'2',rules:[]};f.store.setSizingDraft(draft);draft.globalSize='999';const unsubscribe=f.store.subscribe(()=>{});unsubscribe();await f.store.refresh();assert.equal(f.store.getSnapshot().sizingDraft.globalSize,'2');assert.throws(()=>f.store.setSizingDraft({...draft,documentId:'two'}),/不属于/);assert.equal(posts,0);f.store.stop();f.store.setSizingDraft(draft);assert.equal(f.store.getSnapshot().sizingDraft.globalSize,'2');});

test('an asynchronously failed followed job surfaces its reason without hiding the prior artifact or resubmitting',async t=>{
  let latest=null,posts=0;const f=fixture(t,async(url,options)=>{if(options.method==='POST'){posts++;latest=job('new-job','running');return json({ok:true,meshJob:latest});}if(url.includes('/documents/'))return json({ok:true,jobs:[...(latest?[latest]:[]),job('history')]});return json(result('history'));});
  await f.store.refresh();assert.equal(f.store.getSnapshot().selectedJobId,'history');await f.store.create({baseRevision:1,repairMode:'strict',qualityThreshold:.2});latest={...latest,state:'failed',error:'局部尺寸目标已变化，请重选。'};await f.store.refresh();assert.match(f.store.getSnapshot().error,/局部尺寸目标已变化/);assert.equal(f.store.getSnapshot().selectedJobId,'history');assert.equal(posts,1);await f.store.refresh();assert.match(f.store.getSnapshot().error,/局部尺寸目标已变化/);assert.equal(posts,1);
});

test('complete artifact reads outlive the short control budget and remain cancellable at the shared heavy deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let signal,reply;
  const f=fixture(t,async(url,options)=>url.includes('/documents/')?json({ok:true,jobs:[]}):new Promise((resolve,reject)=>{signal=options.signal;reply=resolve;signal.addEventListener('abort',()=>reject(Error('fixture abort')),{once:true});}));
  try{await f.store.refresh();const first=f.store.select('slow');t.mock.timers.tick(MESH_QUERY_TIMEOUTS.controlMs+1);assert.equal(signal.aborted,false);reply(json(result('slow')));await first;assert.equal(f.store.getSnapshot().selectedJobId,'slow');
    const timed=f.store.select('expired');t.mock.timers.tick(MESH_QUERY_TIMEOUTS.browserMs+1);await timed;assert.equal(signal.aborted,true);assert.match(f.store.getSnapshot().error,/超时/);assert.equal(f.store.getSnapshot().selectedJobId,'slow');
  }finally{f.store.stop();t.mock.timers.reset();}
});

test('lightweight task-list reads retain the short deadline instead of hanging behind the heavy budget',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let signal;
  const f=fixture(t,async(_url,options)=>new Promise((_resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(Error('fixture abort')),{once:true});}));
  try{t.mock.timers.tick(MESH_QUERY_TIMEOUTS.controlMs-1);assert.equal(signal.aborted,false);t.mock.timers.tick(2);await f.store.refresh();assert.equal(signal.aborted,true);assert.match(f.store.getSnapshot().error,/超时/);}
  finally{f.store.stop();t.mock.timers.reset();}
});

test('task snapshots are stable until an update and restored mesh visibility is always off',async t=>{
  const f=fixture(t,async url=>url.endsWith('/mesh/jobs')?json({ok:true,jobs:[job('mesh')]}):json(result('mesh')));
  await f.store.refresh();assert.equal(f.seen.length,1);assert.equal(f.seen[0].meshJob.requestedVisible,false);assert.equal(f.seen[0].meshJob.visible,false);
  assert.equal(f.store.getSnapshot().selectedJobId,'mesh');assert.equal(f.store.getSnapshot(),f.store.getSnapshot());assert.equal(f.store.getSnapshot().busy,false);assert.equal(f.store.getSnapshot().loading,false);
});
test('older manual selection failures cannot replace a newer selected artifact or its error state',async t=>{
  const old=deferred();const f=fixture(t,async url=>url.endsWith('/mesh/jobs')?json({ok:true,jobs:[]}):url.endsWith('/old')?old.promise:json(result('new')));await f.store.refresh();
  const selecting=f.store.select('old');await f.store.select('new');assert.equal(f.store.getSnapshot().busy,true);
  old.resolve(json({ok:false,error:'obsolete failure',meshJob:job('old','failed')},500));await selecting;
  assert.equal(f.store.getSnapshot().selectedJobId,'new');assert.equal(f.store.getSnapshot().error,'');assert.equal(f.store.getSnapshot().busy,false);assert.deepEqual(f.seen.map(item=>item.meshJob.jobId),['new']);
});
test('manual selection wins over automatic initial restore already in flight',async t=>{
  const automatic=deferred();const f=fixture(t,async url=>url.endsWith('/mesh/jobs')?json({ok:true,jobs:[job('automatic')]}):url.endsWith('/automatic')?automatic.promise:json(result('manual')));
  await new Promise(resolve=>setTimeout(resolve,0));await f.store.select('manual');automatic.resolve(json(result('automatic')));await f.store.refresh();
  assert.equal(f.store.getSnapshot().selectedJobId,'manual');assert.deepEqual(f.seen.map(item=>item.meshJob.jobId),['manual']);
});
test('manual history choice survives polling when another job completes',async t=>{
  let latest=job('background','running');const f=fixture(t,async url=>url.endsWith('/mesh/jobs')?json({ok:true,jobs:[latest,job('history')]}):json(result('history')));await f.store.refresh();
  await f.store.select('history');latest=job('background');await f.store.refresh();assert.equal(f.store.getSnapshot().selectedJobId,'history');assert.equal(f.seen.some(item=>item.meshJob.jobId==='background'),false);
});
test('stopping and restarting one owner invalidates late responses and old busy accounting',async t=>{
  const old=deferred();let gets=0;const f=fixture(t,async()=>++gets===1?old.promise:json({ok:true,jobs:[]}));const previous=f.store.refresh();f.store.stop();f.store.start();await f.store.refresh();
  old.resolve(json({ok:true,jobs:[job('late')]}));await previous;assert.equal(f.store.getSnapshot().jobs.length,0);assert.equal(f.store.getSnapshot().loading,false);assert.equal(f.store.getSnapshot().busy,false);assert.equal(f.seen.length,0);
});
test('a stopped workspace never dispatches a stale create, cancel or select callback',async t=>{
  let count=0;const f=fixture(t,async()=>{count++;return json({ok:true,jobs:[]});});await f.store.refresh();f.store.stop();const before=count;
  await f.store.create({baseRevision:1,repairMode:'none',qualityThreshold:.2});await f.store.cancel('job');await f.store.select('job');await f.store.refresh();assert.equal(count,before);
});
test('foreign or mismatched job identities never enter the current workspace or its viewport',async t=>{
  let payload={ok:true,jobs:[job('foreign','complete','two')]};const f=fixture(t,async()=>json(payload));await f.store.refresh();assert.equal(f.store.getSnapshot().jobs.length,0);assert.match(f.store.getSnapshot().error,/当前工程/);
  for(const meshJob of [job('foreign','complete','two'),job('wrong')]){payload={...result('wanted'),meshJob};await f.store.select('wanted');assert.equal(f.store.getSnapshot().selectedJobId,null);}
  assert.equal(f.seen.length,0);
});
test('an older list cannot erase an accepted create; the same refresh reconciles a new list',async t=>{
  const first=deferred();let lists=0;const calls=[];const f=fixture(t,async(url,init)=>{calls.push({url,init});if(init.method==='POST')return json({ok:true,meshJob:job('new','queued')});return ++lists===1?first.promise:json({ok:true,jobs:[job('new','running')]});});
  const creating=f.store.create({baseRevision:9,repairMode:'conservative',qualityThreshold:.2});await new Promise(resolve=>setTimeout(resolve,0));first.resolve(json({ok:true,jobs:[]}));await creating;
  assert.equal(lists,2);assert.equal(f.store.getSnapshot().active.jobId,'new');assert.equal(f.store.getSnapshot().busy,false);const body=JSON.parse(calls.find(item=>item.init.method==='POST').init.body);assert.equal(body.background,true);assert.equal(body.selection,null);assert.equal(body.baseRevision,9);
});
test('accepted create during an automatic artifact load cannot lose its follow identity',async t=>{
  const old=deferred();let lists=0;const f=fixture(t,async(url,init)=>{
    if(init.method==='POST')return json({ok:true,meshJob:job('created','queued')});if(url.endsWith('/mesh/jobs'))return json({ok:true,jobs:++lists===1?[job('old')]:[job('created')]});if(url.endsWith('/old'))return old.promise;return json(result('created'));
  });await new Promise(resolve=>setTimeout(resolve,0));const creating=f.store.create({baseRevision:1,repairMode:'none',qualityThreshold:.2});old.resolve(json(result('old')));await creating;
  assert.equal(f.store.getSnapshot().selectedJobId,'created');assert.equal(f.seen.some(item=>item.meshJob.jobId==='old'),false);
});
test('manual selection made after a create was sent keeps precedence over its eventual acceptance',async t=>{
  const create=deferred();let list=[];const f=fixture(t,async(url,init)=>init.method==='POST'?create.promise:url.endsWith('/mesh/jobs')?json({ok:true,jobs:list}):json(result('manual')));await f.store.refresh();
  const pending=f.store.create({baseRevision:1,repairMode:'none',qualityThreshold:.2});await f.store.select('manual');list=[job('created')];create.resolve(json({ok:true,meshJob:job('created')}));await pending;
  assert.equal(f.store.getSnapshot().selectedJobId,'manual');assert.deepEqual(f.seen.map(value=>value.meshJob.jobId),['manual']);
});
test('newest preparation report and independently restored renderable mesh both survive initial recovery',async t=>{
  const report={...job('report'),kind:'preparation',preparationSummary:{reportAvailable:true}},mesh={...job('mesh'),preparationSummary:{reportAvailable:true}};
  const f=fixture(t,async url=>url.endsWith('/mesh/jobs')?json({ok:true,jobs:[report,mesh]}):url.endsWith('/report')?json({ok:true,meshJob:report,preparation:{diagnostics:{name:'newest'},preview:null}}):json({...result('mesh'),preparation:{diagnostics:{name:'older'},preview:null}}));
  await f.store.refresh();assert.equal(f.store.getSnapshot().selectedJobId,'mesh');assert.equal(f.store.getSnapshot().selectedInspectionId,'report');assert.equal(f.store.getSnapshot().inspection.preparation.diagnostics.name,'newest');
});
test('invalid protocol and failed create remain visible and are never automatically resubmitted',async t=>{
  let writes=0;const f=fixture(t,async(_url,init)=>{if(init.method==='POST'){writes++;throw Error('lost response');}return json({jobs:[]});});await f.store.refresh();assert.match(f.store.getSnapshot().error,/协议/);
  await f.store.create({baseRevision:1,repairMode:'none',qualityThreshold:.2});assert.equal(writes,1);assert.equal(f.store.getSnapshot().busy,false);
});

test('a recovered historical artifact cannot clear an uncertain create error',async t=>{
  let recovering=false,writes=0;const f=fixture(t,async(url,init)=>{if(init.method==='POST'){writes++;recovering=true;throw Error('creation reply was lost');}return url.endsWith('/mesh/jobs')?json({ok:true,jobs:recovering?[job('history')]:[]}):json(result('history'));});
  await f.store.refresh();await f.store.create({baseRevision:1,repairMode:'none',qualityThreshold:.2});assert.equal(f.store.getSnapshot().selectedJobId,'history');assert.match(f.store.getSnapshot().error,/回复未确认.*不要重复提交/);assert.match(f.store.getSnapshot().error,/reply was lost/);assert.equal(writes,1);
});
test('a failed viewport handoff is not presented as a loaded artifact',async t=>{
  const f=fixture(t,async url=>url.endsWith('/mesh/jobs')?json({ok:true,jobs:[]}):json(result('mesh')));await f.store.refresh();f.store.setOnResult(()=>{throw Error('viewport rejected result');});await f.store.select('mesh');assert.equal(f.store.getSnapshot().selectedJobId,null);assert.match(f.store.getSnapshot().error,/viewport rejected/);assert.equal(f.store.getSnapshot().busy,false);
});
test('active jobs poll read-only status and stop polling when their terminal artifact is loaded',{timeout:1000},async t=>{
  let reads=0,writes=0;const store=new ProjectMeshTaskStore({documentId:'one',apiRoot:'http://fixture/api',pollMs:2,fetchImpl:async(url,init)=>{if(init.method==='POST')writes++;if(url.endsWith('/mesh/jobs'))return json({ok:true,jobs:[job('poll',++reads===1?'running':'complete')]});return json(result('poll'));}});t.after(store.stop);
  const finished=new Promise(resolve=>{const unsubscribe=store.subscribe(()=>{if(store.getSnapshot().selectedJobId==='poll'&&!store.getSnapshot().busy){unsubscribe();resolve();}});});store.start();await finished;assert.equal(reads,2);assert.equal(writes,0);assert.equal(store.getSnapshot().active,undefined);
});

test('lost cancellation replies keep active state until a read-only terminal record reconciles them',async t=>{
  const cancelling=deferred();let state='running',writes=0;
  const f=fixture(t,async(_url,init)=>{if(init.method==='POST'){writes++;return cancelling.promise;}return json({ok:true,jobs:[job('cancel',state)]});});await f.store.refresh();const pending=f.store.cancel('cancel');assert.equal(f.store.getSnapshot().cancelling,true);assert.equal(f.store.getSnapshot().busy,true);
  cancelling.reject(Error('lost cancel reply'));await pending;assert.equal(f.store.getSnapshot().active.state,'running');assert.equal(f.store.getSnapshot().cancelling,false);assert.equal(f.store.getSnapshot().busy,false);assert.match(f.store.getSnapshot().error,/取消回复未确认/);assert.equal(writes,1);
  state='cancelled';await f.store.refresh();assert.equal(f.store.getSnapshot().active,undefined);assert.equal(f.store.getSnapshot().error,'');assert.equal(writes,1);
});
