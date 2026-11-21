import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {openLegacyStepProject} from './helpers/legacy-step-project.mjs';
import {selectGeometry} from './helpers/generated-topology-fixtures.mjs';
import {stopTestChild} from './helpers/stop-test-child.mjs';

const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-naming-upgrade-中文-')),states=new Map();
let gateway,api;
async function start(){
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  api=`http://127.0.0.1:${port}/api`;
  gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:String(port)}});
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Naming upgrade fixture startup unconfirmed: '+data)),20000);
    gateway.once('error',error=>{clearTimeout(timer);reject(error);});gateway.once('exit',code=>{clearTimeout(timer);reject(Error('Naming upgrade fixture exited '+code));});
    gateway.stderr.on('data',()=>{});gateway.stdout.on('data',bytes=>{output=(output+bytes).slice(-8192);if(output.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});
  });
}
async function stop(){
  if(!gateway)return;const child=gateway;
  if(child.exitCode===null&&child.signalCode===null){
    const control=JSON.parse(fs.readFileSync(path.join(data,'.gateway-control.json'),'utf8'));assert.equal(control.ownerPid,child.pid);
    let timer;const ended=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Naming fixture shutdown unconfirmed; preserve '+data)),25000);child.once('close',code=>code===0?resolve():reject(Error('Naming fixture exit '+code)));});
    try{await fetch(api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':control.token},signal:AbortSignal.timeout(3000)}).catch(()=>{});await ended;}
    catch(error){await stopTestChild(child);throw error;}finally{clearTimeout(timer);}
  }
  await stopTestChild(child);gateway=null;
}
before(start);
after(async()=>{await stop();assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.ok(path.basename(data).startsWith('cad-naming-upgrade-'));fs.rmSync(data,{recursive:true,force:true});});
async function raw(id,operation,parameters={},inputs={},patch={}){
  const state=states.get(id),request={documentId:id,operation,parameters,inputs,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{}),...patch};
  const response=await fetch(api+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)}),value=await response.json();
  if(value.ok)states.set(id,value);return {status:response.status,value,request};
}
async function cad(...args){const response=await raw(...args);assert.equal(response.status,200,JSON.stringify(response.value));assert.equal(response.value.ok,true);return response.value;}
const near=(a,b)=>Math.abs(a-b)<1e-5;
async function legacy(id,buildSource){
  const source=id+'_source',modern=id+'_modern';if(buildSource)await buildSource(source);else await cad(source,'primitive.box',{width:30,depth:40,height:20});
  const exported=await fetch(api+`/documents/${source}/exports/step`,{method:'POST'}).then(response=>response.json());assert.equal(exported.ok,true);
  const bytes=await fetch(new URL(exported.downloadUrl,api)).then(response=>response.arrayBuffer());
  const imported=await fetch(api+`/documents/${modern}/imports/step`,{method:'POST',headers:{'content-type':'application/step'},body:bytes});assert.equal(imported.status,200,await imported.text());
  const summary=await openLegacyStepProject(api,modern,id);states.set(id,summary);return {bodyId:summary.activeBodyId,view:await cad(id,'body.presentation',{}, {bodyId:summary.activeBodyId})};
}
function sameState(actual,expected){for(const key of ['revision','stateToken','stateSequence','features','bodyMetadata','entityIdentities','coordinateSystems','history'])assert.deepEqual(actual[key],expected[key],key);}
async function typed(id,instanceId){return (await cad(id,'property.instance.list')).instances.find(item=>item.instanceId===instanceId);}

