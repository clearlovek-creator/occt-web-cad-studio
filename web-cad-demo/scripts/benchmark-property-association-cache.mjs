/* Synthetic decoded-metadata benchmark; not native CAD/GPU, peak RSS or
 * exclusive-CPU qualification. Schema cloning is included in both paths. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {resolvePropertySchema} from '../gateway/property-associations.mjs';
import {PropertyAssociationCache} from '../gateway/property-association-cache.mjs';
import {hashFile} from '../gateway/frontend-release.mjs';

const root=path.resolve(import.meta.dirname,'..');
function fixture(scenario){
  const bodyIdentity='a'.repeat(32),topologyIdentity='b'.repeat(32);
  const target=(r,index)=>({kind:'face',bodyId:'body-1',topologyId:`face-${r}-${index}`,topologyRevision:r,bodyIdentity,topologyIdentity:r===9?topologyIdentity:'c'.repeat(32)});
  const count=scenario==='current'?100000:10000;
  const entries=Array.from({length:count},(_,i)=>{const a=target(1,i+1);return {sourceBodyId:a.bodyId,sourceTopologyId:a.topologyId,sourceBodyIdentity:a.bodyIdentity,sourceTopologyIdentity:a.topologyIdentity,inputPreserved:false,destinations:[target(9,i+1)]};});
  return {schema:{types:[],instances:Array.from({length:10000},(_,i)=>({instanceId:'property-'+i,state:'active',target:target(scenario==='current'?9:1,i+1),value:{value:i}}))},view:{ok:true,revision:9,bodyMetadata:[{bodyId:'body-1',bodyIdentity,topologyIdentity,topologyRevision:9,faceCount:count,edgeCount:count}],features:[{computedRevision:9,topologyLineage:{version:1,basis:'occt-history',state:'current',resultRevision:9,entries}}]},historyRecords:count};
}
const sources=['gateway/property-associations.mjs','gateway/property-association-budget.mjs','gateway/property-association-cache.mjs'];
const hashes=()=>Object.fromEntries(sources.map(f=>[f,hashFile(path.join(root,f))]));
if(process.argv[2]==='--child'){
  const [scenario,implementation]=process.argv.slice(3);
  assert.ok(['current','one-hop'].includes(scenario));assert.ok(['uncached','cache'].includes(implementation));
  const f=fixture(scenario),authority={documentId:'benchmark',workerInstance:'12345678-1234-1234-1234-123456789abc',generation:1,stateToken:'d'.repeat(64),stateSequence:1,propertyVersion:1,stable:true};
  let resolves=0;
  const cache=new PropertyAssociationCache({resolve:(s,v)=>{resolves++;return resolvePropertySchema(s,v);}});
  const read=()=>{const view={...f.view};if(implementation==='cache'){cache.observe(view,authority);return cache.read('benchmark',view,{authority:()=>authority,loadSchema:()=>structuredClone(f.schema)});}resolves++;return resolvePropertySchema(structuredClone(f.schema),view);};
  globalThis.gc?.();const start=performance.now(),first=read(),firstMs=performance.now()-start;
  assert.equal(first.instances.filter(i=>i.state==='active').length,10000);
  if(implementation==='cache')assert.equal(first.associationCache.status,'stored');
  const repeatMs=[];
  for(let i=0;i<5;i++){const start=performance.now(),result=read();repeatMs.push(performance.now()-start);assert.equal(result.instances.length,10000);assert.equal(result.instances[9999].value.value,9999);if(implementation==='cache')assert.equal(result.associationCache.hit,true);}
  assert.equal(resolves,implementation==='cache'?1:6);
  console.log(JSON.stringify({scenario,implementation,firstMs,repeatMs,resolves,instances:10000,historyRecords:f.historyRecords,cache:cache.status()}));
}else{
  assert.equal(process.argv.length,2);
  const output=path.resolve(process.env.PROPERTY_ASSOCIATION_CACHE_BENCHMARK||'.artifacts/property-association-cache-benchmark.json');
  assert.ok(!fs.existsSync(output),'Existing benchmark is not overwritten.');
  const before=hashes(),samples=[];
  for(const scenario of ['current','one-hop'])for(const implementation of ['uncached','cache'])for(let iteration=0;iteration<3;iteration++){
    const child=spawn(process.execPath,['--expose-gc','--max-old-space-size=512',import.meta.filename,'--child',scenario,implementation],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',b=>{out+=b;if(out.length>65536)child.kill();});child.stderr.on('data',b=>err=(err+b).slice(-8192));
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,err);
    const sample={...JSON.parse(out),iteration};samples.push(sample);console.log(JSON.stringify(sample));
  }
  assert.deepEqual(hashes(),before);
  const median=a=>{const sorted=[...a].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
  const cases=[];for(const scenario of ['current','one-hop'])for(const implementation of ['uncached','cache']){const rows=samples.filter(s=>s.scenario===scenario&&s.implementation===implementation);cases.push({scenario,implementation,firstMedianMs:median(rows.map(r=>r.firstMs)),repeatMedianMs:median(rows.flatMap(r=>r.repeatMs)),instances:10000,historyRecords:rows[0].historyRecords,encodedCacheBytes:rows[0].cache.bytes});}
  const result={ok:true,nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,osRelease:os.release(),sources:before,samples,cases,paidProviderCalls:0,scope:'Synthetic metadata: construction/import and native I/O excluded; fresh schema cloning included in every timed read. First fill and repeated reads reported separately. Three fresh GC-enabled processes per path, five repeated reads each; no exclusive CPU, peak RSS, industrial CAD/GPU or overall end-to-end guarantee.'};
  fs.writeFileSync(output,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,output,cases}));
}
