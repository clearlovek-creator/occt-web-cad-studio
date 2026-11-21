import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {stopTestChild} from './helpers/stop-test-child.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-step-workflow-')),fixtures=path.join(data,'fixtures'),api='http://127.0.0.1:8915/api';
let gateway,bytes;const states=new Map();
async function launch(){
  const child=spawn(process.execPath,['tests/fixtures/gateway-shutdown.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8915',GEOMETRY_DATA_DIR:data,GEOMETRY_SHUTDOWN_GRACE_MS:'100',GEOMETRY_SHUTDOWN_STOP_MS:'1000'},windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.events=[];child.diagnostics='';let lines='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{lines+=chunk;let at;while((at=lines.indexOf('\n'))>=0){const line=lines.slice(0,at);lines=lines.slice(at+1);try{child.events.push(JSON.parse(line));}catch{}}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('STEP workflow Gateway timeout: '+child.diagnostics)),15000);child.once('error',reject);child.stderr.on('data',chunk=>child.diagnostics+=chunk);child.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});return child;
}
const tell=type=>gateway.stdin.write(JSON.stringify({type})+'\n');
const eventPositions=new WeakMap();
async function event(type){const child=gateway,positions=eventPositions.get(child)||new Map();eventPositions.set(child,positions);const until=Date.now()+10000;for(;;){const index=child.events.findIndex((item,index)=>index>(positions.get(type)??-1)&&item.type==='fixture.'+type);if(index>=0){positions.set(type,index);return child.events[index];}assert.ok(Date.now()<until,'Expected actual fixture event: '+type+' '+child.diagnostics);await new Promise(resolve=>setTimeout(resolve,5));}}
async function cad(id,operation='document.summary',parameters={},state=states.get(id)){const response=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,...(state?{baseRevision:state.revision,baseStateToken:state.stateToken}:{})})}),result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));states.set(id,result);return result;}
async function upload(id,requestId,body=bytes,extra={}){const response=await fetch(api+`/documents/${id}/imports/step`,{method:'POST',headers:{'Content-Type':'application/step','X-Request-Id':requestId,'X-File-Name':encodeURIComponent('零件.step'),...extra},body}),result=await response.json();if(result.ok)states.set(id,result);return {status:response.status,result};}
async function status(id,requestId){const response=await fetch(api+`/documents/${id}/imports/step/status${requestId?'?requestId='+requestId:''}`);assert.equal(response.status,200);return (await response.json()).stepImportStatus;}
async function exit(){await new Promise((resolve,reject)=>{if(gateway.exitCode!==null||gateway.signalCode!==null)return resolve();const timer=setTimeout(()=>reject(Error('Gateway has not actually exited')),6000);gateway.once('exit',()=>{clearTimeout(timer);resolve();});});}
async function stopGracefully(){const control=JSON.parse(fs.readFileSync(path.join(data,'.gateway-control.json')));const response=await fetch(api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':control.token}});assert.equal(response.status,202);await exit();}
before(async()=>{
  const worker=process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe'),env={...process.env,PATH:[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:\\msys64\\ucrt64\\bin',process.env.PATH].join(path.delimiter)};
  const generated=spawnSync(path.join(path.dirname(worker),'step_import_tests.exe'),['--fixture-output',fixtures],{env,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(generated.status,0,generated.stderr||generated.stdout);bytes=fs.readFileSync(path.join(fixtures,'solids.step'));gateway=await launch();
});
after(async()=>{await stopTestChild(gateway);assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});

test('STEP status observes real receiving and converting phases, rejects overlapping upload, then certifies commit',async()=>{
  const id='phases',baseline=await cad(id,'primitive.box',{width:7,depth:8,height:9});let request;
  const reply=new Promise((resolve,reject)=>{request=httpRequest(api+`/documents/${id}/imports/step`,{method:'POST',headers:{'Content-Type':'application/step','Content-Length':bytes.length,'X-Request-Id':'phases-once','X-File-Name':encodeURIComponent('零件.step'),'X-Base-State-Token':baseline.stateToken,'X-Base-Revision':baseline.revision}},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve(JSON.parse(text)));});request.on('error',reject);request.write(bytes.subarray(0,100));});
  reply.catch(()=>{});
  try{
    for(let i=0;;i++){const current=await status(id,'phases-once');if(current){assert.equal(current.phase,'receiving');break;}assert.ok(i<100);await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal((await cad(id)).stateToken,baseline.stateToken);
    tell('arm-step');await event('step-armed');request.end(bytes.subarray(100));await event('step-held');
    const converting=await status(id,'phases-once');assert.equal(converting.phase,'converting');assert.equal(converting.bytes,bytes.length);assert.equal(converting.fileName,'零件.step');assert.equal(converting.ownerInstanceId,undefined);
    const overlap=await upload(id,'overlap');assert.equal(overlap.status,409);assert.equal(overlap.result.code,'STEP_IMPORT_BUSY');
    tell('release-geometry');const result=await reply;assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.bodyCount,2);assert.equal(result.stepImportStatus.phase,'complete');
    const committed=await status(id);assert.equal(committed.requestId,'phases-once');assert.equal(committed.stateToken,result.stateToken);assert.equal(committed.report.bodyCount,2);assert.equal(fs.existsSync(result.features[0].stringParameters.sourcePath),true);
    assert.deepEqual(gateway.events.filter(item=>item.type==='fixture.step-phase'&&item.requestId==='phases-once').map(item=>item.phase),['receiving','queued','preparing','converting','committing','complete']);
    const duplicate=await upload(id,'phases-once');assert.equal(duplicate.status,409);assert.equal(duplicate.result.code,'STEP_IMPORT_REQUEST_EXISTS');assert.equal((await cad(id)).stateToken,result.stateToken);
  }finally{request.destroy();tell('release-geometry');}
});

