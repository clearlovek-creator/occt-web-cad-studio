import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectGeometry} from './helpers/generated-topology-fixtures.mjs';
import {createLoftRepairFixture,loftRepairFaceIndex} from './helpers/loft-repair-fixtures.mjs';
import {constructedPatterns} from './helpers/constructed-topology-fixtures.mjs';
import {createGeneratedFixture} from './helpers/generated-topology-fixtures.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-lifecycle-recovery-状态-')),api='http://127.0.0.1:8890/api',states=new Map();let gateway;
async function startGateway(){gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8890',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let diagnostics='';const timer=setTimeout(()=>reject(Error('Gateway startup timeout '+diagnostics)),20000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>diagnostics+=chunk);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stopGateway(){if(!gateway || gateway.exitCode!==null)return;const ended=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await ended;}
before(startGateway);
after(async()=>{await stopGateway();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function raw(id,operation,parameters={},inputs={},options={}){const state=states.get(id),result=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,options,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})})}).then(r=>r.json());if(result.ok&&!options.preview)states.set(id,result);return result;}
async function cad(...args){const r=await raw(...args);assert.equal(r.ok,true,JSON.stringify(r));return r;}
const near=(a,b)=>Math.abs(a-b)<1e-5;

async function bind(id,bodyId,kind,topologyId,key){const type=await cad(id,'property.type.create',{key,targetScope:kind,association:'required',fields:[{key:'marker',type:'int'}]});return (await cad(id,'property.instance.create',{typeId:type.type.typeId,name:key,value:{marker:7},target:{kind,bodyId,topologyId}})).instance;}
async function attached(id,instanceId){return (await cad(id,'property.instance.list')).instances.find(item=>item.instanceId===instanceId);}

for(const operation of ['detail.thicken','detail.revolve','detail.sweep','detail.pipe',...Object.keys(constructedPatterns)])test(`${operation} restores Face/Edge properties through repeated suppression, Undo and Redo without creating a replacement Body`,async()=>{
  const id='lifecycle_'+operation.replace('.','_');let result;
  if(operation==='detail.thicken')result=(await createGeneratedFixture(cad,id,operation)).result;
  else if(operation.startsWith('pattern.')){const base=await cad(id,'primitive.box',{width:10,depth:8,height:6,x:20});result=await cad(id,operation,constructedPatterns[operation].parameters,{bodyId:base.bodyId});}
  else {const profile=await cad(id,'surface.rectangle',{width:10,height:8,x:20});result=await cad(id,operation,operation==='detail.revolve'?{angleDegrees:90,axisY:1,axisZ:0}:{pathX:0,pathY:0,pathZ:12},{bodyId:profile.bodyId,faceId:profile.triangleFaceIds[0]});}
  const featureId=result.features.at(-1).id,bodyId=result.features.at(-1).outputBodies.at(-1),view=await cad(id,'body.presentation',{}, {bodyId}),faceId=view.triangleFaceIds[0],edgeId=view.edges[0].edgeId;
  const face=await bind(id,bodyId,'face',faceId,'FaceBoundary'),edge=await bind(id,bodyId,'edge',edgeId,'EdgeBoundary');
  await cad(id,'property.set',{key:'rawMarker',type:'int',value:19},{kind:'face',bodyId,topologyId:faceId});
  const before=await cad(id,'document.view'),bodyIdentity=before.bodyMetadata.find(body=>body.bodyId===bodyId).bodyIdentity;
  for(let pass=0;pass<2;pass++){
    const suppressed=await cad(id,'feature.suppress',{}, {featureId});assert.equal(suppressed.bodyMetadata.some(body=>body.bodyId===bodyId),false);assert.notEqual((await attached(id,face.instanceId)).state,'active');
    assert.ok(suppressed.features.every(feature=>!Object.hasOwn(feature,'suspendedTopology')),'Private bulk recovery evidence must not enter UI/Agent model responses');
    const restored=await cad(id,'feature.restore',{}, {featureId});assert.equal(restored.bodyMetadata.find(body=>body.bodyId===bodyId).bodyIdentity,bodyIdentity);
    for(const record of [face,edge]){const current=await attached(id,record.instanceId);assert.equal(current.state,'active',JSON.stringify(current));assert.deepEqual(current.value,{marker:7});const measured=await cad(id,'geometry.measure',{}, {bodyId,selectionType:current.target.kind,selectionId:current.target.topologyId});assert.ok((measured.area??measured.length)>0);}
    const raw=(await cad(id,'property.list')).propertyRecords.filter(record=>record.bodyId===bodyId&&record.state==='active'&&record.values.rawMarker);assert.equal(raw.length,1);assert.equal(raw[0].values.rawMarker.value,19);
    await cad(id,'document.undo');assert.equal((await cad(id,'document.view')).bodyMetadata.some(body=>body.bodyId===bodyId),false);assert.notEqual((await attached(id,face.instanceId)).state,'active');
    await cad(id,'document.redo');assert.equal((await attached(id,face.instanceId)).state,'active');
  }
});

