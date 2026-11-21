/* Real OCCT writes and exact-result replay in a disposable project. No LLM. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mutation-retention-'));
const worker=path.resolve(process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe'));assert.ok(fs.existsSync(worker),'Build the selected OCCT worker first');
const counts=(process.env.CAD_BENCH_COUNTS||'10,50,200').split(',').map(Number),samples=Number(process.env.CAD_BENCH_SAMPLES||20),port=Number(process.env.CAD_BENCH_PORT||8906);
assert.ok(counts.length<=8&&counts.every(n=>Number.isSafeInteger(n)&&n>0&&n<=1000));assert.ok(Number.isSafeInteger(samples)&&samples>=3&&samples<=50);assert.ok(Number.isSafeInteger(port)&&port>=1024&&port<=65535);counts.sort((a,b)=>a-b);
const variant=process.env.CAD_BENCH_VARIANT||'release';assert.match(variant,/^[A-Za-z0-9_-]{1,50}$/);
const api=`http://127.0.0.1:${port}/api`,output=path.join(root,'.artifacts/performance',`mutation-retention-${variant}.json`);fs.mkdirSync(path.dirname(output),{recursive:true});
let gateway,state,created=0;const cases=[];
async function start(){const began=performance.now();gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:String(port),GEOMETRY_WORKER_PATH:worker}});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Mutation benchmark Gateway startup timeout')),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});return performance.now()-began;}
async function stop(){if(!gateway)return;const child=gateway;gateway=null;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
async function request(route,body){const began=performance.now(),response=await fetch(api+route,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(300000)}),text=await response.text(),payload=JSON.parse(text);assert.ok(response.ok&&payload.ok,JSON.stringify({route,code:payload.code,error:payload.error}));return {payload,ms:performance.now()-began,bytes:Buffer.byteLength(text)};}
async function cad(operation,parameters={},extra={}){const result=await request('/commands',{documentId:'bench',operation,parameters,...(state?{baseRevision:state.revision,baseStateToken:state.stateToken}:{}),...extra});state=result.payload;return result;}
function distribution(values){const sorted=values.toSorted((a,b)=>a-b);return {samples:values.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],minMs:sorted[0],maxMs:sorted.at(-1)};}
try{
  await start();await cad('document.summary');
  for(const count of counts){
    const began=performance.now();
    while(created<count){const size=Math.min(20,count-created),result=await request('/command-batches',{documentId:'bench',batchId:'build-'+created,baseRevision:state.revision,baseStateToken:state.stateToken,steps:Array.from({length:size},(_,i)=>({operation:'primitive.box',parameters:{width:2.5,depth:3.25,height:4.75,x:((created+i)%20)*10,y:Math.floor((created+i)/20)*10}}))});state=result.payload;created+=size;}
    const fixtureBuildMs=performance.now()-began,times=[],responseBytes=[],integrityBefore=(await request('/health')).payload.storage.checkpointIntegrity;let firstInput,firstResult;
    for(let sample=0;sample<samples;sample++){
      const input={documentId:'bench',operation:'variable.set',requestId:`write-${count}-${sample}`,baseRevision:state.revision,baseStateToken:state.stateToken,parameters:{name:'benchScalar',type:'dimensionless',expression:String(sample+1)}},result=await request('/commands',input);state=result.payload;times.push(result.ms);responseBytes.push(result.bytes);if(!sample){firstInput=input;firstResult=result.payload;}
    }
    const finalToken=state.stateToken,finalRevision=state.revision,health=(await request('/health')).payload,directory=path.join(data,'history/bench'),manifestFile=path.join(directory,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));
    assert.ok(manifest.idempotency.every(entry=>entry.responseRef&&!Object.hasOwn(entry,'response')));assert.ok(manifest.idempotency.length<=health.capabilities.idempotencyRetention.maxEntriesPerDocument);
    const retainedOutcomeBytes=manifest.idempotency.reduce((sum,entry)=>sum+entry.responseRef.bytes,0),manifestBytes=fs.statSync(manifestFile).size;assert.ok(retainedOutcomeBytes<=health.capabilities.idempotencyRetention.maxSerializedOutcomeBytesPerDocument);
    const integrityAfter=health.storage.checkpointIntegrity,checkpointIntegrity=integrityAfter?{strategy:integrityAfter.strategy,readBufferBytes:integrityAfter.readBufferBytes,geometryFiles:integrityAfter.geometryFiles-integrityBefore.geometryFiles,geometryBytes:integrityAfter.geometryBytes-integrityBefore.geometryBytes,geometryReadMs:integrityAfter.geometryReadMs-integrityBefore.geometryReadMs,repairPasses:integrityAfter.passes.repair-integrityBefore.passes.repair,commitPasses:integrityAfter.passes.commit-integrityBefore.passes.commit}:null;
    if(checkpointIntegrity){assert.equal(checkpointIntegrity.repairPasses,samples);assert.equal(checkpointIntegrity.commitPasses,samples);assert.equal(checkpointIntegrity.readBufferBytes,1024*1024);}
    const replay=await request('/commands',firstInput);assert.deepEqual(replay.payload,firstResult);assert.equal((await cad('document.summary')).payload.stateToken,finalToken);
    await stop();const restartReadyMs=await start(),cold=(await request('/health')).payload;assert.equal(cold.loadedDocuments,0);
    const restartedReplay=await request('/commands',firstInput);assert.deepEqual(restartedReplay.payload,firstResult);await cad('document.summary');assert.equal(state.stateToken,finalToken);assert.equal(state.revision,finalRevision);assert.equal(state.bodyCount,count);
    const retainedFiles=fs.readdirSync(path.join(directory,'outcomes')).filter(name=>/^outcome-/.test(name)),physicalOutcomeBytes=retainedFiles.reduce((sum,name)=>sum+fs.statSync(path.join(directory,'outcomes',name)).size,0);
    const result={bodyCount:count,featureCount:state.featureCount,fixtureBuildMs,writeLatency:distribution(times),checkpointIntegrity,responseBytes:{min:Math.min(...responseBytes),max:Math.max(...responseBytes)},manifestBytes,retainedEntries:manifest.idempotency.length,retainedOutcomeBytes,physicalOutcomeBytes,manifestToOutcomeRatio:manifestBytes/retainedOutcomeBytes,gatewayHeapUsedAfterWrites:health.runtime.gatewayMemory.heapUsed,gatewayRssAfterWrites:health.runtime.gatewayMemory.rss,coldGatewayHeapUsed:cold.runtime.gatewayMemory.heapUsed,restartReadyMs,replayMs:replay.ms,restartedReplayMs:restartedReplay.ms,geometryUnchangedByReplay:true};cases.push(result);console.log(JSON.stringify(result));
  }
  const sources={};for(const file of ['gateway/server.mjs','gateway/history-store.mjs','gateway/checkpoint-reader.mjs','gateway/idempotency-outcome-store.mjs','gateway/project-transaction-service.mjs','scripts/benchmark-mutation-retention.mjs','package-lock.json'])sources[file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
  const report={format:'web-cad-mutation-retention-benchmark',version:1,variant,createdAt:new Date().toISOString(),inputs:{counts,samples},worker:{fileName:path.basename(worker),sha256:crypto.createHash('sha256').update(fs.readFileSync(worker)).digest('hex')},environment:{node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length},scope:'real local OCCT Box batches and scalar variable writes; exact replay after other edits and Gateway restart; Gateway memory only, not native/browser total or arbitrary industrial assembly qualification; OS caches not cleared and no exclusive CPU reservation',sources,cases};fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,report:output,cases:cases.length}));
}finally{await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(data).startsWith('cad-mutation-retention-'));fs.rmSync(data,{recursive:true,force:true});}
