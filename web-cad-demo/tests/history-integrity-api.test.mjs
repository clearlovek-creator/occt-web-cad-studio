import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {stopTestChild} from './helpers/stop-test-child.mjs';

const root=path.resolve(import.meta.dirname,'..'),api='http://127.0.0.1:8912/api';
let state;
async function launch(data){
  state=null;
  const child=spawn(process.execPath,['tests/fixtures/gateway-shutdown.mjs'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GEOMETRY_PORT:'8912',GEOMETRY_DATA_DIR:data}});child.events=[];let buffer='',diagnostics='';
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{child.events.push(JSON.parse(line));}catch{}}});child.stderr.on('data',chunk=>diagnostics+=chunk);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('History integrity test startup timeout: '+diagnostics)),15000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error('History integrity test exited: '+code+' '+diagnostics));});child.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});return child;
}
async function request(route,body){const response=await fetch(api+route,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});return response.json();}
const cad=async(operation,parameters={},extra={})=>{const result=await request('/commands',{documentId:'integrity',operation,parameters,...(state?{baseRevision:state.revision,baseStateToken:state.stateToken}:{}),...extra});if(result.ok)state=result;return result;};
async function until(predicate){const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'Expected real native reply gate');await new Promise(resolve=>setTimeout(resolve,5));}}
const tell=(child,type)=>child.stdin.write(JSON.stringify({type})+'\n');
function clean(data){assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}

test('single edits, batches and Undo/Redo each perform one preflight history pass and retain full commit verification',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-history-io-api-'));let child;
  try{
    child=await launch(data);assert.equal((await cad('primitive.box',{width:10,depth:10,height:10})).ok,true);
    const actions=[()=>cad('primitive.sphere',{radius:2,x:30}),()=>cad('variable.set',{name:'testScalar',type:'dimensionless',expression:'2'}),()=>cad('document.undo'),()=>cad('document.redo'),()=>request('/command-batches',{documentId:'integrity',baseRevision:state.revision,baseStateToken:state.stateToken,steps:[{operation:'primitive.box',parameters:{width:3,depth:4,height:5,x:60}},{operation:'primitive.sphere',parameters:{radius:1,x:80}}]})];
    for(const action of actions){const before=(await request('/health')).storage.checkpointIntegrity,result=await action();assert.equal(result.ok,true,JSON.stringify(result));const after=(await request('/health')).storage.checkpointIntegrity;assert.equal(after.passes.repair-before.passes.repair,1);assert.equal(after.passes.commit-before.passes.commit,1);assert.ok(after.geometryFiles>before.geometryFiles);assert.ok(after.geometryBytes>before.geometryBytes);assert.equal(after.readBufferBytes,1024*1024);}
  }finally{await stopTestChild(child);clean(data);}
});

for(const kind of ['geometry','properties'])test(`commit still detects old ${kind} corruption introduced after preflight and preserves recovery evidence`,async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-history-integrity-race-'));let child;
  try{
    child=await launch(data);await cad('primitive.box',{width:10,depth:10,height:10});const baseline=await cad('primitive.sphere',{radius:2,x:30});
    const directory=path.join(data,'history/integrity'),manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'))),file=path.join(directory,manifest.undo[0])+(kind==='properties'?'.properties.json':''),original=fs.readFileSync(file);
    tell(child,'arm-geometry');await until(()=>child.events.some(item=>item.type==='fixture.geometry-armed'));
    const pending=cad('primitive.box',{width:3,depth:4,height:5,x:60});pending.catch(()=>{});await until(()=>child.events.some(item=>item.type==='fixture.geometry-held'));
    const changed=Buffer.from(original);changed[changed.length-1]^=1;fs.writeFileSync(file,changed);tell(child,'release-geometry');const result=await pending;assert.equal(result.ok,false,'A successful native reply cannot override corrupted retained history');assert.equal(result.code,'PROJECT_ROLLBACK_FAILED');assert.equal(result.recoverable,false);
    assert.ok(fs.existsSync(path.join(data,'document-transactions/integrity.pending.json')));assert.deepEqual(fs.readFileSync(file),changed,'Corruption evidence must not be silently overwritten');
    const blocked=await cad('primitive.sphere',{radius:1,x:80});assert.equal(blocked.code,'PROJECT_RECOVERY_REQUIRED');assert.equal(blocked.recoverable,false);
    // Explicit storage repair is test-only; normal startup must never invent it.
    await stopTestChild(child);fs.writeFileSync(file,original);child=await launch(data);const restored=await cad('document.summary');assert.equal(restored.ok,true);assert.equal(restored.bodyCount,baseline.bodyCount);assert.equal(restored.revision,baseline.revision);assert.equal(restored.features.length,baseline.features.length);assert.deepEqual(fs.readdirSync(path.join(data,'document-transactions')),[]);
  }finally{await stopTestChild(child);clean(data);}
});
