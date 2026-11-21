import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {stopTestChild} from './helpers/stop-test-child.mjs';
import {selectGeometry} from './helpers/generated-topology-fixtures.mjs';
import {validateBatchSelectionProvenance} from '../gateway/batch-selection-provenance.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-loft-holes-')),listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));const api=`http://127.0.0.1:${port}/api`,states=new Map();let gateway;
async function start(){let diagnostic='';gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:String(port),GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});gateway.stderr.on('data',chunk=>diagnostic+=chunk);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Multi-loop Gateway startup failed: '+diagnostic)),15000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(String(chunk).includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){await stopTestChild(gateway);gateway=null;}
before(start);after(async()=>{await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function raw(id,operation,parameters={},inputs={},options={}){const state=states.get(id);return fetch(api+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,options,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})})}).then(response=>response.json());}
async function cad(...args){const result=await raw(...args);assert.equal(result.ok,true,JSON.stringify(result));if(!args[4]?.preview)states.set(args[0],result);return result;}
const near=(a,b)=>Math.abs(a-b)<1e-5*Math.max(1,Math.abs(b));
async function tubeSection(id,z){const view=await cad(id,'primitive.tube',{outerRadius:10,innerRadius:1,height:2,z}),faceId=await selectGeometry(cad,id,view,'face',value=>near(value.centroid[2],z+2)),edgeId=await selectGeometry(cad,id,view,'edge',value=>near(value.centroid[2],z+2)&&near(value.length,2*Math.PI));return {view,bodyId:view.bodyId,faceId,holeEdgeIds:[edgeId]};}
const input=section=>({bodyId:section.bodyId,faceId:section.faceId,holeEdgeIds:section.holeEdgeIds});
async function measure(id,bodyId){return (await cad(id,'geometry.measure',{}, {bodyId})).volume;}
async function property(id,bodyId,topologyId,key){const type=await cad(id,'property.type.create',{key,targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]});return (await cad(id,'property.instance.create',{typeId:type.type.typeId,name:key,value:{marker:7},target:{kind:'face',bodyId,topologyId}})).instance.instanceId;}
async function instance(id,instanceId){return (await cad(id,'property.instance.list')).instances.find(item=>item.instanceId===instanceId);}

test('explicit through-hole Loft previews, replays inner-radius edits and restores cap/wall properties with Undo/Redo',async()=>{
  const id='loft_hole_replay',first=await tubeSection(id,5),last=await tubeSection(id,25),sections=[input(first),input(last)],before=await cad(id,'document.view');
  const preview=await cad(id,'detail.loft',{}, {sections},{preview:true});assert.equal(preview.preview.state,'preview');assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  const result=await cad(id,'detail.loft',{}, {sections});assert.equal(result.features.at(-1).stringParameters.loftVersion,'3');assert.ok(near(await measure(id,result.bodyId),Math.PI*99*20));
  const start=await selectGeometry(cad,id,result,'face',value=>near(value.centroid[2],7)),wall=await selectGeometry(cad,id,result,'face',value=>near(value.area,Math.PI*40)),capProperty=await property(id,result.bodyId,start,'AnnularCap'),wallProperty=await property(id,result.bodyId,wall,'BoreWall'),saved=await cad(id,'document.view');
  await cad(id,'feature.update',{innerRadius:1.5},{featureId:first.view.features[0].id});assert.ok(near(await measure(id,result.bodyId),Math.PI*(2000-20/3*(2.25+1.5+1))));assert.equal((await instance(id,capProperty)).state,'active');assert.equal((await instance(id,wallProperty)).state,'active');
  await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,saved.features);assert.ok(near(await measure(id,result.bodyId),Math.PI*99*20));await cad(id,'document.redo');assert.equal((await instance(id,wallProperty)).state,'active');
});

test('unmapped holes, wrong boundaries, duplicate slots and mixed hole counts reject without changing project state',async()=>{
  const id='loft_hole_invalid',first=await tubeSection(id,5),last=await tubeSection(id,25),before=await cad(id,'document.view'),outer=await selectGeometry(cad,id,first.view,'edge',value=>near(value.centroid[2],7)&&near(value.length,Math.PI*20));
  for(const [sections,code] of [
    [[{bodyId:first.bodyId,faceId:first.faceId},{bodyId:last.bodyId,faceId:last.faceId}],'LOFT_PROFILE_HOLES_UNSUPPORTED'],
    [[input(first),{bodyId:last.bodyId,faceId:last.faceId}],'LOFT_HOLE_MAPPING_REQUIRED'],
    [[{...input(first),holeEdgeIds:[outer]},input(last)],'INVALID_LOFT_HOLE_MAPPING'],
    [[{...input(first),holeEdgeIds:[first.holeEdgeIds[0],first.holeEdgeIds[0]]},{...input(last),holeEdgeIds:[last.holeEdgeIds[0],last.holeEdgeIds[0]]}],'INVALID_LOFT_HOLE_MAPPING']
  ]){const failed=await raw(id,'detail.loft',{}, {sections});assert.equal(failed.code,code,JSON.stringify(failed));const after=await cad(id,'document.view');assert.equal(after.stateToken,before.stateToken);assert.deepEqual(after.features,before.features);assert.deepEqual(after.entityIdentities,before.entityIdentities);}
});

