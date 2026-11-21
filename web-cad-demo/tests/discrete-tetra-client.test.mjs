import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {ProjectMeshTaskStore} from '../app/model/project-mesh-task-store.ts';
import {defaultTetraDraft,tetraSettingsFromDraft,parseTetraDerivation,parseTetraSummary} from '../app/model/discrete-tetra.ts';
import {assessMeshDisplaySource} from '../app/model/mesh-display-source.ts';
import {captureMeshMaterialSource,canonicalMeshMaterial} from '../shared/mesh-material-source.mjs';
import {captureCadMeshMaterials} from '../gateway/cad-mesh-materials.mjs';
import {cadDiscreteTetraFixture} from './helpers/cad-discrete-tetra-fixture.mjs';

const token='a'.repeat(64),uuid='12345678-1234-4234-8234-123456789abc';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
const summary=()=>({version:1,basis:'cad-source-bound-partition-tetra-v1',bodyCount:1,faceCount:6,solidCount:1,cellCount:1,tetraCount:6,nodeCount:8,unassignedCellCount:0,quality:{minimumSICN:.4,lowQualityCount:0,meetsRequestedQuality:true},normalMeshAdmitted:false,appliedToCad:false});
const job=(id='tetra',state='complete',derivation={})=>({jobId:id,documentId:'one',revision:1,kind:'discrete-tetra',state,createdAt:'2026-11-18T00:00:00Z',selection:{kind:'all'},freshness:{status:'current',reason:'current',changedBodyIds:[]},visible:false,requestedVisible:false,options:{discreteTetra:tetraSettingsFromDraft(defaultTetraDraft())},discreteTetraSummary:state==='complete'?summary():null,derivation:{version:1,state:'available',sourceToken:token,canStart:state==='complete',defaultVisible:false,...derivation}});
function fixture(t,{jobs=[],handle}={}){
  const f={jobs,seen:[],requests:[],reads:0};
  f.store=new ProjectMeshTaskStore({documentId:'one',apiRoot:'http://private/api',pollMs:60000,fetchImpl:async(url,init)=>{
    const request={url,method:init.method||'GET',body:init.body?JSON.parse(init.body):undefined,signal:init.signal};f.requests.push(request);
    const custom=await handle?.(request,f);if(custom)return custom;
    if(url.includes('/documents/'))return json({ok:true,jobs:f.jobs,discreteTetra:{configured:true,derivation:{supported:true}}});
    f.reads++;const current=f.jobs.find(row=>url.endsWith('/'+row.jobId));
    if(current?.derivation.state==='ready')return json({ok:true,meshJob:{...current,normalMeshAdmitted:true},mesh:{dimension:3,nodeCount:8,elementCount:6},derivedMaterialSource:{version:1,basis:'cad-body-material-snapshot-v1',bodies:[],materials:[]},downloadUrl:'/api/mesh/outputs/'+current.jobId+'.msh'});
    return json({ok:true,meshJob:current});
  }});f.store.setOnResult(value=>f.seen.push(value));f.store.start();t.after(f.store.stop);return f;
}
const posts=f=>f.requests.filter(row=>row.method==='POST');

