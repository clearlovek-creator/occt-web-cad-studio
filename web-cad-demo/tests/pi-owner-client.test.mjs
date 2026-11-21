import test from 'node:test';
import assert from 'node:assert/strict';
import {PiSessionOwnershipClient,normalizePiOwnership} from '../app/modeling/pi-session-ownership-client.ts';
const digest='a'.repeat(64),legacy=()=>({state:'legacy',sessionId:'old',documentId:'doc',historyDigest:digest,fileCount:1,totalBytes:200,preview:{version:1,messages:[{role:'user',text:'original context',truncated:false}],omittedMessages:0,skippedLines:0,limited:false}}),bound=()=>({state:'bound',sessionId:'old',documentId:'doc',historyDigest:digest,ownerToken:'11111111-1111-4111-8111-111111111111',adoption:'explicit-legacy',createdAt:new Date().toISOString()});
const json=(owner,status=200,extra={})=>new Response(JSON.stringify({ok:status===200,version:1,ownership:owner,...extra}),{status,headers:{'Content-Type':'application/json'}});
function storage(){const values=new Map();return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
const hold=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
test('ownership DTO rejects foreign identities, invalid proof and over-budget or hidden-role preview',()=>{
  assert.equal(normalizePiOwnership(legacy(),'old','doc').state,'legacy');for(const item of [{...legacy(),sessionId:'other'},{...legacy(),documentId:'other'},{...legacy(),historyDigest:'bad'},{...legacy(),preview:{...legacy().preview,messages:[{role:'toolResult',text:'hidden',truncated:false}]}},{...legacy(),preview:{...legacy().preview,messages:Array(13).fill(legacy().preview.messages[0])}},{...bound(),ownerToken:'bad'}])assert.throws(()=>normalizePiOwnership(item,'old','doc'));
});
test('read-only inspect never submits ownership and an explicit checked action records identity before one POST',async()=>{
  const cache=storage(),calls=[];let client;client=new PiSessionOwnershipClient('/api','old','doc',cache,async(url,init)=>{calls.push({url,init});if(init.method==='POST'){assert.equal(JSON.parse(cache.getItem(client.key)).historyDigest,digest);return json(bound());}return json(legacy());});await client.inspect();assert.equal(calls.length,1);assert.match(calls[0].url,/preview=1/);await assert.rejects(client.adopt(false));await client.adopt(true);assert.equal(calls.filter(c=>c.init.method==='POST').length,1);assert.deepEqual(JSON.parse(calls.at(-1).init.body),{documentId:'doc',historyDigest:digest});assert.equal(cache.getItem(client.key),null);assert.equal(client.snapshot().ownership.state,'bound');
});
test('lost confirmation survives recreation and is recovered only by a matching bound GET without another POST',async()=>{
  const cache=storage();let writes=0;const first=new PiSessionOwnershipClient('/api','old','doc',cache,async(_url,init)=>{if(init.method==='POST'){writes++;throw Error('lost reply');}return json(legacy());});await first.inspect();await assert.rejects(first.adopt(true));assert.equal(first.snapshot().pending,true);const second=new PiSessionOwnershipClient('/api','old','doc',cache,async(_url,init)=>{assert.equal(init.method,'GET');return json(bound());});await assert.rejects(second.adopt(true));await second.inspect();assert.equal(second.snapshot().pending,false);assert.equal(second.snapshot().ownership.state,'bound');assert.equal(writes,1);assert.equal(cache.getItem(first.key),null);
});
test('a legacy GET cannot prove an unknown confirmation did not execute and never permits a second write',async()=>{
  const cache=storage();let writes=0;const client=new PiSessionOwnershipClient('/api','old','doc',cache,async(_url,init)=>{if(init.method==='POST'){writes++;throw Error('lost');}return json(legacy());});await client.inspect();await assert.rejects(client.adopt(true));await client.inspect();await assert.rejects(client.adopt(true));assert.equal(writes,1);assert.equal(client.snapshot().pending,true);
});
test('foreign confirmation replies retain pending proof and cannot be treated as connection permission',async()=>{
  const cache=storage(),client=new PiSessionOwnershipClient('/api','old','doc',cache,async(_url,init)=>json(init.method==='POST'?{...bound(),historyDigest:'b'.repeat(64)}:legacy()));await client.inspect();await assert.rejects(client.adopt(true));assert.equal(client.snapshot().pending,true);assert.equal(client.snapshot().ownership.state,'legacy');assert.notEqual(cache.getItem(client.key),null);
});
test('a verified pre-write rejection allows fresh review but unknown write-phase failure retains the pending identity',async()=>{
  for(const outcome of ['not-started','unknown']){const cache=storage(),client=new PiSessionOwnershipClient('/api','old','doc',cache,async(_url,init)=>init.method==='POST'?json(null,409,{outcome,error:'changed'}):json(legacy()));await client.inspect();await assert.rejects(client.adopt(true));assert.equal(client.snapshot().pending,outcome==='unknown');assert.equal(cache.getItem(client.key)!==null,outcome==='unknown');}
});
test('storage refusal and corrupt or foreign pending caches do not send or overwrite a confirmation',async()=>{
  let posts=0;const cache=storage(),client=new PiSessionOwnershipClient('/api','old','doc',{...cache,setItem(){throw Error('quota');}},async(_url,init)=>{if(init.method==='POST')posts++;return json(legacy());});await client.inspect();await assert.rejects(client.adopt(true));assert.equal(posts,0);
  const reference=new PiSessionOwnershipClient('/api','old','doc',cache);cache.setItem(reference.key,'broken original bytes');const restored=new PiSessionOwnershipClient('/api','old','doc',cache,async()=>json(legacy()));await restored.inspect();await assert.rejects(restored.adopt(true));assert.equal(cache.getItem(reference.key),'broken original bytes');
});
test('read coalescing and closed owner fencing prevent late preview publication or cross-workspace callbacks',async()=>{
  const held=hold(),cache=storage(),events=[];let reads=0;const client=new PiSessionOwnershipClient('/api','old','doc',cache,async()=>{reads++;return held.promise;},value=>events.push(value));const first=client.inspect(),second=client.inspect();assert.equal(first,second);const rejected=assert.rejects(first);client.close();const count=events.length;held.resolve(json(legacy()));await rejected;assert.equal(events.length,count);assert.equal(reads,1);
});
