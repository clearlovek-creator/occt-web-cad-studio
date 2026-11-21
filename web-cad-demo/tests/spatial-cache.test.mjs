import test from 'node:test';
import assert from 'node:assert/strict';
import {SpatialMeasurementCache,compactSpatialMeasurement} from '../gateway/spatial-cache.mjs';
import {nearestBoundsRelations} from '../gateway/spatial-relations.mjs';
const view=(identity='b'.repeat(32))=>({revision:5,bodyMetadata:[{bodyId:'body-1',bodyIdentity:'a'.repeat(32),topologyIdentity:identity,topologyRevision:5}]});
test('cached measurements never retain whole model trees, materials, properties or presentation buffers',()=>{
  const metadata={ok:true,bodyId:'body-1',volume:12,edgeLengthPolicy:'unique-topological-edges',bounds:{min:[0,0,0],max:[1,2,6]},spatialPolicy:{version:1}},result=compactSpatialMeasurement({...metadata,features:[{id:'huge-tree'}],bodyMetadata:Array(1000).fill({}),positions:Array(10000).fill(1),materials:[{private:'not geometry'}]});assert.deepEqual(result,metadata);
});
test('spatial cache isolates equal-revision branches, old workers, document lifetimes and bounded LRU measurements',async()=>{
  const cache=new SpatialMeasurementCache({maxDocuments:2,maxMeasurements:2});let calls=0;const load=async()=>({ok:true,value:++calls});
  assert.equal((await cache.read('doc',view(),'body',load)).measurement.value,1);assert.equal((await cache.read('doc',view(),'body',load)).cached,true);
  assert.equal((await cache.read('doc',view('c'.repeat(32)),'body',load)).measurement.value,2,'An abandoned branch must not reuse the same-R result');
  const legacy={revision:5,bodyMetadata:[{bodyId:'body-1',topologyRevision:5}]};await cache.read('legacy',legacy,'body',load);assert.equal((await cache.read('legacy',legacy,'body',load)).cached,true);assert.equal((await cache.read('legacy',structuredClone(legacy),'body',load)).cached,false);
  const v=view();await cache.read('doc',v,'face-1',load);await cache.read('doc',v,'face-2',load);await cache.read('doc',v,'face-3',load);assert.equal(cache.documents.get('doc').measurements.size,2);assert.equal((await cache.read('doc',v,'face-1',load)).cached,false);
  await cache.read('third',v,'body',load);assert.equal(cache.documents.size,2);
});
test('spatial cache deduplicates pending reads, never caches failures and never lets late old results replace a new branch',async()=>{
  const cache=new SpatialMeasurementCache();let finish,calls=0;const old=cache.read('doc',view(),'body',()=>{calls++;return new Promise(resolve=>finish=resolve);});const duplicate=cache.read('doc',view(),'body',()=>{throw Error('Should deduplicate');});await Promise.resolve();assert.equal(calls,1);
  const next=view('c'.repeat(32));assert.equal((await cache.read('doc',next,'body',async()=>({ok:true,value:'new'}))).measurement.value,'new');finish({ok:true,value:'old'});assert.equal((await old).measurement.value,'old');await duplicate;assert.equal((await cache.read('doc',next,'body',()=>{throw Error('Must stay cached');})).measurement.value,'new');
  let attempts=0;const failing=()=>{attempts++;throw Error('Temporary measurement error');};assert.equal((await cache.read('doc',next,'bad',failing)).measurement,null);await cache.read('doc',next,'bad',failing);assert.equal(attempts,2);
});
const relation=(a,first,b,second)=>({bodyA:a,bodyB:b,gap:Math.hypot(...first.bounds.min.map((v,i)=>Math.max(0,v-second.bounds.max[i],second.bounds.min[i]-first.bounds.max[i])))});
const compare=(a,b)=>a.gap-b.gap||(a.bodyA<b.bodyA?-1:a.bodyA>b.bodyA?1:0)||(a.bodyB<b.bodyB?-1:a.bodyB>b.bodyB?1:0);
test('bounded nearest AABB relations match exhaustive top-K for ties, overlap, nesting, negative coordinates and shuffled input',()=>{
  const entries=Array.from({length:80},(_,i)=>{const min=[Math.sin(i*9)*30,Math.cos(i*7)*20,i%5],size=[i%7+1,i%4+1,i%3+1];return [`body-${i}`,{bounds:{min,max:min.map((x,axis)=>x+size[axis])}}];});entries.push(['overlap',{bounds:entries[4][1].bounds}],['nested',{bounds:{min:[-100,-100,-100],max:[100,100,100]}}]);
  const sorted=[...entries].sort((a,b)=>a[0]<b[0]?-1:1),all=[];for(let a=0;a<sorted.length;a++)for(let b=a+1;b<sorted.length;b++)all.push(relation(sorted[a][0],sorted[a][1],sorted[b][0],sorted[b][1]));all.sort(compare);
  for(const limit of [1,8,32,4000])assert.deepEqual(nearestBoundsRelations(new Map([...entries].reverse()),relation,limit),all.slice(0,limit));
  let calls=0;const large=new Map(Array.from({length:2000},(_,i)=>[`body-${i}`,{bounds:{min:[i*10,0,0],max:[i*10+1,1,1]}}]));const result=nearestBoundsRelations(large,(...args)=>{calls++;return relation(...args);});assert.equal(result.length,32);assert.ok(calls<2000*50,`Sweep pruning must avoid exhaustive separated-box work; calls=${calls}`);
});
