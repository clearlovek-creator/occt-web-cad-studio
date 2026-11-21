import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-coordinate-关联-'));
const api='http://127.0.0.1:8878/api';
let gateway;
async function startGateway(){
  gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8878',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    let stderr='';const timer=setTimeout(()=>reject(new Error('startup timeout '+stderr)),20000);
    gateway.once('error',reject);gateway.stderr.on('data',chunk=>stderr+=chunk);
    gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});
  });
}
before(startGateway);
after(async()=>{
  if(gateway){const ended=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await ended;}
  assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});
});
const states=new Map();
async function raw(id,operation,parameters={},inputs={},options){
  const state=states.get(id);
  const response=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{}),...(options?{options}:{})})});
  const result=await response.json();if(result.ok && !options?.preview)states.set(id,result);return result;
}
async function cad(...args){const result=await raw(...args);assert.equal(result.ok,true,JSON.stringify(result));return result;}
const coordinate=(view,id='attached')=>view.coordinateSystems.find(item=>item.id===id);
const near=(a,b)=>{assert.equal(a.length,b.length);a.forEach((value,i)=>assert.ok(Math.abs(value-b[i])<1e-6,`${a} != ${b}`));};
function faceAtZ(view,z){
  for(let triangle=0;triangle<view.triangleFaceIds.length;triangle++){
    const vertices=view.indices.slice(triangle*3,triangle*3+3);
    if(vertices.every(vertex=>Math.abs(view.positions[vertex*3+2]-z)<1e-7))return view.triangleFaceIds[triangle];
  }
  throw new Error('No face at Z='+z);
}
async function attach(id,view,name='attached',extra={}){
  return cad(id,'coordinate.set',{id:name,name,kind:'face',referenceBodyId:view.bodyId,referenceTopologyId:faceAtZ(view,view.positions.filter((_,i)=>i%3===2).reduce((a,b)=>Math.max(a,b),-Infinity)),...extra});
}
async function centroid(id,bodyId){return (await cad(id,'geometry.measure',{}, {bodyId})).bodyMetadata.find(body=>body.bodyId===bodyId).centroid;}
const box={width:20,depth:30,height:10};
const child={width:2,depth:4,height:6,coordinateSystemId:'attached'};

test('a persistent face frame and a two-level geometry/coordinate chain follow upstream parameters atomically',async()=>{
  const id='coordinate_chain',base=await cad(id,'primitive.box',box),source=base.features[0].id;
  const initial=await attach(id,base);near(coordinate(initial).origin,[10,15,10]);assert.equal(coordinate(initial).associationMode,'associative');assert.equal(coordinate(initial).referenceState,'resolved');
  assert.equal(coordinate(initial).referenceSelector,undefined,'Private topology evidence must not inflate query_model or UI responses');
  assert.ok(initial.features[0].identity);
  const second=await cad(id,'primitive.box',child);near(await centroid(id,second.bodyId),[11,17,13]);
  await attach(id,second,'upper');const third=await cad(id,'primitive.box',{width:2,depth:2,height:2,coordinateSystemId:'upper'});
  const before=await cad(id,'document.view'),beforeCenters=[await centroid(id,second.bodyId),await centroid(id,third.bodyId)];
  const updated=await cad(id,'feature.update',{width:40,height:20},{featureId:source});
  near(coordinate(updated).origin,[20,15,20]);
  near(await centroid(id,second.bodyId),beforeCenters[0].map((v,i)=>v+[10,0,10][i]));
  near(await centroid(id,third.bodyId),beforeCenters[1].map((v,i)=>v+[10,0,10][i]));
  assert.equal(updated.features[0].identity,before.features[0].identity);
  const undo=await cad(id,'document.undo');assert.deepEqual(undo.coordinateSystems,before.coordinateSystems);near(await centroid(id,third.bodyId),beforeCenters[1]);
  const redo=await cad(id,'document.redo');near(coordinate(redo).origin,[20,15,20]);
  const top=await cad(id,'body.presentation',{}, {bodyId:third.bodyId}),beforeCycle=await cad(id,'document.view');
  const cycle=await raw(id,'coordinate.set',{id:'attached',name:'multi-level cycle',kind:'face',referenceBodyId:third.bodyId,referenceTopologyId:faceAtZ(top,28)});
  assert.equal(cycle.code,'COORDINATE_DEPENDENCY_CYCLE',JSON.stringify(cycle));assert.equal((await cad(id,'document.view')).stateToken,beforeCycle.stateToken);
});

