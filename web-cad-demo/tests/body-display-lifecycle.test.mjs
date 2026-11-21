import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';

const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-body-display-'));
let gateway;
before(async()=>{gateway=await gatedGeometryGateway(data,{GEOMETRY_WORKER_TIMEOUT_MS:'60000'});});
after(async()=>{
  if(gateway)assert.equal(await gateway.stop(),0);
  if(process.env.CAD_KEEP_DISPLAY_TEST_DATA==='1')console.log('Retained display fixture: '+data);
  else{assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-body-display-/);fs.rmSync(data,{recursive:true,force:true});}
});
const cad=(id,operation,parameters={},inputs={})=>gateway.cad(operation,parameters,inputs,id);
const body=(result,id)=>{const value=result.bodyMetadata.find(row=>row.bodyId===id);assert.ok(value,'Missing Body '+id);return value;};
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-12,`Body opacity ${actual} must preserve ${expected}`);
async function box(id,opacity=.35){const created=await cad(id,'primitive.box',{width:12,depth:10,height:8});await cad(id,'body.update',{opacity,name:'Display fixture',color:'#336699'},{bodyId:created.bodyId});return created;}
async function portable(id,copy){const response=await fetch(gateway.api+'/documents/'+id+'/project/save',{method:'POST'});assert.equal(response.status,200);const opened=await fetch(gateway.api+'/documents/'+copy+'/project/open',{method:'POST',headers:{'content-type':'application/vnd.webcad.project'},body:Buffer.from(await response.arrayBuffer())});assert.equal(opened.status,200,await opened.text());return cad(copy,'document.summary');}

test('Body opacity survives a portable project save and opening, not merely the update reply',async()=>{
  const id='display_portable',created=await box(id);const opened=await portable(id,id+'_copy');near(body(opened,created.bodyId).opacity,.35);assert.equal(body(opened,created.bodyId).color,'#336699');
});
test('Undo and Redo preserve the prior opacity while changing other Body display fields',async()=>{
  const id='display_undo',created=await box(id);await cad(id,'body.update',{color:'#775533'},{bodyId:created.bodyId});const undone=await cad(id,'document.undo');near(body(undone,created.bodyId).opacity,.35);assert.equal(body(undone,created.bodyId).color,'#336699');const redone=await cad(id,'document.redo');near(body(redone,created.bodyId).opacity,.35);assert.equal(body(redone,created.bodyId).color,'#775533');
});
test('a suppressed Pattern retains per-instance display values through portable opening and restore',async()=>{
  const id='display_pattern_restore',created=await box(id),pattern=await cad(id,'pattern.linear',{count:2,spacing:20,directionX:1,directionY:0,directionZ:0},{bodyId:created.bodyId}),featureId=pattern.features.at(-1).id,copyId=pattern.features.at(-1).outputBodies.at(-1);
  await cad(id,'body.update',{opacity:.54,name:'Hidden patterned part',visible:false,color:'#882244'},{bodyId:copyId});await cad(id,'feature.suppress',{}, {featureId});await portable(id,id+'_copy');const restored=await cad(id+'_copy','feature.restore',{}, {featureId}),part=body(restored,copyId);near(part.opacity,.54);assert.equal(part.visible,false);assert.equal(part.color,'#882244');assert.equal(part.name,'Hidden patterned part');
});
test('Boolean suppression and deletion restore each consumed input opacity independently',async()=>{
  const id='display_boolean',target=await box(id,.25),tool=await cad(id,'primitive.box',{width:4,depth:12,height:10,x:4,y:-1,z:-1});await cad(id,'body.update',{opacity:.65},{bodyId:tool.bodyId});const cut=await cad(id,'boolean.cut',{}, {targetBody:target.bodyId,toolBody:tool.bodyId}),featureId=cut.features.at(-1).id;
  const suppressed=await cad(id,'feature.suppress',{}, {featureId});near(body(suppressed,target.bodyId).opacity,.25);near(body(suppressed,tool.bodyId).opacity,.65);await cad(id,'feature.restore',{}, {featureId});const deleted=await cad(id,'feature.delete',{}, {featureId});near(body(deleted,target.bodyId).opacity,.25);near(body(deleted,tool.bodyId).opacity,.65);
});
test('new Pattern slots inherit source opacity without overwriting an existing instance override',async()=>{
  const id='display_pattern_resize',created=await box(id),pattern=await cad(id,'pattern.linear',{count:2,spacing:20,directionX:1,directionY:0,directionZ:0},{bodyId:created.bodyId}),featureId=pattern.features.at(-1).id,copyId=pattern.features.at(-1).outputBodies.at(-1);await cad(id,'body.update',{opacity:.7},{bodyId:copyId});const expanded=await cad(id,'feature.update',{count:3},{featureId});for(const row of expanded.bodyMetadata)near(row.opacity,row.bodyId===copyId?.7:.35);
});
test('an independent geometric copy inherits source opacity and retains it after upstream editing',async()=>{
  const id='display_copy',created=await box(id),copied=await cad(id,'transform.copy',{dx:30},{bodyId:created.bodyId});near(body(copied,copied.bodyId).opacity,.35);const updated=await cad(id,'feature.update',{width:15},{featureId:created.features.at(-1).id});near(body(updated,copied.bodyId).opacity,.35);
});
test('Body opacity keeps double precision in immediate and persisted model responses',async()=>{
  const id='display_precision',value=.3512345678901234,created=await box(id,value);near(body(await cad(id,'document.summary'),created.bodyId).opacity,value);near(body(await portable(id,id+'_copy'),created.bodyId).opacity,value);
});
test('supported opacity endpoints survive native project persistence and invalid updates remain atomic',async()=>{
  for(const value of [.05,1]){const id='display_endpoint_'+String(value).replace('.','_'),created=await box(id,value);near(body(await portable(id,id+'_copy'),created.bodyId).opacity,value);const before=await cad(id,'document.summary'),invalid=await gateway.post('/commands',{documentId:id,operation:'body.update',baseRevision:before.revision,baseStateToken:before.stateToken,inputs:{bodyId:created.bodyId},parameters:{name:'Must not commit',opacity:1.2}});assert.equal(invalid.status,400);assert.equal(invalid.value.code,'INVALID_BODY_OPACITY');const after=await cad(id,'document.summary');assert.equal(after.stateToken,before.stateToken);assert.equal(body(after,created.bodyId).name,'Display fixture');near(body(after,created.bodyId).opacity,value);}
});
test('a real Gateway restart reloads the saved Body opacity rather than resetting it',async()=>{
  const id='display_restart',created=await box(id,.42),before=await cad(id,'document.summary');assert.equal(await gateway.stop(),0);gateway=await gatedGeometryGateway(data,{GEOMETRY_WORKER_TIMEOUT_MS:'60000'});const restored=await cad(id,'document.summary');assert.equal(restored.stateToken,before.stateToken);near(body(restored,created.bodyId).opacity,.42);
});
