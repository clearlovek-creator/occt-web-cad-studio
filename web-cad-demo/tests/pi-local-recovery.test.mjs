import test from 'node:test';
import assert from 'node:assert/strict';
import {PiSessionOwnershipClient,piOwnershipPendingKey} from '../app/modeling/pi-session-ownership-client.ts';
import {PiOwnerLocalBackups,withPiOwnerStorageLock} from '../app/modeling/pi-owner-local-backup.ts';
const historyDigest='a'.repeat(64),bound=patch=>({state:'bound',sessionId:'old',documentId:'doc',historyDigest,ownerToken:'11111111-1111-4111-8111-111111111111',adoption:'explicit-legacy',createdAt:'2026-11-17T00:00:00Z',...patch});
const legacy=()=>({state:'legacy',sessionId:'old',documentId:'doc',historyDigest,fileCount:1,totalBytes:100,preview:{version:1,messages:[{role:'user',text:'original',truncated:false}],omittedMessages:0,skippedLines:0,limited:false}});
const json=ownership=>new Response(JSON.stringify({ok:true,version:1,ownership}));
const key=piOwnershipPendingKey('/api','old','doc');
function storage(original='broken original\n中文\uD800'){const values=new Map(original===null?[]:[[key,original]]),writes=[];return {values,writes,getItem:name=>values.get(name)??null,setItem:(name,value)=>{writes.push({name,value});values.set(name,value);},removeItem:name=>{writes.push({remove:name});values.delete(name);}};}
const hold=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
async function fixture({cache=storage(),handler=()=>json(bound())}={}){const methods=[],client=new PiSessionOwnershipClient('/api','old','doc',cache,async(_url,init)=>{methods.push(init.method);return handler(init);});await client.inspect();return {client,cache,methods};}
test('bad local record is preserved during inspection and explicit repair performs only fresh GET and exact local backup',async()=>{
  const f=await fixture(),original=f.cache.getItem(key);assert.equal(f.client.snapshot().blocked,true);assert.equal(f.cache.writes.length,0);await assert.rejects(f.client.repairCache(false));await f.client.repairCache(true);assert.deepEqual(f.methods,['GET','GET']);assert.equal(f.cache.getItem(key),null);assert.equal(f.client.snapshot().blocked,false);assert.equal(f.client.snapshot().pending,false);assert.equal(f.client.snapshot().backups.length,1);const exported=JSON.parse(await f.client.exportBackup(f.client.snapshot().backups[0].id));assert.equal(exported.record.originalValue,original);assert.equal(exported.originalKey,key);assert.equal(exported.documentId,'doc');assert.equal(exported.record.owner.ownerToken,bound().ownerToken);
});
test('archive survives client recreation and can be exported without an ownership write or native connection',async()=>{
  const f=await fixture();await f.client.repairCache(true);let calls=0;const reopened=new PiSessionOwnershipClient('/api','old','doc',f.cache,async()=>{calls++;throw Error('not called');});assert.equal(reopened.snapshot().backups.length,1);const saved=JSON.parse(await reopened.exportBackup(reopened.snapshot().backups[0].id));assert.match(saved.record.originalValue,/broken original/);assert.equal(calls,0);
});
test('legacy, absent and empty backend identity cannot authorize discarding an invalid local record',async()=>{
  for(const owner of [legacy(),{state:'absent',sessionId:'old',documentId:'doc'},{state:'empty',sessionId:'old',documentId:'doc'}]){const f=await fixture({handler:()=>json(owner)}),before=f.cache.getItem(key);await assert.rejects(f.client.repairCache(true));assert.equal(f.cache.getItem(key),before);assert.equal(f.cache.writes.length,0);}
});
test('a valid unknown confirmation cannot be reclassified as corrupt or repaired away even with a bound mismatched owner',async()=>{
  const bytes=JSON.stringify({version:1,sessionId:'old',documentId:'doc',historyDigest}),cache=storage(bytes),client=new PiSessionOwnershipClient('/api','old','doc',cache,async()=>json(bound({historyDigest:'b'.repeat(64)})));await assert.rejects(client.inspect());await assert.rejects(client.repairCache(true));assert.equal(cache.getItem(key),bytes);assert.equal(cache.writes.length,0);assert.equal(client.snapshot().pending,true);
});
test('fresh bound proof changes, foreign documents and network failure refuse repair before local writes',async()=>{
  for(const next of [()=>json(bound({ownerToken:'22222222-2222-4222-8222-222222222222'})),()=>json(bound({documentId:'foreign'})),()=>{throw Error('lost');}]){let count=0;const f=await fixture({handler:()=>++count===1?json(bound()):next()}),before=f.cache.getItem(key);await assert.rejects(f.client.repairCache(true));assert.equal(f.cache.getItem(key),before);assert.equal(f.cache.writes.length,0);assert.equal(f.client.snapshot().blocked,true);}
});
test('another tab changing the bad pending record while fresh proof is in flight never loses its newer record',async()=>{
  const held=hold();let count=0;const f=await fixture({handler:()=>++count===1?json(bound()):held.promise}),pending=f.client.repairCache(true),checked=assert.rejects(pending);f.cache.values.set(key,'newer record from another tab');held.resolve(json(bound()));await checked;assert.equal(f.cache.getItem(key),'newer record from another tab');assert.equal(f.cache.writes.length,0);
});
test('concurrent explicit repair, inspection and adoption are rejected while the original repair owns its state',async()=>{
  const held=hold();let count=0;const f=await fixture({handler:()=>++count===1?json(bound()):held.promise}),pending=f.client.repairCache(true);assert.equal(f.client.snapshot().repairing,true);await assert.rejects(f.client.repairCache(true));await assert.rejects(f.client.inspect());await assert.rejects(f.client.adopt(true));held.resolve(json(bound()));await pending;assert.equal(count,2);assert.equal(f.client.snapshot().backups.length,1);
});
test('closing the owner client during fresh read prevents any later backup or marker removal',async()=>{
  const held=hold();let count=0;const f=await fixture({handler:()=>++count===1?json(bound()):held.promise}),before=f.cache.getItem(key),pending=f.client.repairCache(true),checked=assert.rejects(pending);f.client.close();held.resolve(json(bound()));await checked;assert.equal(f.cache.getItem(key),before);assert.equal(f.cache.writes.length,0);
});
test('backup quota failure and silent failed readback preserve the entire bad marker',async()=>{
  for(const mode of ['throw','ignore']){const cache=storage(),set=cache.setItem;cache.setItem=(name,value)=>{if(name.endsWith(':backups')){if(mode==='throw')throw Error('quota');return;}set(name,value);};const f=await fixture({cache}),before=cache.getItem(key);await assert.rejects(f.client.repairCache(true));assert.equal(cache.getItem(key),before);assert.equal(f.client.snapshot().blocked,true);}
});
test('failed marker removal keeps a verified backup; retry deduplicates that backup and then repairs',async()=>{
  const cache=storage(),remove=cache.removeItem;let ignore=true;cache.removeItem=name=>{if(!ignore)remove(name);};const f=await fixture({cache}),original=cache.getItem(key);await assert.rejects(f.client.repairCache(true));assert.equal(cache.getItem(key),original);assert.equal(f.client.snapshot().backups.length,1);assert.equal(JSON.parse(await f.client.exportBackup(f.client.snapshot().backups[0].id)).record.originalValue,original);ignore=false;await f.client.repairCache(true);assert.equal(cache.getItem(key),null);assert.equal(f.client.snapshot().backups.length,1);
});
test('partially completed local removal can be reconciled only with an existing exact backup and a fresh matching owner',async()=>{
  const cache=storage(),get=cache.getItem,remove=cache.removeItem;let failed=false;cache.removeItem=name=>{remove(name);failed=true;};cache.getItem=name=>{if(name===key&&failed){failed=false;throw Error('temporary read failure');}return get(name);};const f=await fixture({cache});await assert.rejects(f.client.repairCache(true));assert.equal(get(key),null);await f.client.repairCache(true);assert.equal(f.client.snapshot().blocked,false);assert.equal(f.client.snapshot().backups.length,1);
});
test('a marker removed without an exact preserved backup cannot be called safely repaired',async()=>{
  const f=await fixture();f.cache.values.delete(key);await assert.rejects(f.client.repairCache(true));assert.equal(f.client.snapshot().blocked,true);assert.equal(f.cache.writes.length,0);
});
test('existing damaged archive is never overwritten to make space for a repair',async()=>{
  const cache=storage();cache.values.set(key+':backups','preserve unreadable backup');const f=await fixture({cache}),before=cache.getItem(key);assert.match(f.client.snapshot().backupError,/不可解析/);await assert.rejects(f.client.repairCache(true));assert.equal(cache.getItem(key),before);assert.equal(cache.getItem(key+':backups'),'preserve unreadable backup');assert.equal(cache.writes.length,0);
});
test('oversized raw markers are not truncated and cannot be cleared through the bounded repair path',async()=>{
  const cache=storage('x'.repeat(65537)),f=await fixture({cache});await assert.rejects(f.client.repairCache(true),/65536/);assert.equal(cache.getItem(key).length,65537);assert.equal(cache.writes.length,0);
});
test('unreadable browser storage does not invent an original record or permit repair',async()=>{
  const cache=storage();cache.getItem=()=>{throw Error('storage denied');};const f=await fixture({cache});await assert.rejects(f.client.repairCache(true));assert.equal(f.client.snapshot().blocked,true);assert.equal(cache.writes.length,0);
});
test('archive integrity rejects same-length mutation, foreign scope, duplicate and hidden records before export or later repair',async()=>{
  for(const mutate of [v=>{v.records[0].originalValue='X'+v.records[0].originalValue.slice(1);},v=>{v.documentId='foreign';},v=>{v.records.push(v.records[0]);},v=>{v.extra=true;}]){const f=await fixture();await f.client.repairCache(true);const archiveKey=key+':backups',value=JSON.parse(f.cache.getItem(archiveKey)),id=value.records[0].id;mutate(value);f.cache.values.set(archiveKey,JSON.stringify(value));const bytes=f.cache.getItem(archiveKey);await assert.rejects(f.client.exportBackup(id));f.cache.values.set(key,'another damaged marker');const next=new PiSessionOwnershipClient('/api','old','doc',f.cache,async()=>json(bound()));await next.inspect();await assert.rejects(next.repairCache(true));assert.equal(f.cache.getItem(archiveKey),bytes);assert.equal(f.cache.getItem(key),'another damaged marker');}
});
test('local archive supports exactly eight distinct repairs and never evicts older evidence',async()=>{
  const cache=storage(null),backups=new PiOwnerLocalBackups(cache,key,'/api','old','doc');for(let i=0;i<8;i++){const plan=await backups.prepare('raw-'+i,bound());plan.publish();}assert.equal(backups.list().length,8);const bytes=cache.getItem(backups.key);await assert.rejects(backups.prepare('raw-9',bound()),/8 份/);assert.equal(cache.getItem(backups.key),bytes);const repeated=await backups.prepare('raw-0',bound());assert.equal(repeated.alreadyPreserved,true);repeated.publish();assert.equal(cache.getItem(backups.key),bytes);
});
test('distinct unpaired UTF-16 strings have distinct exact archives rather than TextEncoder replacement collisions',async()=>{
  const cache=storage(null),backups=new PiOwnerLocalBackups(cache,key,'/api','old','doc');for(const raw of ['\uD800','\uD801','中文\n\0']){const plan=await backups.prepare(raw,bound());plan.publish();}const list=backups.list();assert.equal(new Set(list.map(item=>item.id)).size,3);const raws=await Promise.all(list.map(async item=>JSON.parse(await backups.export(item.id)).record.originalValue));assert.deepEqual(raws,['\uD800','\uD801','中文\n\0']);
});
test('backup publication rechecks the exact catalog and refuses another writer or foreign owner',async()=>{
  const cache=storage(null),backups=new PiOwnerLocalBackups(cache,key,'/api','old','doc'),plan=await backups.prepare('raw',bound());cache.values.set(backups.key,'external change');assert.throws(()=>plan.publish());assert.equal(cache.getItem(backups.key),'external change');await assert.rejects(backups.prepare('raw',bound({documentId:'other'})),/不匹配/);
});
test('storage writer lock rejects overlap and releases ownership after both success and failure',async()=>{
  const held=hold(),pending=withPiOwnerStorageLock('test-lock',()=>held.promise);await assert.rejects(withPiOwnerStorageLock('test-lock',async()=>1));held.resolve(2);assert.equal(await pending,2);await assert.rejects(withPiOwnerStorageLock('test-lock',async()=>{throw Error('failure');}));assert.equal(await withPiOwnerStorageLock('test-lock',async()=>3),3);
});
test('normal successful ownership cannot silently clear a pending marker when removal was ignored',async()=>{
  const cache=storage(null),remove=cache.removeItem;let ignore=true;cache.removeItem=name=>{if(!ignore)remove(name);};const client=new PiSessionOwnershipClient('/api','old','doc',cache,async(_url,init)=>json(init.method==='POST'?bound():legacy()));await client.inspect();await assert.rejects(client.adopt(true));assert.equal(client.snapshot().pending,true);assert.notEqual(cache.getItem(key),null);ignore=false;const recovered=new PiSessionOwnershipClient('/api','old','doc',cache,async()=>json(bound()));await recovered.inspect();assert.equal(recovered.snapshot().pending,false);assert.equal(cache.getItem(key),null);
});
test('duplicate adoption during storage-lock acquisition never submits twice',async()=>{
  const cache=storage(null),held=hold();let posts=0;const client=new PiSessionOwnershipClient('/api','old','doc',cache,async(_url,init)=>{if(init.method==='POST'){posts++;await held.promise;return json(bound());}return json(legacy());});await client.inspect();const pending=client.adopt(true);await assert.rejects(client.adopt(true));held.resolve();await pending;assert.equal(posts,1);
});
test('valid pending JSON with whitespace or a different field order is recovered against its exact original bytes',async()=>{
  const bytes=JSON.stringify({historyDigest,documentId:'doc',version:1,sessionId:'old'},null,2),cache=storage(bytes),client=new PiSessionOwnershipClient('/api','old','doc',cache,async()=>json(bound()));assert.equal(client.snapshot().pending,true);await client.inspect();assert.equal(cache.getItem(key),null);assert.equal(client.snapshot().pending,false);assert.equal(cache.writes.some(item=>item.name===key),false,'Do not rewrite the original marker just to canonicalize it');
});
test('missing browser Web Locks cannot fall back to an in-process lock and pretend cross-tab protection',async()=>{
  const previous=globalThis.window,descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');globalThis.window={};Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});try{await assert.rejects(withPiOwnerStorageLock('browser-test',async()=>true),/Web Locks/);}finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete globalThis.navigator;}
});
test('a newer record appearing during backup publication is retained while the old backup remains exportable',async()=>{
  const cache=storage(),set=cache.setItem;cache.setItem=(name,value)=>{set(name,value);if(name.endsWith(':backups'))cache.values.set(key,'newer record after backup');};const f=await fixture({cache});await assert.rejects(f.client.repairCache(true));assert.equal(cache.getItem(key),'newer record after backup');assert.equal(f.client.snapshot().backups.length,1);assert.match(JSON.parse(await f.client.exportBackup(f.client.snapshot().backups[0].id)).record.originalValue,/broken original/);
});
test('a UI owner fence closing during fresh proof prevents local writes without permanently disposing the reusable client',async()=>{
  const held=hold();let count=0,current=true;const f=await fixture({handler:()=>++count===2?held.promise:json(bound())}),original=f.cache.getItem(key),pending=f.client.repairCache(true,()=>current),checked=assert.rejects(pending);current=false;held.resolve(json(bound()));await checked;assert.equal(f.cache.getItem(key),original);assert.equal(f.cache.writes.length,0);await f.client.inspect();assert.equal(f.client.snapshot().ownership.state,'bound');
});