test('coordinate rebinding may reference a later independent feature through stable dependency ordering, but rejects cycles',async()=>{
  const id='coordinate_order',base=await cad(id,'primitive.box',box);await attach(id,base);
  const dependent=await cad(id,'primitive.box',child),later=await cad(id,'primitive.box',{...box,x:100,z:50});
  const originalOrder=later.features.map(item=>item.id);
  const rebound=await attach(id,later);near(coordinate(rebound).origin,[110,15,60]);near(await centroid(id,dependent.bodyId),[111,17,63]);
  assert.deepEqual(rebound.features.map(item=>item.id),originalOrder,'Dependency execution must not rewrite displayed history order');
  await cad(id,'feature.update',{height:20},{featureId:later.features.at(-1).id});near(await centroid(id,dependent.bodyId),[111,17,73]);
  const presentation=await cad(id,'body.presentation',{}, {bodyId:dependent.bodyId}),before=await cad(id,'document.view');
  const cycle=await raw(id,'coordinate.set',{id:'attached',name:'cycle',kind:'face',referenceBodyId:dependent.bodyId,referenceTopologyId:faceAtZ(presentation,76)});
  assert.equal(cycle.code,'COORDINATE_DEPENDENCY_CYCLE',JSON.stringify(cycle));
  const after=await cad(id,'document.view');for(const key of ['stateToken','revision','features','coordinateSystems','entityIdentities'])assert.deepEqual(after[key],before[key],key);
});

async function holeCoordinate(id,used){
  const base=await cad(id,'primitive.box',{width:100,depth:100,height:20}),tool=await cad(id,'primitive.cylinder',{radius:5,height:30,x:25,y:25,z:-5});
  const cut=await cad(id,'boolean.cut',{}, {targetBody:base.bodyId,toolBody:tool.bodyId});
  let face;
  for(const candidate of new Set(cut.triangleFaceIds)){
    const measured=await cad(id,'geometry.measure',{}, {bodyId:base.bodyId,selectionType:'face',selectionId:candidate});
    if(Math.abs(measured.area-2*Math.PI*5*20)<1e-3 && Math.abs(measured.centroid[0]-25)<1e-6 && Math.abs(measured.centroid[1]-25)<1e-6){face=candidate;break;}
  }
  assert.ok(face,'A real cylindrical Cut wall is required');
  await cad(id,'coordinate.set',{id:'attached',name:'Hole wall',kind:'face',referenceBodyId:base.bodyId,referenceTopologyId:face});
  if(used)await cad(id,'primitive.box',child);
  return {base,tool,cut};
}

test('a disappeared Boolean face becomes visibly unresolved when unused and cannot be used as a stale construction frame',async()=>{
  const id='coordinate_missing_unused',fixture=await holeCoordinate(id,false);
  const changed=await cad(id,'feature.update',{x:200},{featureId:fixture.tool.features.at(-1).id});
  assert.equal(coordinate(changed).referenceState,'unresolved');assert.ok(coordinate(changed).referenceDiagnostic);
  const before=await cad(id,'document.view'),rejected=await raw(id,'primitive.box',child);
  assert.equal(rejected.code,'COORDINATE_REFERENCE_UNRESOLVED');assert.equal(rejected.details.coordinateSystemId,'attached');
  assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  const frozen=await raw(id,'coordinate.set',{id:'attached',name:'stale freeze',kind:'face',preserveReference:true,associationMode:'snapshot'});
  assert.equal(frozen.code,'COORDINATE_REFERENCE_UNRESOLVED','An invalid anchor cannot be made valid by freezing its old location');
  assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  const view=await cad(id,'body.presentation',{}, {bodyId:fixture.base.bodyId});
  const repaired=await attach(id,{...view,bodyId:fixture.base.bodyId});assert.equal(coordinate(repaired).referenceState,'resolved');
  await cad(id,'primitive.box',child);
});

