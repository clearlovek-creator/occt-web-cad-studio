import { ObservedCommandClient } from "./helpers/observed-command-client.mjs";
const observedClient=new ObservedCommandClient();
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-property-history-中文-')),api='http://127.0.0.1:8872/api';let gateway;
const revisions=new Map();
async function start(){gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8872',GEOMETRY_DATA_DIR:directory},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let errors='';const timer=setTimeout(()=>reject(new Error('startup timeout '+errors)),20000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>errors+=chunk);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){if(!gateway)return;const child=gateway;gateway=null;const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}
async function restart(){await stop();await start();}
before(start);after(async()=>{await stop();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});});
async function post(route,body){const response=await fetch(api+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(observedClient.prepare(body, "", route))});return {status:response.status,...observedClient.observe(await response.json(),body.documentId)};}
async function cad(id,operation,parameters={},inputs={}){const result=await post('/commands',{documentId:id,operation,baseRevision:revisions.get(id)||0,parameters,inputs});assert.equal(result.ok,true,JSON.stringify(result));if(Number.isSafeInteger(result.revision))revisions.set(id,result.revision);return result;}
const schema=id=>cad(id,'property.type.list');

test('two clients at the same native revision cannot overwrite old drafts; restart and Undo/Redo never revive edit tokens',async()=>{
  const id='property_concurrency',initial=await schema(id);
  const created=await post('/commands',{documentId:id,operation:'property.type.create',baseStateToken:initial.stateToken,parameters:{key:'Setup',fields:[{key:'x',type:'double'}]}});
  assert.equal(created.ok,true,JSON.stringify(created));
  assert.notEqual(created.stateToken,initial.stateToken);assert.equal(created.propertySchema.stateToken,created.stateToken);
  assert.ok(created.stateSequence>initial.stateSequence);
  const a=await schema(id),b=await schema(id);assert.equal(a.stateToken,b.stateToken);
  const edit={documentId:id,operation:'property.type.update',inputs:{typeId:created.type.typeId},parameters:{name:'Client A'},baseRevision:a.revision,baseStateToken:a.stateToken};
  const saved=await post('/commands',edit);assert.equal(saved.ok,true);assert.equal(saved.revision,a.revision);
  const conflict=await post('/commands',{...edit,parameters:{name:'Client B'}});assert.equal(conflict.status,409);assert.equal(conflict.code,'PROJECT_STATE_CONFLICT');assert.equal(conflict.currentStateToken,saved.stateToken);
  assert.equal((await schema(id)).types[0].name,'Client A');
  await restart();const restarted=await schema(id);assert.equal(restarted.stateToken,saved.stateToken);assert.equal(restarted.stateSequence,saved.stateSequence);
  const undone=await cad(id,'document.undo'),redone=await cad(id,'document.redo');
  assert.equal(redone.propertySchema.types[0].name,'Client A');assert.notEqual(undone.stateToken,saved.stateToken);assert.notEqual(redone.stateToken,saved.stateToken);
  assert.ok(undone.stateSequence>saved.stateSequence);assert.ok(redone.stateSequence>undone.stateSequence);
  const aba=await post('/commands',edit);assert.equal(aba.code,'PROJECT_STATE_CONFLICT');
  const before=await schema(id),invalid=await post('/commands',{...edit,baseStateToken:before.stateToken,parameters:{name:''}});assert.equal(invalid.ok,false);assert.equal((await schema(id)).stateToken,before.stateToken,'Failed edits must not publish a new state token');
});

