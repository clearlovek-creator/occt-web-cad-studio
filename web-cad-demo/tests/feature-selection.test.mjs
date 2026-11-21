import { ObservedCommandClient } from "./helpers/observed-command-client.mjs";
const observedClient=new ObservedCommandClient();
import assert from 'node:assert/strict';
import {openLegacyStepProject} from './helpers/legacy-step-project.mjs';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {before,after,test} from 'node:test';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-feature-selection-'));
const api='http://127.0.0.1:8868/api';let gateway;const revisions=new Map();
before(async()=>{gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8868',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('selection test gateway startup timeout')),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});});
after(async()=>{if(gateway){const exited=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await exited;}const resolved=path.resolve(data);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('cad-feature-selection-'));fs.rmSync(resolved,{recursive:true,force:true});});
async function raw(id,operation,parameters={},inputs={}){const response=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(observedClient.prepare({documentId:id,baseRevision:revisions.get(id)||0,operation,parameters,inputs}))});const result=await response.json();observedClient.observe(result,id);if(result.ok&&Number.isSafeInteger(result.revision))revisions.set(id,result.revision);return result;}
async function cad(...args){const result=await raw(...args);assert.equal(result.ok,true,JSON.stringify(result));return result;}
async function choose(id,result,kind,predicate){const ids=kind==='face'?[...new Set(result.triangleFaceIds)]:result.edges.map(edge=>edge.edgeId);for(const selectionId of ids){const measured=await cad(id,'geometry.measure',{}, {bodyId:result.bodyId,selectionType:kind,selectionId});if(predicate(measured))return selectionId;}throw new Error('The required '+kind+' fixture was not found');}
const near=(a,b)=>Math.abs(a-b)<1e-5;

