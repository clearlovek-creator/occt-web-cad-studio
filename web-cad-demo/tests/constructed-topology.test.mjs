import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectGeometry} from './helpers/generated-topology-fixtures.mjs';
import {constructedPatterns as patterns} from './helpers/constructed-topology-fixtures.mjs';

const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-constructed-来源-')),api='http://127.0.0.1:8883/api',states=new Map();let gateway;
before(async()=>{gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8883',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Gateway startup timeout')),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});});
after(async()=>{const ended=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await ended;assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function cad(id,operation,parameters={},inputs={}){const state=states.get(id),r=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})})}),p=await r.json();assert.equal(p.ok,true,JSON.stringify(p));states.set(id,p);return p;}
const near=(a,b)=>Math.abs(a-b)<1e-4;
async function bind(id,bodyId,topologyId,key){const type=await cad(id,'property.type.create',{key,targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]});return (await cad(id,'property.instance.create',{typeId:type.type.typeId,name:key,value:{marker:7},target:{kind:'face',bodyId,topologyId}})).instance.instanceId;}
async function instance(id,instanceId){return (await cad(id,'property.instance.list')).instances.find(i=>i.instanceId===instanceId);}
async function measure(id,record){assert.equal(record.state,'active',JSON.stringify(record));return cad(id,'geometry.measure',{}, {bodyId:record.target.bodyId,selectionType:'face',selectionId:record.target.topologyId});}
function covered(view,bodyId){const body=view.bodyMetadata.find(b=>b.bodyId===bodyId);assert.equal(body.topologyNaming.namedFaceCount,body.faceCount);assert.equal(body.topologyNaming.namedEdgeCount,body.edgeCount);}

for(const operation of ['detail.sweep','detail.pipe','detail.revolve'])test(`${operation} gives start/end caps independent identities and preserves the unconsumed profile`,async()=>{
  const id='constructed_'+operation.split('.')[1],base=await cad(id,'surface.rectangle',{width:10,height:8,x:20}),profileFace=base.triangleFaceIds[0];
  await cad(id,'property.set',{key:'sourceMarker',type:'int',value:11},{kind:'face',bodyId:base.bodyId,topologyId:profileFace});
  const result=await cad(id,operation,operation==='detail.revolve'?{angleDegrees:90,axisX:0,axisY:1,axisZ:0}:{pathX:0,pathY:0,pathZ:12},{bodyId:base.bodyId,faceId:profileFace});
  assert.equal((await cad(id,'property.list')).propertyRecords.filter(r=>r.state==='active'&&r.values.sourceMarker).length,1,'Creating another Body must not orphan the retained profile');
  covered(result,result.bodyId);
  const end=await selectGeometry(cad,id,result,'face',m=>operation==='detail.revolve'?near(m.centroid[0],0)&&near(m.centroid[2],-20):near(m.centroid[2],12));
  const start=await selectGeometry(cad,id,result,'face',m=>near(m.centroid[2],0)&&near(m.area,80));
  const endId=await bind(id,result.bodyId,end,'EndCap'),startId=await bind(id,result.bodyId,start,'StartCap'),before=await cad(id,'document.view');
  await cad(id,'feature.update',{width:16,height:10,x:40,y:30,z:5},{featureId:base.features[0].id});
  const endMeasure=await measure(id,await instance(id,endId)),startMeasure=await measure(id,await instance(id,startId));
  assert.ok(near(endMeasure.area,160)&&near(startMeasure.area,160));
  const expected=operation==='detail.revolve'?[5,30,-40]:[40,30,17];expected.forEach((v,i)=>assert.ok(near(endMeasure.centroid[i],v),JSON.stringify(endMeasure.centroid)));[40,30,5].forEach((v,i)=>assert.ok(near(startMeasure.centroid[i],v)));
  await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);assert.equal((await instance(id,endId)).target.topologyId,end);await cad(id,'document.redo');await measure(id,await instance(id,endId));
});