test('queued import rechecks its baseline after an earlier mutation commits, before conversion',async()=>{
  const id='queued',before=await cad(id,'primitive.box',{width:10,depth:10,height:10});tell('arm-geometry');await event('geometry-armed');
  const editing=cad(id,'primitive.box',{width:3,depth:4,height:5,x:30},before);await event('geometry-held');
  const importing=upload(id,'queued-stale',bytes,{'X-Base-State-Token':before.stateToken,'X-Base-Revision':String(before.revision)});
  for(let i=0;;i++){const record=await status(id,'queued-stale');if(record?.phase==='queued')break;assert.ok(i<100);await new Promise(resolve=>setTimeout(resolve,5));}
  tell('release-geometry');const changed=await editing,result=await importing;assert.equal(result.result.code,'PROJECT_STATE_CONFLICT');assert.equal((await cad(id)).stateToken,changed.stateToken);
  assert.deepEqual(gateway.events.filter(item=>item.type==='fixture.step-phase'&&item.requestId==='queued-stale').map(item=>item.phase),['receiving','queued','preparing','failed']);
});

test('failed parse has a durable unchanged report; stale token/revision fail before native conversion',async()=>{
  const id='failures',before=await cad(id,'primitive.box',{width:11,depth:12,height:13}),bad=await upload(id,'bad','not a STEP');assert.equal(bad.result.code,'STEP_READ_FAILED');assert.equal(bad.result.stepImportStatus.unchanged,true);assert.equal((await status(id,'bad')).phase,'failed');assert.equal((await cad(id)).stateToken,before.stateToken);
  const changed=await cad(id,'variable.set',{name:'length',type:'length',expression:'2 mm'},before);
  const stale=await upload(id,'stale-token',bytes,{'X-Base-State-Token':before.stateToken,'X-Base-Revision':String(before.revision)});assert.equal(stale.result.code,'PROJECT_STATE_CONFLICT');assert.equal((await status(id,'stale-token')).phase,'failed');assert.equal((await cad(id)).stateToken,changed.stateToken);
  const wrongRevision=await upload(id,'stale-revision',bytes,{'X-Base-State-Token':changed.stateToken,'X-Base-Revision':String(changed.revision+1)});assert.equal(wrongRevision.result.code,'STALE_REVISION');assert.equal((await cad(id)).stateToken,changed.stateToken);
});

