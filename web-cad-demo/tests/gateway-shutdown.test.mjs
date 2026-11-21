import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {stopTestChild} from './helpers/stop-test-child.mjs';
const root=path.resolve(import.meta.dirname,'..'),api='http://127.0.0.1:8910/api';
async function launch(data,extra={}){
  const child=spawn(process.execPath,['tests/fixtures/gateway-shutdown.mjs'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:'8910',GEOMETRY_SHUTDOWN_GRACE_MS:'2000',GEOMETRY_SHUTDOWN_STOP_MS:'2000',PI_CLI_PATH:path.join(root,'tests/fixtures/pi-rpc-fixture.mjs'),PI_CLI_CWD:root,...extra}});let output='';
  child.events=[];child.stdout.setEncoding('utf8');let lines='';child.stdout.on('data',chunk=>{lines+=chunk;let at;while((at=lines.indexOf('\n'))>=0){const line=lines.slice(0,at);lines=lines.slice(at+1);try{child.events.push(JSON.parse(line));}catch{}}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Shutdown test Gateway startup timeout: '+output)),15000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error('Gateway startup exited: '+code+' '+output));});child.stderr.on('data',chunk=>output+=chunk);child.stdout.on('data',chunk=>{output+=chunk;if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});return child;
}
async function post(route,body){const response=await fetch(api+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});return response.json();}
async function restoredMeshJobs(){const deadline=Date.now()+10000;for(;;){const response=await fetch(api+'/documents/default/mesh/jobs',{signal:AbortSignal.timeout(5000)}),jobs=await response.json();if(jobs.ok){assert.equal(response.status,200);assert.ok(Array.isArray(jobs.jobs));return jobs;}assert.equal(response.status,503,JSON.stringify(jobs));assert.equal(jobs.code,'MESH_CATALOG_RECOVERING',JSON.stringify(jobs));assert.equal(jobs.meshCatalog?.state,'recovering');assert.ok(Date.now()<deadline,'Mesh catalog did not finish recovering: '+JSON.stringify(jobs));await new Promise(resolve=>setTimeout(resolve,5));}}
async function observedExit(child,ms=1500){if(child.exitCode!==null||child.signalCode!==null)return true;return new Promise(resolve=>{const exit=()=>{clearTimeout(timer);resolve(true);},timer=setTimeout(()=>{child.off('exit',exit);resolve(false);},ms);child.once('exit',exit);});}
const tell=(child,type)=>child.stdin.write(JSON.stringify({type})+'\n');
async function event(child,type){const until=Date.now()+5000;for(;;){const value=child.events.find(item=>item.type===type);if(value)return value;assert.ok(Date.now()<until,'Expected actual fixture event: '+type);await new Promise(resolve=>setTimeout(resolve,5));}}
async function stopViaControl(data){const control=JSON.parse(fs.readFileSync(path.join(data,'.gateway-control.json'))),response=await fetch(api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':control.token},body:'{}'});assert.equal(response.status,202);return response.json();}
const cad=(operation,parameters={},extra={})=>post('/commands',{documentId:'default',operation,parameters,...extra});
function cleanup(data){assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
test('service shutdown closes idle native Pi SSE and exits without requiring a forced process kill',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-shutdown-sse-'));let child;const abort=new AbortController();
  try{child=await launch(data);const session=await post('/pi/sessions',{sessionId:'stop-test',documentId:'default'});assert.equal(session.ok,true);const response=await fetch(api+`/pi/sessions/stop-test/events?documentId=default&streamId=${session.streamId}&after=${session.eventCursor}`,{signal:abort.signal});const reader=response.body.getReader();await reader.read();child.stdin.write(JSON.stringify({type:'shutdown'})+'\n');assert.equal(await observedExit(child),true,'Idle SSE must not keep the stopped Gateway and its data-directory ownership alive');assert.equal(child.exitCode,0);}
  finally{abort.abort();await stopTestChild(child);assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
});

test('the private shutdown channel rejects missing credentials, browser origins and stale credentials',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-shutdown-auth-'));let child;
  try{child=await launch(data);const control=JSON.parse(fs.readFileSync(path.join(data,'.gateway-control.json')));for(const headers of [{},{'x-cad-shutdown-token':'0'.repeat(64)},{'x-cad-shutdown-token':control.token,Origin:'http://localhost:3000'}]){const response=await fetch(api+'/runtime/shutdown',{method:'POST',headers});assert.equal(response.status,403);}assert.equal((await cad('document.summary')).ok,true);await stopViaControl(data);assert.equal(await observedExit(child,6000),true);assert.equal(child.exitCode,0);assert.equal(fs.existsSync(path.join(data,'.gateway-control.json')),false);child=await launch(data);const response=await fetch(api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':control.token}});assert.equal(response.status,403);assert.equal((await cad('document.summary')).ok,true);}
  finally{await stopTestChild(child);cleanup(data);}
});

test('shutdown drains an already executed native mutation while rejecting queued commands without executing them',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-shutdown-drain-'));let child;
  try{child=await launch(data);const baseline=await cad('primitive.box',{width:10,depth:10,height:10});tell(child,'arm-geometry');await event(child,'fixture.geometry-armed');const request={operation:'primitive.box',parameters:{width:5,depth:6,height:7,x:30},requestId:'drained-once'},first=cad(request.operation,request.parameters,{requestId:request.requestId});const held=await event(child,'fixture.geometry-held');assert.equal(held.bodyCount,2,'The real native geometry must already have changed');const queued=cad('primitive.sphere',{radius:2,x:60},{requestId:'queued-must-not-run'});
    for(let i=0;i<100;i++){const health=await fetch(api+'/health').then(response=>response.json());if(health.lifecycle.queuedDocumentActions)break;assert.ok(i<99);await new Promise(resolve=>setTimeout(resolve,5));}
    await stopViaControl(data);const cancelled=await queued;assert.equal(cancelled.code,'SERVICE_STOPPING');assert.equal(child.exitCode,null);tell(child,'release-geometry');const committed=await first;assert.equal(committed.ok,true);assert.equal(committed.bodyCount,2);assert.equal(await observedExit(child,6000),true);assert.equal(child.exitCode,0);assert.equal(child.events.filter(item=>item.type==='fixture.geometry-start').length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(data,'.gateway-last-shutdown.json'))).state,'complete');
    child=await launch(data);const restored=await cad('document.summary');assert.equal(restored.bodyCount,2);assert.notEqual(restored.stateToken,baseline.stateToken);assert.equal(restored.stateToken,committed.stateToken);const replay=await cad(request.operation,request.parameters,{requestId:request.requestId});assert.equal(replay.revision,committed.revision);assert.equal((await cad('document.summary')).bodyCount,2);
  }finally{await stopTestChild(child);cleanup(data);}
});

test('a drain deadline preserves an unfinished journal, never restarts the geometry worker, and restores the complete baseline',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-shutdown-deadline-'));let child;
  try{child=await launch(data,{GEOMETRY_SHUTDOWN_GRACE_MS:'100',GEOMETRY_SHUTDOWN_STOP_MS:'1000'});await cad('property.type.create',{key:'KeepType',fields:[]});const baseline=await cad('primitive.box',{width:10,depth:10,height:10});tell(child,'arm-geometry');await event(child,'fixture.geometry-armed');const pending=cad('primitive.box',{width:5,depth:6,height:7,x:30},{requestId:'interrupted-mutation'}).catch(()=>null);assert.equal((await event(child,'fixture.geometry-held')).bodyCount,2);await stopViaControl(data);await pending;assert.equal(await observedExit(child,6000),true);assert.equal(child.exitCode,1);assert.equal(child.events.filter(item=>item.type==='fixture.geometry-start').length,1,'Rollback during stopping must not launch a replacement native process');assert.ok(fs.readdirSync(path.join(data,'document-transactions')).some(file=>file.endsWith('.pending.json')));assert.equal(JSON.parse(fs.readFileSync(path.join(data,'.gateway-last-shutdown.json'))).state,'interrupted');
    child=await launch(data);const restored=await cad('document.summary');assert.equal(restored.bodyCount,1);assert.equal(restored.revision,baseline.revision);assert.equal(restored.bodyMetadata[0].bodyIdentity,baseline.bodyMetadata[0].bodyIdentity);assert.ok((await cad('property.type.list')).types.some(type=>type.key==='KeepType'));assert.deepEqual(fs.readdirSync(path.join(data,'document-transactions')),[]);assert.equal(restored.features.length,baseline.features.length);
  }finally{await stopTestChild(child);cleanup(data);}
});