for(const [operation,fixture] of Object.entries(patterns))test(`${operation} preserves a particular instance's Face across source changes without borrowing another instance`,async()=>{
  const id='constructed_'+operation.split('.')[1],base=await cad(id,'primitive.box',{width:10,depth:8,height:6,x:20});
  const sourceFace=await selectGeometry(cad,id,base,'face',m=>near(m.centroid[2],6));
  await cad(id,'property.set',{key:'sourceMarker',type:'int',value:11},{kind:'face',bodyId:base.bodyId,topologyId:sourceFace});const sourceInstance=await bind(id,base.bodyId,sourceFace,'SourceBoundary');
  const result=await cad(id,operation,fixture.parameters,{bodyId:base.bodyId}),bodyId=result.features.at(-1).outputBodies.at(-1),view=await cad(id,'body.presentation',{}, {bodyId});covered(result,bodyId);
  const copied=(await cad(id,'property.list')).propertyRecords.filter(r=>r.state==='active'&&r.values.sourceMarker);assert.equal(copied.length,result.features.at(-1).outputBodies.length,'Each copied Face must inherit from exact transform history');assert.equal((await instance(id,sourceInstance)).state,'active','The original instance remains on the untransformed source');
  const face=await selectGeometry(cad,id,view,'face',m=>near(m.centroid[2],6));const attached=await bind(id,bodyId,face,'InstanceBoundary');
  await cad(id,'feature.update',{width:14,depth:10,height:9,x:50,y:40,z:5},{featureId:base.features[0].id});
  const record=await instance(id,attached);assert.equal(record.target.bodyId,bodyId);const measured=await measure(id,record);assert.ok(near(measured.area,140));fixture.expected.forEach((v,i)=>assert.ok(near(measured.centroid[i],v),JSON.stringify(measured.centroid)));
  if(operation==='pattern.rectangular'){
    const featureId=result.features.at(-1).id;const expanded=await cad(id,'feature.update',{countX:3},{featureId});assert.equal(expanded.features.at(-1).outputBodies[4],bodyId,'An instance belongs to logical row/column, not a recycled flat position');
    const retained=await measure(id,await instance(id,attached));fixture.expected.forEach((v,i)=>assert.ok(near(retained.centroid[i],v)));
    const saved=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(saved.status,200);const copy=id+'_portable',opened=await fetch(api+`/documents/${copy}/project/open`,{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:Buffer.from(await saved.arrayBuffer())});assert.equal(opened.status,200,await opened.text());
    await cad(copy,'document.summary');const reexpanded=await cad(copy,'feature.update',{countX:4},{featureId});assert.equal(reexpanded.features.at(-1).outputBodies[5],bodyId);const restored=await measure(copy,await instance(copy,attached));fixture.expected.forEach((v,i)=>assert.ok(near(restored.centroid[i],v)));
    await cad(id,'feature.update',{countX:1},{featureId});assert.notEqual((await instance(id,attached)).state,'active');await cad(id,'feature.update',{countX:2},{featureId});const current=await cad(id,'document.view');assert.notEqual(current.features.at(-1).outputBodies[3],bodyId,'A deleted logical slot cannot revive a retired Body identity');assert.notEqual((await instance(id,attached)).state,'active');
  }
});

test('loft creation preserves the raw attributes of retained input Bodies',async()=>{
  const id='constructed_loft_source',first=await cad(id,'surface.rectangle',{width:10,height:10}),face=first.triangleFaceIds[0];await cad(id,'property.set',{key:'sourceMarker',type:'int',value:11},{kind:'face',bodyId:first.bodyId,topologyId:face});
  const second=await cad(id,'surface.rectangle',{width:15,height:12,z:10});await cad(id,'detail.loft',{}, {sections:[{bodyId:first.bodyId,faceId:face},{bodyId:second.bodyId,faceId:second.triangleFaceIds[0]}]});
  assert.equal((await cad(id,'property.list')).propertyRecords.filter(r=>r.state==='active'&&r.values.sourceMarker).length,1);
});

