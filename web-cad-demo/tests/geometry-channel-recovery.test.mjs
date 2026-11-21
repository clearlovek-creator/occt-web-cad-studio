import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {stopTestChild} from './helpers/stop-test-child.mjs';

const root=path.resolve(import.meta.dirname,'..');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function launch(data,extra={}){
  const port=await freePort(),api=`http://127.0.0.1:${port}/api`,child=spawn(process.execPath,['tests/fixtures/gateway-shutdown.mjs'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:String(port),GEOMETRY_WORKER_TIMEOUT_MS:'500',GEOMETRY_WORKER_STARTUP_TIMEOUT_MS:'5000',GEOMETRY_WORKER_STOP_TIMEOUT_MS:'2000',...extra}});
  const events=[];let lines='',diagnostics='',ready=false;child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready'))ready=true;lines+=chunk;let at;while((at=lines.indexOf('\n'))>=0){const line=lines.slice(0,at);lines=lines.slice(at+1);try{events.push(JSON.parse(line));}catch{}}});child.stderr.on('data',chunk=>diagnostics=(diagnostics+chunk).slice(-32768));
  const until=Date.now()+15000;while(!ready){assert.equal(child.exitCode,null,diagnostics);assert.ok(Date.now()<until,'Private recovery fixture startup unconfirmed: '+diagnostics);await tick();}
  const tell=type=>child.stdin.write(JSON.stringify({type})+'\n');
  const event=async(type,offset=0)=>{const deadline=Date.now()+5000;for(;;){const found=events.slice(offset).find(value=>value.type===type);if(found)return found;assert.ok(Date.now()<deadline,'Expected real native event '+type+'\n'+diagnostics);await tick();}};
  const get=async route=>fetch(api+route).then(response=>response.json());
  const raw=async(operation,parameters={},inputs={},documentId='default')=>{const state=await get('/documents/'+documentId);const response=await fetch(api+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation,parameters,inputs,documentId,baseRevision:state.revision,baseStateToken:state.stateToken})});return {status:response.status,value:await response.json()};};
  const cad=async(...args)=>{const {status,value}=await raw(...args);assert.equal(status,200,JSON.stringify(value));assert.equal(value.ok,true);return value;};
  async function stop(){
    tell('release-geometry-exit');tell('release-geometry');
    if(child.exitCode==null&&child.signalCode==null){const control=JSON.parse(fs.readFileSync(path.join(data,'.gateway-control.json')));const ended=new Promise(resolve=>child.once('close',resolve));await fetch(api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':control.token}}).catch(()=>{});let timer;try{await Promise.race([ended,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Recovery fixture stop unconfirmed')),10000))]);}finally{clearTimeout(timer);}}
    await stopTestChild(child);
  }
  return {child,events,api,get,raw,cad,tell,event,stop};
}
async function seeded(f){
  const box=await f.cad('primitive.box',{width:10,depth:20,height:30}),type=await f.cad('property.type.create',{key:'RecoveryBoundary',targetScope:'body',association:'required',fields:[{key:'enabled',type:'bool'}]});
  await f.cad('property.instance.create',{typeId:type.type.typeId,value:{enabled:true},target:{kind:'body',bodyId:box.bodyId}});await f.cad('property.set',{key:'recoveryMarker',type:'int',value:42},{kind:'body',bodyId:box.bodyId});
  return {model:await f.cad('document.summary'),raw:(await f.cad('property.list')).propertyRecords,typed:(await f.cad('property.instance.list')).instances};
}
async function assertRestored(f,before,{sameToken=true}={}){
  const model=await f.cad('document.summary');for(const key of ['revision','features','bodyMetadata','entityIdentities','coordinateSystems'])assert.deepEqual(model[key],before.model[key],key);if(sameToken)assert.equal(model.stateToken,before.model.stateToken);
  assert.deepEqual((await f.cad('property.list')).propertyRecords,before.raw);assert.deepEqual((await f.cad('property.instance.list')).instances,before.typed);assert.equal(model.bodyCount,1);
}
function cleanup(data){assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-native-recovery-/);fs.rmSync(data,{recursive:true,force:true});}

