import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {transactionFixture} from './helpers/project-transaction-fixture.mjs';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-transaction-中文-'));t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});return transactionFixture(root);}

test('the transaction supplies its fully verified baseline to the command without dropping commit-time integrity checks',async t=>{
  const f=fixture(t);await f.transactions.run('baseline',async()=>({ok:true}));
  await f.transactions.run('baseline',async history=>{assert.equal(history.current,f.history.get('baseline').current);assert.deepEqual(history.projectData,f.history.get('baseline').projectData);await f.commit('baseline','second');return {ok:true};});
  const before=f.history.integrityMetrics();
  await f.transactions.run('baseline',async history=>{assert.equal(history.undo.length,1);assert.ok(fs.existsSync(history.current));await f.commit('baseline','third');return {ok:true};});
  const after=f.history.integrityMetrics();assert.equal(after.passes.repair-before.passes.repair,1);assert.ok(after.passes.commit>before.passes.commit);assert.ok(after.geometryBytes>before.geometryBytes);
});
test('interrupted native work is marked non-committed only after complete rollback has succeeded',async t=>{
  const f=fixture(t);await f.transactions.run('interrupted',async()=>{await f.commit('interrupted','baseline');return {ok:true};});
  const original=Object.assign(Error('Native deadline'),{code:'WORKER_TIMEOUT'});
  await assert.rejects(f.transactions.run('interrupted',async()=>{f.setModel({revision:9,name:'Not committed'});throw original;}),error=>error===original&&error.projectRollback?.confirmed===true&&error.projectRollback.documentId==='interrupted');
  assert.equal(fs.existsSync(f.transactions.journalPath('interrupted')),false);
});

test('structured failed responses receive internal non-JSON rollback proof only after geometry, properties and history are restored',async t=>{
  for(const wrapped of [false,true]){
    const f=fixture(t),id=wrapped?'wrapped':'direct';await f.transactions.run(id,async()=>({ok:true}));
    const before=f.history.get(id),schema=f.schemas.list(id),response={ok:false,code:'STEP_INVALID',error:'invalid STEP'},result=wrapped?{response}:response;
    assert.equal(await f.transactions.run(id,async()=>{f.setModel({revision:7,name:'Rejected'});f.schemas.createType(id,{key:'MustRollback'});await f.commit(id,'unpublished');return result;},{success:value=>(value.response||value).ok}),result);
    assert.deepEqual(response.projectRollback,{documentId:id,confirmed:true});
    assert.equal(Object.getOwnPropertyDescriptor(response,'projectRollback').enumerable,false);
    assert.deepEqual(JSON.parse(JSON.stringify(response)),{ok:false,code:'STEP_INVALID',error:'invalid STEP'});
    assert.equal(f.model().name,'Baseline');assert.deepEqual(f.schemas.list(id),schema);
    const after=f.history.get(id);assert.equal(after.current,before.current);assert.deepEqual(after.events,before.events);
    assert.equal(fs.existsSync(f.transactions.journalPath(id)),false);
  }
});

test('immutable rejected responses stay conservative and failed restoration cannot manufacture proof',async t=>{
  const f=fixture(t),id='immutable';await f.transactions.run(id,async()=>({ok:true}));
  const frozen=Object.freeze({ok:false,code:'REJECTED'});
  assert.equal(await f.transactions.run(id,async()=>{f.setModel({revision:4,name:'Rejected'});return frozen;}),frozen);
  assert.equal(frozen.projectRollback,undefined);assert.equal(f.model().name,'Baseline');
  const response={ok:false,code:'REJECTED'};f.failRestore(true);
  await assert.rejects(f.transactions.run(id,async()=>response),{code:'PROJECT_ROLLBACK_FAILED'});
  assert.equal(response.projectRollback,undefined);assert.ok(fs.existsSync(f.transactions.journalPath(id)));
});
test('native execution and durable publication cannot silently span a replacement process generation',async t=>{
  const f=fixture(t);await f.transactions.run('generation',async()=>{await f.commit('generation','baseline');return {ok:true};});const before=f.history.get('generation');let generation=1;
  f.transactions.captureExecutionState=()=>generation;f.transactions.assertExecutionState=(_id,owner)=>{if(owner!==generation)throw Object.assign(Error('native generation changed'),{code:'WORKER_INSTANCE_CHANGED'});};
  await assert.rejects(f.transactions.run('generation',async()=>{f.setModel({revision:9,name:'stale native result'});generation++;await f.commit('generation','must-not-remain');return {ok:true};}),error=>error.code==='WORKER_INSTANCE_CHANGED'&&error.projectRollback?.confirmed===true);
  const after=f.history.get('generation');assert.equal(after.current,before.current);assert.deepEqual(after.events,before.events);assert.notEqual(f.model().name,'stale native result');
});

