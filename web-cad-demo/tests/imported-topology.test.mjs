import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {stopTestChild} from './helpers/stop-test-child.mjs';
import {selectGeometry} from './helpers/generated-topology-fixtures.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-import-naming-中文-')),states=new Map();let gateway,api;
async function start(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));api=`http://127.0.0.1:${port}/api`;gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:String(port)}});await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Import naming fixture startup unconfirmed')),20000);gateway.once('error',reject);gateway.once('exit',code=>{clearTimeout(timer);reject(Error('Import naming fixture exited '+code));});gateway.stderr.on('data',()=>{});gateway.stdout.on('data',bytes=>{output=(output+bytes).slice(-8192);if(output.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){if(!gateway)return;const child=gateway;if(child.exitCode===null&&child.signalCode===null){const control=JSON.parse(fs.readFileSync(path.join(data,'.gateway-control.json'),'utf8'));assert.equal(control.ownerPid,child.pid);let timer;const ended=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Import fixture shutdown unconfirmed; preserve '+data)),25000);child.once('close',code=>code===0?resolve():reject(Error('Import fixture exit '+code)));});try{await fetch(api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':control.token},signal:AbortSignal.timeout(3000)}).catch(()=>{});await ended;}finally{clearTimeout(timer);}}await stopTestChild(child);gateway=null;}
before(start);after(async()=>{await stop();assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.ok(path.basename(data).startsWith('cad-import-naming-'));fs.rmSync(data,{recursive:true,force:true});});
async function cad(id,operation,parameters={},inputs={}){const state=states.get(id),response=await fetch(api+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})})}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.ok,true);states.set(id,value);return value;}
const near=(a,b)=>Math.abs(a-b)<1e-5;
async function importedBox(id){const source=id+'_source';await cad(source,'primitive.box',{width:30,depth:40,height:20});const exported=await fetch(api+`/documents/${source}/exports/step`,{method:'POST'}).then(response=>response.json());assert.equal(exported.ok,true);const bytes=await fetch(new URL(exported.downloadUrl,api)).then(response=>response.arrayBuffer());const response=await fetch(api+`/documents/${id}/imports/step`,{method:'POST',headers:{'content-type':'application/step'},body:bytes}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));states.set(id,value);const bodyId=value.activeBodyId;return {imported:value,bodyId,view:await cad(id,'body.presentation',{}, {bodyId})};}
async function bind(id,bodyId,face,key='ImportedBoundary'){await cad(id,'property.set',{key:'rawImportedMarker',type:'int',value:71},{kind:'face',bodyId,topologyId:face});const type=await cad(id,'property.type.create',{key,targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]});const instance=await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Boundary from STEP',value:{marker:71},target:{kind:'face',bodyId,topologyId:face}});return instance.instance.instanceId;}
async function instance(id,instanceId){return (await cad(id,'property.instance.list')).instances.find(item=>item.instanceId===instanceId);}

test('a fillet created from immutable STEP topology retains raw and typed Face attributes when its radius changes',async()=>{
  const id='import_fillet',f=await importedBox(id),edge=await selectGeometry(cad,id,f.view,'edge',m=>near(m.centroid[0],0)&&near(m.centroid[1],0)&&near(m.length,20));
  const result=await cad(id,'detail.fillet',{radius:2},{bodyId:f.bodyId,edgeId:edge}),featureId=result.features.at(-1).id;
  const face=await selectGeometry(cad,id,result,'face',m=>near(m.area,20*Math.PI)&&m.centroid[0]>0&&m.centroid[0]<2&&m.centroid[1]>0&&m.centroid[1]<2);
  const instanceId=await bind(id,f.bodyId,face),before=await cad(id,'document.view');
  const changed=await cad(id,'feature.update',{radius:3},{featureId}),record=await instance(id,instanceId);
  assert.equal(record.state,'active','Same retained STEP bytes must keep the fillet generator reference when only its radius changes');assert.deepEqual(record.value,{marker:71});
  const measured=await cad(id,'geometry.measure',{}, {bodyId:record.target.bodyId,selectionType:'face',selectionId:record.target.topologyId});assert.ok(near(measured.area,30*Math.PI));assert.ok(near(measured.centroid[0],3-6/Math.PI)&&near(measured.centroid[1],3-6/Math.PI));
  const raw=(await cad(id,'property.list')).propertyRecords.filter(item=>item.state==='active'&&item.values.rawImportedMarker);assert.equal(raw.length,1);assert.equal(raw[0].topologyId,record.target.topologyId);
  const metadata=changed.bodyMetadata.find(item=>item.bodyId===f.bodyId);assert.equal(metadata.topologyNaming.namedFaceCount,metadata.faceCount);assert.equal(metadata.topologyNaming.namedEdgeCount,metadata.edgeCount);
  await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);assert.equal((await instance(id,instanceId)).target.topologyId,face);
  await cad(id,'document.redo');assert.equal((await instance(id,instanceId)).state,'active');
  const saved=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(saved.status,200);
  const copy=id+'_copy',opened=await fetch(api+`/documents/${copy}/project/open`,{method:'POST',headers:{'content-type':'application/vnd.webcad.project'},body:Buffer.from(await saved.arrayBuffer())});assert.equal(opened.status,200,await opened.text());
  await cad(copy,'document.summary');await cad(copy,'feature.update',{radius:4},{featureId});const reopened=await instance(copy,instanceId);assert.equal(reopened.state,'active');
  const remesured=await cad(copy,'geometry.measure',{}, {bodyId:reopened.target.bodyId,selectionType:'face',selectionId:reopened.target.topologyId});assert.ok(near(remesured.area,40*Math.PI));
});

