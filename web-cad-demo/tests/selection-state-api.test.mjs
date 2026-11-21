import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-selection-state-中文-')),api='http://127.0.0.1:8880/api';let gateway;
before(async()=>{gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8880',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let stderr='';const timer=setTimeout(()=>reject(new Error('startup timeout '+stderr)),20000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>stderr+=chunk);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});});
after(async()=>{const stopped=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await stopped;assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
// Intentionally raw: never fetch or inject a current token before a write.
async function post(route,body){const response=await fetch(api+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,payload:await response.json()};}
async function cmd(id,operation,parameters={},inputs={},extra={}){return post('/commands',{documentId:id,operation,parameters,inputs,...extra});}
async function ok(...args){const result=await cmd(...args);assert.equal(result.payload.ok,true,JSON.stringify(result));return result.payload;}
const box={width:20,depth:30,height:10};
const faceRequest=(body,face)=>({id:'attached',name:'Attached',kind:'face',referenceBodyId:body,referenceTopologyId:face});
async function unchanged(id,before){const after=await ok(id,'document.view');for(const key of ['revision','stateToken','stateSequence','features','entityIdentities','coordinateSystems','bodyMetadata'])assert.deepEqual(after[key],before[key],key);return after;}

test('all external geometry selection writes fail closed without a token, including non-associative snapshots and repair arrays',async()=>{
  const id='selection_missing',base=await ok(id,'primitive.box',box);
  const operations=[
    ['detail.fillet',{radius:1},{bodyId:base.bodyId,edgeId:base.edges[0].edgeId}],['detail.chamfer',{distance:1},{bodyId:base.bodyId,edgeId:base.edges[0].edgeId}],
    ...['shell','thicken','draft','revolve','sweep','pipe'].map(kind=>['detail.'+kind,{thickness:1,angleDegrees:5,pathX:'0,0,0',pathY:'1,0,0',pathZ:'0,0,1'},{bodyId:base.bodyId,faceId:base.triangleFaceIds[0]}]),
    ['coordinate.set',faceRequest(base.bodyId,base.triangleFaceIds[0]),{}],['coordinate.set',{...faceRequest(base.bodyId,base.triangleFaceIds[0]),associationMode:'snapshot'},{}],
    ...['body','face','edge'].map(kind=>['property.set',{key:'flag',type:'bool',value:true},{kind,bodyId:base.bodyId,topologyId:kind==='face'?base.triangleFaceIds[0]:kind==='edge'?base.edges[0].edgeId:''}]),
    ['property.delete',{key:'flag'},{kind:'face',bodyId:base.bodyId,topologyId:base.triangleFaceIds[0]}],
    ['feature.update',{selectionEdits:[{featureId:base.features[0].id}]},{featureId:base.features[0].id}],
  ];
  for(const [operation,parameters,inputs] of operations){const result=await cmd(id,operation,parameters,inputs,{baseRevision:base.revision});assert.equal(result.status,428,JSON.stringify(result));assert.equal(result.payload.code,'SELECTION_STATE_REQUIRED');assert.equal(result.payload.fieldPath,'baseStateToken');assert.ok(result.payload.selectionPaths.length);await unchanged(id,base);}
});

test('typed instance create/update/retarget are protected, while unassociated project data and queries remain usable',async()=>{
  const id='selection_typed',base=await ok(id,'primitive.box',box),type=await ok(id,'property.type.create',{key:'Port',name:'Port',targetScope:'face',association:'required',fields:[]});
  const target={kind:'face',bodyId:base.bodyId,topologyId:base.triangleFaceIds[0]},before=await ok(id,'document.view');
  const missing=await cmd(id,'property.instance.create',{typeId:type.type.typeId,name:'Port1',value:{},target});assert.equal(missing.status,428);await unchanged(id,before);
  const created=await ok(id,'property.instance.create',{typeId:type.type.typeId,name:'Port1',value:{},target},{},{baseStateToken:before.stateToken});
  for(const operation of ['property.instance.update','property.instance.retarget']){const result=await cmd(id,operation,{value:{},target},{instanceId:created.instance.instanceId});assert.equal(result.status,428);}
  assert.equal((await cmd(id,'property.instance.update',{value:{}},{instanceId:created.instance.instanceId})).payload.ok,true,'Value-only editing does not create a new geometric selection');
  const projectType=await ok(id,'property.type.create',{key:'Setup',name:'Setup',targetScope:'project',association:'none',fields:[]});await ok(id,'property.instance.create',{typeId:projectType.type.typeId,name:'Setup1',value:{},target:null});
  await ok(id,'geometry.measure',{}, {bodyId:base.bodyId,selectionType:'face',selectionId:base.triangleFaceIds[0]});
});

test('the old fillet route forwards observed tokens and cannot bypass the selection policy',async()=>{
  const id='selection_legacy',base=await ok(id,'primitive.box',box),body={documentId:id,revision:base.revision,bodyId:base.bodyId,edgeId:base.edges[0].edgeId,radius:1};
  assert.equal((await post('/fillet',body)).status,428);await unchanged(id,base);
  const result=await post('/fillet',{...body,baseStateToken:base.stateToken});assert.equal(result.payload.ok,true,JSON.stringify(result));assert.equal(result.payload.features.length,2);
});

test('Undo branch reuse of native revision and Face IDs never revives an old selection token',async()=>{
  const id='selection_aba',base=await ok(id,'primitive.box',box),old=await ok(id,'transform.translate',{dx:10,dy:0,dz:0},{bodyId:base.bodyId},{baseRevision:base.revision});
  await ok(id,'document.undo');const current=await ok(id,'transform.translate',{dx:100,dy:0,dz:0},{bodyId:base.bodyId},{baseRevision:base.revision});
  assert.equal(current.revision,old.revision);assert.deepEqual(current.triangleFaceIds,old.triangleFaceIds);assert.notEqual(current.stateToken,old.stateToken);
  const rejected=await cmd(id,'coordinate.set',faceRequest(base.bodyId,old.triangleFaceIds[0]),{},{baseRevision:old.revision,baseStateToken:old.stateToken});assert.equal(rejected.status,409);assert.equal(rejected.payload.code,'PROJECT_STATE_CONFLICT');await unchanged(id,current);
  assert.equal((await cmd(id,'coordinate.set',faceRequest(base.bodyId,current.triangleFaceIds[0]),{},{baseRevision:current.revision,baseStateToken:current.stateToken})).payload.ok,true);
});

test('same-R project-data changes and concurrent writers reject stale selection intent under the document queue',async()=>{
  const id='selection_concurrent',base=await ok(id,'primitive.box',box),changed=await ok(id,'property.type.create',{key:'Tag',targetScope:'project',association:'none',fields:[]});assert.equal(changed.revision,base.revision);
  assert.equal((await cmd(id,'coordinate.set',faceRequest(base.bodyId,base.triangleFaceIds[0]),{},{baseRevision:base.revision,baseStateToken:base.stateToken})).status,409);
  const observed=await ok(id,'document.view'),results=await Promise.all(['a','b'].map(name=>cmd(id,'coordinate.set',{...faceRequest(base.bodyId,base.triangleFaceIds[0]),id:name},{},{baseRevision:observed.revision,baseStateToken:observed.stateToken})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await ok(id,'document.view')).coordinateSystems.length,2);
});

test('completed idempotent selection writes replay before checking a now-old or omitted token, but new writes remain guarded',async()=>{
  const id='selection_replay',base=await ok(id,'primitive.box',box),parameters=faceRequest(base.bodyId,base.triangleFaceIds[0]),options={idempotencyKey:'frame-once'};
  const first=await ok(id,'coordinate.set',parameters,{},{baseRevision:base.revision,baseStateToken:base.stateToken,options});
  const replay=await ok(id,'coordinate.set',parameters,{},{baseRevision:base.revision,options});assert.equal(replay.stateToken,first.stateToken);await unchanged(id,first);
  assert.equal((await cmd(id,'coordinate.set',{...parameters,id:'new'},{},{options:{idempotencyKey:'new-frame'}})).status,428);
});

test('batch missing or mixed observations reject before any step commits; one observed batch still supports unrelated edits and one Undo',async()=>{
  const id='selection_batch',base=await ok(id,'primitive.box',box),steps=[{operation:'variable.set',parameters:{name:'flag',type:'dimensionless',expression:'1'}},{operation:'detail.fillet',inputs:{bodyId:base.bodyId,edgeId:base.edges[0].edgeId},parameters:{radius:1}}];
  assert.equal((await post('/command-batches',{documentId:id,batchId:'missing',steps})).status,428);await unchanged(id,base);assert.equal((await ok(id,'document.view')).variables.length,0);
  const mixed=await post('/command-batches',{documentId:id,batchId:'mixed',baseStateToken:base.stateToken,steps:[steps[0],{...steps[1],baseStateToken:'0'.repeat(64)}]});assert.equal(mixed.status,409);await unchanged(id,base);
  const result=await post('/command-batches',{documentId:id,batchId:'observed',baseRevision:base.revision,baseStateToken:base.stateToken,steps});assert.equal(result.payload.ok,true,JSON.stringify(result));assert.equal(result.payload.variables.length,1);
  const undo=await ok(id,'document.undo');assert.equal(undo.variables.length,0);assert.equal(undo.features.length,1);
});

test('batch reset/recreate ABA cannot attach an entry Face to a new Body, but explicit producer references succeed',async()=>{
  const id='selection_batch_aba',base=await ok(id,'primitive.box',box),steps=[{stepId:'clear',operation:'document.create'},{stepId:'new',operation:'primitive.box',parameters:{...box,x:200}},{stepId:'frame',operation:'coordinate.set',parameters:faceRequest(base.bodyId,base.triangleFaceIds[0])}];
  const rejected=await post('/command-batches',{documentId:id,batchId:'batch-aba',baseStateToken:base.stateToken,steps});assert.equal(rejected.payload.code,'BATCH_ROLLED_BACK',JSON.stringify(rejected));assert.equal(rejected.payload.causeCode,'BATCH_SELECTION_STALE');assert.deepEqual(rejected.payload.results.map(r=>r.status),['rolled-back','rolled-back','not-executed']);assert.ok(rejected.payload.results.every(r=>r.ok===false && r.bodyId===undefined && r.positions===undefined),'No rolled-back step may claim success or publish provisional geometry');await unchanged(id,base);
  steps[2].parameters=faceRequest({$ref:'new.bodyId'},{$ref:'new.triangleFaceIds.0'});
  const accepted=await post('/command-batches',{documentId:id,batchId:'batch-ref',baseStateToken:base.stateToken,steps});assert.equal(accepted.payload.ok,true,JSON.stringify(accepted));assert.notEqual(accepted.payload.entityIdentities['body-1'].bodyIdentity,base.entityIdentities['body-1'].bodyIdentity);assert.equal(accepted.payload.coordinateSystems.find(c=>c.id==='attached').referenceState,'resolved');
});

test('a topology change inside a batch invalidates literal Face/Edge selections, while Body associations keep their logical owner',async()=>{
  const id='selection_batch_topology',base=await ok(id,'primitive.box',box),steps=[{stepId:'moved',operation:'transform.translate',inputs:{bodyId:base.bodyId},parameters:{dx:10,dy:0,dz:0}},{operation:'coordinate.set',parameters:faceRequest(base.bodyId,base.triangleFaceIds[0])}];
  const failed=await post('/command-batches',{documentId:id,batchId:'stale-face',baseStateToken:base.stateToken,steps});assert.equal(failed.payload.causeCode,'BATCH_SELECTION_STALE');await unchanged(id,base);
  steps[1]={operation:'property.set',inputs:{kind:'body',bodyId:base.bodyId},parameters:{key:'mark',type:'bool',value:true}};
  const body=await post('/command-batches',{documentId:id,batchId:'body-owner',baseStateToken:base.stateToken,steps});assert.equal(body.payload.ok,true,JSON.stringify(body));
});

test('coordinate copying in a batch must reference the actual modified producer, not an entry record with the same ID',async()=>{
  const id='selection_batch_coordinate',base=await ok(id,'primitive.box',box),frame=await ok(id,'coordinate.set',faceRequest(base.bodyId,base.triangleFaceIds[0]),{},{baseRevision:base.revision,baseStateToken:base.stateToken});
  const steps=[{stepId:'renamed',operation:'coordinate.set',parameters:{id:'attached',name:'Renamed',kind:'face',preserveReference:true}},{operation:'coordinate.set',parameters:{id:'copy',name:'Copy',kind:'face',copyReferenceFrom:'attached'}}];
  const stale=await post('/command-batches',{documentId:id,batchId:'old-coordinate',baseStateToken:frame.stateToken,steps});assert.equal(stale.payload.causeCode,'BATCH_SELECTION_STALE');await unchanged(id,frame);
  steps[1].parameters.copyReferenceFrom={$ref:'renamed.coordinateSystems.1.id'};
  const copied=await post('/command-batches',{documentId:id,batchId:'new-coordinate',baseStateToken:frame.stateToken,steps});assert.equal(copied.payload.ok,true,JSON.stringify(copied));assert.equal(copied.payload.coordinateSystems.length,3);
});