test('a disappeared Boolean face with dependent geometry rejects the whole upstream edit without partial coordinate updates',async()=>{
  const id='coordinate_missing_used',fixture=await holeCoordinate(id,true),before=await cad(id,'document.view');
  const rejected=await raw(id,'feature.update',{x:200},{featureId:fixture.tool.features.at(-1).id});
  assert.equal(rejected.code,'COORDINATE_REFERENCE_UNRESOLVED',JSON.stringify(rejected));
  const after=await cad(id,'document.view');for(const key of ['stateToken','revision','features','coordinateSystems','bodyMetadata','entityIdentities'])assert.deepEqual(after[key],before[key],key);
});

function coordinateEdit(input,index){
  const p=input.inputPreview;
  return {coordinateSystemId:p.coordinateSystemId,documentId:input.documentId,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:'face',inputFingerprint:p.inputFingerprint,index};
}
async function coordinateInspection(id,proposal,source={}){
  return cad(id,'feature.input.preview',{proposal},{coordinateSystemId:'attached',...source});
}
test('an upstream change and a coordinate face replacement preview and commit atomically as one undo event',async()=>{
  const id='coordinate_joint_repair',fixture=await holeCoordinate(id,true),before=await cad(id,'document.view');
  const proposal={operation:'feature.update',inputs:{featureId:fixture.tool.features.at(-1).id},parameters:{x:200}};
  const inspected=await coordinateInspection(id,proposal);
  assert.equal(inspected.inputPreview.coordinateSystemId,'attached');assert.equal(inspected.inputPreview.selectionState,'unresolved');
  assert.equal(inspected.inputPreview.sourceFeatureId,fixture.cut.features.at(-1).id);
  const index=Number(faceAtZ(inspected.inputPreview.presentation,20).split('-').at(-1));
  const edit=coordinateEdit(inspected,index),parameters={...proposal.parameters,coordinateSelectionEdits:[edit]};
  const preview=await cad(id,'feature.update',parameters,proposal.inputs,{preview:true});
  assert.equal(coordinate(preview).referenceState,'resolved');near(coordinate(preview).origin,[50,50,20]);
  for(const key of ['stateToken','revision','features','coordinateSystems','bodyMetadata','entityIdentities'])assert.deepEqual((await cad(id,'document.view'))[key],before[key],key);
  const result=await cad(id,'feature.update',parameters,proposal.inputs);assert.equal(result.revision,before.revision+1);
  near(coordinate(result).origin,[50,50,20]);assert.equal(result.features.find(f=>f.id===proposal.inputs.featureId).numberParameters.x,200);
  near(await centroid(id,before.bodyId),[51,52,23]);
  const undone=await cad(id,'document.undo');for(const key of ['features','coordinateSystems','bodyMetadata','entityIdentities'])assert.deepEqual(undone[key],before[key],key);
  const redone=await cad(id,'document.redo');near(coordinate(redone).origin,[50,50,20]);
  const follow=await cad(id,'feature.update',{height:30},{featureId:fixture.base.features[0].id});near(coordinate(follow).origin,[50,50,30]);
});