test('explicit upgrade is one Undo step, preserves current raw and typed Face/Edge targets after two Cuts, and enables later inheritance',async()=>{
  const id='upgrade_boolean',fixture=await legacy(id),edge=await selectGeometry(cad,id,fixture.view,'edge',m=>near(m.centroid[0],0)&&near(m.centroid[1],0)&&near(m.length,20));
  const fillet=await cad(id,'detail.fillet',{radius:2},{bodyId:fixture.bodyId,edgeId:edge}),featureId=fillet.features.at(-1).id;
  const cylinder=await cad(id,'primitive.cylinder',{radius:3,height:40,x:15,y:20,z:-10});await cad(id,'boolean.cut',{}, {targetBody:fixture.bodyId,toolBody:cylinder.bodyId});
  const notch=await cad(id,'primitive.box',{width:15,depth:15,height:40,x:20,y:30,z:-10}),result=await cad(id,'boolean.cut',{}, {targetBody:fixture.bodyId,toolBody:notch.bodyId});
  const face=await selectGeometry(cad,id,result,'face',m=>near(m.area,20*Math.PI)&&m.centroid[0]>0&&m.centroid[0]<2&&m.centroid[1]>0&&m.centroid[1]<2);
  const boundary=await selectGeometry(cad,id,result,'edge',m=>near(m.centroid[0],0)&&near(m.centroid[2],20)&&near(m.length,38));
  const instances=[];
  for(const [kind,topologyId] of [['face',face],['edge',boundary]]){
    await cad(id,'property.set',{key:'marker',type:'int',value:71},{kind,bodyId:fixture.bodyId,topologyId});
    const type=await cad(id,'property.type.create',{key:'Upgrade'+kind,targetScope:kind,association:'required',fields:[{key:'marker',type:'int'}]});
    const created=await cad(id,'property.instance.create',{typeId:type.type.typeId,value:{marker:71},target:{kind,bodyId:fixture.bodyId,topologyId}});instances.push(created.instance.instanceId);
  }
  const before=await cad(id,'document.summary'),rawBefore=(await cad(id,'property.list')).propertyRecords,typedBefore=await Promise.all(instances.map(instance=>typed(id,instance))),presentation=await cad(id,'body.presentation',{}, {bodyId:fixture.bodyId});
  const preview=await cad(id,'document.naming.preview');assert.equal(preview.importedNamingUpgrade.sourceCount,1);assert.equal(preview.importedNamingUpgrade.referenceCount,1);assert.equal(preview.importedNamingUpgrade.geometryUnchanged,true);assert.equal(preview.importedNamingUpgrade.preview,true);
  sameState(await cad(id,'document.summary'),before);
  const committed=await raw(id,'document.naming.upgrade',{}, {},{requestId:'upgrade-once'});assert.equal(committed.status,200,JSON.stringify(committed.value));
  const after=await cad(id,'document.summary');assert.equal(after.revision,before.revision+1);assert.notEqual(after.stateToken,before.stateToken);assert.deepEqual(after.entityIdentities,before.entityIdentities);
  assert.equal(after.history.lastEvent.operation,'document.naming.upgrade');assert.notEqual(after.history.eventId,before.history.eventId);
  const now=await cad(id,'body.presentation',{}, {bodyId:fixture.bodyId});for(const key of ['topologyRevision','positions','normals','indices','triangleFaceIds','edges'])assert.deepEqual(now[key],presentation[key],key);
  assert.deepEqual((await cad(id,'property.list')).propertyRecords,rawBefore);assert.deepEqual(await Promise.all(instances.map(instance=>typed(id,instance))),typedBefore);
  const replay=await raw(id,'document.naming.upgrade',{}, {},{...committed.request});assert.equal(replay.status,200,JSON.stringify(replay.value));assert.deepEqual(replay.value,committed.value);sameState(await cad(id,'document.summary'),after);
  const noop=await cad(id,'document.naming.upgrade');assert.equal(noop.importedNamingUpgrade.changed,false);sameState(await cad(id,'document.summary'),after);
  await cad(id,'document.undo');const undone=await cad(id,'document.summary');assert.equal(undone.features[0].numberParameters.importNamingVersion,undefined);assert.deepEqual(undone.entityIdentities,before.entityIdentities);assert.deepEqual((await cad(id,'property.list')).propertyRecords,rawBefore);
  await cad(id,'document.redo');assert.equal((await cad(id,'document.summary')).features[0].numberParameters.importNamingVersion,1);
  await cad(id,'feature.update',{radius:3},{featureId});
  async function verify(){
    const [a,b]=await Promise.all(instances.map(instance=>typed(id,instance)));assert.equal(a.state,'active');assert.equal(b.state,'active');
    const fm=await cad(id,'geometry.measure',{}, {bodyId:a.target.bodyId,selectionType:'face',selectionId:a.target.topologyId}),em=await cad(id,'geometry.measure',{}, {bodyId:b.target.bodyId,selectionType:'edge',selectionId:b.target.topologyId});assert.ok(near(fm.area,30*Math.PI));assert.ok(near(em.length,37));
  }
  await verify();await stop();await start();await verify();
});