test('a real executed mutation times out without publishing its late reply, waits for actual native exit, then restores the complete old project',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-native-recovery-'));let f;
  try{f=await launch(data);const before=await seeded(f);f.tell('arm-geometry');await f.event('fixture.geometry-armed');f.tell('arm-geometry-exit');await f.event('fixture.geometry-exit-armed');
    let settled=false;const pending=f.raw('primitive.box',{width:5,depth:6,height:7,x:30}).finally(()=>settled=true);pending.catch(()=>{});const held=await f.event('fixture.geometry-held');assert.equal(held.bodyCount,2);const kill=await f.event('fixture.geometry-exit-held');assert.equal(kill.pid,held.pid);assert.equal(settled,false);
    f.tell('release-geometry');await tick();const health=await f.get('/health');assert.equal(health.runtime.workerChannel.state,'retiring');assert.equal(health.worker,false);assert.equal(settled,false);assert.equal(f.events.filter(value=>value.type==='fixture.geometry-start').length,1);
    f.tell('release-geometry-exit');const result=await pending;assert.equal(result.status,504,JSON.stringify(result.value));assert.equal(result.value.code,'WORKER_TIMEOUT');assert.deepEqual(result.value.projectRollback,{documentId:'default',confirmed:true});await f.event('fixture.geometry-exit');await assertRestored(f,before);assert.equal(f.events.filter(value=>value.type==='fixture.geometry-start').length,2);assert.equal(fs.readdirSync(path.join(data,'document-transactions')).some(file=>file.endsWith('.pending.json')),false);
    assert.equal((await f.cad('primitive.box',{width:2,depth:3,height:4,x:50})).bodyCount,2,'A fresh explicit operation remains possible after proven restoration');
  }finally{await f?.stop();cleanup(data);}
});
test('a real timed-out STEP import is failed, not unknown, only after confirmed exit and complete project rollback',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-native-recovery-'));let f;
  try{f=await launch(data);const before=await seeded(f);await f.cad('primitive.box',{width:4,depth:5,height:6},{},'source');const exported=await fetch(f.api+'/documents/source/exports/step',{method:'POST'}).then(response=>response.json()),bytes=await fetch(new URL(exported.downloadUrl,f.api)).then(response=>response.arrayBuffer());
    f.tell('arm-step');await f.event('fixture.step-armed');f.tell('arm-geometry-exit');await f.event('fixture.geometry-exit-armed');
    const requestId='timed-out-step',pending=fetch(f.api+'/documents/default/imports/step',{method:'POST',headers:{'content-type':'application/step','x-request-id':requestId},body:bytes}).then(async response=>({status:response.status,value:await response.json()}));pending.catch(()=>{});await f.event('fixture.step-held');await f.event('fixture.geometry-exit-held');f.tell('release-geometry');f.tell('release-geometry-exit');const result=await pending;assert.equal(result.value.code,'WORKER_TIMEOUT');assert.equal(result.value.projectRollback.confirmed,true);
    const status=await f.get('/documents/default/imports/step/status?requestId='+requestId);assert.equal(status.stepImportStatus.phase,'failed');await assertRestored(f,before);
  }finally{await f?.stop();cleanup(data);}
});
test('unconfirmed real native termination blocks replacement and retains transaction evidence until explicit exit and service recovery',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-native-recovery-'));let f;
  try{f=await launch(data,{GEOMETRY_WORKER_STOP_TIMEOUT_MS:'40'});const before=await seeded(f);f.tell('arm-geometry');await f.event('fixture.geometry-armed');f.tell('arm-geometry-exit');await f.event('fixture.geometry-exit-armed');const pending=f.raw('primitive.box',{width:5,depth:6,height:7,x:30});pending.catch(()=>{});await f.event('fixture.geometry-held');await f.event('fixture.geometry-exit-held');const result=await pending;assert.equal(result.value.code,'PROJECT_ROLLBACK_FAILED');assert.equal(result.value.projectRollback,undefined);assert.equal((await f.get('/health')).runtime.workerChannel.state,'blocked');assert.equal(f.events.filter(value=>value.type==='fixture.geometry-start').length,1);assert.ok(fs.readdirSync(path.join(data,'document-transactions')).some(file=>file.endsWith('.pending.json')));
    f.tell('release-geometry-exit');await f.event('fixture.geometry-exit');await f.stop();f=null;f=await launch(data);await assertRestored(f,before,{sameToken:false});assert.equal(fs.readdirSync(path.join(data,'document-transactions')).some(file=>file.endsWith('.pending.json')),false);
  }finally{await f?.stop();cleanup(data);}
});
test('Gateway shutdown retains data-directory ownership while the old real geometry process still has an unconfirmed exit',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-native-recovery-'));let f,probe;
  try{f=await launch(data,{GEOMETRY_WORKER_STOP_TIMEOUT_MS:'30',GEOMETRY_SHUTDOWN_GRACE_MS:'50',GEOMETRY_SHUTDOWN_STOP_MS:'50'});await seeded(f);f.tell('arm-geometry');await f.event('fixture.geometry-armed');f.tell('arm-geometry-exit');await f.event('fixture.geometry-exit-armed');const pending=f.raw('primitive.box',{width:5,depth:6,height:7,x:30});pending.catch(()=>{});await f.event('fixture.geometry-held');await f.event('fixture.geometry-exit-held');assert.equal((await pending).value.code,'PROJECT_ROLLBACK_FAILED');
    const controlFile=path.join(data,'.gateway-control.json'),control=fs.readFileSync(controlFile),token=JSON.parse(control);await fetch(f.api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':token.token}});await f.event('cad.shutdown');
    const deadline=Date.now()+3000;while(!f.events.some(value=>value.type==='cad.shutdown'&&value.phase==='native-stop-unconfirmed')){assert.ok(Date.now()<deadline,'Native ownership guard was not reached');await tick();}assert.equal(f.child.exitCode,null);
    let output='';probe=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:String(await freePort())}});probe.stdout.on('data',bytes=>output+=bytes);probe.stderr.on('data',bytes=>output+=bytes);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Writer ownership probe exit unconfirmed')),5000);probe.once('close',()=>{clearTimeout(timer);resolve();});});assert.notEqual(probe.exitCode,0);assert.match(output,/DATA_DIRECTORY_IN_USE/);assert.deepEqual(fs.readFileSync(controlFile),control);
    f.tell('release-geometry-exit');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Old Gateway did not finish after exact native exit')),5000);f.child.once('close',()=>{clearTimeout(timer);resolve();});});assert.equal(f.child.exitCode,1);assert.ok(f.events.some(value=>value.type==='fixture.geometry-exit'));
  }finally{await stopTestChild(probe);await f?.stop();cleanup(data);}
});
test('a valid native mutation result followed by transport corruption cannot publish a false success from restored baseline geometry',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-native-recovery-'));let f;
  try{f=await launch(data);const before=await seeded(f);f.tell('fault-after-geometry-reply');await f.event('fixture.geometry-result-fault-armed');const result=await f.raw('primitive.box',{width:5,depth:6,height:7,x:30});assert.equal((await f.event('fixture.geometry-result-then-fault')).bodyCount,2);assert.equal(result.value.code,'WORKER_INSTANCE_CHANGED');assert.equal(result.value.projectRollback.confirmed,true);await assertRestored(f,before);assert.equal(fs.readdirSync(path.join(data,'document-transactions')).some(file=>file.endsWith('.pending.json')),false);
  }finally{await f?.stop();cleanup(data);}
});