test('successful replacement import is undoable and redoable with the complete prior engineering metadata',async()=>{
  const id='undo_replacement';await cad(id,'primitive.box',{width:17,depth:18,height:19});await cad(id,'variable.set',{name:'keep',type:'dimensionless',expression:'4'});await cad(id,'coordinate.set',{id:'keep-axis',name:'Keep axis',origin:[5,6,7],xAxis:[1,0,0],yAxis:[0,1,0]});
  await cad(id,'property.type.create',{key:'KeepSetup',association:'none',targetScope:'project',fields:[{key:'frequency',type:'double'}]});
  const before=await cad(id),typesBefore=await cad(id,'property.type.list'),{result}=await upload(id,'undo-import');assert.equal(result.ok,true);assert.equal(result.canUndo,true,'Import must not discard the prior engineering history');assert.equal(result.bodyCount,2);
  await cad(id,'document.undo');const restored=await cad(id);for(const key of ['features','variables','coordinateSystems','materials','bodyMetadata'])assert.deepEqual(restored[key],before[key],key);assert.deepEqual((await cad(id,'property.type.list')).types,typesBefore.types);
  await cad(id,'document.redo');const redone=await cad(id);assert.deepEqual(redone.features,result.features);assert.equal(redone.bodyCount,2);assert.equal(fs.existsSync(redone.features[0].stringParameters.sourcePath),true);
});

test('report publication failure after commit preserves the source and accepted import outcome',async()=>{
  tell('fail-step-report');await event('step-report-armed');const {result}=await upload('report_failure','report-once');assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.stepImportStatus.reportDurable,false);assert.equal(fs.existsSync(result.features[0].stringParameters.sourcePath),true);
  const record=await status('report_failure','report-once');assert.equal(record.phase,'complete');assert.equal(record.recovered,true);assert.equal(record.stateToken,result.stateToken);const before=await cad('report_failure');const imported=before.features[0].id;
  const edited=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:'report_failure',operation:'transform.translate',baseRevision:before.revision,baseStateToken:before.stateToken,parameters:{dx:2,dy:0,dz:0},inputs:{bodyId:'body-1'}})}).then(r=>r.json());assert.equal(edited.ok,true,JSON.stringify(edited));assert.equal(edited.features[0].id,imported);
});

test('precommit report failure rolls the real native import back before deleting its unused upload',async()=>{
  const id='precommit_failure',before=await cad(id,'primitive.box',{width:10,depth:20,height:30}),files=fs.readdirSync(path.join(data,'imports')).sort();
  tell('fail-step-commit-report');await event('step-commit-report-armed');const {result}=await upload(id,'precommit-report-once');assert.equal(result.ok,false);assert.equal(result.code,'STEP_IMPORT_REPORT_UNAVAILABLE');
  const after=await cad(id);assert.equal(after.stateToken,before.stateToken);assert.deepEqual(after.features,before.features);assert.deepEqual(fs.readdirSync(path.join(data,'imports')).sort(),files);assert.equal((await status(id,'precommit-report-once')).phase,'failed');
});

test('a process exit after durable commit but before report publication recovers the accepted outcome without replay',async()=>{
  tell('exit-step-report');await event('step-exit-armed');await upload('after_commit','committed-before-report').catch(()=>null);await exit();assert.equal(gateway.exitCode,89);gateway=await launch();
  const record=await status('after_commit','committed-before-report');assert.equal(record.phase,'complete');assert.equal(record.recovered,true);const current=await cad('after_commit');assert.equal(current.bodyCount,2);assert.equal(current.stateToken,record.stateToken);assert.equal(current.features.length,1);
  assert.equal(fs.existsSync(current.features[0].stringParameters.sourcePath),true);
  const duplicate=await upload('after_commit','committed-before-report');assert.equal(duplicate.result.code,'STEP_IMPORT_REQUEST_EXISTS');assert.equal((await cad('after_commit')).stateToken,current.stateToken);
});

test('interrupted native conversion retains source evidence and restores the full pre-import project on restart',async()=>{
  const id='interrupted',before=await cad(id,'primitive.box',{width:21,depth:22,height:23});tell('arm-step');await event('step-armed');const filesBefore=new Set(fs.readdirSync(path.join(data,'imports'))),pending=upload(id,'interrupted-once').catch(()=>null);await event('step-held');
  await stopGracefully();await pending;assert.equal(gateway.exitCode,1);const retained=fs.readdirSync(path.join(data,'imports')).filter(file=>!filesBefore.has(file));assert.equal(retained.length,1,'Unconfirmed source must not be deleted');
  gateway=await launch();const report=await status(id,'interrupted-once');assert.ok(['unknown','interrupted'].includes(report.phase));const current=await cad(id);assert.equal(current.bodyCount,before.bodyCount);assert.deepEqual(current.features,before.features);assert.equal(current.revision,before.revision);assert.equal(fs.existsSync(path.join(data,'imports',retained[0])),true);
  const again=await upload(id,'interrupted-once');assert.equal(again.result.code,'STEP_IMPORT_REQUEST_EXISTS');
});
