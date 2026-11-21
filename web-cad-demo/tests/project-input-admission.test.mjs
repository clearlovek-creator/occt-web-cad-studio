import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';

function scratch(){return fs.mkdtempSync(path.join(os.tmpdir(),'cad-project-input-api-'));}
function clean(data){assert.equal(path.dirname(path.resolve(data)),path.resolve(os.tmpdir()));assert.ok(path.basename(data).startsWith('cad-project-input-api-'));fs.rmSync(data,{recursive:true,force:true});}
async function packageBytes(f){await f.cad('primitive.box',{width:3,depth:4,height:5},{},'source');const response=await fetch(f.api+'/documents/source/project/save',{method:'POST'});assert.equal(response.status,200);return Buffer.from(await response.arrayBuffer());}
const upload=async(f,bytes,documentId='default')=>{const response=await fetch(f.api+'/documents/'+documentId+'/project/open',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes});return {status:response.status,value:await response.json()};};
async function hold(f){await f.cad('primitive.box',{width:2,depth:2,height:2},{},'busy');const at=f.events.length;f.tell('arm-geometry');await f.event('geometry-armed',at);const pending=f.post('/commands',{documentId:'busy',operation:'primitive.box',parameters:{width:1,depth:1,height:1}});await f.event('geometry-held',at);return {pending};}

test('queued project packages are private files, share upload capacity and reach the original open workflow without retaining full package input in queue',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);await f.cad('primitive.box',{width:10,depth:20,height:30});const bytes=await packageBytes(f),{pending}=await hold(f);
    const first=upload(f,bytes);await f.until(async()=>{const health=await f.get('/health');return health.lifecycle.documentActions.queued===1&&health.lifecycle.projectInputs.slots===1;},'First package did not stage');
    const second=upload(f,bytes,'second');await f.until(async()=>{const health=await f.get('/health');return health.lifecycle.documentActions.queued===2&&health.lifecycle.projectInputs.slots===2;},'Second package did not stage');
    const health=await f.get('/health');assert.equal(health.lifecycle.projectInputs.reservedBytes,bytes.length*2);assert.equal(health.lifecycle.documentActions.queuedInputBytes,256);
    const files=fs.readdirSync(path.join(data,'pending-project-inputs'));assert.equal(files.length,2);for(const file of files)assert.deepEqual(fs.readFileSync(path.join(data,'pending-project-inputs',file)),bytes);
    const refused=await upload(f,bytes,'third');assert.equal(refused.status,429);assert.equal(refused.value.code,'PROJECT_INPUT_CAPACITY');assert.equal(refused.value.execution,'not-started');
    f.tell('release-geometry');assert.equal((await pending).value.ok,true);assert.equal((await first).value.ok,true);assert.equal((await second).value.ok,true);
    for(const id of ['default','second']){const model=await f.cad('document.summary',{}, {},id);assert.equal(model.bodyCount,1);const primitive=model.features.find(feature=>feature.type==='primitive.box');assert.ok(primitive);for(const [key,value] of Object.entries({width:3,depth:4,height:5}))assert.equal(primitive.numberParameters[key],value,key);assert.ok(Math.abs(model.bodyMetadata[0].volume-60)<1e-8);}
    await f.until(async()=>!(await f.get('/health')).lifecycle.projectInputs.slots,'Package leases were not released');assert.deepEqual(fs.readdirSync(path.join(data,'pending-project-inputs')),[]);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('queue expiry cleans its staged package before returning a not-started outcome and never touches the target project',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data,{GEOMETRY_ACTION_QUEUE_TIMEOUT_MS:'80'});await f.cad('primitive.box',{width:10,depth:20,height:30});const before=await f.cad('document.summary'),bytes=await packageBytes(f),{pending}=await hold(f);
    const result=await upload(f,bytes);assert.equal(result.status,504);assert.equal(result.value.code,'DOCUMENT_ACTION_QUEUE_TIMEOUT');assert.equal(result.value.execution,'not-started');assert.equal((await f.get('/health')).lifecycle.projectInputs.slots,0);assert.deepEqual(fs.readdirSync(path.join(data,'pending-project-inputs')),[]);
    f.tell('release-geometry');await pending;const after=await f.cad('document.summary');for(const key of ['stateToken','bodyCount','features','bodyMetadata','entityIdentities'])assert.deepEqual(after[key],before[key],key);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('same-length staged package tampering is rejected and preserved without changing the target geometry or history',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);await f.cad('primitive.box',{width:10,depth:20,height:30});const before=await f.cad('document.summary'),bytes=await packageBytes(f),{pending}=await hold(f),opening=upload(f,bytes);
    await f.until(async()=>{const health=await f.get('/health');return health.lifecycle.documentActions.queued===1&&health.lifecycle.projectInputs.slots===1;},'Package did not queue');
    const file=path.join(data,'pending-project-inputs',fs.readdirSync(path.join(data,'pending-project-inputs'))[0]),changed=Buffer.from(bytes);changed[0]^=1;fs.writeFileSync(file,changed);
    f.tell('release-geometry');await pending;const result=await opening;assert.equal(result.status,409);assert.equal(result.value.code,'PROJECT_INPUT_CHANGED');assert.equal(result.value.execution,'not-started');assert.equal((await f.cad('document.summary')).stateToken,before.stateToken);assert.deepEqual(fs.readFileSync(file),changed);assert.equal((await f.get('/health')).lifecycle.projectInputs.retainedSlots,1);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});

test('real mutation input bytes are charged before shared-worker admission, independently of queue count limits',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data,{GEOMETRY_ACTION_QUEUE_BYTES:'1'});await f.cad('primitive.box',{width:10,depth:20,height:30});const before=await f.cad('document.summary'),{pending}=await hold(f),at=f.events.length;
    const result=await f.post('/commands',{documentId:'default',operation:'primitive.box',parameters:{width:3,depth:4,height:5}});assert.equal(result.status,429);assert.equal(result.value.code,'DOCUMENT_ACTION_INPUT_LIMIT');assert.equal(result.value.execution,'not-started');assert.equal(f.events.slice(at).some(event=>event.type==='fixture.native-request'&&event.documentId==='default'),false);
    assert.equal((await f.get('/health')).lifecycle.documentActions.queuedInputBytes,0);f.tell('release-geometry');await pending;assert.equal((await f.cad('document.summary')).stateToken,before.stateToken);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