test('Fillet and Chamfer input edges survive upstream resizing and large relocation; selectors persist through a package',async()=>{
  for(const operation of ['detail.fillet','detail.chamfer']){
    const id=operation.replace('.','_'),base=await cad(id,'primitive.box',{width:30,depth:30,height:30});
    const edge=await choose(id,base,'edge',value=>near(value.centroid[0],0)&&near(value.centroid[1],0)&&near(value.length,30));
    const detail=await cad(id,operation,operation==='detail.fillet'?{radius:2}:{distance:2},{bodyId:base.bodyId,edgeId:edge});
    const reference=detail.features.at(-1).stringParameters['selection.edgeId'];assert.equal(JSON.parse(reference).version,1);assert.match(JSON.parse(reference).fingerprint,/^[a-f0-9]{64}$/);
    const query=await (await fetch(api+'/agent/model/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,kind:'feature',featureId:detail.features.at(-1).id})})).json();
    assert.deepEqual(query.query.feature.inputSelections,[{field:'edgeId',kind:'edge',basis:'exact-brep+semantic-topology'}]);
    assert.equal(query.query.feature.stringParameters['selection.edgeId'],undefined);assert.equal(JSON.stringify(query).includes(JSON.parse(reference).fingerprint),false,'Opaque internal references must not inflate Agent context');
    const changed=await cad(id,'feature.update',{width:60,depth:40,height:50,x:1000,y:200,z:100},{featureId:base.features[0].id});
    assert.equal(changed.features.at(-1).stringParameters['selection.edgeId'],reference,'Reference must not be overwritten by resolved indexes');
    const volume=await cad(id,'geometry.measure',{}, {bodyId:base.bodyId,selectionType:'body'});
    const removed=operation==='detail.fillet'?(4-Math.PI)*50:2*50;assert.ok(near(volume.volume,60*40*50-removed),JSON.stringify(volume));
    const corner=await choose(id,changed,'face',value=>value.centroid[0]>1000&&value.centroid[0]<1002&&value.centroid[1]>200&&value.centroid[1]<202&&near(value.centroid[2],125));assert.ok(corner,'Blend must stay on the lower X/lower Y vertical edge');
    const saved=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(saved.status,200);
    const restoredId=id+'_portable',opened=await fetch(api+`/documents/${restoredId}/project/open`,{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:Buffer.from(await saved.arrayBuffer())});assert.equal(opened.status,200,await opened.text());
    await cad(restoredId,'document.summary');const updated=await cad(restoredId,'feature.update',operation==='detail.fillet'?{radius:3}:{distance:3},{featureId:detail.features.at(-1).id});assert.equal(updated.features.at(-1).stringParameters['selection.edgeId'],reference);
  }
});

test('a disappearing Boolean hole edge cannot redirect a downstream Fillet to another edge',async()=>{
  const id='disappearing_selection',box=await cad(id,'primitive.box',{width:100,depth:100,height:20});
  const tool=await cad(id,'primitive.cylinder',{radius:5,height:30,x:25,y:25,z:-5});
  const cut=await cad(id,'boolean.cut',{}, {targetBody:box.bodyId,toolBody:tool.bodyId});
  const rim=await choose(id,cut,'edge',value=>value.curveType==='circle'&&near(value.centroid[2],20));
  const detail=await cad(id,'detail.fillet',{radius:1},{bodyId:box.bodyId,edgeId:rim});
  const before=await cad(id,'document.summary');const failed=await raw(id,'feature.update',{x:200},{featureId:tool.features.at(-1).id});
  assert.equal(failed.ok,false);assert.equal(failed.code,'FEATURE_SELECTION_UNRESOLVED',JSON.stringify(failed));
  const after=await cad(id,'document.summary');assert.equal(after.revision,before.revision);assert.deepEqual(after.entityIdentities,before.entityIdentities);assert.deepEqual(after.features,before.features);
  assert.equal(after.features.at(-1).id,detail.features.at(-1).id);assert.equal((await cad(id,'geometry.check',{}, {bodyId:box.bodyId})).valid,true);
});

test('Shell keeps its top opening after the source is resized and relocated',async()=>{
  const id='shell_selection',base=await cad(id,'primitive.box',{width:30,depth:30,height:30});
  const face=await choose(id,base,'face',value=>near(value.centroid[2],30));
  const shell=await cad(id,'detail.shell',{thickness:2,inward:true},{bodyId:base.bodyId,faceId:face});const reference=shell.features.at(-1).stringParameters['selection.faceId'];
  const changed=await cad(id,'feature.update',{width:60,depth:40,height:50,x:1000,y:200,z:100},{featureId:base.features[0].id});
  assert.equal(changed.features.at(-1).stringParameters['selection.faceId'],reference);
  const volume=await cad(id,'geometry.measure',{}, {bodyId:base.bodyId,selectionType:'body'});assert.ok(near(volume.volume,60*40*50-56*36*48),JSON.stringify(volume));
});

test('Thicken, Sweep, Pipe and Revolve keep their selected source Face when its dimensions change',async()=>{
  for(const operation of ['detail.thicken','detail.sweep','detail.pipe','detail.revolve']){
    const id=operation.replace('.','_')+'_selection';const revolve=operation==='detail.revolve';
    const base=await cad(id,'surface.rectangle',{width:20,height:10,x:revolve?10:0});
    const parameters=operation==='detail.thicken'?{thickness:2}:revolve?{angleDegrees:360,originX:0,originY:0,originZ:0,axisX:0,axisY:1,axisZ:0}:{pathX:0,pathY:0,pathZ:10};
    const created=await cad(id,operation,parameters,{bodyId:base.bodyId,faceId:base.triangleFaceIds[0]});const feature=created.features.at(-1),reference=feature.stringParameters['selection.faceId'];assert.equal(JSON.parse(reference).kind,'face');
    const changed=await cad(id,'feature.update',{width:revolve?8:40,height:revolve?12:30,x:revolve?20:1000},{featureId:base.features[0].id});assert.equal(changed.features.at(-1).stringParameters['selection.faceId'],reference);
    const result=await cad(id,'geometry.measure',{}, {bodyId:feature.outputBodies[0],selectionType:'body'});
    const expected=operation==='detail.thicken'?2400:revolve?Math.PI*(24*24-16*16)*12:12000;assert.ok(near(result.volume,expected),operation+': '+JSON.stringify({volume:result.volume,expected}));
  }
});

test('unchanged legacy STEP geometry permits parameter edits using its exact input fingerprint',async()=>{
  const sourceId='step_selector_source';await cad(sourceId,'primitive.box',{width:30,depth:30,height:30});
  const exported=await (await fetch(api+`/documents/${sourceId}/exports/step`,{method:'POST'})).json();assert.equal(exported.ok,true);
  const bytes=Buffer.from(await (await fetch('http://127.0.0.1:8868'+exported.downloadUrl)).arrayBuffer());
  const id='step_selector_import',modern=id+'_modern',imported=await fetch(api+`/documents/${modern}/imports/step`,{method:'POST',headers:{'Content-Type':'application/step'},body:bytes});assert.equal(imported.status,200,await imported.text());await openLegacyStepProject(api,modern,id);
  const state=await cad(id,'document.summary'),bodyId=state.activeBodyId;
  const presentation=await cad(id,'body.presentation',{}, {bodyId});
  const fillet=await cad(id,'detail.fillet',{radius:2},{bodyId,edgeId:presentation.edges[0].edgeId});
  const selector=JSON.parse(fillet.features.at(-1).stringParameters['selection.edgeId']);assert.equal(selector.origins.length,0,'STEP fixture must not accidentally use constructor naming');
  const updated=await cad(id,'feature.update',{radius:3},{featureId:fillet.features.at(-1).id});assert.equal(updated.features.at(-1).numberParameters.radius,3);
  assert.equal((await cad(id,'geometry.check',{}, {bodyId})).valid,true);
});

test('Draft keeps the selected wall after source dimensions change',async()=>{
  const id='draft_input_selection',base=await cad(id,'primitive.box',{width:30,depth:30,height:30});
  const selected=await choose(id,base,'face',value=>near(value.centroid[0],0));
  const draft=await cad(id,'detail.draft',{angleDegrees:5,neutralOriginX:0,neutralOriginY:0,neutralOriginZ:0,neutralNormalX:0,neutralNormalY:0,neutralNormalZ:1,directionX:0,directionY:0,directionZ:1},{bodyId:base.bodyId,faceId:selected});
  const reference=draft.features.at(-1).stringParameters['selection.faceId'];
  const updated=await cad(id,'feature.update',{width:50,depth:40},{featureId:base.features[0].id});assert.equal(updated.features.at(-1).stringParameters['selection.faceId'],reference);
  assert.ok(await choose(id,updated,'face',value=>Math.abs(value.centroid[0])<3&&near(value.centroid[1],20)&&Math.abs(value.centroid[2]-15)<.1));
  assert.equal((await cad(id,'geometry.check',{}, {bodyId:base.bodyId})).valid,true);
});
