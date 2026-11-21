import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectGeometry} from './helpers/generated-topology-fixtures.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-real-loft-截面-')),api='http://127.0.0.1:8885/api',states=new Map();let gateway;
async function start(){gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8885',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Gateway startup timeout')),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){const ended=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await ended;}
before(start);after(async()=>{await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function raw(id,operation,parameters={},inputs={},options={},extra={}){const state=states.get(id);return fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,options,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{}),...extra})}).then(r=>r.json());}
async function cad(...args){const p=await raw(...args);assert.equal(p.ok,true,JSON.stringify(p));if(!args[4]?.preview)states.set(args[0],p);return p;}
const near=(a,b)=>Math.abs(a-b)<1e-4;
const section=view=>({bodyId:view.bodyId,faceId:view.triangleFaceIds[0]});
async function circles(id){const first=await cad(id,'surface.disk',{radius:5,z:7}),last=await cad(id,'surface.disk',{radius:10,z:27});return {first,last,sections:[section(first),section(last)]};}
async function volume(id,bodyId){return (await cad(id,'geometry.measure',{}, {bodyId})).volume;}
async function attach(id,bodyId,faceId){const type=await cad(id,'property.type.create',{key:'LoftBoundary',targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]});return (await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Loft boundary',value:{marker:7},target:{kind:'face',bodyId,topologyId:faceId}})).instance.instanceId;}
async function record(id,instanceId){return (await cad(id,'property.instance.list')).instances.find(i=>i.instanceId===instanceId);}

test('real circular Loft preserves true cap outlines and exact frustum volume, then regenerates attributes after a radius edit',async()=>{
  const id='real_loft_circle',f=await circles(id),result=await cad(id,'detail.loft',{}, {sections:f.sections});assert.equal(result.features.at(-1).stringParameters.loftVersion,'2');assert.ok(near(await volume(id,result.bodyId),Math.PI*20/3*175));
  const query=await(await fetch(api+'/agent/model/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,kind:'geometry-tree'})})).json(),summary=query.query.features.find(feature=>feature.id===result.features.at(-1).id);assert.equal(summary.stringParameters.loftSections,undefined);assert.equal(summary.stringParameters.loftNextSection,undefined);assert.equal(summary.inputSelections[0].sections.length,2);assert.equal(summary.inputSelections[0].sections[0].selector,undefined,'Opaque native selectors must not inflate Agent context');
  const end=await selectGeometry(cad,id,result,'face',m=>near(m.centroid[2],27));assert.ok(near((await cad(id,'geometry.measure',{}, {bodyId:result.bodyId,selectionType:'face',selectionId:end})).area,Math.PI*100));
  const instanceId=await attach(id,result.bodyId,end),before=await cad(id,'document.view');await cad(id,'feature.update',{radius:7},{featureId:f.first.features[0].id});assert.ok(near(await volume(id,result.bodyId),Math.PI*20/3*219));assert.equal((await record(id,instanceId)).state,'active');
  await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);assert.equal((await record(id,instanceId)).target.topologyId,end);await cad(id,'document.redo');assert.equal((await record(id,instanceId)).state,'active');
});
test('actual-position rectangular Loft uses nonzero real coordinates instead of packing at global Z=0',async()=>{
  const id='real_loft_rectangle',a=await cad(id,'surface.rectangle',{width:10,height:8,x:10,y:20,z:7}),b=await cad(id,'surface.rectangle',{width:20,height:16,x:10,y:20,z:37});const result=await cad(id,'detail.loft',{}, {sections:[section(a),section(b)]});assert.ok(near(await volume(id,result.bodyId),5600));
  const cap=await selectGeometry(cad,id,result,'face',m=>near(m.centroid[2],37));const m=await cad(id,'geometry.measure',{}, {bodyId:result.bodyId,selectionType:'face',selectionId:cap});m.centroid.forEach((value,index)=>assert.ok(Math.abs(value-[10,20,37][index])<1e-10));assert.ok(near(m.area,320));
});
test('explicit Z-spacing moves real profiles without replacing their shape and follows a length expression',async()=>{
  const id='real_loft_spacing';await cad(id,'variable.set',{name:'gap',type:'length',expression:'30 mm'});const f=await circles(id),result=await cad(id,'detail.loft',{placement:'z-spacing',sectionSpacing:'gap'}, {sections:f.sections});assert.equal(result.features.at(-1).stringParameters['expr.sectionSpacing'],'gap');assert.ok(near(await volume(id,result.bodyId),Math.PI*30/3*175));
  await cad(id,'variable.set',{name:'gap',type:'length',expression:'40 mm'});assert.ok(near(await volume(id,result.bodyId),Math.PI*40/3*175));
});
test('Loft preview and invalid definitions leave geometry, feature identities and project state untouched',async()=>{
  const id='real_loft_preview',f=await circles(id),before=await cad(id,'document.view');const preview=await cad(id,'detail.loft',{}, {sections:f.sections},{preview:true});assert.equal(preview.preview.state,'preview');assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);assert.deepEqual((await cad(id,'document.view')).features,before.features);
  for(const [parameters,inputs] of [[{}, {sectionBodies:f.first.bodyId+','+f.last.bodyId}],[{placement:'z-spacing',sectionSpacing:0},{sections:f.sections}],[{sectionSpacing:10},{sections:f.sections}]]){assert.equal((await raw(id,'detail.loft',parameters,inputs)).ok,false);assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);assert.deepEqual((await cad(id,'document.view')).features,before.features);}
});
test('profile selection requires its observed state even if display Face IDs still exist',async()=>{
  const id='real_loft_stale',f=await circles(id),old=states.get(id).stateToken;await cad(id,'variable.set',{name:'unrelated',type:'dimensionless',expression:'1'});
  assert.equal((await raw(id,'detail.loft',{}, {sections:f.sections},{},{baseStateToken:undefined})).code,'SELECTION_STATE_REQUIRED');assert.equal((await raw(id,'detail.loft',{}, {sections:f.sections},{},{baseStateToken:old})).ok,false);
});
test('Loft section replacement/reordering is explicit, previewable, atomic and undoable',async()=>{
  const id='real_loft_edit',f=await circles(id),result=await cad(id,'detail.loft',{}, {sections:f.sections}),feature=result.features.at(-1),references=JSON.parse(feature.stringParameters.loftSections),before=await cad(id,'document.view');
  const definition={sections:references.toReversed().map(ref=>({sectionId:ref.sectionId})),placement:'actual',ruled:false};await cad(id,'feature.update',{loftDefinition:definition},{featureId:feature.id},{preview:true});assert.deepEqual((await cad(id,'document.view')).features,before.features);
  const changed=await cad(id,'feature.update',{loftDefinition:definition},{featureId:feature.id});assert.equal(changed.bodyCount,before.bodyCount);assert.equal(JSON.parse(changed.features.at(-1).stringParameters.loftSections)[0].sectionId,references[1].sectionId);assert.ok(near(await volume(id,result.bodyId),Math.PI*20/3*175));
  await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);
});
test('Face sections with holes are rejected without discarding inner loops',async()=>{
  const id='real_loft_holes',body=await cad(id,'primitive.box',{width:20,depth:20,height:2}),tool=await cad(id,'primitive.cylinder',{radius:3,height:10,x:10,y:10,z:-2}),cut=await cad(id,'boolean.cut',{}, {targetBody:body.bodyId,toolBody:tool.bodyId}),cap=await selectGeometry(cad,id,cut,'face',m=>near(m.centroid[2],2)),last=await cad(id,'surface.rectangle',{width:20,height:20,x:10,y:10,z:30}),before=await cad(id,'document.view');
  const failed=await raw(id,'detail.loft',{}, {sections:[{bodyId:cut.bodyId,faceId:cap},section(last)]});assert.equal(failed.code,'LOFT_PROFILE_HOLES_UNSUPPORTED');assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);assert.deepEqual((await cad(id,'document.view')).features,before.features);
});
test('portable Loft definitions and properties survive gateway restart and later upstream edits',async()=>{
  const id='real_loft_portable',f=await circles(id),result=await cad(id,'detail.loft',{}, {sections:f.sections}),end=await selectGeometry(cad,id,result,'face',m=>near(m.centroid[2],27)),instanceId=await attach(id,result.bodyId,end);
  const saved=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(saved.status,200);const copy=id+'_copy',opened=await fetch(api+`/documents/${copy}/project/open`,{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:Buffer.from(await saved.arrayBuffer())});assert.equal(opened.status,200,await opened.text());await stop();await start();await cad(copy,'document.summary');await cad(copy,'feature.update',{radius:7},{featureId:f.first.features[0].id});assert.ok(near(await volume(copy,result.bodyId),Math.PI*20/3*219));assert.equal((await record(copy,instanceId)).state,'active');
});
test('nonparallel sections retain their actual planes and circular end caps',async()=>{
  const id='real_loft_tilted',first=await cad(id,'surface.disk',{radius:5});await cad(id,'coordinate.set',{id:'tilted',name:'Tilted section',kind:'cartesian',origin:[0,0,20],xAxis:[1,0,0],yAxis:[0,Math.cos(Math.PI/6),Math.sin(Math.PI/6)]});
  const last=await cad(id,'surface.disk',{radius:10,coordinateSystemId:'tilted'}),result=await cad(id,'detail.loft',{}, {sections:[section(first),section(last)]});assert.equal((await cad(id,'geometry.check',{}, {bodyId:result.bodyId})).valid,true);
  const cap=await selectGeometry(cad,id,result,'face',m=>near(m.area,Math.PI*100)),measured=await cad(id,'geometry.measure',{}, {bodyId:result.bodyId,selectionType:'face',selectionId:cap});[0,0,20].forEach((v,i)=>assert.ok(near(measured.centroid[i],v)));assert.ok(near(measured.area,Math.PI*100));
});
test('a legacy Loft only upgrades after explicit real-section definition, with atomic preview and Undo',async()=>{
  const worker=process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe'),fixture=path.join(data,'legacy-loft.xbf'),env={...process.env,PATH:[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',process.env.PATH].join(path.delimiter)};
  const generated=spawnSync(path.join(path.dirname(worker),'loft_tests.exe'),['--fixture-output','./legacy-loft.xbf'],{cwd:data,env,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(generated.status,0,generated.stderr||generated.error?.message);
  const id='real_loft_upgrade',opened=await fetch(api+`/documents/${id}/project/open`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:fs.readFileSync(fixture)});assert.equal(opened.status,200,await opened.text());const original=await cad(id,'document.view');assert.equal(original.features.at(-1).stringParameters.loftVersion,undefined);
  const f=await circles(id),before=await cad(id,'document.view'),definition={sections:f.sections,placement:'actual',ruled:false};await cad(id,'feature.update',{loftDefinition:definition},{featureId:'feature-3'},{preview:true});assert.deepEqual((await cad(id,'document.view')).features,before.features);
  const upgraded=await cad(id,'feature.update',{loftDefinition:definition},{featureId:'feature-3'});assert.equal(upgraded.features.find(f=>f.id==='feature-3').stringParameters.loftVersion,'2');assert.ok(near(await volume(id,'body-3'),Math.PI*20/3*175));
  await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);assert.ok(near(await volume(id,'body-3'),1600));
});
test('changing smooth Loft to ruled segments cannot silently shrink a side-face attribute onto the first interval',async()=>{
  const id='real_loft_ruled',a=await cad(id,'surface.disk',{radius:5}),b=await cad(id,'surface.disk',{radius:7,z:10}),c=await cad(id,'surface.disk',{radius:10,z:20}),result=await cad(id,'detail.loft',{}, {sections:[section(a),section(b),section(c)]});
  const side=await selectGeometry(cad,id,result,'face',m=>m.centroid[2]>1&&m.centroid[2]<19),property=await attach(id,result.bodyId,side),references=JSON.parse(result.features.at(-1).stringParameters.loftSections);
  await cad(id,'feature.update',{loftDefinition:{sections:references.map(ref=>({sectionId:ref.sectionId})),placement:'actual',ruled:true}},{featureId:result.features.at(-1).id});const old=await record(id,property);assert.notEqual(old.state,'active');assert.deepEqual(old.value,{marker:7});await cad(id,'document.undo');assert.equal((await record(id,property)).state,'active');
});
test('a self-referential Loft definition is rejected with no partial feature-identity changes',async()=>{
  const id='real_loft_cycle',f=await circles(id),result=await cad(id,'detail.loft',{}, {sections:f.sections}),before=await cad(id,'document.view'),cap=await selectGeometry(cad,id,result,'face',m=>near(m.centroid[2],27));
  const failed=await raw(id,'feature.update',{loftDefinition:{sections:[{bodyId:result.bodyId,faceId:cap},f.sections[0]],placement:'actual'}},{featureId:result.features.at(-1).id});assert.equal(failed.code,'LOFT_DEPENDENCY_CYCLE');assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);assert.deepEqual((await cad(id,'document.view')).features,before.features);
});