test('coordinate repair evidence rejects foreign, changed, duplicate and out-of-range faces without publishing partial changes',async()=>{
  const id='coordinate_repair_proof',fixture=await holeCoordinate(id,true),before=await cad(id,'document.view');
  const proposal={operation:'feature.update',inputs:{featureId:fixture.tool.features.at(-1).id},parameters:{x:200}};
  const inspected=await coordinateInspection(id,proposal),edit=coordinateEdit(inspected,Number(faceAtZ(inspected.inputPreview.presentation,20).split('-').at(-1)));
  for(const change of [{documentId:'foreign'},{sourceBodyIdentity:'0'.repeat(32)},{inputFingerprint:'0'.repeat(64)},{kind:'edge'},{index:99999}]){
    const result=await raw(id,proposal.operation,{x:200,coordinateSelectionEdits:[{...edit,...change}]},proposal.inputs);
    assert.equal(result.ok,false,JSON.stringify(change));assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  }
  const duplicate=await raw(id,proposal.operation,{x:200,coordinateSelectionEdits:[edit,edit]},proposal.inputs);assert.equal(duplicate.code,'INVALID_SELECTION_REPAIR');
  const missing=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation:proposal.operation,inputs:proposal.inputs,parameters:{x:200,coordinateSelectionEdits:[edit]}})});
  assert.equal(missing.status,428);assert.equal((await missing.json()).code,'SELECTION_STATE_REQUIRED');
  // The cylinder moved outside the target; its historical cut result remains exactly the same.
  // Changing target size instead must invalidate the inspected fingerprint.
  const wrong=await raw(id,'feature.update',{height:35,coordinateSelectionEdits:[edit]},{featureId:fixture.base.features[0].id});assert.equal(wrong.code,'STALE_SELECTION_REPAIR');
  assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
});

test('suppression/deletion can explicitly rebind a coordinate to another historical output without using a final live Body',async()=>{
  for(const operation of ['feature.suppress','feature.delete']){
    const id='coordinate_repair_'+operation.split('.')[1],fixture=await holeCoordinate(id,true),before=await cad(id,'document.view');
    const proposal={operation,inputs:{featureId:fixture.cut.features.at(-1).id},parameters:{}};
    const unavailable=await raw(id,'feature.input.preview',{proposal},{coordinateSystemId:'attached'});assert.equal(unavailable.code,'FEATURE_INPUT_UNAVAILABLE');
    const inspected=await coordinateInspection(id,proposal,{sourceFeatureId:fixture.base.features[0].id,sourceBodyId:fixture.base.bodyId});
    assert.equal(inspected.inputPreview.selectionState,'unverified');assert.equal(inspected.inputPreview.resolvedIndex,0);
    const edit=coordinateEdit(inspected,Number(faceAtZ(inspected.inputPreview.presentation,20).split('-').at(-1)));
    const result=await cad(id,operation,{coordinateSelectionEdits:[edit]},proposal.inputs);
    assert.equal(coordinate(result).referenceFeatureId,fixture.base.features[0].id);assert.equal(coordinate(result).referenceState,'resolved');
    const undone=await cad(id,'document.undo');assert.deepEqual(undone.coordinateSystems,before.coordinateSystems);
  }
});

test('several broken coordinate anchors can be staged one at a time and committed together without partial frames',async()=>{
  const id='coordinate_multiple_repair',fixture=await holeCoordinate(id,true);
  await cad(id,'coordinate.set',{id:'second',name:'Second',kind:'face',copyReferenceFrom:'attached'});await cad(id,'primitive.box',{...child,coordinateSystemId:'second'});
  const before=await cad(id,'document.view'),proposal={operation:'feature.update',inputs:{featureId:fixture.tool.features.at(-1).id},parameters:{x:200}};
  const first=await coordinateInspection(id,proposal),edit=coordinateEdit(first,Number(faceAtZ(first.inputPreview.presentation,20).split('-').at(-1)));
  const partial={...proposal,parameters:{...proposal.parameters,coordinateSelectionEdits:[edit]}};
  const needsSecond=await raw(id,partial.operation,partial.parameters,partial.inputs,{preview:true});assert.equal(needsSecond.code,'COORDINATE_REFERENCE_UNRESOLVED');assert.equal(needsSecond.details.coordinateSystemId,'second');
  const second=await coordinateInspection(id,partial,{coordinateSystemId:'second'}),edit2=coordinateEdit(second,Number(faceAtZ(second.inputPreview.presentation,20).split('-').at(-1)));
  assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  const result=await cad(id,proposal.operation,{x:200,coordinateSelectionEdits:[edit,edit2]},proposal.inputs);
  for(const name of ['attached','second']){assert.equal(coordinate(result,name).referenceState,'resolved');near(coordinate(result,name).origin,[50,50,20]);}
  const undone=await cad(id,'document.undo');assert.deepEqual(undone.coordinateSystems,before.coordinateSystems);assert.deepEqual(undone.features,before.features);
});