test('naming maintenance requires an exact observed state, empty parameters, and an explicit separate preview',async()=>{
  const id='upgrade_state';await legacy(id);const before=await cad(id,'document.summary');
  for(const operation of ['document.naming.preview','document.naming.upgrade']){
    assert.equal((await raw(id,operation,{}, {},{baseStateToken:undefined})).value.code,'SELECTION_STATE_REQUIRED');
    assert.equal((await raw(id,operation,{}, {},{baseRevision:undefined})).value.code,'SCHEMA_VALIDATION_FAILED');
    assert.equal((await raw(id,operation,{importNamingVersion:1})).value.code,'SCHEMA_VALIDATION_FAILED');
    assert.equal((await raw(id,operation,{}, {},{options:{preview:true}})).value.code,'SCHEMA_VALIDATION_FAILED');
  }
  sameState(await cad(id,'document.summary'),before);
  await cad(id,'document.naming.preview');
  // Type metadata changes the engineering state without advancing native R.
  await cad(id,'property.type.create',{key:'StateOnly',targetScope:'project',association:'none',fields:[{key:'f',type:'double'}]});
  const changed=await cad(id,'document.summary');assert.equal(changed.revision,before.revision);assert.notEqual(changed.stateToken,before.stateToken);
  for(const operation of ['document.naming.preview','document.naming.upgrade'])assert.equal((await raw(id,operation,{}, {},{baseRevision:before.revision,baseStateToken:before.stateToken})).value.code,'PROJECT_STATE_CONFLICT');
  sameState(await cad(id,'document.summary'),changed);
});

test('source bytes changed after a valid preview reject commit and preserve both property systems and history',async()=>{
  const id='upgrade_source';await legacy(id);const before=await cad(id,'document.summary');await cad(id,'document.naming.preview');
  const source=before.features[0].stringParameters.sourcePath;assert.ok(path.resolve(source).startsWith(data+path.sep));const bytes=fs.readFileSync(source);
  try{
    fs.appendFileSync(source,'\n');const failed=await raw(id,'document.naming.upgrade');assert.notEqual(failed.status,200);assert.equal(failed.value.code,'STEP_REPLAY_SOURCE_CHANGED');
  }finally{fs.writeFileSync(source,bytes);}
  sameState(await cad(id,'document.summary'),before);
});

test('Loft sections are upgraded at historical inputs, not the later live Body with the same display ID',async()=>{
  const id='upgrade_loft',fixture=await legacy(id),moved=await cad(id,'transform.translate',{dx:0,dy:0,dz:5},{bodyId:fixture.bodyId}),transform=moved.features.at(-1).id;
  const face=await selectGeometry(cad,id,moved,'face',m=>near(m.centroid[2],25)),last=await cad(id,'surface.rectangle',{width:30,height:40,x:15,y:20,z:60});
  const loft=await cad(id,'detail.loft',{}, {sections:[{bodyId:fixture.bodyId,faceId:face},{bodyId:last.bodyId,faceId:last.triangleFaceIds[0]}]}),featureId=loft.features.at(-1).id,loftId=loft.bodyId;
  await cad(id,'transform.translate',{dx:3,dy:0,dz:0},{bodyId:fixture.bodyId});
  const before=await cad(id,'document.summary'),volume=await cad(id,'geometry.measure',{}, {bodyId:loftId});
  const preview=await cad(id,'document.naming.preview');assert.equal(preview.importedNamingUpgrade.referenceCount,2);sameState(await cad(id,'document.summary'),before);
  const upgraded=await cad(id,'document.naming.upgrade'),definition=upgraded.features.find(item=>item.id===featureId),sections=JSON.parse(definition.stringParameters.loftSections);
  assert.ok(sections.every(item=>JSON.parse(item.selector).complete));assert.equal(sections[0].featureId,transform);
  await cad(id,'feature.update',{dz:10},{featureId:transform});const changed=await cad(id,'geometry.measure',{}, {bodyId:loftId});assert.ok(near(volume.volume-changed.volume,6000));
});