test('Loft replays its captured historical source before a later transform instead of the final live Body',async()=>{
  const id='real_loft_historical_transform',f=await circles(id),result=await cad(id,'detail.loft',{}, {sections:f.sections});
  await cad(id,'transform.translate',{dx:100,dy:0,dz:100},{bodyId:f.first.bodyId});
  await cad(id,'feature.update',{radius:7},{featureId:f.first.features[0].id});
  assert.ok(near(await volume(id,result.bodyId),Math.PI*20/3*219));
  const loft=await cad(id,'body.presentation',{}, {bodyId:result.bodyId}),cap=await selectGeometry(cad,id,loft,'face',m=>near(m.area,Math.PI*49));
  const measured=await cad(id,'geometry.measure',{}, {bodyId:result.bodyId,selectionType:'face',selectionId:cap});[0,0,7].forEach((v,i)=>assert.ok(near(measured.centroid[i],v)));
  const liveView=await cad(id,'body.presentation',{}, {bodyId:f.first.bodyId}),live=await cad(id,'geometry.measure',{}, {bodyId:f.first.bodyId,selectionType:'face',selectionId:liveView.triangleFaceIds[0]});[100,0,107].forEach((v,i)=>assert.ok(near(live.centroid[i],v)));
});

test('a real Solid Face remains the historical Loft section after its Body is consumed by Boolean',async()=>{
  const id='real_loft_historical_boolean',first=await cad(id,'primitive.cylinder',{radius:5,height:2,z:5}),top=await selectGeometry(cad,id,first,'face',m=>near(m.centroid[2],7)),last=await cad(id,'surface.disk',{radius:10,z:27});
  const result=await cad(id,'detail.loft',{}, {sections:[{bodyId:first.bodyId,faceId:top},section(last)]}),cap=await selectGeometry(cad,id,result,'face',m=>near(m.centroid[2],7)),property=await attach(id,result.bodyId,cap);
  const target=await cad(id,'primitive.box',{width:30,depth:30,height:10,x:-15,y:-15});await cad(id,'boolean.cut',{}, {targetBody:target.bodyId,toolBody:first.bodyId});
  assert.equal((await cad(id,'document.summary')).bodyMetadata.some(body=>body.bodyId===first.bodyId),false);
  await cad(id,'feature.update',{radius:7},{featureId:first.features[0].id});assert.ok(near(await volume(id,result.bodyId),Math.PI*20/3*219));
  const attached=await record(id,property);assert.equal(attached.state,'active');const measured=await cad(id,'geometry.measure',{}, {bodyId:result.bodyId,selectionType:'face',selectionId:attached.target.topologyId});assert.ok(near(measured.area,Math.PI*49));assert.ok(near(measured.centroid[2],7));
});