test('an admitted but incomplete upload cannot become a new CAD operation after shutdown begins',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-shutdown-upload-'));let child,upload;
  try{
    child=await launch(data);const baseline=await cad('primitive.box',{width:10,depth:10,height:10});
    const body=JSON.stringify({documentId:'default',operation:'primitive.sphere',requestId:'late-upload',parameters:{radius:3,x:50}});
    const admittedBefore=child.events.filter(item=>item.type==='fixture.request-admitted'&&item.path==='/api/commands').length;
    const reply=new Promise((resolve,reject)=>{
      upload=httpRequest(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{
        let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,payload:JSON.parse(text)}));response.on('error',reject);
      });upload.on('error',reject);upload.write(body.slice(0,12));
    });reply.catch(()=>{});
    for(let i=0;i<100;i++){if(child.events.filter(item=>item.type==='fixture.request-admitted'&&item.path==='/api/commands').length>admittedBefore)break;assert.ok(i<99,'The real server must have admitted this partial body before stopping');await new Promise(resolve=>setTimeout(resolve,5));}
    await stopViaControl(data);upload.end(body.slice(12));const response=await reply;
    assert.equal(response.status,503);assert.equal(response.payload.code,'SERVICE_STOPPING');
    assert.equal(await observedExit(child,6000),true);assert.equal(child.exitCode,0);
    assert.equal(child.events.filter(item=>item.type==='fixture.geometry-start').length,1);
    child=await launch(data);const restored=await cad('document.summary');assert.equal(restored.stateToken,baseline.stateToken);assert.equal(restored.bodyCount,1);
  }finally{upload?.destroy();await stopTestChild(child);cleanup(data);}
});