test('a selected curved-sweep route is upgraded with source ownership and follows an edited imported-body transform',async()=>{
  const id='upgrade_sweep',fixture=await legacy(id),moved=await cad(id,'transform.translate',{dx:5,dy:0,dz:0},{bodyId:fixture.bodyId}),transform=moved.features.at(-1).id;
  const edge=await selectGeometry(cad,id,moved,'edge',m=>near(m.centroid[0],5)&&near(m.centroid[1],0)&&near(m.length,20)),profile=await cad(id,'surface.disk',{radius:1});
  const pipe=await cad(id,'detail.pipe',{placement:'align-start'},{bodyId:profile.bodyId,faceId:profile.triangleFaceIds[0],pathBodyId:fixture.bodyId,pathEdgeIds:[edge]}),pipeId=pipe.bodyId,featureId=pipe.features.at(-1).id;
  const preview=await cad(id,'document.naming.preview');assert.equal(preview.importedNamingUpgrade.referenceCount,2);
  const upgraded=await cad(id,'document.naming.upgrade'),feature=upgraded.features.find(item=>item.id===featureId),route=JSON.parse(feature.stringParameters.sweepPath);
  assert.equal(route.featureId,transform);assert.ok(route.edges.every(item=>JSON.parse(item.selector).complete));
  await cad(id,'feature.update',{dx:15},{featureId:transform});const measured=await cad(id,'geometry.measure',{}, {bodyId:pipeId});assert.ok(near(measured.bounds.min[0],14)&&near(measured.bounds.max[0],16));assert.ok(near(measured.volume,20*Math.PI));
});

test('imported through-hole Loft upgrades every face and hole seed without filling its channel',async()=>{
  const id='upgrade_holes',fixture=await legacy(id,source=>cad(source,'primitive.tube',{outerRadius:10,innerRadius:2,height:2}));
  const copied=await cad(id,'transform.copy',{dx:0,dy:0,dz:20},{bodyId:fixture.bodyId}),copyId=copied.bodyId,copyFeature=copied.features.at(-1).id;
  async function section(bodyId,z){const view=await cad(id,'body.presentation',{}, {bodyId}),faceId=await selectGeometry(cad,id,view,'face',m=>near(m.centroid[2],z)),hole=await selectGeometry(cad,id,view,'edge',m=>near(m.centroid[2],z)&&near(m.length,4*Math.PI));return {bodyId,faceId,holeEdgeIds:[hole]};}
  const loft=await cad(id,'detail.loft',{}, {sections:[await section(fixture.bodyId,2),await section(copyId,22)]}),loftId=loft.bodyId,featureId=loft.features.at(-1).id;
  const preview=await cad(id,'document.naming.preview');assert.equal(preview.importedNamingUpgrade.referenceCount,4);
  const upgraded=await cad(id,'document.naming.upgrade'),sections=JSON.parse(upgraded.features.find(item=>item.id===featureId).stringParameters.loftSections);
  for(const section of sections){assert.equal(JSON.parse(section.selector).complete,true);assert.equal(section.holeSelectors.length,1);assert.equal(JSON.parse(section.holeSelectors[0]).complete,true);}
  await cad(id,'feature.update',{dz:30},{featureId:copyFeature});const measured=await cad(id,'geometry.measure',{}, {bodyId:loftId});assert.ok(near(measured.volume,30*96*Math.PI));
});