test('variable-driven rectangular columns preserve logical instances and downstream Face references',async()=>{
  const id='constructed_rect_variable';await cad(id,'variable.set',{name:'columns',type:'integer',expression:'2'});const base=await cad(id,'primitive.box',{width:10,depth:8,height:6,x:20}),pattern=await cad(id,'pattern.rectangular',{countX:'columns',countY:2,spacingX:20,spacingY:30},{bodyId:base.bodyId}),featureId=pattern.features.at(-1).id,bodyId=pattern.features.at(-1).outputBodies[3],view=await cad(id,'body.presentation',{}, {bodyId});
  const faceId=await selectGeometry(cad,id,view,'face',m=>near(m.centroid[2],6));await cad(id,'detail.sweep',{pathX:0,pathY:0,pathZ:5},{bodyId,faceId});
  const changed=await cad(id,'variable.set',{name:'columns',type:'integer',expression:'3'});assert.equal(changed.features.find(f=>f.id===featureId).outputBodies[4],bodyId);assert.equal(changed.features.at(-1).state,'valid');
  const before=await cad(id,'document.view'),r=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation:'variable.set',baseRevision:before.revision,baseStateToken:before.stateToken,parameters:{name:'columns',type:'integer',expression:'1'}})}),failed=await r.json();assert.equal(failed.ok,false,'Removing a referenced logical slot must not silently retarget the dependent sweep');
  const after=await cad(id,'document.view');assert.equal(after.stateToken,before.stateToken);assert.deepEqual(after.features,before.features);assert.deepEqual(after.bodyMetadata,before.bodyMetadata);
});

test('reversing a sweep keeps the end cap semantic role and a closed revolution cannot reuse a vanished cap',async()=>{
  const id='constructed_reverse',base=await cad(id,'surface.rectangle',{width:10,height:8,x:20}),faceId=base.triangleFaceIds[0];
  const sweep=await cad(id,'detail.sweep',{pathX:0,pathY:0,pathZ:12},{bodyId:base.bodyId,faceId}),end=await selectGeometry(cad,id,sweep,'face',m=>near(m.centroid[2],12)),endId=await bind(id,sweep.bodyId,end,'SweepEnd');
  await cad(id,'feature.update',{pathZ:-12},{featureId:sweep.features.at(-1).id});assert.ok(near((await measure(id,await instance(id,endId))).centroid[2],-12),'A reversed sweep end must not swap with its stationary start');
  const revolve=await cad(id,'detail.revolve',{angleDegrees:90,axisY:1,axisZ:0},{bodyId:base.bodyId,faceId}),cap=await selectGeometry(cad,id,revolve,'face',m=>near(m.centroid[0],0)&&near(m.centroid[2],-20)),capId=await bind(id,revolve.bodyId,cap,'RevolveEnd');
  const full=await cad(id,'feature.update',{angleDegrees:360},{featureId:revolve.features.at(-1).id});covered(full,revolve.bodyId);assert.notEqual((await instance(id,capId)).state,'active');assert.deepEqual((await instance(id,capId)).value,{marker:7});
  await cad(id,'document.undo');assert.equal((await instance(id,capId)).state,'active');
});

test('changing between Boolean-split profiles with the same ancestor cannot move an end-cap attribute',async()=>{
  const id='constructed_split_profiles',base=await cad(id,'primitive.box',{width:30,depth:10,height:10}),tool=await cad(id,'primitive.box',{width:2,depth:20,height:6,x:14,y:-5,z:5}),cut=await cad(id,'boolean.cut',{}, {targetBody:base.bodyId,toolBody:tool.bodyId});
  const faceId=await selectGeometry(cad,id,cut,'face',m=>near(m.centroid[2],10)&&m.centroid[0]<14),sweep=await cad(id,'detail.sweep',{pathX:0,pathY:0,pathZ:8},{bodyId:cut.bodyId,faceId}),end=await selectGeometry(cad,id,sweep,'face',m=>near(m.centroid[2],18)),attached=await bind(id,sweep.bodyId,end,'SplitCap'),featureId=sweep.features.at(-1).id;
  const input=await cad(id,'feature.input.preview',{changes:{pathZ:8}},{featureId,editedFeatureId:featureId}),p=input.inputPreview;
  const candidates=new Set();for(let t=0;t<p.presentation.triangleFaceIds.length;t++)if(p.presentation.indices.slice(t*3,t*3+3).every(index=>near(p.presentation.positions[index*3+2],10)&&p.presentation.positions[index*3]>=16-1e-4))candidates.add(Number(p.presentation.triangleFaceIds[t].split('-').at(-1)));assert.equal(candidates.size,1);
  const edit={documentId:id,featureId,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:'face',inputFingerprint:p.inputFingerprint,index:[...candidates][0]};
  await cad(id,'feature.update',{pathZ:8,selectionEdits:[edit]},{featureId});const old=await instance(id,attached);assert.notEqual(old.state,'active','Two separately selected pieces of the same ancestor face are not the same profile');assert.deepEqual(old.value,{marker:7});
});