test('a complete material edit is one atomic transaction; later property failures restore all previous material data',async()=>{
  const id='atomic_material';await cad(id,'material.set',{name:'Custom',relativePermittivity:2.5,conductivity:0,color:'#123456'});await cad(id,'material.property.set',{materialName:'Custom',key:'old',type:'double',value:7});
  const before=await cad(id,'document.view'),base={documentId:id,baseRevision:before.revision,baseStateToken:before.stateToken};
  const failed=await post('/command-batches',{...base,batchId:'invalid-material',steps:[{operation:'material.set',parameters:{name:'Custom',relativePermittivity:9,conductivity:2,color:'#ff0000'}},{operation:'material.property.set',parameters:{materialName:'Custom',key:'new',type:'double',value:3}},{operation:'material.property.set',parameters:{materialName:'Custom',key:'broken',type:'expression',expression:'missing_material_variable',dimension:'dimensionless'}}]});
  assert.equal(failed.ok,false);const restored=await cad(id,'document.view');assert.deepEqual(restored.materials,before.materials);assert.equal(restored.revision,before.revision);assert.equal(restored.stateToken,before.stateToken);
  const saved=await post('/command-batches',{...base,batchId:'valid-material',steps:[{operation:'material.set',parameters:{name:'Custom',relativePermittivity:4.4,conductivity:1,color:'#abcdef'}},{operation:'material.property.set',parameters:{materialName:'Custom',key:'new',type:'double',value:3}},{operation:'material.property.delete',parameters:{materialName:'Custom',key:'old'}}]});
  assert.equal(saved.ok,true,JSON.stringify(saved));revisions.set(id,saved.revision);assert.equal(saved.materials.find(m=>m.name==='Custom').relativePermittivity,4.4);
  assert.deepEqual((await cad(id,'document.undo')).materials,before.materials);
});

test('migration preview has no history or schema writes; defaults commit atomically and Undo restores missing fields',async()=>{
  const id='property_migration',type=await cad(id,'property.type.create',{key:'Defaults',fields:[]});
  await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'First',value:{}});await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Second',value:{}});
  const before=await schema(id),fields=[{key:'frequency',type:'double',required:true,default:3},{key:'axis',type:'vector3',default:[0,0,1]},{key:'exact',type:'int',default:'9223372036854775807'}];
  const request={documentId:id,operation:'property.type.preview',inputs:{typeId:type.type.typeId},parameters:{fields},baseStateToken:before.stateToken};
  const preview=await post('/commands',request);assert.equal(preview.ok,true,JSON.stringify(preview));assert.equal(preview.migration.instanceCount,2);assert.equal(preview.stateToken,before.stateToken);assert.equal(preview.history.eventId,before.history.eventId);
  assert.deepEqual((await schema(id)).propertySchema,before.propertySchema);
  const committed=await post('/commands',{...request,operation:'property.type.update'});assert.equal(committed.ok,true);assert.notEqual(committed.stateToken,before.stateToken);
  for(const instance of committed.propertySchema.instances)assert.deepEqual(instance.value,preview.migration.examples[0].addedValues);
  const old=await cad(id,'document.undo');assert.deepEqual(old.propertySchema.instances.map(i=>i.value),[{},{}]);
});

test('lost-response retries replay semantic edits before stale precondition checks and never duplicate a batch',async()=>{
  const id='property_retry',initial=await schema(id);
  const input={documentId:id,operation:'property.type.create',requestId:'transport-first',options:{idempotencyKey:'create-once'},baseStateToken:initial.stateToken,parameters:{key:'Once',fields:[]}};
  const first=await post('/commands',input);assert.equal(first.ok,true);
  await restart();const replay=await post('/commands',{...input,requestId:'transport-retry'});assert.equal(replay.ok,true,JSON.stringify(replay));assert.equal(replay.type.typeId,first.type.typeId);assert.equal(replay.stateToken,first.stateToken);assert.equal((await schema(id)).types.length,1);
  assert.equal((await post('/commands',{...input,parameters:{key:'Different',fields:[]}})).code,'IDEMPOTENCY_CONFLICT');
  const before=await schema(id),batch={documentId:id,batchId:'once-batch',baseRevision:before.revision,baseStateToken:before.stateToken,steps:[{operation:'primitive.box',parameters:{width:5,depth:5,height:5}},{operation:'property.instance.create',parameters:{typeId:first.type.typeId,value:{},name:'Only instance'}}]};
  const committed=await post('/command-batches',batch);assert.equal(committed.ok,true,JSON.stringify(committed));
  const repeated=await post('/command-batches',{...batch,requestId:'batch-transport-retry'});assert.equal(repeated.ok,true,JSON.stringify(repeated));assert.equal(repeated.batch.state,'replayed');assert.equal(repeated.bodyCount,1);assert.equal(repeated.propertySchema.instances.length,1);
});