test('a restored feature can become the explicit coordinate source within the same proposed lifecycle operation',async()=>{
  const id='coordinate_repair_restore',fixture=await holeCoordinate(id,true),cutId=fixture.cut.features.at(-1).id;
  const suppress={operation:'feature.suppress',inputs:{featureId:cutId},parameters:{}};
  const base=await coordinateInspection(id,suppress,{sourceFeatureId:fixture.base.features[0].id,sourceBodyId:fixture.base.bodyId});
  const edit=coordinateEdit(base,Number(faceAtZ(base.inputPreview.presentation,20).split('-').at(-1)));
  await cad(id,suppress.operation,{coordinateSelectionEdits:[edit]},suppress.inputs);const before=await cad(id,'document.view');
  const restore={operation:'feature.restore',inputs:{featureId:cutId},parameters:{}};
  const restored=await coordinateInspection(id,restore,{sourceFeatureId:cutId,sourceBodyId:fixture.base.bodyId});
  const replacement=coordinateEdit(restored,Number(faceAtZ(restored.inputPreview.presentation,20).split('-').at(-1)));
  const result=await cad(id,restore.operation,{coordinateSelectionEdits:[replacement]},restore.inputs);assert.equal(coordinate(result).referenceFeatureId,cutId);
  const undone=await cad(id,'document.undo');assert.deepEqual(undone.features,before.features);assert.deepEqual(undone.coordinateSystems,before.coordinateSystems);
});

test('deleting one historical source with several dependent coordinates still allows each independent repair inspection',async()=>{
  const id='coordinate_multiple_deleted',fixture=await holeCoordinate(id,true);
  await cad(id,'coordinate.set',{id:'second',name:'Second',kind:'face',copyReferenceFrom:'attached'});await cad(id,'primitive.box',{...child,coordinateSystemId:'second'});
  const before=await cad(id,'document.view'),proposal={operation:'feature.delete',inputs:{featureId:fixture.cut.features.at(-1).id},parameters:{}};
  const source={sourceFeatureId:fixture.base.features[0].id,sourceBodyId:fixture.base.bodyId};
  const dependent=before.features.find(f=>f.stringParameters?.coordinateSystemId==='attached');assert.ok(dependent);
  const cycle=await raw(id,'feature.input.preview',{proposal},{coordinateSystemId:'attached',sourceFeatureId:dependent.id,sourceBodyId:dependent.outputBodies[0]});assert.equal(cycle.code,'COORDINATE_DEPENDENCY_CYCLE');
  const first=await coordinateInspection(id,proposal,source),edit=coordinateEdit(first,Number(faceAtZ(first.inputPreview.presentation,20).split('-').at(-1)));
  const partial={...proposal,parameters:{coordinateSelectionEdits:[edit]}};
  const incomplete=await raw(id,partial.operation,partial.parameters,partial.inputs,{preview:true});assert.equal(incomplete.code,'COORDINATE_REFERENCE_UNRESOLVED');assert.equal(incomplete.details.coordinateSystemId,'second');
  const second=await coordinateInspection(id,partial,{...source,coordinateSystemId:'second'}),edit2=coordinateEdit(second,Number(faceAtZ(second.inputPreview.presentation,20).split('-').at(-1)));
  const result=await cad(id,proposal.operation,{coordinateSelectionEdits:[edit,edit2]},proposal.inputs);for(const name of ['attached','second'])assert.equal(coordinate(result,name).referenceFeatureId,fixture.base.features[0].id);
  const undone=await cad(id,'document.undo');assert.deepEqual(undone.features,before.features);assert.deepEqual(undone.coordinateSystems,before.coordinateSystems);
});