test('project state sequence survives restart and rollback never moves response ordering backwards',async t=>{
  const f=fixture(t);await f.transactions.run('ordered',async()=>({ok:true}));const initial=f.history.get('ordered');assert.equal(initial.stateSequence,0);
  await f.transactions.run('ordered',async()=>{await f.commit('ordered','first');return {ok:true};});const first=f.history.get('ordered');assert.equal(first.stateSequence,1);
  f.history.recordIdempotency('ordered',{key:'saved',response:{ok:true}});assert.equal(f.history.get('ordered').stateSequence,1);
  const restarted=transactionFixture(f.root);assert.equal(restarted.history.get('ordered').stateSequence,1);
  await assert.rejects(f.transactions.run('ordered',async()=>{await f.commit('ordered','unpublished');throw new Error('after history publication');}),/after history publication/);
  const rolledBack=f.history.get('ordered');assert.equal(rolledBack.current,first.current);assert.equal(rolledBack.events.at(-1).eventId,'first');assert.ok(rolledBack.stateSequence>first.stateSequence);
  assert.equal(transactionFixture(f.root).history.get('ordered').stateSequence,rolledBack.stateSequence);
  assert.throws(()=>f.history.normalize('ordered',{...rolledBack,stateSequence:-1},false),/state sequence/);
});

test('native and property checkpoints commit together and retain the old checkpoint until the journal commits',async t=>{
  const f=fixture(t);let before;
  await f.transactions.run('normal',async()=>{
    assert.equal(f.transactions.active.has('normal'),true);
    const journal=JSON.parse(fs.readFileSync(f.transactions.journalPath('normal')));assert.equal(journal.phase,'prepared');assert.equal(journal.version,2);assert.ok(fs.statSync(f.transactions.journalPath('normal')).size<1024);before=f.transactions.validateJournal('normal',journal).history;
    f.schemas.createType('normal',{key:'Setup'});f.setModel({revision:2,name:'Changed'});await f.commit('normal');assert.ok(fs.existsSync(before.current));return {ok:true};
  });
  const after=f.history.get('normal');assert.equal(after.undo[0],before.current);assert.deepEqual(f.history.readProjectData('normal',after.current),f.schemas.validateSnapshot(f.schemas.list('normal')));assert.equal(fs.existsSync(f.transactions.journalPath('normal')),false);
  assert.equal(f.transactions.active.has('normal'),false);
});

test('recovery journal references an immutable manifest backup instead of duplicating large cached model responses',async t=>{
  const f=fixture(t);await f.transactions.run('large',async()=>({ok:true}));f.history.commit('large',{...f.history.get('large'),idempotency:[{key:'saved-result',response:{positions:Array(100000).fill(1)}}]});
  const entry=f.history.get('large').idempotency[0];assert.equal(Object.hasOwn(entry,'response'),false);assert.ok(entry.responseRef.bytes>100000);assert.equal(f.history.readIdempotency('large',entry).positions.length,100000);
  await f.transactions.run('large',async()=>{const file=f.transactions.journalPath('large'),journal=JSON.parse(fs.readFileSync(file));assert.ok(fs.statSync(file).size<1024);assert.ok(journal.beforeManifest.bytes<10000);assert.ok(!fs.readFileSync(file,'utf8').includes(f.root));return {ok:true};});
  assert.deepEqual(fs.readdirSync(f.transactions.directory),[]);
});

