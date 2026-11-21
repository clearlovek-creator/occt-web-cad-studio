import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';
import {ModelingController} from '../app/modeling/modeling-controller.ts';
import {decodeProjectPackage} from '../gateway/project-package.mjs';
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cad-project-open-api-'));
function clean(data){assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-project-open-api-/);fs.rmSync(data,{recursive:true,force:true});}
async function packageBytes(f){await f.cad('primitive.sphere',{radius:5},{},'source');const response=await fetch(f.api+'/documents/source/project/save',{method:'POST'});assert.equal(response.status,200);return Buffer.from(await response.arrayBuffer());}
async function state(f){return {model:await f.cad('document.summary'),raw:(await f.cad('property.list')).propertyRecords,typed:(await f.cad('property.instance.list')).instances};}
async function seed(f){const body=await f.cad('primitive.box',{width:10,depth:20,height:30}),type=await f.cad('property.type.create',{key:'OpenBoundary',association:'required',targetScope:'body',fields:[{key:'marker',type:'int'}]});await f.cad('property.instance.create',{typeId:type.type.typeId,value:{marker:51},target:{kind:'body',bodyId:body.bodyId}});await f.cad('property.set',{key:'openMarker',type:'int',value:51},{kind:'body',bodyId:body.bodyId});await f.cad('variable.set',{name:'oldProjectSize',type:'length',expression:'12 mm'});return state(f);}
async function same(f,before){const after=await state(f);for(const key of ['revision','stateToken','features','bodyMetadata','entityIdentities','variables','coordinateSystems','materials'])assert.deepEqual(after.model[key],before.model[key],key);assert.deepEqual(after.raw,before.raw);assert.deepEqual(after.typed,before.typed);}
async function upload(f,bytes){const response=await fetch(f.api+'/documents/default/project/open',{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:bytes});return {status:response.status,value:await response.json()};}
async function holdFinalSnapshot(f,bytes){const at=f.events.length;f.tell('arm-project-open');await f.event('project-open-armed',at);const pending=upload(f,bytes);await f.event('project-open-held',at);f.tell('arm-task-commit');await f.event('task-commit-armed',at);f.tell('release-geometry');await f.event('task-commit-held',at);const schema=JSON.parse(fs.readFileSync(path.join(f.data,'property-schemas/default.json'),'utf8'));assert.equal(schema.types.length,0,'Imported typed data must actually have replaced the baseline before fault');return {pending,at};}
test('the actual controller accepts real package open, save and workspace activation without replacing the source engineering data',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await packageBytes(f),before=await seed(f),controller=new ModelingController({apiRoot:f.api,fetchImpl:fetch,taskControl:true});await controller.execute({operation:'document.view'});
    const opened=await controller.openProject(new Blob([bytes]));assert.notEqual(opened.documentId,'default');assert.equal(controller.getSnapshot().documentId,opened.documentId);assert.equal(opened.features[0].type,'primitive.sphere');assert.equal(controller.getSnapshot().busy,false);await same(f,before);
    const saved=await controller.saveProject();assert.equal(decodeProjectPackage(Buffer.from(await saved.arrayBuffer())).metadata.document.id,opened.documentId);
    await controller.restoreWorkspace('default');assert.equal(controller.getSnapshot().documentId,'default');assert.equal(controller.getSnapshot().model.features[0].type,'primitive.box');assert.equal(controller.getSnapshot().busy,false);await same(f,before);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
test('unsupported project file task headers are rejected instead of silently bypassing cancellation protocol',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data);const bytes=await packageBytes(f),before=await seed(f);
    for(const action of ['save','open']){const response=await fetch(f.api+'/documents/default/project/'+action,{method:'POST',headers:{'X-Cad-Task-Id':'11111111-1111-4111-8111-111111111111',...(action==='open'?{'Content-Type':'application/vnd.webcad.project'}:{'Content-Type':'application/json'})},body:action==='open'?bytes:JSON.stringify({command:{protocolVersion:1,operation:'project.save',documentId:'default',requestId:'missing-save-task'}})});assert.equal(response.status,404);assert.equal((await response.json()).code,'MODELING_TASK_NOT_FOUND');}
    await same(f,before);assert.equal((await f.get('/health')).lifecycle.projectInputs.slots,0);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
test('native failure after actual package restore and typed-data replacement proves full rollback before returning failure',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data,{GEOMETRY_WORKER_TIMEOUT_MS:'3000'});f.data=data;const bytes=await packageBytes(f),before=await seed(f),instance=(await f.get('/health')).capabilities.nativeGeometry.workerInstance;
    const {pending}=await holdFinalSnapshot(f,bytes),result=await pending;
    assert.equal(result.status,504,JSON.stringify(result));assert.equal(result.value.code,'WORKER_TIMEOUT');assert.deepEqual(result.value.projectRollback,{documentId:'default',confirmed:true});
    await same(f,before);assert.notEqual((await f.get('/health')).capabilities.nativeGeometry.workerInstance,instance);
    assert.equal(fs.readdirSync(path.join(data,'project-transactions')).some(name=>name.endsWith('.pending.json')),false);assert.deepEqual(fs.readdirSync(path.join(data,'project-assets')),[]);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
test('unconfirmed native exit retains the combined package journal, denies subsequent geometry and open/save, and startup recovers without replay',async()=>{
  const data=scratch();let f;
  try{
    f=await gatedGeometryGateway(data,{GEOMETRY_WORKER_TIMEOUT_MS:'3000',GEOMETRY_WORKER_STOP_TIMEOUT_MS:'100'});f.data=data;const bytes=await packageBytes(f),before=await seed(f);
    const held=await holdFinalSnapshot(f,bytes);f.tell('arm-geometry-exit');await f.event('geometry-exit-armed',held.at);await f.event('geometry-exit-held',held.at);const result=await held.pending;
    assert.equal(result.status,503,JSON.stringify(result));assert.equal(result.value.code,'PROJECT_ROLLBACK_FAILED');assert.equal(result.value.projectRollback,undefined);
    const file=path.join(data,'project-transactions/default.pending.json'),journal=fs.readFileSync(file),record=JSON.parse(journal);assert.equal(record.version,3);assert.equal(record.beforeMeshAssets.documentId,'default');assert.equal(record.nextMeshAssets.documentId,'default');assert.equal(record.phase,'prepared');assert.equal(record.rollbackProof.sha256.length,64);assert.ok(fs.existsSync(record.rollbackPath));assert.ok(fs.existsSync(record.assetDirectory));
    for(const [route,body,contentType] of [['/commands',JSON.stringify({documentId:'default',operation:'primitive.box',parameters:{width:1,depth:1,height:1}}),'application/json'],['/documents/default/project/save',undefined,undefined],['/documents/default/project/open',bytes,'application/vnd.webcad.project']]){const response=await fetch(f.api+route,{method:'POST',...(contentType?{headers:{'Content-Type':contentType}}:{}),...(body===undefined?{}:{body})});assert.equal(response.status,503);assert.equal((await response.json()).code,'PROJECT_RECOVERY_REQUIRED');}
    assert.deepEqual(fs.readFileSync(file),journal);await f.stop();f=null;
    f=await gatedGeometryGateway(data);await same(f,before);assert.equal(fs.existsSync(file),false);assert.equal(f.events.filter(item=>item.type==='fixture.native-request'&&item.operation==='document.restore'&&item.documentId==='default').length,1,'Only the restored original checkpoint may be loaded; the interrupted package must not be replayed');
    assert.deepEqual(fs.readdirSync(path.join(data,'project-assets')),[]);
  }finally{if(f){assert.equal(await f.stop(),0);clean(data);}}
});