test('STEP Face coordinates and dependent geometry follow an edited upstream transform without reselection',async()=>{
  const id='import_coordinate',f=await importedBox(id),moved=await cad(id,'transform.translate',{dx:5,dy:0,dz:0},{bodyId:f.bodyId}),transform=moved.features.at(-1).id;
  const face=await selectGeometry(cad,id,moved,'face',m=>near(m.centroid[2],20));
  const frame=await cad(id,'coordinate.set',{id:'import_frame',name:'Imported face frame',kind:'face',referenceBodyId:f.bodyId,referenceTopologyId:face}),origin=frame.coordinateSystems.find(item=>item.id==='import_frame').origin;
  const child=await cad(id,'primitive.box',{width:1,depth:2,height:3,coordinateSystemId:'import_frame'}),childId=child.bodyId;
  const changed=await cad(id,'feature.update',{dx:15,dy:25,dz:35},{featureId:transform}),coordinate=changed.coordinateSystems.find(item=>item.id==='import_frame');
  assert.equal(coordinate.referenceState,'resolved');[10,25,35].forEach((delta,axis)=>assert.ok(near(coordinate.origin[axis]-origin[axis],delta)));
  assert.equal((await cad(id,'geometry.check',{}, {bodyId:childId})).valid,true);
  const metadata=changed.bodyMetadata.find(item=>item.bodyId===f.bodyId);assert.equal(metadata.topologyNaming.namedFaceCount,metadata.faceCount);assert.equal(metadata.topologyNaming.namedEdgeCount,metadata.edgeCount);
});

test('imported generated Face and Edge attributes survive two Boolean Cuts, parameter replay and a real Gateway restart',async()=>{
  const id='import_boolean',f=await importedBox(id),edge=await selectGeometry(cad,id,f.view,'edge',m=>near(m.centroid[0],0)&&near(m.centroid[1],0)&&near(m.length,20));
  const fillet=await cad(id,'detail.fillet',{radius:2},{bodyId:f.bodyId,edgeId:edge}),featureId=fillet.features.at(-1).id;
  const cylinder=await cad(id,'primitive.cylinder',{radius:3,height:40,x:15,y:20,z:-10});await cad(id,'boolean.cut',{}, {targetBody:f.bodyId,toolBody:cylinder.bodyId});
  const notch=await cad(id,'primitive.box',{width:15,depth:15,height:40,x:20,y:30,z:-10}),cut=await cad(id,'boolean.cut',{}, {targetBody:f.bodyId,toolBody:notch.bodyId});
  const face=await selectGeometry(cad,id,cut,'face',m=>near(m.area,20*Math.PI)&&m.centroid[0]>0&&m.centroid[0]<2&&m.centroid[1]>0&&m.centroid[1]<2),faceInstance=await bind(id,f.bodyId,face,'ImportedBooleanFace');
  const boundary=await selectGeometry(cad,id,cut,'edge',m=>near(m.centroid[0],0)&&near(m.centroid[2],20)&&near(m.length,38));
  await cad(id,'property.set',{key:'rawImportedEdge',type:'int',value:73},{kind:'edge',bodyId:f.bodyId,topologyId:boundary});
  const type=await cad(id,'property.type.create',{key:'ImportedBooleanEdge',targetScope:'edge',association:'required',fields:[{key:'marker',type:'int'}]}),created=await cad(id,'property.instance.create',{typeId:type.type.typeId,value:{marker:73},target:{kind:'edge',bodyId:f.bodyId,topologyId:boundary}}),edgeInstance=created.instance.instanceId;
  await cad(id,'feature.update',{radius:3},{featureId});
  async function check(){const a=await instance(id,faceInstance),b=await instance(id,edgeInstance);assert.equal(a.state,'active');assert.equal(b.state,'active');assert.deepEqual(a.value,{marker:71});assert.deepEqual(b.value,{marker:73});const fm=await cad(id,'geometry.measure',{}, {bodyId:a.target.bodyId,selectionType:'face',selectionId:a.target.topologyId}),em=await cad(id,'geometry.measure',{}, {bodyId:b.target.bodyId,selectionType:'edge',selectionId:b.target.topologyId});assert.ok(near(fm.area,30*Math.PI));assert.ok(near(em.length,37));}
  await check();await stop();await start();await check();
});

test('changed retained STEP bytes still block replay without changing geometry or active attribute anchors',async()=>{
  const id='import_changed_source',f=await importedBox(id),moved=await cad(id,'transform.translate',{dx:5,dy:0,dz:0},{bodyId:f.bodyId}),featureId=moved.features.at(-1).id,face=await selectGeometry(cad,id,moved,'face',m=>near(m.centroid[2],20)),instanceId=await bind(id,f.bodyId,face),before=await cad(id,'document.summary');
  const source=f.imported.features[0].stringParameters.sourcePath,bytes=fs.readFileSync(source);assert.ok(path.resolve(source).startsWith(data+path.sep));
  try{
    fs.appendFileSync(source,'\n');const response=await fetch(api+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId:id,operation:'feature.update',parameters:{dx:9},inputs:{featureId},baseRevision:before.revision,baseStateToken:before.stateToken})}),failure=await response.json();assert.notEqual(response.status,200);assert.equal(failure.code,'STEP_REPLAY_SOURCE_CHANGED');
    const after=await cad(id,'document.summary');for(const key of ['revision','stateToken','stateSequence','features','bodyMetadata','entityIdentities'])assert.deepEqual(after[key],before[key]);assert.equal((await instance(id,instanceId)).state,'active');
  }finally{fs.writeFileSync(source,bytes);}
});