test('feature Edge repair and coordinate Face repair share one full replay and one Undo',async()=>{
  const id='coordinate_and_feature_repair',fixture=await holeCoordinate(id,false);let rim;
  for(const edge of fixture.cut.edges){const measured=await cad(id,'geometry.measure',{}, {bodyId:fixture.base.bodyId,selectionType:'edge',selectionId:edge.edgeId});if(measured.curveType==='circle'&&Math.abs(measured.centroid[2]-20)<1e-7)rim=edge.edgeId;}
  assert.ok(rim);const fillet=await cad(id,'detail.fillet',{radius:1},{bodyId:fixture.base.bodyId,edgeId:rim});await cad(id,'primitive.box',child);
  const before=await cad(id,'document.view'),proposal={operation:'feature.update',inputs:{featureId:fixture.tool.features.at(-1).id},parameters:{x:200}};
  const input=await cad(id,'feature.input.preview',{proposal},{featureId:fillet.features.at(-1).id}),p=input.inputPreview;
  const edge=p.presentation.edges.find(edge=>edge.points.every((value,index)=>index%3===2||Math.abs(value)<1e-7));assert.ok(edge);
  const selection={documentId:id,featureId:p.featureId,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:'edge',inputFingerprint:p.inputFingerprint,index:Number(edge.edgeId.split('-').at(-1))};
  const partial={...proposal,parameters:{x:200,selectionEdits:[selection]}};
  const needsCoordinate=await raw(id,partial.operation,partial.parameters,partial.inputs,{preview:true});assert.equal(needsCoordinate.code,'COORDINATE_REFERENCE_UNRESOLVED');
  const inspected=await coordinateInspection(id,partial),edit=coordinateEdit(inspected,Number(faceAtZ(inspected.inputPreview.presentation,20).split('-').at(-1)));
  const result=await cad(id,proposal.operation,{...partial.parameters,coordinateSelectionEdits:[edit]},proposal.inputs);assert.equal(result.revision,before.revision+1);near(coordinate(result).origin,[50,50,20]);
  const undone=await cad(id,'document.undo');assert.deepEqual(undone.features,before.features);assert.deepEqual(undone.coordinateSystems,before.coordinateSystems);
});

test('coordinate dependencies protect source history deletion, while unused anchors become unresolved and Undo restores them',async()=>{
  const id='coordinate_delete',base=await cad(id,'primitive.box',box);await attach(id,base);const dependent=await cad(id,'primitive.box',child);
  const before=await cad(id,'document.view'),rejected=await raw(id,'body.delete',{}, {bodyId:base.bodyId});assert.equal(rejected.code,'BODY_IN_USE');
  assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  await cad(id,'body.delete',{}, {bodyId:dependent.bodyId});
  const removed=await cad(id,'body.delete',{}, {bodyId:base.bodyId});assert.equal(coordinate(removed).referenceState,'unresolved');
  const created=await cad(id,'primitive.box',box);assert.notEqual(created.bodyId,base.bodyId);assert.equal(coordinate(created).referenceState,'unresolved');
  const blocked=await raw(id,'primitive.box',child);assert.equal(blocked.code,'COORDINATE_REFERENCE_UNRESOLVED');
  await cad(id,'document.undo');const restored=await cad(id,'document.undo');assert.equal(coordinate(restored).referenceState,'resolved');
  await cad(id,'primitive.box',child);
});

