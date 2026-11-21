import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ModelingTaskClient} from '../app/modeling/modeling-task-client.ts';
const now=new Date().toISOString(),task=(phase='executing',patch={})=>({version:1,taskId:randomUUID(),documentId:'default',operation:'primitive.box',requestKey:randomUUID(),phase,sequence:4,createdAt:now,updatedAt:now,cancelRequested:false,cancellable:phase==='executing',reportDurable:true,...patch});
const json=tasks=>new Response(JSON.stringify({ok:true,tasks}),{headers:{'content-type':'application/json'}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
test('concurrent registry discovery shares one GET and publishes a complete validated batch once',async()=>{
  const held=deferred(),calls=[],snapshots=[],rows=[task(),task('succeeded')],client=new ModelingTaskClient('/api',async(url,init)=>{calls.push({url,init});return held.promise;},value=>snapshots.push(value),{pollMs:60000});
  try{const first=client.restore('default');assert.equal(client.restore('default'),first);held.resolve(json(rows));await first;assert.equal(calls.length,1);assert.equal(calls[0].init?.method,undefined);assert.equal(snapshots.length,1);assert.equal(snapshots[0].length,2);assert.ok(snapshots[0].every(item=>item.external===true));assert.equal(client.hasPending('default'),true);}finally{client.dispose();}
});
test('unchanged discovery does not emit extra renders and a later terminal retains its external ownership',async()=>{
  const snapshots=[],row=task();let rows=[row];const client=new ModelingTaskClient('/api',async()=>json(rows),value=>snapshots.push(value),{pollMs:60000});
  try{await client.restore('default');await client.restore('default');assert.equal(snapshots.length,1);rows=[{...row,phase:'cancelled',sequence:7,cancelRequested:true,cancellable:false,restored:true}];await client.restore('default');assert.equal(snapshots.length,2);assert.equal(snapshots.at(-1)[0].external,true);assert.equal(client.hasPending('default'),false);}finally{client.dispose();}
});
test('a malformed or foreign row rejects the entire registry page without partially adopting its good rows',async()=>{
  const snapshots=[],client=new ModelingTaskClient('/api',async()=>json([task(),task('executing',{documentId:'foreign'})]),value=>snapshots.push(value),{pollMs:60000});try{await assert.rejects(client.restore('default'));assert.equal(snapshots.length,0);assert.equal(client.hasPending('default'),false);}finally{client.dispose();}
});
test('late discovery after disposal cannot publish tasks or schedule new observations',async()=>{
  const held=deferred(),snapshots=[],client=new ModelingTaskClient('/api',async()=>held.promise,value=>snapshots.push(value),{pollMs:60000});const work=client.restore('default');client.dispose();held.resolve(json([task()]));await work;await client.restore('default');assert.equal(snapshots.length,0);assert.equal(client.hasPending('default'),false);
});
test('a task submitted by this page is not reclassified as an external job by later registry discovery',async()=>{
  const row=task('reserved',{sequence:1,cancellable:true}),snapshots=[];
  const client=new ModelingTaskClient('/api',async(_url,init)=>init?.method==='POST'?new Response(JSON.stringify({ok:true,modelingTask:row}),{status:201}):json([{...row,phase:'succeeded',sequence:7,cancellable:false}]),value=>snapshots.push(value),{pollMs:60000});
  try{await client.run({operation:'primitive.box',documentId:'default',requestId:row.requestKey,parameters:{width:1,depth:2,height:3}},async()=>({ok:true,status:200,payload:{ok:true,documentId:'default',modelingTask:{...row,phase:'succeeded',sequence:7,cancellable:false}}}));await client.restore('default');assert.equal(snapshots.at(-1)[0].external,undefined);}finally{client.dispose();}
});
