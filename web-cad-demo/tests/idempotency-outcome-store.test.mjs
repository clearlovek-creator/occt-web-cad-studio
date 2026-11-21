import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {IdempotencyOutcomeStore} from '../gateway/idempotency-outcome-store.mjs';
import {transactionFixture} from './helpers/project-transaction-fixture.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-outcome-中文-'));t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});return {root,store:new IdempotencyOutcomeStore(path.join(root,'history'))};}

test('full responses are immutable, content addressed and read on demand without a response cache',t=>{
  const {root,store}=fixture(t),response={ok:true,revision:3,positions:Array.from({length:100000},(_,i)=>i/3)},entry=store.storeEntry('doc',{key:'once',fingerprint:'f',response});
  assert.equal(Object.hasOwn(entry,'response'),false);assert.ok(JSON.stringify(entry).length<350);assert.deepEqual(store.read('doc',entry),response);
  assert.deepEqual(store.storeEntry('doc',{key:'twice',response}).responseRef,entry.responseRef);assert.equal(fs.readdirSync(path.join(root,'history/doc/outcomes')).length,1);
  assert.deepEqual(new IdempotencyOutcomeStore(path.join(root,'history')).read('doc',entry),response);
});
test('missing, tampered and invalid references fail closed instead of supplying a replacement result',t=>{
  const {store}=fixture(t),entry=store.storeEntry('doc',{key:'once',response:{ok:true,value:10}}),file=path.join(store.directory('doc'),entry.responseRef.file);
  fs.writeFileSync(file,'x'.repeat(entry.responseRef.bytes));assert.throws(()=>store.read('doc',entry),e=>e.code==='IDEMPOTENCY_RESULT_UNAVAILABLE');
  fs.rmSync(file);assert.throws(()=>store.read('doc',entry),e=>e.code==='IDEMPOTENCY_RESULT_UNAVAILABLE');
  for(const responseRef of [{...entry.responseRef,file:'../elsewhere.json'},{...entry.responseRef,bytes:-1},{...entry.responseRef,sha256:'0'.repeat(64)}])assert.throws(()=>store.read('doc',{responseRef}),e=>e.code==='IDEMPOTENCY_RESULT_UNAVAILABLE');
  assert.throws(()=>store.read('../doc',entry),e=>e.code==='IDEMPOTENCY_RESULT_UNAVAILABLE');
});
test('size and write failures do not publish a partial immutable result',t=>{
  const {root}=fixture(t),store=new IdempotencyOutcomeStore(path.join(root,'history'),{maxBytes:40});assert.throws(()=>store.write('doc',{value:'x'.repeat(100)}),/限制/);assert.equal(fs.existsSync(store.directory('doc')),false);
  const link=fs.linkSync;fs.linkSync=()=>{throw Object.assign(new Error('injected publication failure'),{code:'EPERM'});};try{assert.throws(()=>store.write('doc',{ok:true}),/injected/);}finally{fs.linkSync=link;}
  assert.deepEqual(fs.readdirSync(store.directory('doc')),[]);
});
test('cleanup removes only unreferenced managed outcomes and interrupted temporary files',t=>{
  const {store}=fixture(t),kept=store.storeEntry('doc',{key:'keep',response:{ok:true,keep:1}}),orphan=store.storeEntry('doc',{key:'orphan',response:{ok:true,orphan:1}}),directory=store.directory('doc');
  const pending='.pending-11111111-1111-4111-8111-111111111111.tmp';fs.writeFileSync(path.join(directory,pending),'partial');fs.writeFileSync(path.join(directory,'user-note.txt'),'keep this file');
  store.cleanup('doc',[kept]);assert.equal(fs.existsSync(path.join(directory,kept.responseRef.file)),true);assert.equal(fs.existsSync(path.join(directory,orphan.responseRef.file)),false);assert.equal(fs.existsSync(path.join(directory,pending)),false);assert.equal(fs.readFileSync(path.join(directory,'user-note.txt'),'utf8'),'keep this file');
});
test('outcome retention is bounded and cleanup never removes a prepared transaction baseline',async t=>{
  const {root}=fixture(t),f=transactionFixture(root);f.history.idempotencyLimit=3;await f.transactions.run('doc',async()=>({ok:true}));
  for(let i=0;i<3;i++)f.history.recordIdempotency('doc',{key:'key-'+i,response:{ok:true,value:i}});
  const before=f.history.get('doc'),oldFiles=before.idempotency.map(entry=>path.join(f.history.outcomes.directory('doc'),entry.responseRef.file));
  await assert.rejects(f.transactions.run('doc',async()=>{f.history.recordIdempotency('doc',{key:'new',response:{ok:true,value:9}});assert.ok(oldFiles.every(file=>fs.existsSync(file)),'Prepared backup retains all outcomes until commit/rollback is finalized');throw Error('rollback outcomes');}),/rollback outcomes/);
  assert.deepEqual(f.history.get('doc').idempotency,before.idempotency);assert.equal(fs.readdirSync(f.history.outcomes.directory('doc')).length,3);
  await f.transactions.run('doc',async()=>{f.history.recordIdempotency('doc',{key:'new',response:{ok:true,value:9}});return {ok:true};});
  assert.equal(f.history.get('doc').idempotency.length,3);assert.equal(fs.existsSync(oldFiles[0]),false);assert.equal(fs.readdirSync(f.history.outcomes.directory('doc')).length,3);
});
test('legacy inline outcomes load without writes and migrate only on a successful manifest commit',async t=>{
  const {root}=fixture(t),f=transactionFixture(root);await f.transactions.run('legacy',async()=>({ok:true}));
  const manifestFile=path.join(root,'history/legacy/manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));manifest.version=1;manifest.idempotency=[{key:'legacy',response:{ok:true,legacy:1}}];fs.writeFileSync(manifestFile,JSON.stringify(manifest));const bytes=fs.readFileSync(manifestFile);
  const loaded=transactionFixture(root);assert.deepEqual(fs.readFileSync(manifestFile),bytes);assert.equal(loaded.history.readIdempotency('legacy',loaded.history.get('legacy').idempotency[0]).legacy,1);
  loaded.history.commit('legacy',loaded.history.get('legacy'));assert.equal(JSON.parse(fs.readFileSync(manifestFile)).version,2);const entry=loaded.history.get('legacy').idempotency[0];assert.equal(Object.hasOwn(entry,'response'),false);assert.equal(loaded.history.readIdempotency('legacy',entry).legacy,1);
});
test('retained outcome bytes have a per-document bound in addition to the entry-count bound',async t=>{
  const {root}=fixture(t),f=transactionFixture(root);f.history.idempotencyBytes=170;await f.transactions.run('doc',async()=>({ok:true}));
  for(let i=0;i<8;i++)f.history.recordIdempotency('doc',{key:'key-'+i,response:{ok:true,index:i,value:'x'.repeat(35)}});
  const entries=f.history.get('doc').idempotency;assert.ok(entries.length<8&&entries.length>0);assert.ok(entries.reduce((sum,entry)=>sum+entry.responseRef.bytes,0)<=170);assert.equal(entries.at(-1).key,'key-7');assert.equal(fs.readdirSync(f.history.outcomes.directory('doc')).length,entries.length);
});
test('failed outcome persistence rolls back geometry and schema instead of acknowledging an unrepeatable success',async t=>{
  const {root}=fixture(t),f=transactionFixture(root);await f.transactions.run('doc',async()=>({ok:true}));const before=f.history.get('doc'),write=f.history.outcomes.write.bind(f.history.outcomes);
  f.history.outcomes.write=()=>{throw Error('injected disk full');};
  try{await assert.rejects(f.transactions.run('doc',async()=>{f.schemas.createType('doc',{key:'NotCommitted'});f.setModel({revision:2,name:'NotCommitted'});await f.commit('doc');f.history.recordIdempotency('doc',{key:'must-retry',response:{ok:true}});return {ok:true};}),/injected disk full/);}finally{f.history.outcomes.write=write;}
  assert.equal(f.history.get('doc').current,before.current);assert.deepEqual(f.history.get('doc').idempotency,before.idempotency);assert.equal(f.schemas.list('doc').types.length,0);assert.equal(f.model().name,'Baseline');assert.equal(fs.existsSync(f.transactions.journalPath('doc')),false);
});
