import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectGeometry} from './helpers/generated-topology-fixtures.mjs';
import {createLoftRepairFixture,loftRepairFaceIndex as faceIndex} from './helpers/loft-repair-fixtures.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-loft-repair-历史-')),api='http://127.0.0.1:8887/api',states=new Map();let gateway;
async function start(){gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8887',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let error='';const timer=setTimeout(()=>reject(Error('Gateway startup timeout '+error)),20000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>error+=chunk);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){const ended=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await ended;}
before(start);after(async()=>{await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function raw(id,operation,parameters={},inputs={},options={},extra={}){const state=states.get(id);const result=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,options,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{}),...extra})}).then(r=>r.json());if(result.ok&&!options.preview)states.set(id,result);return result;}
async function cad(...args){const result=await raw(...args);assert.equal(result.ok,true,JSON.stringify(result));return result;}
const near=(a,b)=>Math.abs(a-b)<1e-5;
function unchanged(a,b){for(const key of ['stateToken','stateSequence','revision','features','variables','materials','coordinateSystems','entityIdentities'])assert.deepEqual(b[key],a[key],key+' changed during a read/failed proposal');}
function selection(id,response,index){const p=response.inputPreview;return {documentId:id,featureId:p.featureId,sectionId:p.sectionId,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:'face',inputFingerprint:p.inputFingerprint,index};}
async function inspect(id,fixture,proposal,sectionId=fixture.refs[0].sectionId,source={}){return cad(id,'feature.input.preview',{proposal},{featureId:fixture.loftFeature,sectionId,...source});}
const fixture=(id,...args)=>createLoftRepairFixture(cad,id,...args);
async function submit(id,p,edits,preview=false){return cad(id,p.operation,{...p.parameters,selectionEdits:edits},p.inputs||{},{preview});}

test('a split Loft section reports its exact repair slot and uses the proposed historical output atomically',async()=>{
  const id='loft_repair_split',f=await fixture(id),start=await selectGeometry(cad,id,f.loft,'face',m=>near(m.centroid[2],10)),end=await selectGeometry(cad,id,f.loft,'face',m=>near(m.centroid[2],30)),type=await cad(id,'property.type.create',{key:'LoftRepairBoundary',targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]});
  const properties=[];for(const [face,marker] of [[start,7],[end,9]])properties.push((await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Boundary '+marker,value:{marker},target:{kind:'face',bodyId:f.loft.bodyId,topologyId:face}})).instance.instanceId);
  const before=await cad(id,'document.view'),failed=await raw(id,f.proposal.operation,f.proposal.parameters,f.proposal.inputs);
  assert.equal(failed.code,'LOFT_SECTION_UNRESOLVED');assert.equal(failed.details?.featureId,f.loftFeature);assert.equal(failed.details?.sectionId,f.refs[0].sectionId);assert.equal(failed.details.selectionKind,'face');
  const response=await inspect(id,f,f.proposal);assert.equal(response.proposalOperation,'feature.update');assert.equal(response.inputPreview.sectionId,f.refs[0].sectionId);assert.equal(response.inputPreview.selectionState,'unresolved');
  const edit=selection(id,response,faceIndex(response.inputPreview.presentation,10,8));unchanged(before,await cad(id,'document.view'));await submit(id,f.proposal,[edit],true);unchanged(before,await cad(id,'document.view'));
  const result=await submit(id,f.proposal,[edit]);assert.equal(result.revision,before.revision+1);assert.equal(result.features.find(feature=>feature.id===f.loftFeature).inputFeatures[0],f.cut.features.at(-1).id);assert.equal((await cad(id,'geometry.check',{}, {bodyId:f.loft.bodyId})).valid,true);
  const changed=(await cad(id,'property.instance.list')).instances;assert.notEqual(changed.find(item=>item.instanceId===properties[0]).state,'active','A new split endpoint must not borrow the old whole-cap attribute');assert.deepEqual(changed.find(item=>item.instanceId===properties[0]).value,{marker:7});assert.equal(changed.find(item=>item.instanceId===properties[1]).state,'active','The unrelated unchanged endpoint must retain its attribute');
  await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);for(const item of (await cad(id,'property.instance.list')).instances)assert.equal(item.state,'active');await cad(id,'document.redo');assert.deepEqual((await cad(id,'document.view')).features,result.features);assert.equal((await cad(id,'property.instance.list')).instances.find(item=>item.instanceId===properties[1]).state,'active');
});