test('suppressed Loft geometry and Face properties recover together across portable project opening',async()=>{
  const id='lifecycle_property',a=await cad(id,'surface.disk',{radius:5,z:7}),b=await cad(id,'surface.disk',{radius:10,z:27}),loft=await cad(id,'detail.loft',{}, {sections:[{bodyId:a.bodyId,faceId:a.triangleFaceIds[0]},{bodyId:b.bodyId,faceId:b.triangleFaceIds[0]}]}),featureId=loft.features.at(-1).id,cap=await selectGeometry(cad,id,loft,'face',m=>near(m.centroid[2],27)),type=await cad(id,'property.type.create',{key:'Boundary',targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]}),instance=(await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'End boundary',value:{marker:7},target:{kind:'face',bodyId:loft.bodyId,topologyId:cap}})).instance;
  const before=await cad(id,'document.view');await cad(id,'feature.suppress',{}, {featureId});const missing=(await cad(id,'property.instance.list')).instances.find(item=>item.instanceId===instance.instanceId);assert.notEqual(missing.state,'active');assert.deepEqual(missing.value,{marker:7});
  const saved=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(saved.status,200);const copy=id+'_copy',opened=await fetch(api+`/documents/${copy}/project/open`,{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:Buffer.from(await saved.arrayBuffer())});assert.equal(opened.status,200,await opened.text());await cad(copy,'document.summary');const result=await cad(copy,'feature.restore',{}, {featureId});assert.equal(result.bodyMetadata.find(body=>body.bodyId===loft.bodyId).bodyIdentity,before.bodyMetadata.find(body=>body.bodyId===loft.bodyId).bodyIdentity);
  const restored=(await cad(copy,'property.instance.list')).instances.find(item=>item.instanceId===instance.instanceId);assert.equal(restored.state,'active',JSON.stringify(restored));assert.deepEqual(restored.value,{marker:7});const measured=await cad(copy,'geometry.measure',{}, {bodyId:loft.bodyId,selectionType:'face',selectionId:restored.target.topologyId});assert.ok(near(measured.area,Math.PI*100));assert.ok(near(measured.centroid[2],27));
});

test('restoring a Loft after upstream topology changed requires a joint historical section repair, with no partial restoration',async()=>{
  const id='lifecycle_restore_repair',f=await createLoftRepairFixture(cad,id);await cad(id,'feature.suppress',{}, {featureId:f.loftFeature});await cad(id,'feature.update',{x:8},{featureId:f.tool.features.at(-1).id});const before=await cad(id,'document.view'),failed=await raw(id,'feature.restore',{}, {featureId:f.loftFeature});assert.equal(failed.code,'LOFT_SECTION_UNRESOLVED');assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  const proposal={operation:'feature.restore',inputs:{featureId:f.loftFeature},parameters:{}},response=await cad(id,'feature.input.preview',{proposal},{featureId:f.loftFeature,sectionId:f.refs[0].sectionId}),p=response.inputPreview,edit={documentId:id,featureId:f.loftFeature,sectionId:p.sectionId,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:'face',inputFingerprint:p.inputFingerprint,index:loftRepairFaceIndex(p.presentation,10,8)};
  await cad(id,'feature.restore',{selectionEdits:[edit]},{featureId:f.loftFeature},{preview:true});assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);await cad(id,'feature.restore',{selectionEdits:[edit]},{featureId:f.loftFeature});assert.equal((await cad(id,'geometry.check',{}, {bodyId:f.loft.bodyId})).valid,true);await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);
});