test('face references survive portable projects and variable edits; explicit snapshots remain fixed until rebinding',async()=>{
  const id='coordinate_portable';await cad(id,'variable.set',{name:'H',type:'length',expression:'10 mm'});
  const base=await cad(id,'primitive.box',{...box,height:'H'});await attach(id,base);const dependent=await cad(id,'primitive.box',child);
  await attach(id,base,'snapshot',{associationMode:'snapshot'});
  const fixed=coordinate(await cad(id,'document.view'),'snapshot').origin;
  const bytes=await(await fetch(api+`/documents/${id}/project/save`,{method:'POST'})).arrayBuffer();
  const restoredId='coordinate_restored',opened=await fetch(api+`/documents/${restoredId}/project/open`,{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:bytes});
  const view=await opened.json();assert.equal(view.ok,true,JSON.stringify(view));states.set(restoredId,view);
  const changed=await cad(restoredId,'variable.set',{name:'H',type:'length',expression:'30 mm'});
  near(coordinate(changed).origin,[10,15,30]);near(await centroid(restoredId,dependent.bodyId),[11,17,33]);near(coordinate(changed,'snapshot').origin,fixed);
  const renamed=await cad(restoredId,'coordinate.set',{id:'attached',name:'Renamed frame',kind:'face',preserveReference:true});
  assert.equal(coordinate(renamed).name,'Renamed frame');assert.equal(coordinate(renamed).referenceState,'resolved');
});

test('source and target coordinate transforms both prevent deleting referenced coordinate systems',async()=>{
  const id='coordinate_transform_delete';await cad(id,'coordinate.set',{id:'local',name:'Local',origin:[10,0,0],xAxis:[1,0,0],yAxis:[0,1,0]});
  const base=await cad(id,'primitive.box',box);await cad(id,'transform.coordinate',{sourceCoordinateSystemId:'local',targetCoordinateSystemId:'global'},{bodyId:base.bodyId});
  assert.equal((await raw(id,'coordinate.delete',{}, {id:'local'})).code,'COORDINATE_SYSTEM_IN_USE');
});

test('historical face anchors do not drift to later Body transforms and lifecycle changes never substitute predecessor faces',async()=>{
  const id='coordinate_historical',base=await cad(id,'primitive.box',box);await attach(id,base);const dependent=await cad(id,'primitive.box',child);
  await cad(id,'transform.translate',{dx:0,dy:0,dz:50},{bodyId:base.bodyId});
  const updated=await cad(id,'feature.update',{height:20},{featureId:base.features[0].id});
  near(coordinate(updated).origin,[10,15,20]);near(await centroid(id,dependent.bodyId),[11,17,23]);
  const current=await cad(id,'body.presentation',{}, {bodyId:base.bodyId});await attach(id,{...current,bodyId:base.bodyId},'transformed');
  const transformId=updated.features.at(-1).id;
  const suppressed=await cad(id,'feature.suppress',{}, {featureId:transformId});assert.equal(coordinate(suppressed,'transformed').referenceState,'unresolved');
  const restored=await cad(id,'feature.restore',{}, {featureId:transformId});assert.equal(coordinate(restored,'transformed').referenceState,'resolved');near(coordinate(restored,'transformed').origin,[10,15,70]);
  const extra=await cad(id,'primitive.box',{...child,coordinateSystemId:'transformed'}),before=await cad(id,'document.view');
  const rejected=await raw(id,'feature.delete',{}, {featureId:transformId});assert.equal(rejected.code,'COORDINATE_REFERENCE_UNRESOLVED');assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);assert.ok(extra.bodyId);
});

test('both coordinate transform matrices follow their persistent face frames during upstream edits',async()=>{
  const id='coordinate_matrix',base=await cad(id,'primitive.box',box);await attach(id,base);
  const first=await cad(id,'primitive.box',{width:2,depth:4,height:6,x:100});
  await cad(id,'transform.coordinate',{sourceCoordinateSystemId:'global',targetCoordinateSystemId:'attached'},{bodyId:first.bodyId});
  const second=await cad(id,'primitive.box',{width:2,depth:4,height:6,x:200});
  await cad(id,'transform.coordinate',{sourceCoordinateSystemId:'attached',targetCoordinateSystemId:'global'},{bodyId:second.bodyId});
  const before=[await centroid(id,first.bodyId),await centroid(id,second.bodyId)];
  await cad(id,'feature.update',{height:20},{featureId:base.features[0].id});
  near(await centroid(id,first.bodyId),before[0].map((v,i)=>v+(i===2?-10:0)));
  near(await centroid(id,second.bodyId),before[1].map((v,i)=>v+(i===2?10:0)));
});