test('Loft section repairs reject forged source proofs, duplicate slots and non-rendered Face indexes without partial changes',async()=>{
  const id='loft_repair_proof',f=await fixture(id),response=await inspect(id,f,f.proposal),edit=selection(id,response,faceIndex(response.inputPreview.presentation,10,8)),before=await cad(id,'document.view');
  for(const tamper of [{documentId:'foreign'},{sourceBodyIdentity:'0'.repeat(32)},{inputFingerprint:'0'.repeat(64)},{kind:'edge'},{index:response.inputPreview.presentation.stats.faceCount+1},{sectionId:'section-missing'}]){
    const failed=await raw(id,f.proposal.operation,{...f.proposal.parameters,selectionEdits:[{...edit,...tamper}]},f.proposal.inputs);assert.equal(failed.ok,false,JSON.stringify(tamper));unchanged(before,await cad(id,'document.view'));
  }
  assert.equal((await raw(id,f.proposal.operation,{...f.proposal.parameters,selectionEdits:[edit,edit]},f.proposal.inputs)).code,'INVALID_SELECTION_REPAIR');
  const wrongProposal=await raw(id,f.proposal.operation,{x:7,selectionEdits:[edit]},f.proposal.inputs);assert.equal(wrongProposal.code,'STALE_SELECTION_REPAIR');unchanged(before,await cad(id,'document.view'));
  assert.equal((await raw(id,'feature.input.preview',{proposal:f.proposal},{featureId:f.loftFeature,sectionId:'section-missing'})).ok,false);
});

test('two sections of one Loft can be repaired sequentially without committing the first choice',async()=>{
  const id='loft_repair_two',f=await fixture(id,'feature',true),before=await cad(id,'document.view'),first=await inspect(id,f,f.proposal),a=selection(id,first,faceIndex(first.inputPreview.presentation,0,8));
  const next=await raw(id,f.proposal.operation,{...f.proposal.parameters,selectionEdits:[a]},f.proposal.inputs);assert.equal(next.code,'LOFT_SECTION_UNRESOLVED');assert.equal(next.details.sectionId,f.refs[1].sectionId);unchanged(before,await cad(id,'document.view'));
  const pending={...f.proposal,parameters:{...f.proposal.parameters,selectionEdits:[a]}},second=await inspect(id,f,pending,f.refs[1].sectionId),b=selection(id,second,faceIndex(second.inputPreview.presentation,10,8));
  await submit(id,f.proposal,[a,b],true);unchanged(before,await cad(id,'document.view'));const result=await submit(id,f.proposal,[a,b]);assert.equal(result.revision,before.revision+1);assert.ok(near((await cad(id,'geometry.measure',{}, {bodyId:f.loft.bodyId})).volume,1600));
  await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);
});

for(const mode of ['variable','coordinate'])test(`${mode} changes stage a real Loft section repair and commit with one Undo`,async()=>{
  const id='loft_repair_'+mode,f=await fixture(id,mode),before=await cad(id,'document.view');assert.equal((await raw(id,f.proposal.operation,f.proposal.parameters,f.proposal.inputs)).code,'LOFT_SECTION_UNRESOLVED');
  const response=await inspect(id,f,f.proposal),edit=selection(id,response,faceIndex(response.inputPreview.presentation,10,8));unchanged(before,await cad(id,'document.view'));await submit(id,f.proposal,[edit],true);unchanged(before,await cad(id,'document.view'));
  await submit(id,f.proposal,[edit]);await cad(id,'document.undo');const restored=await cad(id,'document.view');for(const key of ['features','variables','coordinateSystems','materials'])assert.deepEqual(restored[key],before[key]);
});

for(const action of ['suppress','delete'])test(`${action} of a section source allows explicit rebind to a surviving historical output`,async()=>{
  const id='loft_repair_'+action,f=await fixture(id),proposal={operation:'feature.'+action,inputs:{featureId:f.cut.features.at(-1).id},parameters:{}},before=await cad(id,'document.view');
  assert.equal((await raw(id,proposal.operation,{},proposal.inputs)).code,'LOFT_SECTION_UNRESOLVED');
  const response=await inspect(id,f,proposal,f.refs[0].sectionId,{sourceFeatureId:f.box.features.at(-1).id,sourceBodyId:f.box.bodyId});assert.equal(response.inputPreview.selectionState,'unverified');
  const edit=selection(id,response,faceIndex(response.inputPreview.presentation,10));await submit(id,proposal,[edit],true);unchanged(before,await cad(id,'document.view'));const result=await submit(id,proposal,[edit]);
  assert.equal(JSON.parse(result.features.find(feature=>feature.id===f.loftFeature).stringParameters.loftSections)[0].featureId,f.box.features.at(-1).id);await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);
});

