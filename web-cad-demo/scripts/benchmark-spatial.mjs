/* Reproducible local HTTP + worker workload. Disposable CAD files, no LLM. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
const root=path.resolve(import.meta.dirname,'..'),worker=path.resolve(process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe'));
const variant=process.env.CAD_BENCH_VARIANT||'local';assert.match(variant,/^[a-zA-Z0-9_-]{1,50}$/);
const counts=(process.env.CAD_BENCH_COUNTS||'10,50,200').split(',').map(Number);assert.ok(counts.length<=8&&counts.every(n=>Number.isSafeInteger(n)&&n>0&&n<=2000));counts.sort((a,b)=>a-b);
const samples=Number(process.env.CAD_BENCH_SAMPLES||10);assert.ok(Number.isSafeInteger(samples)&&samples>=3&&samples<=100);
const port=Number(process.env.CAD_BENCH_PORT||8897);
assert.ok(Number.isSafeInteger(port)&&port>=1024&&port<=65535,'CAD_BENCH_PORT must be a valid local TCP port');assert.ok(fs.existsSync(worker)&&fs.statSync(worker).isFile(),'Build the selected geometry worker before benchmarking');
const api=`http://127.0.0.1:${port}/api`,data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-spatial-benchmark-')),output=path.join(root,'.artifacts/performance',`spatial-${variant}.json`);fs.mkdirSync(path.dirname(output),{recursive:true});
let child;const results=[],states=new Map();let peakGatewayRss=0;
async function request(route,body){const start=performance.now(),response=await fetch(api+route,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(600000)}),text=await response.text(),payload=JSON.parse(text),ms=performance.now()-start;assert.ok(response.ok&&payload.ok,JSON.stringify({route,status:response.status,error:payload.error}));return {payload,ms,bytes:Buffer.byteLength(text)};}
async function cad(operation,parameters={},inputs={}){const old=states.get('bench'),result=await request('/commands',{documentId:'bench',operation,parameters,inputs,baseRevision:old?.revision||0,...(old?.stateToken?{baseStateToken:old.stateToken}:{})});states.set('bench',result.payload);return result;}
async function health(){const result=(await request('/health')).payload;peakGatewayRss=Math.max(peakGatewayRss,result.runtime?.gatewayMemory?.rss||0);return result;}
function distribution(values){const sorted=[...values].sort((a,b)=>a-b);return {samples:sorted.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],minMs:sorted[0],maxMs:sorted.at(-1)};}
try{
  child=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:String(port),GEOMETRY_DATA_DIR:data,GEOMETRY_WORKER_PATH:worker},windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Benchmark gateway startup timeout')),20000);child.once('error',reject);child.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
  await cad('document.summary');let created=0;
  for(const count of counts){const fixtureStart=performance.now();while(created<count){const steps=Array.from({length:Math.min(20,count-created)},(_,i)=>{const index=created+i;return {operation:'primitive.box',parameters:{width:2+(index%3)*.125,depth:3.25,height:4.5,x:(index%20)*10,y:Math.floor(index/20)*10,z:0}};});const state=states.get('bench'),result=await request('/command-batches',{documentId:'bench',baseRevision:state.revision,baseStateToken:state.stateToken,batchId:`benchmark-${created}-${steps.length}`,steps});states.set('bench',result.payload);created+=steps.length;await health();}
    const fixtureBuildMs=performance.now()-fixtureStart,initial=await cad('document.summary'),before=await health(),first=await request('/agent/model/query',{documentId:'bench',kind:'geometry-tree'}),after=await health();
    assert.equal(first.payload.query.spatial.totalBodyCount,count);assert.equal(first.payload.query.spatial.status,'complete');assert.equal(first.payload.query.bodies.length,count);assert.ok(first.payload.query.bodies.every(body=>body.spatial?.bounds));
    const summaryTimes=[],queryTimes=[];let summaryBytes=0,queryBytes=0;
    for(let sample=0;sample<samples;sample++){const summary=await cad('document.summary'),query=await request('/agent/model/query',{documentId:'bench',kind:'geometry-tree'});assert.equal(summary.payload.stateToken,initial.payload.stateToken);assert.equal(query.payload.query.stateToken,initial.payload.stateToken);summaryTimes.push(summary.ms);queryTimes.push(query.ms);summaryBytes=summary.bytes;queryBytes=query.bytes;await health();}
    const firstMeasurementRequests=after.runtime.geometryMeasureRequests-before.runtime.geometryMeasureRequests;
    if(initial.payload.spatialPolicy?.version===1)assert.equal(firstMeasurementRequests,0,'A validated metadata query must not issue one worker measurement per Body');
    results.push({bodyCount:count,featureCount:initial.payload.featureCount,fixtureBuildMs,spatialPolicy:initial.payload.spatialPolicy||'legacy',firstAgentQueryMs:first.ms,firstAgentQueryWorkerMeasurements:firstMeasurementRequests,spatialSources:first.payload.query.spatial.sources,summary:{...distribution(summaryTimes),responseBytes:summaryBytes},geometryQuery:{...distribution(queryTimes),responseBytes:queryBytes},peakGatewayRssBytes:peakGatewayRss});console.log(JSON.stringify(results.at(-1)));
  }
  const report={format:'web-cad-spatial-benchmark',version:1,variant,createdAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,cpuModel:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem()},worker:{fileName:path.basename(worker),sha256:crypto.createHash('sha256').update(fs.readFileSync(worker)).digest('hex')},scope:'local HTTP end-to-end, disjoint parametric Boxes, gateway RSS only; not total native/browser/mesh memory or arbitrary industrial assembly certification',results};fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({report:output,cases:results.length}));
}finally{if(child){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(data).startsWith('cad-spatial-benchmark-'));fs.rmSync(data,{recursive:true,force:true});}
