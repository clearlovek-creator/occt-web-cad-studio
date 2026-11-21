import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {openLegacyStepProject} from './helpers/legacy-step-project.mjs';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGeneratedFixture,selectGeometry,originBox,movedBox} from './helpers/generated-topology-fixtures.mjs';

const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-generated-命名-')),api='http://127.0.0.1:8881/api';
let gateway;const states=new Map();
async function start(){gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8881',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let diagnostic='';const timer=setTimeout(()=>reject(Error('Gateway startup timeout '+diagnostic)),20000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>diagnostic+=chunk);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){if(!gateway)return;const child=gateway;gateway=null;const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}
before(start);after(async()=>{await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function cad(id,operation,parameters={},inputs={}){const state=states.get(id);const r=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})})});const p=await r.json();assert.equal(p.ok,true,JSON.stringify(p));states.set(id,p);return p;}
const near=(a,b)=>Math.abs(a-b)<1e-4;
function expectedFace(operation,height){
  if(operation==='detail.shell')return {centroid:[130,225,52],area:56*46};
  if(operation==='detail.thicken')return {centroid:[130,200,50+height+1],area:120};
  if(operation==='detail.draft')return {centroid:[100+(50+height/2)*Math.tan(Math.PI/36),225,50+height/2],area:50*height/Math.cos(Math.PI/36)};
  if(operation==='detail.chamfer')return {centroid:[101,201,50+height/2],area:2*Math.SQRT2*height};
  const d=4/Math.PI;
  return {centroid:operation==='detail.offset'?[100-d,200-d,50+height/2]:[102-d,202-d,50+height/2],area:Math.PI*height};
}
function checkFace(measured,operation,height){const expected=expectedFace(operation,height);assert.ok(near(measured.area,expected.area),JSON.stringify({operation,area:measured.area,expected:expected.area}));measured.centroid.forEach((value,index)=>assert.ok(near(value,expected.centroid[index]),JSON.stringify({operation,centroid:measured.centroid,expected:expected.centroid})));}
const select=(...args)=>selectGeometry(cad,...args);
const fixture=(id,operation)=>createGeneratedFixture(cad,id,operation);
async function bind(id,bodyId,topologyId,key='Boundary'){const type=await cad(id,'property.type.create',{key,targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]});const instance=await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Generated face boundary '+key,value:{marker:7},target:{kind:'face',bodyId,topologyId}});await cad(id,'property.set',{key:'marker',type:'int',value:7},{kind:'face',bodyId,topologyId});return instance.instance.instanceId;}
async function attached(id,instanceId){return (await cad(id,'property.instance.list')).instances.find(i=>i.instanceId===instanceId);}