test('a checkpoint publication failure rolls back geometry, typed values and the complete history',async t=>{
  const f=fixture(t);await f.transactions.run('failure',async()=>({ok:true}));const before=f.history.get('failure'),schema=f.schemas.list('failure'),commit=f.history.commit.bind(f.history);let fail=true;
  f.history.commit=(id,value,options)=>{if(fail&&value.current!==before.current){fail=false;throw new Error('injected manifest failure');}return commit(id,value,options);};
  await assert.rejects(f.transactions.run('failure',async()=>{f.schemas.createType('failure',{key:'MustRollback'});f.setModel({revision:2,name:'MustRollback'});await f.commit('failure');return {ok:true};}),/injected manifest/);
  assert.deepEqual(f.history.get('failure'),before);assert.deepEqual(f.schemas.list('failure'),schema);assert.deepEqual(f.model(),{revision:1,name:'Baseline'});assert.equal(fs.existsSync(f.transactions.journalPath('failure')),false);
});

test('rollback failures preserve recovery evidence and block further writes until recovery succeeds',async t=>{
  const f=fixture(t);await f.transactions.run('blocked',async()=>({ok:true}));const before=f.history.get('blocked');
  await assert.rejects(f.transactions.run('blocked',async()=>{f.schemas.createType('blocked',{key:'Uncommitted'});f.setModel({revision:2,name:'Uncommitted'});await f.commit('blocked');f.failRestore(true);throw new Error('injected action failure');}),error=>error.code==='PROJECT_ROLLBACK_FAILED');
  assert.ok(fs.existsSync(f.transactions.journalPath('blocked')));await assert.rejects(f.transactions.run('blocked',async()=>({ok:true})),error=>error.code==='PROJECT_RECOVERY_REQUIRED');
  f.failRestore(false);f.transactions.recover();await f.command('document.restore',{documentId:'blocked',parameters:{path:f.history.get('blocked').current}});
  assert.equal(f.schemas.list('blocked').types.length,0);assert.equal(f.history.get('blocked').current,before.current);assert.equal(f.history.get('blocked').restoreError,null);assert.equal(f.model().name,'Baseline');
});

for(const stage of ['prepared','committed'])test(`process exit during ${stage} transaction recovers the correct complete project without replay`,async t=>{
  const f=fixture(t),child=spawnSync(process.execPath,[path.resolve('tests/helpers/project-transaction-crash.mjs'),f.root,stage],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(child.status,stage==='prepared'?86:87,child.stderr);
  const recovered=transactionFixture(f.root);assert.ok(fs.existsSync(recovered.transactions.journalPath('crash')));recovered.transactions.recover();const state=recovered.history.get('crash');assert.equal(state.restoreError,null);await recovered.command('document.restore',{documentId:'crash',parameters:{path:state.current}});
  assert.equal(recovered.model().name,stage==='prepared'?'Baseline':'AfterCrash');assert.equal(recovered.schemas.list('crash').types.length,stage==='prepared'?0:1);assert.equal(fs.existsSync(recovered.transactions.journalPath('crash')),false);assert.equal(recovered.restores(),1);
  assert.equal(state.idempotency.length,stage==='prepared'?0:1);if(stage==='committed')assert.equal(recovered.history.readIdempotency('crash',state.idempotency[0]).name,'AfterCrash');
});

test('tampered property sidecars and corrupt journals are preserved rather than repaired from a native revision alone',async t=>{
  const f=fixture(t);await f.transactions.run('damaged',async()=>({ok:true}));const before=f.history.get('damaged');fs.appendFileSync(before.current+'.properties.json',' ');
  assert.equal(f.history.isValidSnapshot('damaged',before.current),false);assert.equal(f.history.isValidProjectData('damaged',before.current),false);await assert.rejects(f.transactions.run('damaged',async()=>({ok:true})),/快照|检查点/);
  fs.writeFileSync(f.transactions.journalPath('other'),'{ corrupt');f.transactions.recover();assert.match(f.history.get('other').restoreError,/事务恢复失败/);assert.equal(fs.readFileSync(f.transactions.journalPath('other'),'utf8'),'{ corrupt');
});