test('freezing an active reference is explicit, while upgrading a snapshot requires a fresh face selection',async()=>{
  const id='coordinate_freeze',base=await cad(id,'primitive.box',box);await attach(id,base);
  const frozen=await cad(id,'coordinate.set',{id:'attached',name:'Frozen',kind:'face',preserveReference:true,associationMode:'snapshot'});
  const origin=coordinate(frozen).origin;assert.equal(coordinate(frozen).associationMode,'snapshot');
  await cad(id,'feature.update',{height:20},{featureId:base.features[0].id});near(coordinate(await cad(id,'document.view')).origin,origin);
  const before=await cad(id,'document.view'),rejected=await raw(id,'coordinate.set',{id:'attached',name:'Upgrade',kind:'face',preserveReference:true,associationMode:'associative'});
  assert.equal(rejected.code,'INVALID_COORDINATE_REFERENCE');assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  const current=await cad(id,'body.presentation',{}, {bodyId:base.bodyId});const rebound=await attach(id,{...current,bodyId:base.bodyId});near(coordinate(rebound).origin,[10,15,20]);
});

test('copying a face coordinate preserves its persistent anchor without replaying an old face number',async()=>{
  const id='coordinate_copy',base=await cad(id,'primitive.box',box);await attach(id,base);
  await cad(id,'feature.update',{height:20},{featureId:base.features[0].id});
  const copy=await cad(id,'coordinate.set',{id:'copy',name:'Copy',kind:'face',copyReferenceFrom:'attached'});
  assert.equal(coordinate(copy,'copy').referenceState,'resolved');near(coordinate(copy,'copy').origin,[10,15,20]);
  const changed=await cad(id,'feature.update',{height:30},{featureId:base.features[0].id});near(coordinate(changed,'copy').origin,[10,15,30]);near(coordinate(changed).origin,[10,15,30]);
  const token=changed.stateToken,rejected=await raw(id,'coordinate.set',{id:'attached',name:'overwrite',kind:'face',copyReferenceFrom:'copy'});assert.equal(rejected.code,'COORDINATE_SYSTEM_EXISTS');assert.equal((await cad(id,'document.view')).stateToken,token);
});

test('a proposed geometry edit computes dependent coordinate frames but preview never publishes their values or identities',async()=>{
  const id='coordinate_preview',base=await cad(id,'primitive.box',box);await attach(id,base);await cad(id,'primitive.box',child);
  const before=await cad(id,'document.view'),preview=await raw(id,'feature.update',{height:30},{featureId:base.features[0].id},{preview:true});
  assert.equal(preview.ok,true,JSON.stringify(preview));assert.equal(preview.preview.state,'preview');near(coordinate(preview).origin,[10,15,30]);
  const after=await cad(id,'document.view');for(const key of ['revision','stateToken','features','coordinateSystems','entityIdentities','bodyMetadata'])assert.deepEqual(after[key],before[key],key);
});

test('persistent coordinate references survive an actual gateway/worker restart and still drive the restored geometry',async()=>{
  const id='coordinate_restart',base=await cad(id,'primitive.box',box);await attach(id,base);const dependent=await cad(id,'primitive.box',child),before=await cad(id,'document.view');
  const stopped=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await stopped;await startGateway();
  const restored=await cad(id,'document.view');for(const key of ['revision','stateToken','features','coordinateSystems','entityIdentities'])assert.deepEqual(restored[key],before[key],key);
  const edited=await cad(id,'feature.update',{width:40,height:30},{featureId:base.features[0].id});near(coordinate(edited).origin,[20,15,30]);near(await centroid(id,dependent.bodyId),[21,17,33]);
  const repaired=await cad('coordinate_joint_repair','document.view');near(coordinate(repaired).origin,[50,50,30]);
  const followed=await cad('coordinate_joint_repair','feature.update',{height:40},{featureId:repaired.features.find(f=>f.type==='primitive.box').id});near(coordinate(followed).origin,[50,50,40]);
});