test('tetra UI draft maps only explicit strict all-geometry settings without CAD strategy, paths or policy relaxation',()=>{
  const value=tetraSettingsFromDraft({...defaultTetraDraft(),optimization:true});assert.equal(value.quality.mode,'strict');assert.equal(value.quality.maxBadFraction,0);assert.equal(value.source.maxTriangles,4096);assert.equal(value.optimization.acceptance,'non-regressing');assert.equal(value.optimization.iterations,3);
  for(const patch of [{meshSize:''},{meshSize:'0'},{meshSize:'Infinity'},{linearDeflection:'-1'},{qualityThreshold:'1.01'},{qualityThreshold:'abc'}])assert.throws(()=>tetraSettingsFromDraft({...defaultTetraDraft(),...patch}));
});
test('tetra optimization choices preserve the explicit method without changing existing task settings',()=>{
  assert.equal(defaultTetraDraft().optimizationMethod,'gmsh');assert.equal(tetraSettingsFromDraft(defaultTetraDraft()).optimization,undefined);
  for(const method of ['gmsh','netgen','relocate']){const draft={...defaultTetraDraft(),optimization:true,optimizationMethod:method},settings=tetraSettingsFromDraft(draft);assert.equal(settings.optimization.method,method);assert.equal(settings.optimization.iterations,3);assert.equal(settings.optimization.acceptance,'non-regressing');draft.optimizationMethod='gmsh';assert.equal(settings.optimization.method,method);}
  for(const method of ['unknown','__proto__','',undefined])assert.throws(()=>tetraSettingsFromDraft({...defaultTetraDraft(),optimization:true,optimizationMethod:method}),/后优化方法/);
});
test('tetra descriptor parsers reject invalid identities, stages and fabricated raw admission',()=>{
  assert.deepEqual(parseTetraDerivation(job().derivation),job().derivation);assert.deepEqual(parseTetraSummary(summary()),summary());
  for(const patch of [{sourceToken:'bad'},{state:'guessed-ready'},{canStart:'yes'},{defaultVisible:true},{requestId:'bad'}])assert.throws(()=>parseTetraDerivation({...job().derivation,...patch}));
  for(const patch of [{normalMeshAdmitted:true},{appliedToCad:true},{tetraCount:0},{quality:{minimumSICN:NaN}}])assert.throws(()=>parseTetraSummary({...summary(),...patch}));
});
test('history reads raw tetra summary with no mesh, no error, no automatic writes and detached workspace setup',async t=>{
  const f=fixture(t,{jobs:[job()]});await f.store.refresh();assert.equal(f.store.getSnapshot().selectedTetraId,'tetra');assert.equal(f.store.getSnapshot().selectedJobId,null);assert.equal(f.store.getSnapshot().error,'');assert.equal(f.store.getSnapshot().setupRoute,'discrete');assert.equal(posts(f).length,0);assert.equal(f.seen.length,0);
  const draft={...defaultTetraDraft(),meshSize:'3'};f.store.setTetraDraft(draft);draft.meshSize='900';assert.equal(f.store.getSnapshot().tetraDraft.meshSize,'3');
});
test('historical authenticated result is adopted hidden without deriving or rewriting files',async t=>{
  const f=fixture(t,{jobs:[job('ready','complete',{state:'unverified',canStart:false})],handle:(request,f)=>{if(request.url.endsWith('/ready')){f.jobs=[job('ready','complete',{state:'ready',canStart:false})];}}});await f.store.refresh();assert.equal(f.seen.length,1);assert.equal(f.seen[0].meshJob.visible,false);assert.equal(f.seen[0].meshJob.requestedVisible,false);assert.equal(posts(f).length,0);assert.equal(f.store.getSnapshot().selectedJobId,'ready');
});
test('one confirmed new tetra create automatically prepares only its own completed original once',async t=>{
  const f=fixture(t,{handle:(request,f)=>{
    if(request.method==='POST'&&request.url.includes('/documents/')){assert.equal(request.body.kind,'discrete-tetra');assert.equal('selection'in request.body,false);assert.equal(request.body.background,true);f.jobs=[job('new','running')];return json({ok:true,meshJob:f.jobs[0]},202);}
    if(request.url.endsWith('/derive')){f.jobs=[job('new','complete',{state:'working',canStart:false,requestId:request.body.requestId})];return json({ok:true,meshJob:f.jobs[0]},202);}
  }});await f.store.refresh();await f.store.create({kind:'discrete-tetra',baseRevision:1,discreteTetra:tetraSettingsFromDraft(defaultTetraDraft())});f.jobs=[job('new')];await f.store.refresh();await turn();await f.store.refresh();await turn();assert.equal(posts(f).length,2);assert.equal(posts(f)[1].body.sourceToken,token);assert.equal(f.store.getSnapshot().active.jobId,'new');
  const requestId=posts(f)[1].body.requestId;f.jobs=[job('new','complete',{state:'ready',canStart:false,requestId})];await f.store.refresh();assert.equal(f.seen.length,1);assert.equal(f.seen[0].meshJob.visible,false);await f.store.refresh();assert.equal(posts(f).length,2);
});
test('a lost create reply never grants automatic derivation authority to a recovered task',async t=>{
  const f=fixture(t,{handle:(request,f)=>{if(request.method==='POST'){f.jobs=[job('unknown')];throw Error('lost');}}});await f.store.refresh();await f.store.create({kind:'discrete-tetra',baseRevision:1,discreteTetra:tetraSettingsFromDraft(defaultTetraDraft())});await turn();await f.store.refresh();assert.equal(posts(f).length,1);assert.match(f.store.getSnapshot().error,/回复未确认/);assert.equal(f.store.getSnapshot().selectedTetraId,'unknown');
});
test('manual history selection revokes pending automatic preparation of a new job',async t=>{
  const f=fixture(t,{jobs:[job('old')],handle:(request,f)=>{if(request.method==='POST'){f.jobs=[job('new','running'),job('old')];return json({ok:true,meshJob:f.jobs[0]},202);}}});await f.store.refresh();await f.store.create({kind:'discrete-tetra',baseRevision:1,discreteTetra:tetraSettingsFromDraft(defaultTetraDraft())});await f.store.select('old');f.jobs=[job('new'),job('old')];await f.store.refresh();await turn();assert.equal(posts(f).length,1);assert.equal(f.store.getSnapshot().selectedTetraId,'old');
});