test('coordinate-driven real sections update the actual Loft and its bound cap atomically',async()=>{
  const id='real_loft_coordinate';await cad(id,'coordinate.set',{id:'section_plane',name:'Section plane',kind:'cartesian',origin:[0,0,27],xAxis:[1,0,0],yAxis:[0,1,0]});
  const first=await cad(id,'surface.disk',{radius:5,z:7}),last=await cad(id,'surface.disk',{radius:10,coordinateSystemId:'section_plane'}),result=await cad(id,'detail.loft',{}, {sections:[section(first),section(last)]}),end=await selectGeometry(cad,id,result,'face',m=>near(m.centroid[2],27)),property=await attach(id,result.bodyId,end),before=await cad(id,'document.view');
  await cad(id,'coordinate.set',{id:'section_plane',name:'Section plane',kind:'cartesian',origin:[0,0,47],xAxis:[1,0,0],yAxis:[0,1,0]});assert.ok(near(await volume(id,result.bodyId),Math.PI*40/3*175));
  const attached=await record(id,property);assert.equal(attached.state,'active');assert.ok(near((await cad(id,'geometry.measure',{}, {bodyId:result.bodyId,selectionType:'face',selectionId:attached.target.topologyId})).centroid[2],47));
  await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).coordinateSystems,before.coordinateSystems);assert.equal((await record(id,property)).target.topologyId,end);assert.ok(near(await volume(id,result.bodyId),Math.PI*20/3*175));
});