for(const operation of ['detail.fillet','detail.chamfer','detail.shell','detail.thicken','detail.offset','detail.draft'])test(`${operation} generated face properties survive upstream dimensions/placement, Undo/Redo and portable projects`,async()=>{
  const id='generated_'+operation.split('.')[1],f=await fixture(id,operation),instanceId=await bind(id,f.result.bodyId,f.face),before=await cad(id,'document.view');
  const changed=await cad(id,'feature.update',movedBox,{featureId:f.base.features[0].id});
  const instance=await attached(id,instanceId);assert.equal(instance.state,'active',JSON.stringify({instance,before:before.bodyMetadata.find(b=>b.bodyId===f.result.bodyId)?.topologyNaming,after:changed.bodyMetadata.find(b=>b.bodyId===f.result.bodyId)?.topologyNaming}));assert.deepEqual(instance.value,{marker:7});
  const body=changed.bodyMetadata.find(b=>b.bodyId===instance.target.bodyId);assert.equal(body.topologyNaming.namedFaceCount,body.faceCount);assert.equal(body.topologyNaming.namedEdgeCount,body.edgeCount);
  const m=await cad(id,'geometry.measure',{}, {bodyId:instance.target.bodyId,selectionType:'face',selectionId:instance.target.topologyId});
  checkFace(m,operation,35);
  assert.ok(m.centroid[0]>95&&m.centroid[0]<160&&m.centroid[1]>195&&m.centroid[1]<250&&m.centroid[2]>49&&m.centroid[2]<90,JSON.stringify({area:m.area,centroid:m.centroid}));
  if(operation==='detail.shell'){assert.ok(near(m.centroid[2],52));assert.ok(near(m.area,56*46));}
  if(operation==='detail.thicken'){assert.ok(near(m.centroid[0],130)&&near(m.centroid[1],200)&&near(m.centroid[2],86));assert.ok(near(m.area,120));}
  const raw=(await cad(id,'property.list')).propertyRecords.filter(r=>r.values.marker&&r.state==='active');assert.equal(raw.length,1);assert.equal(raw[0].topologyId,instance.target.topologyId);
  const undo=await cad(id,'document.undo');assert.deepEqual(undo.features,before.features);assert.equal((await attached(id,instanceId)).target.topologyId,f.face);
  await cad(id,'document.redo');assert.equal((await attached(id,instanceId)).state,'active');
  const saved=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(saved.status,200);const portable=id+'_portable';const opened=await fetch(api+`/documents/${portable}/project/open`,{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:Buffer.from(await saved.arrayBuffer())});assert.equal(opened.status,200,await opened.text());
  await cad(portable,'document.summary');await cad(portable,'feature.update',{height:45},{featureId:f.base.features[0].id});const restored=await attached(portable,instanceId);assert.equal(restored.state,'active');checkFace(await cad(portable,'geometry.measure',{}, {bodyId:restored.target.bodyId,selectionType:'face',selectionId:restored.target.topologyId}),operation,45);
});

test('generated faces can drive persistent coordinates and dependent geometry across upstream and local feature changes',async()=>{
  const id='generated_coordinate',f=await fixture(id,'detail.fillet');
  const frame=await cad(id,'coordinate.set',{id:'blend_frame',name:'Blend frame',kind:'face',referenceBodyId:f.result.bodyId,referenceTopologyId:f.face});const original=frame.coordinateSystems.find(c=>c.id==='blend_frame').origin;
  const child=await cad(id,'primitive.box',{width:1,depth:1,height:1,coordinateSystemId:'blend_frame'});
  const updated=await cad(id,'feature.update',movedBox,{featureId:f.base.features[0].id}),coordinate=updated.coordinateSystems.find(c=>c.id==='blend_frame');assert.equal(coordinate.referenceState,'resolved');assert.ok(near(coordinate.origin[0]-original[0],100)&&near(coordinate.origin[1]-original[1],200)&&near(coordinate.origin[2]-original[2],57.5));
  const resized=await cad(id,'feature.update',{radius:3},{featureId:f.result.features.at(-1).id});assert.equal(resized.coordinateSystems.find(c=>c.id==='blend_frame').referenceState,'resolved');assert.equal((await cad(id,'geometry.check',{}, {bodyId:child.bodyId})).valid,true);
});

test('a generated fillet face remains the same boundary after two Boolean cuts and upstream/detail edits',async()=>{
  const id='generated_boolean_chain',f=await fixture(id,'detail.fillet');
  const cylinder=await cad(id,'primitive.cylinder',{radius:3,height:60,x:15,y:20,z:-10});
  await cad(id,'boolean.cut',{}, {targetBody:f.result.bodyId,toolBody:cylinder.bodyId});
  const notch=await cad(id,'primitive.box',{width:10,depth:20,height:60,x:25,y:30,z:-10});
  const final=await cad(id,'boolean.cut',{}, {targetBody:f.result.bodyId,toolBody:notch.bodyId});
  const face=await select(id,final,'face',m=>near(m.area,Math.PI*20)&&near(m.centroid[0],2-4/Math.PI)&&near(m.centroid[1],2-4/Math.PI));
  const instanceId=await bind(id,final.bodyId,face),before=await cad(id,'document.view');
  await cad(id,'feature.update',{width:60,depth:50,height:35},{featureId:f.base.features[0].id});
  const check=async(radius)=>{
    const instance=await attached(id,instanceId);assert.equal(instance.state,'active');assert.deepEqual(instance.value,{marker:7});
    const measured=await cad(id,'geometry.measure',{}, {bodyId:instance.target.bodyId,selectionType:'face',selectionId:instance.target.topologyId});
    assert.ok(near(measured.area,Math.PI*radius/2*35));assert.ok(near(measured.centroid[0],radius-2*radius/Math.PI)&&near(measured.centroid[1],radius-2*radius/Math.PI)&&near(measured.centroid[2],17.5));
    const records=(await cad(id,'property.list')).propertyRecords.filter(r=>r.state==='active'&&r.values.marker);assert.equal(records.length,1);assert.equal(records[0].topologyId,instance.target.topologyId);
  };
  await check(2);await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);assert.equal((await attached(id,instanceId)).target.topologyId,face);
  await cad(id,'document.redo');await check(2);await cad(id,'feature.update',{radius:3},{featureId:f.result.features.at(-1).id});await check(3);
});

