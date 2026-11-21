import {ObservedCommandClient} from './helpers/observed-command-client.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-target-sets-中文-')),api='http://127.0.0.1:8895/api',client=new ObservedCommandClient(),revisions=new Map();let gateway;
async function start(){gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8895',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('set test startup timeout')),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){if(!gateway)return;const child=gateway;gateway=null;const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}
before(start);after(async()=>{await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function raw(id,operation,parameters={},inputs={},extra={}){const response=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(client.prepare({documentId:id,baseRevision:revisions.get(id)||0,operation,parameters,inputs,...extra}))});const result=client.observe(await response.json(),id);if(result.ok&&Number.isSafeInteger(result.revision))revisions.set(id,result.revision);return result;}
async function cad(...args){const result=await raw(...args);assert.equal(result.ok,true,JSON.stringify({code:result.code,error:result.error,details:result.details}));return result;}
const stored=id=>JSON.parse(fs.readFileSync(path.join(data,'property-schemas',id+'.json'),'utf8'));
const faces=result=>[...new Set(result.triangleFaceIds)].map(topologyId=>({kind:'face',bodyId:result.bodyId,topologyId}));
const createType=(id,key,splitPolicy='review',scope='face')=>cad(id,'property.type.create',{key,name:key,targetScope:scope,association:'required',targetMode:'multiple',splitPolicy,fields:[{key:'enabled',type:'bool',default:true}]});

test('real API collections are atomic, identity-qualified, value-only stable and one Undo restores a whole retarget',async()=>{
  const id='set_atomic',a=await cad(id,'primitive.box',{width:10,depth:10,height:10}),b=await cad(id,'primitive.box',{width:8,depth:8,height:8,x:20}),type=await createType(id,'Boundary');
  const created=await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'One set',value:{enabled:true},targets:[faces(a)[0],faces(b)[0]]}),instanceId=created.instance.instanceId;
  assert.equal(created.propertySchema.schemaVersion,2);assert.equal(created.instance.target,null);assert.ok(created.instance.targets.every(target=>/^[a-f0-9]{32}$/.test(target.bodyIdentity)&&/^[a-f0-9]{32}$/.test(target.topologyIdentity)));
  const anchors=stored(id).instances[0].targets,baseline=created.stateToken;
  for(const targets of [[faces(a)[0],{...faces(b)[0],topologyId:'face-999-1'}],[faces(a)[0],faces(a)[0]],[],[null]]){const failed=await raw(id,'property.instance.update',{targets,name:'Must not leak'},{instanceId});assert.equal(failed.ok,false);assert.equal((await cad(id,'document.summary')).stateToken,baseline);assert.equal(stored(id).instances[0].name,'One set');}
  await cad(id,'property.instance.update',{value:{enabled:false}},{instanceId});assert.deepEqual(stored(id).instances[0].targets,anchors);
  await cad(id,'property.instance.retarget',{targets:[faces(a)[1],faces(b)[1]]},{instanceId});const undone=await cad(id,'document.undo');assert.deepEqual(undone.propertySchema.instances[0].targets,anchors);assert.equal(undone.propertySchema.instances[0].value.enabled,false);
  const stale=await raw(id,'property.instance.retarget',{targets:[faces(a)[1]]},{instanceId},{baseStateToken:baseline});assert.equal(stale.code,'PROJECT_STATE_CONFLICT');
  await cad(id,'body.delete',{}, {bodyId:b.bodyId});const broken=(await cad(id,'property.instance.list')).instances[0];assert.equal(broken.state,'needs-review');assert.equal(broken.association.members[1].state,'orphaned');assert.equal(broken.association.candidates.length,1);
  const restored=await cad(id,'document.undo');assert.equal(restored.propertySchema.instances[0].state,'active');assert.equal(restored.propertySchema.instances[0].targets.length,2);
});

test('real Boolean face fanout distinguishes review/all-descendants and survives recompute, Undo, portable opening and gateway restart',async()=>{
  const id='set_fanout',box=await cad(id,'primitive.box',{width:20,depth:20,height:20}),tool=await cad(id,'primitive.box',{width:4,depth:30,height:30,x:8,y:-5,z:-5});
  const review=await createType(id,'Review'),follow=await createType(id,'Following','all-descendants');
  const original=faces(box);for(const type of [review,follow])await cad(id,'property.instance.create',{typeId:type.type.typeId,value:{enabled:true},targets:original});
  const anchors=stored(id).instances.map(instance=>instance.targets);
  await cad(id,'boolean.cut',{}, {targetBody:box.bodyId,toolBody:tool.bodyId});
  let listed=(await cad(id,'property.instance.list')).instances;
  assert.equal(listed[0].state,'needs-review');assert.ok(listed[0].association.candidates.length>original.length);
  assert.equal(listed[1].state,'active');assert.ok(listed[1].targets.length>original.length);assert.deepEqual(stored(id).instances.map(instance=>instance.targets),anchors);
  const expanded=listed[1].targets.length;assert.equal((await cad(id,'document.undo')).propertySchema.instances[0].state,'active');assert.equal((await cad(id,'document.redo')).propertySchema.instances[1].targets.length,expanded);
  await cad(id,'feature.update',{width:24},{featureId:box.features[0].id});listed=(await cad(id,'property.instance.list')).instances;assert.equal(listed[1].state,'active');assert.equal(listed[0].state,'needs-review');
  const response=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());
  const opened=await fetch(api+'/documents/set_portable/project/open',{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:bytes});assert.equal(opened.status,200);
  const portable=(await cad('set_portable','property.instance.list')).instances;assert.equal(portable[1].state,'active');assert.deepEqual(portable[1].targets,listed[1].targets);
  await stop();await start();const recovered=(await cad(id,'property.instance.list')).instances;assert.deepEqual(recovered,listed);assert.deepEqual(stored(id).instances.map(instance=>instance.targets),anchors);
  const repaired=await cad(id,'property.instance.retarget',{targets:listed[0].association.candidates},{instanceId:listed[0].instanceId});assert.equal(repaired.instance.state,'active');assert.equal((await cad(id,'document.undo')).propertySchema.instances[0].state,'needs-review');
});