test('multiple real Boolean-created holes keep explicit correspondence and reject crossed channels atomically',async()=>{
  const id='loft_two_holes';async function section(z){let view=await cad(id,'primitive.box',{width:20,depth:20,height:2,x:-10,y:-10,z});const bodyId=view.bodyId;for(const x of [-3,3]){const tool=await cad(id,'primitive.cylinder',{radius:1,height:4,x,z:z-1});view=await cad(id,'boolean.cut',{}, {targetBody:bodyId,toolBody:tool.bodyId});}const faceId=await selectGeometry(cad,id,view,'face',value=>near(value.centroid[2],z+2)),holeEdgeIds=[];for(const x of [-3,3])holeEdgeIds.push(await selectGeometry(cad,id,view,'edge',value=>near(value.centroid[0],x)&&near(value.centroid[2],z+2)&&near(value.length,2*Math.PI)));return {bodyId,faceId,holeEdgeIds};}
  const first=await section(0),last=await section(20),before=await cad(id,'document.view'),failed=await raw(id,'detail.loft',{}, {sections:[first,{...last,holeEdgeIds:last.holeEdgeIds.toReversed()}]});assert.equal(failed.code,'LOFT_HOLES_INTERSECT',JSON.stringify(failed));assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  const result=await cad(id,'detail.loft',{ruled:true},{sections:[first,last]});assert.ok(near(await measure(id,result.bodyId),(400-2*Math.PI)*20));const summary=await fetch(api+'/agent/model/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId:id,kind:'geometry-tree'})}).then(response=>response.json()),feature=summary.query.features.find(item=>item.id===result.features.at(-1).id);assert.equal(feature.inputSelections[0].sections[0].holeCount,2);assert.equal(JSON.stringify(feature).includes('holeSelectors'),false);
});

test('ordered hole selectors survive project-package reopen, Gateway restart, spacing edits and source changes',async()=>{
  const id='loft_hole_portable',first=await tubeSection(id,5),last=await tubeSection(id,25),result=await cad(id,'detail.loft',{}, {sections:[input(first),input(last)]}),feature=result.features.at(-1);
  const body=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(body.status,200);const copy=id+'_copy',opened=await fetch(api+`/documents/${copy}/project/open`,{method:'POST',headers:{'content-type':'application/vnd.webcad.project'},body:Buffer.from(await body.arrayBuffer())});assert.equal(opened.status,200,await opened.text());await stop();await start();await cad(copy,'document.summary');
  await cad(copy,'feature.update',{loftDefinition:{placement:'z-spacing',sectionSpacing:30}},{featureId:feature.id});assert.ok(near(await measure(copy,result.bodyId),Math.PI*99*30));
  await cad(copy,'feature.update',{innerRadius:1.5},{featureId:first.view.features[0].id});assert.ok(near(await measure(copy,result.bodyId),Math.PI*(3000-10*(2.25+1.5+1))));const updated=(await cad(copy,'document.summary')).features.find(item=>item.id===feature.id),refs=JSON.parse(updated.stringParameters.loftSections);assert.equal(refs.every(item=>item.holeSelectors.length===1),true);assert.equal(updated.stringParameters.loftVersion,'3');
});

test('batch provenance checks each hole edge even when Face and Body come from a fresh producing step',()=>{
  const snapshot=identity=>({bodyMetadata:[{bodyId:'body-1'}],entityIdentities:{'body-1':{bodyIdentity:'same',topologyIdentity:identity}}}),entry=snapshot('old'),current=snapshot('new'),observations=new Map([['changed',current]]),section={bodyId:'body-1',faceId:'face-2-1',holeEdgeIds:['edge-2-1']},resolved={inputs:{sections:[section,section]}},fresh={$ref:'changed.bodyId'};
  const raw={inputs:{sections:[{bodyId:fresh,faceId:{$ref:'changed.faceId'},holeEdgeIds:['edge-2-1']},{bodyId:fresh,faceId:{$ref:'changed.faceId'},holeEdgeIds:[{$ref:'changed.edgeId'}]}]}};
  assert.throws(()=>validateBatchSelectionProvenance('detail.loft',raw,resolved,entry,observations,current),error=>error.code==='BATCH_SELECTION_STALE'&&error.fieldPath==='inputs.sections.0.holeEdgeIds.0');raw.inputs.sections[0].holeEdgeIds=[{$ref:'changed.edgeId'}];assert.doesNotThrow(()=>validateBatchSelectionProvenance('detail.loft',raw,resolved,entry,observations,current));
});

test('existing Face measurement exposes complete real loop membership without changing geometry',async()=>{
  const id='loft_hole_boundaries',section=await tubeSection(id,5),before=await cad(id,'document.summary'),measured=await cad(id,'geometry.measure',{}, {bodyId:section.bodyId,selectionType:'face',selectionId:section.faceId}),summary=measured.boundaryLoops;
  assert.equal(summary.faceId,section.faceId);assert.equal(summary.complete,true);assert.equal(summary.planar,true);assert.equal(summary.valid,true);assert.equal(summary.loops.length,2);assert.equal(summary.loops.filter(loop=>loop.role==='inner').length,1);assert.ok(summary.loops.every(loop=>loop.closed&&loop.edgeIds.every(edge=>section.view.edges.some(item=>item.edgeId===edge))));assert.ok(summary.loops.find(loop=>loop.role==='inner').edgeIds.includes(section.holeEdgeIds[0]));assert.equal((await cad(id,'document.summary')).stateToken,before.stateToken);
});

test('a v3 historical section repairs Face and hole slots together, rejects wrong rings and commits with one Undo',async()=>{
  const id='loft_hole_historical_repair',original=await tubeSection(id,4),moved=await cad(id,'transform.translate',{dx:0,dy:0,dz:1},{bodyId:original.bodyId});
  const first={view:moved,bodyId:moved.bodyId,faceId:await selectGeometry(cad,id,moved,'face',value=>near(value.centroid[2],7)),holeEdgeIds:[await selectGeometry(cad,id,moved,'edge',value=>near(value.centroid[2],7)&&near(value.length,2*Math.PI))]},last=await tubeSection(id,25),alternative=await tubeSection(id,5),result=await cad(id,'detail.loft',{}, {sections:[input(first),input(last)]}),feature=result.features.at(-1),reference=JSON.parse(feature.stringParameters.loftSections)[0],before=await cad(id,'document.view');
  const proposal={operation:'feature.suppress',inputs:{featureId:moved.features.at(-1).id},parameters:{}},sourceFeatureId=alternative.view.features.at(-1).id;
  const failed=await raw(id,proposal.operation,{},proposal.inputs);assert.equal(failed.code,'LOFT_SECTION_UNRESOLVED');
  const read=await cad(id,'feature.input.preview',{proposal},{featureId:feature.id,sectionId:reference.sectionId,sourceFeatureId,sourceBodyId:alternative.bodyId}),preview=read.inputPreview;
  assert.equal(preview.requiredHoleCount,1);assert.deepEqual(preview.selectedHoleIndexes,[0],'Different sources cannot borrow the original hole correspondence');assert.equal(preview.faceBoundaries.complete,true);
  const index=Number(alternative.faceId.split('-').at(-1)),hole=Number(alternative.holeEdgeIds[0].split('-').at(-1)),face=preview.faceBoundaries.faces.find(value=>value.faceId===`face-0-${index}`),outer=Number(face.loops.find(loop=>loop.role==='outer').edgeIds[0].split('-').at(-1));
  const edit={documentId:id,featureId:feature.id,sectionId:reference.sectionId,sourceBodyId:alternative.bodyId,sourceBodyIdentity:preview.sourceBodyIdentity,sourceFeatureId,kind:'face',inputFingerprint:preview.inputFingerprint,index,holeIndexes:[hole]};
  for(const holeIndexes of [[outer],[],[9999]]){const bad=await raw(id,proposal.operation,{selectionEdits:[{...edit,holeIndexes}]},proposal.inputs);assert.equal(bad.ok,false);assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);}
  await cad(id,proposal.operation,{selectionEdits:[edit]},proposal.inputs,{preview:true});assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  const changed=await cad(id,proposal.operation,{selectionEdits:[edit]},proposal.inputs);assert.equal(changed.features.find(value=>value.id===proposal.inputs.featureId).state,'suppressed');assert.equal(JSON.parse(changed.features.find(value=>value.id===feature.id).stringParameters.loftSections)[0].bodyId,alternative.bodyId);assert.ok(near(await measure(id,result.bodyId),Math.PI*99*20));await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);
});