test('changing a fillet generator edge never moves its property to another blend, and Undo restores the exact association',async()=>{
  const id='generated_reselect',f=await fixture(id,'detail.fillet'),first=await bind(id,f.result.bodyId,f.face,'First');
  const edge=await select(id,f.result,'edge',m=>near(m.centroid[0],30)&&near(m.centroid[1],40)&&near(m.length,20));
  const second=await cad(id,'detail.fillet',{radius:2},{bodyId:f.result.bodyId,edgeId:edge});const face=await select(id,second,'face',m=>m.centroid[0]>28&&m.centroid[0]<30&&m.centroid[1]>38&&m.centroid[1]<40&&near(m.centroid[2],10));const other=await bind(id,second.bodyId,face,'Second');
  const before=await cad(id,'document.view'),featureId=f.result.features.at(-1).id;
  const input=await cad(id,'feature.input.preview',{changes:{radius:2}},{featureId,editedFeatureId:featureId}),p=input.inputPreview;
  const picked=p.presentation.edges.find(e=>e.points.every((value,i)=>i%3===0?near(value,30):i%3===1?near(value,0):true));assert.ok(picked);
  const edit={documentId:id,featureId,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:'edge',inputFingerprint:p.inputFingerprint,index:Number(picked.edgeId.split('-').at(-1))};
  await cad(id,'feature.update',{radius:2,selectionEdits:[edit]},{featureId});
  assert.notEqual((await attached(id,first)).state,'active');assert.deepEqual((await attached(id,first)).value,{marker:7});const retained=await attached(id,other);assert.equal(retained.state,'active');
  const measured=await cad(id,'geometry.measure',{}, {bodyId:retained.target.bodyId,selectionType:'face',selectionId:retained.target.topologyId});assert.ok(measured.centroid[0]>28&&measured.centroid[1]>38);
  await cad(id,'document.undo');assert.equal((await attached(id,first)).state,'active');assert.equal((await attached(id,other)).state,'active');assert.deepEqual((await cad(id,'document.view')).features,before.features);
});

test('retained outer skins keep their original properties when shell creates an independent inner skin',async()=>{
  const id='generated_skin_identity',base=await cad(id,'primitive.box',originBox),side=await select(id,base,'face',m=>near(m.centroid[0],0)),instanceId=await bind(id,base.bodyId,side);
  const top=await select(id,base,'face',m=>near(m.centroid[2],20));await cad(id,'detail.shell',{thickness:2},{bodyId:base.bodyId,faceId:top});const result=await attached(id,instanceId);assert.equal(result.state,'active');
  const measured=await cad(id,'geometry.measure',{}, {bodyId:result.target.bodyId,selectionType:'face',selectionId:result.target.topologyId});assert.ok(near(measured.centroid[0],0));assert.ok(!near(measured.centroid[0],2),'The inner offset skin is a new face, not the retained outer face');
  const values=(await cad(id,'property.list')).propertyRecords.filter(r=>r.state==='active'&&r.values.marker);assert.equal(values.length,1);assert.equal(values[0].topologyId,result.target.topologyId);
});