test('deleting an unrepresented suppressed feature is undoable without replacing its source geometry',async()=>{
  const id='lifecycle_delete_recovery',f=await createLoftRepairFixture(cad,id);await cad(id,'feature.suppress',{}, {featureId:f.loftFeature});const before=await cad(id,'document.view'),result=await cad(id,'feature.delete',{}, {featureId:f.loftFeature});assert.equal(result.features.some(feature=>feature.id===f.loftFeature),false);assert.deepEqual(result.bodyMetadata.map(body=>body.bodyId),before.bodyMetadata.map(body=>body.bodyId));await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);
});

test('a same-position replacement section while Loft is suppressed cannot inherit the old cap property',async()=>{
  const id='lifecycle_replaced_cap',a=await cad(id,'surface.disk',{radius:5,z:7}),b=await cad(id,'surface.disk',{radius:10,z:27}),loft=await cad(id,'detail.loft',{}, {sections:[{bodyId:a.bodyId,faceId:a.triangleFaceIds[0]},{bodyId:b.bodyId,faceId:b.triangleFaceIds[0]}]}),featureId=loft.features.at(-1).id,cap=await selectGeometry(cad,id,loft,'face',m=>near(m.centroid[2],27)),instance=await bind(id,loft.bodyId,'face',cap,'ReplacedBoundary');
  const start=await selectGeometry(cad,id,loft,'face',m=>near(m.centroid[2],7)),retained=await bind(id,loft.bodyId,'face',start,'RetainedBoundary');
  await cad(id,'feature.suppress',{}, {featureId});const replacement=await cad(id,'surface.disk',{radius:10,z:27}),view=await cad(id,'document.view'),refs=JSON.parse(view.features.find(feature=>feature.id===featureId).stringParameters.loftSections);
  await cad(id,'feature.update',{loftDefinition:{sections:[{sectionId:refs[0].sectionId},{bodyId:replacement.bodyId,faceId:replacement.triangleFaceIds[0]}],placement:'actual',ruled:false}},{featureId});
  await cad(id,'feature.restore',{}, {featureId});const old=await attached(id,instance.instanceId);assert.notEqual(old.state,'active','Identical geometry does not prove the same selected profile');assert.deepEqual(old.value,{marker:7});
  assert.equal((await attached(id,retained.instanceId)).state,'active','The unchanged opposite cap must retain its own independent generating identity');
});

test('private recovery proofs survive a Gateway restart and resize only their proven generated Face',async()=>{
  const id='lifecycle_restart',a=await cad(id,'surface.disk',{radius:5,z:7}),b=await cad(id,'surface.disk',{radius:10,z:27}),loft=await cad(id,'detail.loft',{}, {sections:[{bodyId:a.bodyId,faceId:a.triangleFaceIds[0]},{bodyId:b.bodyId,faceId:b.triangleFaceIds[0]}]}),featureId=loft.features.at(-1).id,cap=await selectGeometry(cad,id,loft,'face',m=>near(m.centroid[2],27)),instance=await bind(id,loft.bodyId,'face',cap,'RestartBoundary');
  await cad(id,'feature.suppress',{}, {featureId});await cad(id,'feature.update',{radius:12},{featureId:b.features.at(-1).id});const suppressed=await cad(id,'document.view');
  await stopGateway();await startGateway();const reopened=await cad(id,'document.summary');assert.equal(reopened.stateToken,suppressed.stateToken);assert.deepEqual(reopened.features,suppressed.features);
  await cad(id,'feature.restore',{}, {featureId});const current=await attached(id,instance.instanceId);assert.equal(current.state,'active',JSON.stringify(current));const measured=await cad(id,'geometry.measure',{}, {bodyId:loft.bodyId,selectionType:'face',selectionId:current.target.topologyId});assert.ok(near(measured.area,Math.PI*144));assert.ok(near(measured.centroid[2],27));
});