test('alternative section sources are inspected at their historical output, not their later transformed live Body',async()=>{
  const id='loft_repair_history',f=await fixture(id),alternate=await cad(id,'surface.rectangle',{width:8,height:20,x:4,y:10,z:10});await cad(id,'transform.translate',{dx:100,dy:0,dz:100},{bodyId:alternate.bodyId});
  const response=await inspect(id,f,f.proposal,f.refs[0].sectionId,{sourceFeatureId:alternate.features.at(-1).id,sourceBodyId:alternate.bodyId});assert.equal(response.inputPreview.selectionState,'unverified');const index=faceIndex(response.inputPreview.presentation,10,8);
  await submit(id,f.proposal,[selection(id,response,index)]);const view=await cad(id,'body.presentation',{}, {bodyId:f.loft.bodyId}),cap=await selectGeometry(cad,id,view,'face',m=>near(m.centroid[2],10));assert.ok(near((await cad(id,'geometry.measure',{}, {bodyId:f.loft.bodyId,selectionType:'face',selectionId:cap})).area,160));
});

test('section source cycles and coordinate previews disguised as sections are rejected',async()=>{
  const id='loft_repair_cycle',f=await fixture(id),before=await cad(id,'document.view');const cycle=await raw(id,'feature.input.preview',{proposal:f.proposal},{featureId:f.loftFeature,sectionId:f.refs[0].sectionId,sourceFeatureId:f.loftFeature,sourceBodyId:f.loft.bodyId});assert.equal(cycle.code,'LOFT_DEPENDENCY_CYCLE');
  assert.equal((await raw(id,'feature.input.preview',{proposal:f.proposal},{coordinateSystemId:'global',sectionId:f.refs[0].sectionId})).ok,false);unchanged(before,await cad(id,'document.view'));
});

test('a one-source real Loft supports suppress, restore and delete without losing its input Body',async()=>{
  const id='loft_repair_lifecycle',f=await fixture(id,'feature',true),before=await cad(id,'document.view');await cad(id,'feature.suppress',{}, {featureId:f.loftFeature});assert.equal((await cad(id,'document.summary')).bodyMetadata.some(body=>body.bodyId===f.loft.bodyId),false);
  await cad(id,'feature.restore',{}, {featureId:f.loftFeature});assert.ok(near((await cad(id,'geometry.measure',{}, {bodyId:f.loft.bodyId})).volume,4000));await cad(id,'feature.delete',{}, {featureId:f.loftFeature});assert.equal((await cad(id,'document.summary')).bodyMetadata.some(body=>body.bodyId===f.cut.bodyId),true);
  await cad(id,'document.undo');assert.equal((await cad(id,'document.view')).features.length,before.features.length);
});

test('independent Lofts with a removed shared source can each inspect their surviving source without being blocked by the other repair',async()=>{
  const id='loft_repair_independent',f=await fixture(id),second=await cad(id,'detail.loft',{}, {sections:[{bodyId:f.cut.bodyId,faceId:f.cut.triangleFaceIds.find(face=>Number(face.split('-').at(-1))===faceIndex(f.cut,10))},{bodyId:f.last.bodyId,faceId:f.last.triangleFaceIds[0]}]}),secondFeature=second.features.at(-1),secondRef=JSON.parse(secondFeature.stringParameters.loftSections)[0],proposal={operation:'feature.delete',inputs:{featureId:f.cut.features.at(-1).id},parameters:{}},source={sourceFeatureId:f.box.features.at(-1).id,sourceBodyId:f.box.bodyId},before=await cad(id,'document.view');
  const first=await inspect(id,f,proposal,f.refs[0].sectionId,source),a=selection(id,first,faceIndex(first.inputPreview.presentation,10)),pending={...proposal,parameters:{selectionEdits:[a]}};
  const next=await inspect(id,{...f,loftFeature:secondFeature.id},pending,secondRef.sectionId,source),b=selection(id,next,faceIndex(next.inputPreview.presentation,10));unchanged(before,await cad(id,'document.view'));await submit(id,proposal,[a,b]);await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);
});