test('suppressing a generated face preserves its values without attaching them to a surviving planar face',async()=>{
  const id='generated_suppressed',f=await fixture(id,'detail.fillet'),instanceId=await bind(id,f.result.bodyId,f.face);const before=await cad(id,'document.view');
  const suppressed=await cad(id,'feature.suppress',{}, {featureId:f.result.features.at(-1).id});assert.equal(suppressed.bodyMetadata[0].faceCount,6);
  const missing=await attached(id,instanceId);assert.notEqual(missing.state,'active');assert.deepEqual(missing.value,{marker:7});
  assert.equal((await cad(id,'property.list')).propertyRecords.filter(r=>r.state==='active'&&r.values.marker).length,0);
  const undone=await cad(id,'document.undo');assert.deepEqual(undone.features,before.features);assert.equal((await attached(id,instanceId)).state,'active');
});

test('changing a shell opening retires the old rim property instead of binding it to the now-retained outer face',async()=>{
  const id='generated_shell_opening',f=await fixture(id,'detail.shell');const rim=await select(id,f.result,'face',m=>near(m.centroid[2],20)&&near(m.area,30*40-26*36));const instanceId=await bind(id,f.result.bodyId,rim),featureId=f.result.features.at(-1).id;
  const input=await cad(id,'feature.input.preview',{changes:{thickness:2}},{featureId,editedFeatureId:featureId}),p=input.inputPreview;
  let index;for(let t=0;t<p.presentation.triangleFaceIds.length;t++)if(p.presentation.indices.slice(t*3,t*3+3).every(v=>near(p.presentation.positions[v*3],30)))index=Number(p.presentation.triangleFaceIds[t].split('-').at(-1));assert.ok(index);
  const edit={documentId:id,featureId,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:'face',inputFingerprint:p.inputFingerprint,index};
  await cad(id,'feature.update',{thickness:2,selectionEdits:[edit]},{featureId});const result=await attached(id,instanceId);assert.notEqual(result.state,'active','The old top rim is NOT the uncut top outer Face after moving the opening to a side');assert.deepEqual(result.value,{marker:7});
  await cad(id,'document.undo');assert.equal((await attached(id,instanceId)).state,'active');
});

test('unnamed legacy imported generators remain unproven after geometry changes instead of acquiring fabricated semantic identities',async()=>{
  const source='generated_import_source';await cad(source,'primitive.box',originBox);const exported=await(await fetch(api+`/documents/${source}/exports/step`,{method:'POST'})).json();assert.equal(exported.ok,true);const bytes=await(await fetch('http://127.0.0.1:8881'+exported.downloadUrl)).arrayBuffer();
  const id='generated_imported',modern=id+'_modern',imported=await fetch(api+`/documents/${modern}/imports/step`,{method:'POST',headers:{'Content-Type':'application/step'},body:bytes});assert.equal(imported.status,200,await imported.text());await openLegacyStepProject(api,modern,id);const state=await cad(id,'document.summary'),view=await cad(id,'body.presentation',{}, {bodyId:state.activeBodyId});
  const edge=await select(id,view,'edge',m=>near(m.centroid[0],0)&&near(m.centroid[1],0)&&near(m.length,20));const detail=await cad(id,'detail.fillet',{radius:2},{bodyId:view.bodyId,edgeId:edge});const face=await select(id,detail,'face',m=>m.centroid[0]>0&&m.centroid[0]<2&&m.centroid[1]>0&&m.centroid[1]<2&&near(m.centroid[2],10));
  const instanceId=await bind(id,detail.bodyId,face);const updated=await cad(id,'feature.update',{radius:3},{featureId:detail.features.at(-1).id});assert.equal(updated.bodyMetadata[0].topologyNaming.namedFaceCount,0);
  const unresolved=await attached(id,instanceId);assert.notEqual(unresolved.state,'active');assert.deepEqual(unresolved.value,{marker:7});
});