test('suppressed imported Pattern Face/Edge attributes and dormant coordinates survive upgrade, Undo/Redo, portable reopen and restoration',async()=>{
  const id='upgrade_archived_pattern',fixture=await legacy(id),pattern=await cad(id,'pattern.linear',{count:2,spacing:20,directionX:1,directionY:0,directionZ:0},{bodyId:fixture.bodyId}),feature=pattern.features.at(-1),bodyId=feature.outputBodies.at(-1);
  const view=await cad(id,'body.presentation',{}, {bodyId}),face=await selectGeometry(cad,id,view,'face',m=>near(m.centroid[2],20)),edge=await selectGeometry(cad,id,view,'edge',m=>near(m.centroid[0],20)&&near(m.centroid[1],0)&&near(m.length,20));
  const instances=[];
  for(const [kind,topologyId] of [['face',face],['edge',edge]]){
    await cad(id,'property.set',{key:'archivedMarker',type:'int',value:73},{kind,bodyId,topologyId});
    const type=await cad(id,'property.type.create',{key:'Archived'+kind,targetScope:kind,association:'required',fields:[{key:'marker',type:'int'}]});
    const created=await cad(id,'property.instance.create',{typeId:type.type.typeId,value:{marker:73},target:{kind,bodyId,topologyId}});instances.push(created.instance.instanceId);
  }
  await cad(id,'coordinate.set',{id:'archived_frame',name:'Archived top Face',kind:'face',referenceBodyId:bodyId,referenceTopologyId:face});
  await cad(id,'feature.suppress',{}, {featureId:feature.id});
  const before=await cad(id,'document.summary'),rawBefore=(await cad(id,'property.list')).propertyRecords,typedBefore=await Promise.all(instances.map(instance=>typed(id,instance)));
  assert.ok(before.bodyMetadata.every(body=>body.bodyId!==bodyId));assert.ok(typedBefore.every(item=>item.state!=='active'));
  assert.equal(before.coordinateSystems.find(item=>item.id==='archived_frame').referenceState,'unresolved');
  const preview=await cad(id,'document.naming.preview');assert.equal(preview.importedNamingUpgrade.archivedSourceCount,1);assert.ok(preview.importedNamingUpgrade.archivedProofCount>0);assert.ok(preview.importedNamingUpgrade.archivedReferenceCount>0);sameState(await cad(id,'document.summary'),before);
  const withoutNaming=value=>value.bodyMetadata.map(body=>{const copy={...body};delete copy.topologyNaming;return copy;});
  await cad(id,'document.naming.upgrade');const after=await cad(id,'document.summary');assert.deepEqual(withoutNaming(after),withoutNaming(before));assert.deepEqual(after.entityIdentities,before.entityIdentities);assert.deepEqual(after.coordinateSystems,before.coordinateSystems);
  assert.deepEqual((await cad(id,'property.list')).propertyRecords,rawBefore);assert.deepEqual(await Promise.all(instances.map(instance=>typed(id,instance))),typedBefore);
  await cad(id,'document.undo');assert.equal((await cad(id,'document.summary')).features[0].numberParameters.importNamingVersion,undefined);await cad(id,'document.redo');
  const saved=await fetch(api+`/documents/${id}/project/save`,{method:'POST'}),copy=id+'_portable';assert.equal(saved.status,200);const opened=await fetch(api+`/documents/${copy}/project/open`,{method:'POST',headers:{'content-type':'application/vnd.webcad.project'},body:Buffer.from(await saved.arrayBuffer())});assert.equal(opened.status,200,await opened.text());await cad(copy,'document.summary');
  await cad(copy,'feature.restore',{}, {featureId:feature.id});await cad(copy,'feature.update',{spacing:30},{featureId:feature.id});
  for(const [index,kind] of ['face','edge'].entries()){
    const item=await typed(copy,instances[index]);assert.equal(item.state,'active');assert.deepEqual(item.value,{marker:73});const measured=await cad(copy,'geometry.measure',{}, {bodyId:item.target.bodyId,selectionType:kind,selectionId:item.target.topologyId});
    assert.ok(near(measured.centroid[0],kind==='face'?45:30));if(kind==='face')assert.ok(near(measured.area,1200));else assert.ok(near(measured.length,20));
  }
  const coordinate=(await cad(copy,'document.summary')).coordinateSystems.find(item=>item.id==='archived_frame');assert.equal(coordinate.referenceState,'resolved');assert.ok(near(coordinate.origin[0],45));
  await stop();await start();assert.equal((await typed(copy,instances[0])).state,'active');assert.equal((await typed(copy,instances[1])).state,'active');
});

test('a dormant Face coordinate on a suppressed unary feature is upgraded even without a removed-Body archive',async()=>{
  const id='upgrade_dormant_coordinate',fixture=await legacy(id),moved=await cad(id,'transform.translate',{dx:5,dy:0,dz:0},{bodyId:fixture.bodyId}),featureId=moved.features.at(-1).id,face=await selectGeometry(cad,id,moved,'face',m=>near(m.centroid[2],20));
  await cad(id,'coordinate.set',{id:'dormant',name:'Dormant transform Face',kind:'face',referenceBodyId:fixture.bodyId,referenceTopologyId:face});await cad(id,'feature.suppress',{}, {featureId});
  const before=await cad(id,'document.summary'),frame=before.coordinateSystems.find(item=>item.id==='dormant');assert.equal(frame.referenceState,'unresolved');
  const preview=await cad(id,'document.naming.preview');assert.equal(preview.importedNamingUpgrade.archivedSourceCount,1);assert.equal(preview.importedNamingUpgrade.archivedProofCount,0);assert.equal(preview.importedNamingUpgrade.archivedReferenceCount,1);sameState(await cad(id,'document.summary'),before);
  await cad(id,'document.naming.upgrade');assert.deepEqual((await cad(id,'document.summary')).coordinateSystems,before.coordinateSystems);
  await cad(id,'feature.restore',{}, {featureId});await cad(id,'feature.update',{dx:15},{featureId});const after=(await cad(id,'document.summary')).coordinateSystems.find(item=>item.id==='dormant');assert.equal(after.referenceState,'resolved');assert.ok(near(after.origin[0]-frame.origin[0],10));
});