test('Loft and associative coordinate repairs share the original proposal and one transaction',async()=>{
  const id='loft_repair_mixed',f=await fixture(id),top=await selectGeometry(cad,id,f.cut,'face',m=>near(m.centroid[2],10));await cad(id,'coordinate.set',{id:'attached',name:'Attached',kind:'face',referenceBodyId:f.cut.bodyId,referenceTopologyId:top});await cad(id,'primitive.box',{width:1,depth:1,height:1,coordinateSystemId:'attached'});
  const before=await cad(id,'document.view'),input=await inspect(id,f,f.proposal),a=selection(id,input,faceIndex(input.inputPreview.presentation,10,8)),pending={...f.proposal,parameters:{...f.proposal.parameters,selectionEdits:[a]}};
  const failed=await raw(id,pending.operation,pending.parameters,pending.inputs);assert.equal(failed.code,'COORDINATE_REFERENCE_UNRESOLVED');
  const output=await cad(id,'feature.input.preview',{proposal:pending},{coordinateSystemId:'attached'}),p=output.inputPreview,b={coordinateSystemId:'attached',documentId:id,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:'face',inputFingerprint:p.inputFingerprint,index:faceIndex(p.presentation,10,8)};
  const parameters={...pending.parameters,coordinateSelectionEdits:[b]};await cad(id,pending.operation,parameters,pending.inputs,{preview:true});unchanged(before,await cad(id,'document.view'));const result=await cad(id,pending.operation,parameters,pending.inputs);assert.equal(result.coordinateSystems.find(frame=>frame.id==='attached').referenceState,'resolved');await cad(id,'document.undo');const restored=await cad(id,'document.view');assert.deepEqual(restored.features,before.features);assert.deepEqual(restored.coordinateSystems,before.coordinateSystems);
});

test('a source restore may explicitly return a repaired section to the restored historical feature',async()=>{
  const id='loft_repair_restore',f=await fixture(id),cutId=f.cut.features.at(-1).id,suppress={operation:'feature.suppress',inputs:{featureId:cutId},parameters:{}},input=await inspect(id,f,suppress,f.refs[0].sectionId,{sourceFeatureId:f.box.features.at(-1).id,sourceBodyId:f.box.bodyId});await submit(id,suppress,[selection(id,input,faceIndex(input.inputPreview.presentation,10))]);
  const before=await cad(id,'document.view'),restore={operation:'feature.restore',inputs:{featureId:cutId},parameters:{}},output=await inspect(id,f,restore,f.refs[0].sectionId,{sourceFeatureId:cutId,sourceBodyId:f.cut.bodyId});assert.equal(output.inputPreview.selectionState,'unverified');await submit(id,restore,[selection(id,output,faceIndex(output.inputPreview.presentation,10))]);await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);
});

test('a repaired definition survives portable project opening and service restart',async()=>{
  const id='loft_repair_portable',f=await fixture(id),input=await inspect(id,f,f.proposal);await submit(id,f.proposal,[selection(id,input,faceIndex(input.inputPreview.presentation,10,8))]);const before=await cad(id,'document.view'),saved=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(saved.status,200);const copy=id+'_copy',opened=await fetch(api+`/documents/${copy}/project/open`,{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:Buffer.from(await saved.arrayBuffer())});assert.equal(opened.status,200,await opened.text());await stop();await start();await cad(copy,'document.summary');await cad(copy,'feature.update',{width:7},{featureId:f.last.features.at(-1).id});assert.equal((await cad(copy,'geometry.check',{}, {bodyId:f.loft.bodyId})).valid,true);assert.equal(JSON.parse((await cad(copy,'document.view')).features.find(feature=>feature.id===f.loftFeature).stringParameters.loftSections)[0].selector,JSON.parse(before.features.find(feature=>feature.id===f.loftFeature).stringParameters.loftSections)[0].selector);
});

test('same-revision project edits invalidate an old repair token and indirect source cycles remain rejected',async()=>{
  const id='loft_repair_stale',f=await fixture(id),input=await inspect(id,f,f.proposal),edit=selection(id,input,faceIndex(input.inputPreview.presentation,10,8)),old=states.get(id);await cad(id,'property.type.create',{key:'Unrelated',targetScope:'project',association:'none',fields:[]});const current=await cad(id,'document.view');assert.equal(current.revision,old.revision);
  assert.equal((await raw(id,f.proposal.operation,{...f.proposal.parameters,selectionEdits:[edit]},f.proposal.inputs,{},{baseStateToken:old.stateToken})).ok,false);unchanged(current,await cad(id,'document.view'));
  const moved=await cad(id,'transform.translate',{dx:0,dy:0,dz:5},{bodyId:f.loft.bodyId}),before=await cad(id,'document.view'),cycle=await raw(id,'feature.input.preview',{proposal:f.proposal},{featureId:f.loftFeature,sectionId:f.refs[0].sectionId,sourceFeatureId:moved.features.at(-1).id,sourceBodyId:f.loft.bodyId});assert.equal(cycle.code,'COORDINATE_DEPENDENCY_CYCLE');unchanged(before,await cad(id,'document.view'));
});