test('a confirmed new tetra task immediately replaces the old ready detail without adopting a mesh',async t=>{
  const old=job('old','complete',{state:'ready',canStart:false}),f=fixture(t,{jobs:[old],handle:(request,f)=>{if(request.method==='POST'){f.jobs=[job('new','running'),old];return json({ok:true,meshJob:f.jobs[0]},202);}}});
  await f.store.refresh();assert.equal(f.store.getSnapshot().selectedJobId,'old');const seen=f.seen.length;
  await f.store.create({kind:'discrete-tetra',baseRevision:1,discreteTetra:tetraSettingsFromDraft(defaultTetraDraft())});
  assert.equal(f.store.getSnapshot().selectedTetraId,'new');assert.equal(f.store.getSnapshot().selectedJobId,null);assert.equal(f.store.getSnapshot().active.jobId,'new');assert.equal(f.store.getSnapshot().setupRoute,'discrete');assert.equal(f.seen.length,seen);assert.equal(posts(f).length,1);
});

test('failed, cancelled and interrupted new tetra tasks retain their own recovery detail rather than the previous success',async t=>{
  for(const state of ['failed','cancelled','interrupted']){
    const old=job('old','complete',{state:'ready',canStart:false}),f=fixture(t,{jobs:[old],handle:(request,f)=>{if(request.method==='POST'){f.jobs=[job('new','running'),old];return json({ok:true,meshJob:f.jobs[0]},202);}}});
    await f.store.refresh();await f.store.create({kind:'discrete-tetra',baseRevision:1,discreteTetra:tetraSettingsFromDraft(defaultTetraDraft())});
    const recovery={version:1,state:'available',failedStateToken:token,checkpointToken:'b'.repeat(64),canStart:true,automaticReplay:false,newAttempt:true};
    f.jobs=[{...job('new',state),error:'Quality checkpoint retained',optimizationRecovery:recovery},old];await f.store.refresh();await turn();
    const snapshot=f.store.getSnapshot();assert.equal(snapshot.selectedTetraId,'new');assert.equal(snapshot.selectedJobId,null);assert.equal(snapshot.jobs.find(row=>row.jobId===snapshot.selectedTetraId).state,state);assert.deepEqual(snapshot.jobs[0].optimizationRecovery,recovery);assert.equal(snapshot.active,undefined);assert.equal(posts(f).length,1);assert.equal(f.seen.length,1);f.store.stop();
  }
});