test('a selected imported Sheet generator uses stable archived definitions rather than temporary Face IDs',async()=>{
  const id='upgrade_archived_thicken',fixture=await legacy(id,source=>cad(source,'surface.rectangle',{width:20,height:10})),thick=await cad(id,'detail.thicken',{thickness:2},{bodyId:fixture.bodyId,faceId:fixture.view.triangleFaceIds[0]}),feature=thick.features.at(-1),bodyId=thick.bodyId,face=await selectGeometry(cad,id,thick,'face',m=>near(m.centroid[2],2));
  await cad(id,'property.set',{key:'generatedMarker',type:'int',value:91},{kind:'face',bodyId,topologyId:face});
  const type=await cad(id,'property.type.create',{key:'ArchivedThicken',targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]}),instance=await cad(id,'property.instance.create',{typeId:type.type.typeId,value:{marker:91},target:{kind:'face',bodyId,topologyId:face}});
  await cad(id,'feature.suppress',{}, {featureId:feature.id});const before=await cad(id,'document.summary');await cad(id,'document.naming.preview');sameState(await cad(id,'document.summary'),before);await cad(id,'document.naming.upgrade');assert.notEqual((await typed(id,instance.instance.instanceId)).state,'active');
  await cad(id,'feature.restore',{}, {featureId:feature.id});await cad(id,'feature.update',{thickness:3},{featureId:feature.id});const record=await typed(id,instance.instance.instanceId);assert.equal(record.state,'active');const measured=await cad(id,'geometry.measure',{}, {bodyId,selectionType:'face',selectionId:record.target.topologyId});assert.ok(near(measured.centroid[2],3));assert.ok(near(measured.area,200));
});

test('a later unprovable archived source rolls back the entire upgrade and leaves the earlier proof usable',async()=>{
  const id='upgrade_archive_atomic',fixture=await legacy(id);
  const first=await cad(id,'pattern.linear',{count:2,spacing:20,directionX:1,directionY:0,directionZ:0},{bodyId:fixture.bodyId}),a=first.features.at(-1),bodyId=a.outputBodies.at(-1),view=await cad(id,'body.presentation',{}, {bodyId});
  await cad(id,'property.set',{key:'firstArchive',type:'int',value:31},{kind:'face',bodyId,topologyId:view.triangleFaceIds[0]});await cad(id,'feature.suppress',{}, {featureId:a.id});
  const second=await cad(id,'pattern.linear',{count:2,spacing:40,directionX:1,directionY:0,directionZ:0},{bodyId:fixture.bodyId}),b=second.features.at(-1);await cad(id,'feature.suppress',{}, {featureId:b.id});await cad(id,'feature.update',{spacing:50},{featureId:b.id});
  const before=await cad(id,'document.summary'),properties=(await cad(id,'property.list')).propertyRecords;
  for(const operation of ['document.naming.preview','document.naming.upgrade']){const failure=await raw(id,operation);assert.notEqual(failure.status,200);assert.equal(failure.value.code,'IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED');assert.equal(failure.value.details.archiveSourceFeatureId,b.id);sameState(await cad(id,'document.summary'),before);assert.deepEqual((await cad(id,'property.list')).propertyRecords,properties);}
  await cad(id,'feature.restore',{}, {featureId:a.id});const active=(await cad(id,'property.list')).propertyRecords.filter(item=>item.state==='active'&&item.values.firstArchive);assert.equal(active.length,1);assert.equal(active[0].bodyId,bodyId);
});