test('draining retains exclusive data ownership until the exact old Gateway exits',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-shutdown-owner-'));let child,probe;
  try{
    child=await launch(data);const baseline=await cad('primitive.box',{width:10,depth:10,height:10});
    tell(child,'arm-geometry');await event(child,'fixture.geometry-armed');
    const pending=cad('primitive.box',{width:5,depth:6,height:7,x:30},{requestId:'owner-drain'});pending.catch(()=>{});
    await event(child,'fixture.geometry-held');await stopViaControl(data);
    assert.equal(child.exitCode,null);
    const control=fs.readFileSync(path.join(data,'.gateway-control.json'));
    let diagnostics='';probe=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GEOMETRY_PORT:'8911',GEOMETRY_DATA_DIR:data}});
    probe.stdout.on('data',chunk=>diagnostics+=chunk);probe.stderr.on('data',chunk=>diagnostics+=chunk);
    assert.equal(await observedExit(probe,3000),true,'A replacement must fail fast, not wait for and steal the draining owner');assert.notEqual(probe.exitCode,0);assert.match(diagnostics,/DATA_DIRECTORY_IN_USE/);
    assert.deepEqual(fs.readFileSync(path.join(data,'.gateway-control.json')),control,'Rejected replacement must not overwrite live shutdown credentials');
    tell(child,'release-geometry');const committed=await pending;assert.equal(committed.ok,true);assert.equal(await observedExit(child,6000),true);assert.equal(child.exitCode,0);
    child=await launch(data);const restored=await cad('document.summary');assert.equal(restored.stateToken,committed.stateToken);assert.notEqual(restored.stateToken,baseline.stateToken);
  }finally{await stopTestChild(probe);await stopTestChild(child);cleanup(data);}
});

test('mesh shutdown keeps the task stopping until its exact real Gmsh process exits, then persists interruption',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-shutdown-mesh-'));let child;
  try{child=await launch(data);const baseline=await cad('primitive.box',{width:10,depth:10,height:10});tell(child,'arm-mesh');await event(child,'fixture.mesh-armed');const accepted=await post('/documents/default/mesh/jobs',{background:true});assert.equal(accepted.ok,true);const held=await event(child,'fixture.mesh-held');assert.ok(held.nodeCount>0);await stopViaControl(data);const stopping=await event(child,'fixture.mesh-exit-held');assert.equal(stopping.pid,held.pid);assert.equal(stopping.exitCode,null);assert.equal(child.exitCode,null);const metadataFile=path.join(data,'mesh-jobs/default',accepted.meshJob.jobId,'metadata.json');assert.equal(JSON.parse(fs.readFileSync(metadataFile)).state,'cancelling');assert.equal(fs.existsSync(path.join(path.dirname(metadataFile),'result.json')),false);tell(child,'release-mesh-exit');assert.equal(await observedExit(child,6000),true);assert.equal(child.exitCode,0);assert.equal(JSON.parse(fs.readFileSync(metadataFile)).state,'interrupted');assert.ok(child.events.some(item=>item.type==='fixture.mesh-exit'&&item.pid===held.pid));child=await launch(data);const restored=await cad('document.summary');assert.equal(restored.stateToken,baseline.stateToken);const jobs=await restoredMeshJobs();assert.equal(jobs.jobs[0].state,'interrupted');assert.equal(jobs.jobs[0].visible,false);
  }finally{await stopTestChild(child);cleanup(data);}
});