test('two different Face sections may belong to the same Solid and source feature',async()=>{
  const id='real_loft_one_source',source=await cad(id,'primitive.cylinder',{radius:5,height:12,z:7}),bottom=await selectGeometry(cad,id,source,'face',m=>near(m.centroid[2],7)),top=await selectGeometry(cad,id,source,'face',m=>near(m.centroid[2],19));
  const result=await cad(id,'detail.loft',{}, {sections:[{bodyId:source.bodyId,faceId:bottom},{bodyId:source.bodyId,faceId:top}]});assert.equal(result.features.at(-1).inputFeatures.length,1);assert.ok(near(await volume(id,result.bodyId),Math.PI*25*12));
  await cad(id,'feature.update',{radius:7,height:16},{featureId:source.features[0].id});assert.ok(near(await volume(id,result.bodyId),Math.PI*49*16));assert.equal((await cad(id,'geometry.check',{}, {bodyId:result.bodyId})).valid,true);
});

test('inserting an intermediate section preserves properties on the unchanged start and end caps',async()=>{
  const id='real_loft_insert_section',f=await circles(id),result=await cad(id,'detail.loft',{}, {sections:f.sections}),start=await selectGeometry(cad,id,result,'face',m=>near(m.centroid[2],7)),end=await selectGeometry(cad,id,result,'face',m=>near(m.centroid[2],27));
  const startProperty=await attach(id,result.bodyId,start),endType=await cad(id,'property.type.create',{key:'LoftEndBoundary',targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]}),endProperty=(await cad(id,'property.instance.create',{typeId:endType.type.typeId,name:'End boundary',value:{marker:9},target:{kind:'face',bodyId:result.bodyId,topologyId:end}})).instance.instanceId;
  const middle=await cad(id,'surface.disk',{radius:7,z:17}),refs=JSON.parse(result.features.at(-1).stringParameters.loftSections);
  await cad(id,'feature.update',{loftDefinition:{sections:[{sectionId:refs[0].sectionId},section(middle),{sectionId:refs[1].sectionId}],placement:'actual',ruled:false}},{featureId:result.features.at(-1).id});
  for(const [instanceId,z,area] of [[startProperty,7,Math.PI*25],[endProperty,27,Math.PI*100]]){
    const bound=await record(id,instanceId);assert.equal(bound.state,'active','An unchanged endpoint must not depend on the whole section-list hash');
    const measured=await cad(id,'geometry.measure',{}, {bodyId:result.bodyId,selectionType:'face',selectionId:bound.target.topologyId});assert.ok(near(measured.centroid[2],z));assert.ok(near(measured.area,area));
  }
  const replacement=await cad(id,'surface.disk',{radius:10,z:27}),current=(await cad(id,'document.summary')).features.find(feature=>feature.id===result.features.at(-1).id),currentRefs=JSON.parse(current.stringParameters.loftSections);
  await cad(id,'feature.update',{loftDefinition:{sections:[{sectionId:currentRefs[0].sectionId},{sectionId:currentRefs[1].sectionId},section(replacement)],placement:'actual',ruled:false}},{featureId:current.id});
  assert.equal((await record(id,startProperty)).state,'active');assert.notEqual((await record(id,endProperty)).state,'active','A different endpoint at identical coordinates must not inherit the removed endpoint identity');assert.deepEqual((await record(id,endProperty)).value,{marker:9});
  await cad(id,'document.undo');assert.equal((await record(id,startProperty)).state,'active');assert.equal((await record(id,endProperty)).state,'active');
});