test('one timeline restores geometry, typed values, stable instance IDs and face targets through restart and repeated Undo/Redo',async()=>{
  const health=await (await fetch(api+'/health')).json();assert.equal(health.capabilities.typedPropertyHistory,true);assert.equal(health.capabilities.atomicProjectState.recoveryJournalVersion,2);
  const id='unified',box=await cad(id,'primitive.box',{width:10,depth:12,height:8,reset:true}),faces=[...new Set(box.triangleFaceIds)];
  const type=await cad(id,'property.type.create',{key:'WavePort',targetScope:'face',association:'required',fields:[{key:'frequency',type:'double',required:true}]});assert.equal(type.revision,box.revision);assert.equal(type.history.canUndo,true);
  const instance=await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Port1',value:{frequency:3},target:{kind:'face',bodyId:box.bodyId,topologyId:faces[0]}}),instanceId=instance.instance.instanceId;
  await cad(id,'property.instance.update',{value:{frequency:5}},{instanceId});
  const retargeted=await cad(id,'property.instance.retarget',{target:{kind:'face',bodyId:box.bodyId,topologyId:faces[1]}},{instanceId});
  const changed=await cad(id,'feature.update',{width:18},{featureId:box.features[0].id});assert.ok(changed.revision>box.revision);
  const undoneGeometry=await cad(id,'document.undo');assert.equal(undoneGeometry.revision,box.revision);assert.equal(undoneGeometry.propertySchema.instances[0].value.frequency,5);
  await restart();let listing=(await schema(id)).propertySchema;assert.equal(listing.instances[0].instanceId,instanceId);assert.equal(listing.instances[0].target.topologyId,retargeted.instance.target.topologyId);
  const undoneTarget=await cad(id,'document.undo');assert.equal(undoneTarget.propertySchema.instances[0].target.topologyId,faces[0]);
  const undoneValue=await cad(id,'document.undo');assert.equal(undoneValue.propertySchema.instances[0].value.frequency,3);assert.equal(undoneValue.revision,box.revision);
  assert.equal((await cad(id,'document.undo')).propertySchema.instances.length,0);assert.equal((await cad(id,'document.undo')).propertySchema.types.length,0);
  await cad(id,'document.redo');await cad(id,'document.redo');await cad(id,'document.redo');await cad(id,'document.redo');const redone=await cad(id,'document.redo');
  assert.equal(redone.revision,changed.revision);assert.equal(redone.propertySchema.instances[0].instanceId,instanceId);assert.equal(redone.propertySchema.instances[0].value.frequency,5);assert.equal(redone.propertySchema.instances[0].state,'active');
  await cad(id,'property.instance.delete',{}, {instanceId});assert.equal((await schema(id)).propertySchema.instances.length,0);assert.equal((await cad(id,'document.undo')).propertySchema.instances[0].instanceId,instanceId);
  const file=path.join(directory,'history',id,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file));assert.ok(manifest.projectData[manifest.current]);assert.ok(fs.statSync(path.join(path.dirname(file),manifest.current+'.properties.json')).size>0);
});

test('mixed geometry/type/instance batches commit as one undo step and invalid later values roll everything back',async()=>{
  const id='mixed_batch',box=await cad(id,'primitive.box',{width:5,depth:5,height:5,reset:true});
  const steps=[{stepId:'body',operation:'primitive.box',parameters:{width:3,depth:3,height:3,x:10}},
    {stepId:'type',operation:'property.type.create',parameters:{key:'Boundary',targetScope:'body',association:'required',fields:[{key:'enabled',type:'bool',required:true}]}},
    {stepId:'instance',operation:'property.instance.create',parameters:{typeId:{$ref:'type.type.typeId'},name:'Boundary1',value:{enabled:true},target:{kind:'body',bodyId:{$ref:'body.bodyId'}}}}];
  const done=await post('/command-batches',{documentId:id,batchId:'mixed-success',baseRevision:box.revision,steps});assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.bodyCount,2);const instanceId=done.results[2].instance.instanceId;
  const undo=await cad(id,'document.undo');assert.equal(undo.bodyCount,1);assert.equal(undo.propertySchema.types.length,0);assert.equal(undo.propertySchema.instances.length,0);
  const redo=await cad(id,'document.redo');assert.equal(redo.bodyCount,2);assert.equal(redo.propertySchema.instances[0].instanceId,instanceId);
  const before=await cad(id,'document.summary'),beforeSchema=(await schema(id)).propertySchema;
  const invalid=structuredClone(steps);invalid[1].parameters.key='InvalidBoundary';invalid[2].parameters.value.enabled='not-bool';
  const rejected=await post('/command-batches',{documentId:id,batchId:'mixed-failure',baseRevision:before.revision,steps:invalid});assert.equal(rejected.ok,false);assert.equal(rejected.code,'BATCH_ROLLED_BACK');
  const after=await cad(id,'document.summary');for(const key of ['revision','bodyCount','features','entityIdentities'])assert.deepEqual(after[key],before[key]);assert.deepEqual((await schema(id)).propertySchema,beforeSchema);
  assert.equal(fs.existsSync(path.join(directory,'document-transactions',id+'.pending.json')),false);
});