test('a late tetra acceptance cannot replace an explicit history selection made while its reply was pending',async t=>{
  let release;const held=new Promise(resolve=>release=resolve),old=job('old'),f=fixture(t,{jobs:[old],handle:async(request,f)=>{if(request.method==='POST'){await held;f.jobs=[job('new','running'),old];return json({ok:true,meshJob:f.jobs[0]},202);}}});
  await f.store.refresh();const pending=f.store.create({kind:'discrete-tetra',baseRevision:1,discreteTetra:tetraSettingsFromDraft(defaultTetraDraft())});await turn();await f.store.select('old');release();await pending;
  assert.equal(f.store.getSnapshot().selectedTetraId,'old');f.jobs=[job('new'),old];await f.store.refresh();await turn();assert.equal(f.store.getSnapshot().selectedTetraId,'old');assert.equal(posts(f).length,1);
});
test('stale materials revoke preparation even when raw geometry and state are complete',async t=>{
  const stale={...job(),freshness:{status:'stale',reason:'materials changed',changedBodyIds:[]}},f=fixture(t,{jobs:[stale]});await f.store.refresh();await f.store.prepareTetra('tetra');assert.equal(posts(f).length,0);
});
test('explicit historical preparation uses a unique closed request and duplicate calls share one operation',async t=>{
  let release;const held=new Promise(resolve=>release=resolve);const f=fixture(t,{jobs:[job()],handle:async(request,f)=>{if(request.url.endsWith('/derive')){await held;f.jobs=[job('tetra','complete',{state:'working',canStart:false,requestId:request.body.requestId})];return json({ok:true,meshJob:f.jobs[0]},202);}}});await f.store.refresh();const first=f.store.prepareTetra('tetra'),second=f.store.prepareTetra('tetra');assert.equal(first,second);await turn();assert.equal(posts(f).length,1);assert.deepEqual(Object.keys(posts(f)[0].body).sort(),['requestId','sourceToken']);release();await first;assert.equal(f.store.getSnapshot().active.derivation.state,'working');
});
test('lost derivation response remains uncertain when list is unreadable and checks never repost',async t=>{
  let offline=false;const f=fixture(t,{jobs:[job()],handle:(request)=>{if(request.url.endsWith('/derive')){offline=true;throw Error('lost');}if(offline)throw Error('offline');}});await f.store.refresh();await f.store.prepareTetra('tetra');assert.equal(f.store.getSnapshot().tetraActions.tetra.state,'uncertain');await f.store.prepareTetra('tetra');await f.store.checkTetra('tetra');assert.equal(posts(f).length,1);assert.equal(f.store.getSnapshot().historyKnown,false);
});
test('a matching read-only working or ready record reconciles a lost response without replay',async t=>{
  const f=fixture(t,{jobs:[job()],handle:(request,f)=>{if(request.url.endsWith('/derive')){f.jobs=[job('tetra','complete',{state:'working',canStart:false,requestId:request.body.requestId})];throw Error('lost');}}});await f.store.refresh();await f.store.prepareTetra('tetra');assert.equal(f.store.getSnapshot().tetraActions.tetra,undefined);assert.equal(f.store.getSnapshot().active.jobId,'tetra');f.jobs=[job('tetra','complete',{state:'ready',canStart:false})];await f.store.refresh();assert.equal(f.seen.length,1);assert.equal(posts(f).length,1);
});
test('mismatched derivation identity cannot authorize a ready result from an unrelated job',async t=>{
  const f=fixture(t,{jobs:[job()],handle:request=>request.url.endsWith('/derive')?json({ok:true,meshJob:job('foreign','complete',{state:'working',requestId:uuid})},202):undefined});await f.store.refresh();await f.store.prepareTetra('tetra');assert.equal(f.store.getSnapshot().tetraActions.tetra.state,'uncertain');assert.equal(f.seen.length,0);assert.equal(posts(f).length,1);
});
test('confirmed preparation errors preserve the original and allow only explicit retry',async t=>{
  const f=fixture(t,{jobs:[job()],handle:request=>request.url.endsWith('/derive')?json({ok:false,error:'磁盘额度不足'},409):undefined});await f.store.refresh();await f.store.prepareTetra('tetra');assert.equal(f.store.getSnapshot().tetraActions.tetra.state,'failed');assert.equal(f.store.getSnapshot().jobs[0].state,'complete');await f.store.refresh();assert.equal(posts(f).length,1);await f.store.prepareTetra('tetra');assert.equal(posts(f).length,2);assert.notEqual(posts(f)[0].body.requestId,posts(f)[1].body.requestId);
});
test('discard immediately hides the current result, preserves raw task and never remeshes',async t=>{
  const f=fixture(t,{jobs:[job('tetra','complete',{state:'ready',canStart:false})],handle:(request,f)=>{if(request.url.endsWith('/derive-discard')){f.jobs=[job()];return json({ok:true,meshJob:f.jobs[0]});}}});await f.store.refresh();await f.store.discardTetra('tetra');assert.equal(f.store.getSnapshot().selectedJobId,null);assert.equal(f.seen.at(-1).meshJob.visible,false);assert.equal(f.seen.at(-1).mesh.render,undefined);assert.equal(f.seen.at(-1).mesh.admission,undefined);assert.equal(f.seen.at(-1).meshJob.normalMeshAdmitted,false);assert.equal(f.store.getSnapshot().jobs[0].state,'complete');assert.equal(posts(f).length,1);assert.ok(posts(f)[0].url.endsWith('/derive-discard'));
});
test('lost successful discard is resolved from absent derived files without a second deletion',async t=>{
  const f=fixture(t,{jobs:[job('tetra','complete',{state:'ready',canStart:false})],handle:(request,f)=>{if(request.url.endsWith('/derive-discard')){f.jobs=[job()];throw Error('lost');}}});await f.store.refresh();await f.store.discardTetra('tetra');assert.equal(f.store.getSnapshot().tetraActions.tetra,undefined);assert.equal(f.store.getSnapshot().selectedJobId,null);assert.equal(posts(f).length,1);
});
test('cancel during original completion revokes one-click continuation',async t=>{
  const f=fixture(t,{handle:(request,f)=>{if(request.method==='POST'&&request.url.includes('/documents/')){f.jobs=[job('new','running')];return json({ok:true,meshJob:f.jobs[0]},202);}if(request.url.endsWith('/cancel')){f.jobs=[job('new')];return json({ok:true,meshJob:f.jobs[0]});}}});await f.store.refresh();await f.store.create({kind:'discrete-tetra',baseRevision:1,discreteTetra:tetraSettingsFromDraft(defaultTetraDraft())});await f.store.cancel('new');await f.store.refresh();await turn();assert.equal(posts(f).length,2);assert.equal(posts(f).some(row=>row.url.endsWith('/derive')),false);
});
test('stopped owner cannot submit or adopt a late derivation reply',async t=>{
  let release;const held=new Promise(resolve=>release=resolve);const f=fixture(t,{jobs:[job()],handle:async request=>{if(request.url.endsWith('/derive')){await held;return json({ok:true,meshJob:job('tetra','complete',{state:'working',requestId:request.body.requestId})},202);}}});await f.store.refresh();const work=f.store.prepareTetra('tetra');await turn();f.store.stop();release();await work;await f.store.prepareTetra('tetra');await f.store.discardTetra('tetra');assert.equal(posts(f).length,1);assert.equal(f.seen.length,0);
});
test('browser and backend material projection preserve the exact existing canonical hash',()=>{
  const f=cadDiscreteTetraFixture(),value=captureMeshMaterialSource(f.view,f.source),hash=crypto.createHash('sha256').update(JSON.stringify(canonicalMeshMaterial(value))).digest('hex');assert.deepEqual(captureCadMeshMaterials(f.view,f.source),{...value,sha256:hash});assert.deepEqual(f.snapshot.materials,{...value,sha256:hash});
});
test('resident derived meshes become stale immediately on used assignment or definition edits',()=>{
  const f=cadDiscreteTetraFixture(),result={meshJob:{source:f.source,kind:'discrete-tetra'},mesh:{},derivedMaterialSource:f.snapshot.materials};assert.equal(assessMeshDisplaySource(result,f.view,'doc').status,'current');
  for(const change of [view=>view.bodyMetadata[0].material='Steel',view=>view.materials[0].conductivity=1]){const view=structuredClone(f.view);change(view);assert.equal(assessMeshDisplaySource(result,view,'doc').status,'stale');}
});
test('visibility, opacity, unused materials and definition key order do not invalidate a derived mesh',()=>{
  const f=cadDiscreteTetraFixture(),result={meshJob:{source:f.source,kind:'discrete-tetra'},mesh:{},derivedMaterialSource:f.snapshot.materials},view=structuredClone(f.view);view.bodyMetadata[0].visible=false;view.bodyMetadata[0].opacity=.1;view.materials[1].conductivity=1;view.materials[0]=Object.fromEntries(Object.entries(view.materials[0]).reverse());assert.equal(assessMeshDisplaySource(result,view,'doc').status,'current');
});
test('missing or incomplete material binding fails closed while ordinary CAD meshes retain their source policy',()=>{
  const f=cadDiscreteTetraFixture(),result={meshJob:{source:f.source,kind:'discrete-tetra'},mesh:{}};assert.equal(assessMeshDisplaySource(result,f.view,'doc').status,'unverified');assert.equal(assessMeshDisplaySource({...result,derivedMaterialSource:f.snapshot.materials},{...f.view,materials:[]},'doc').status,'unverified');assert.equal(assessMeshDisplaySource({...result,meshJob:{source:f.source,kind:'mesh'}},f.view,'doc').status,'current');assert.equal(assessMeshDisplaySource(result,f.view,'other').status,'stale');
});