test('v1 upgrades only on creating a collection type and Undo/Redo restores the corresponding schema version',async()=>{
  const id='set_version';await cad(id,'primitive.box',{width:4,depth:4,height:4});await cad(id,'property.type.create',{key:'Legacy',fields:[]});const legacy=stored(id);assert.equal(legacy.schemaVersion,1);
  await createType(id,'Multi');assert.equal(stored(id).schemaVersion,2);await cad(id,'document.undo');assert.deepEqual(stored(id),legacy);await cad(id,'document.redo');assert.equal(stored(id).schemaVersion,2);
  const exported=await cad(id,'property.package.export');assert.equal(exported.package.schemaVersion,2);await cad('set_import','property.package.import',{package:exported.package,conflict:'skip'});assert.equal((await cad('set_import','property.type.list')).types.find(type=>type.key==='Multi').targetMode,'multiple');
});

test('real conformal mesh joins one collection on both Bodies and refreshes values without remeshing',async()=>{
  const id='set_mesh',a=await cad(id,'primitive.box',{width:6,depth:6,height:6}),b=await cad(id,'primitive.box',{width:6,depth:6,height:6,x:6}),type=await createType(id,'MeshSet'),instance=await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Shared assignment',targets:[...faces(a),...faces(b)],value:{enabled:true}});
  const submitted=await fetch(api+`/documents/${id}/mesh/jobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json());assert.equal(submitted.ok,true,JSON.stringify({error:submitted.error}));
  const key=submitted.meshJob.jobId;let result=submitted;
  for(let i=0;i<200&&result.meshJob.state!=='complete';i++){assert.ok(!['failed','cancelled','interrupted'].includes(result.meshJob.state),JSON.stringify(result.meshJob.error));await new Promise(resolve=>setTimeout(resolve,50));result=await fetch(api+`/mesh/jobs/${key}`).then(r=>r.json());}
  assert.equal(result.meshJob.state,'complete');assert.equal(result.meshJob.visible,false);
  const boundary=()=>fetch(api+`/mesh/jobs/${key}/boundary`).then(r=>r.json());let report=await boundary();assert.equal(report.ok,true);assert.equal(report.boundary.sourceFaces.length,12);assert.ok(report.boundary.sourceFaces.every(face=>face.properties.length===1&&face.properties[0].instanceId===instance.instance.instanceId));assert.ok(report.boundary.surfaces.some(face=>face.sources.length===2),'Contact surface retains both CAD sources');
  await cad(id,'property.instance.update',{value:{enabled:false}},{instanceId:instance.instance.instanceId});report=await boundary();assert.equal(report.boundary.propertyStatus,'current');assert.ok(report.boundary.sourceFaces.every(face=>face.properties[0].value.enabled===false));
  await cad(id,'body.delete',{}, {bodyId:b.bodyId});report=await boundary();assert.equal(report.boundary.propertyStatus,'source-stale');assert.ok(report.boundary.sourceFaces.every(face=>!face.properties.length));
});

test('Body and Edge collections bind current identities, and batch-created members keep their producer provenance in one commit',async()=>{
  const id='set_other_scopes',a=await cad(id,'primitive.box',{width:5,depth:5,height:5}),b=await cad(id,'primitive.box',{width:5,depth:5,height:5,x:10});
  for(const kind of ['body','edge']){const type=await createType(id,'Set'+kind,'review',kind),targets=[a,b].map(result=>({kind,bodyId:result.bodyId,...(kind==='edge'?{topologyId:result.edges[0].edgeId}:{})}));const result=await cad(id,'property.instance.create',{typeId:type.type.typeId,targets,value:{enabled:true}});assert.equal(result.instance.targets.length,2);assert.ok(result.instance.targets.every(target=>target.bodyIdentity));if(kind==='edge')assert.ok(result.instance.targets.every(target=>target.topologyIdentity));}
  const before=await cad(id,'document.summary'),type=await createType(id,'BatchBodies','review','body'),response=await fetch(api+'/command-batches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,batchId:'body-set-provenance',baseRevision:type.revision,baseStateToken:type.stateToken,steps:[{stepId:'a',operation:'primitive.box',parameters:{width:2,depth:2,height:2,x:30}},{stepId:'b',operation:'primitive.box',parameters:{width:2,depth:2,height:2,x:40}},{operation:'property.instance.create',parameters:{typeId:type.type.typeId,name:'Batch assignment',value:{enabled:true},targets:[{kind:'body',bodyId:{$ref:'a.bodyId'}},{kind:'body',bodyId:{$ref:'b.bodyId'}}]}}]})}).then(r=>r.json());
  assert.equal(response.ok,true,JSON.stringify({code:response.code,error:response.error}));client.observe(response,id);revisions.set(id,response.revision);assert.equal(response.bodyCount,before.bodyCount+2);assert.equal(response.propertySchema.instances.at(-1).targets.length,2);const undo=await cad(id,'document.undo');assert.equal(undo.bodyCount,before.bodyCount);assert.equal(undo.propertySchema.instances.length,2);
});