test('restart restores a damaged live property file from its verified paired checkpoint and keeps the damaged bytes',async()=>{
  const id='live_schema_corrupt';await cad(id,'primitive.box',{width:5,depth:5,height:5});const type=await cad(id,'property.type.create',{key:'Setup',fields:[]});
  await stop();const file=path.join(directory,'property-schemas',id+'.json');fs.writeFileSync(file,'{ damaged live schema');await start();
  const restored=await schema(id);assert.equal(restored.propertySchema.types[0].typeId,type.type.typeId);assert.ok(fs.readdirSync(path.dirname(file)).some(name=>name.startsWith(id+'.json.')&&name.endsWith('.corrupt')));
});

test('damaged paired property history recovers a complete earlier state and quarantines geometry plus typed evidence',async()=>{
  const id='paired_schema_corrupt';await cad(id,'primitive.box',{width:5,depth:5,height:5});const type=await cad(id,'property.type.create',{key:'Setup',fields:[]});await cad(id,'property.instance.create',{typeId:type.type.typeId,value:{}});
  await stop();const folder=path.join(directory,'history',id),manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json')));fs.appendFileSync(path.join(folder,manifest.current+'.properties.json'),' damaged');await start();
  const view=await cad(id,'document.view'),restored=(await schema(id)).propertySchema;assert.equal(view.bodyCount,1);assert.equal(restored.types.length,1);assert.equal(restored.instances.length,0);
  assert.match(view.recoveryWarning,/较早的完整检查点/);assert.ok(view.warnings.includes(view.recoveryWarning));
  const evidence=fs.readdirSync(path.join(directory,'history-quarantine',id));assert.ok(evidence.some(name=>name.includes('.xbf.properties.json-')));assert.ok(evidence.some(name=>name.startsWith(id+'.json-')));
});

test('legacy geometry-only history explicitly preserves current metadata instead of inventing old property values',async()=>{
  const id='legacy_history',box=await cad(id,'primitive.box',{width:5,depth:5,height:5,reset:true});await cad(id,'feature.update',{width:8},{featureId:box.features[0].id});
  await stop();const file=path.join(directory,'history',id,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file));delete manifest.projectData;fs.writeFileSync(file,JSON.stringify(manifest));await start();
  const undo=await cad(id,'document.undo');assert.equal(undo.legacyPropertyHistory,true);assert.match(undo.warnings.join('\n'),/旧历史不含属性检查点/);assert.equal(undo.bodyCount,1);
});

test('unfinished recovery blocks public geometry, attribute, Agent query and meshing reads rather than exposing a half-state',async()=>{
  const id='recovery_barrier';await cad(id,'primitive.box',{width:5,depth:5,height:5});const file=path.join(directory,'document-transactions',id+'.pending.json');fs.writeFileSync(file,JSON.stringify({pending:true}));
  try{
    const direct=await (await fetch(api+'/documents/'+id)).json();assert.equal(direct.ok,false);assert.equal(direct.code,'PROJECT_RECOVERY_REQUIRED');
    const properties=await post('/commands',{documentId:id,operation:'property.type.list'});assert.equal(properties.code,'PROJECT_RECOVERY_REQUIRED');
    const query=await post('/agent/model/query',{documentId:id,kind:'geometry-tree'});assert.equal(query.code,'PROJECT_RECOVERY_REQUIRED');
    const mesh=await post('/documents/'+id+'/mesh/jobs',{});assert.equal(mesh.ok,false);assert.equal(mesh.mesh,undefined);assert.match(mesh.error,/恢复事务/);
  }finally{fs.rmSync(file);}
  assert.equal((await cad(id,'document.summary')).bodyCount,1);
});
