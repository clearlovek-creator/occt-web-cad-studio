import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-project-ref-中文-')),api='http://127.0.0.1:8876/api';let gateway;const states=new Map();
before(async()=>{gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8876',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let diagnostics='';const timer=setTimeout(()=>reject(new Error('Gateway timeout '+diagnostics)),20000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>diagnostics+=chunk);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});});
after(async()=>{if(gateway){const ended=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await ended;}assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function raw(id,operation,parameters={},inputs={},options){const state=states.get(id);const response=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{}),...(options?{options}:{})})});const result=await response.json();if(result.ok&&!options?.preview)states.set(id,result);return result;}
async function cad(...args){const result=await raw(...args);assert.equal(result.ok,true,JSON.stringify(result));return result;}
async function fixture(id,mode){
  if(mode==='variable'){
    await cad(id,'variable.set',{name:'holeX',type:'length',expression:'25 mm'});
    await cad(id,'variable.set',{name:'doubleX',type:'length',expression:'holeX * 2'});
    await cad(id,'material.set',{name:'Probe'});await cad(id,'material.property.set',{materialName:'Probe',key:'offset',type:'expression',expression:'holeX * 2',dimension:'length'});
  }
  if(mode==='coordinate')await cad(id,'coordinate.set',{id:'hole_frame',name:'Hole Frame',origin:[25,25,-5],xAxis:[1,0,0],yAxis:[0,1,0]});
  const box=await cad(id,'primitive.box',{width:100,depth:100,height:20});
  const tool=await cad(id,'primitive.cylinder',mode==='coordinate'?{radius:5,height:30,coordinateSystemId:'hole_frame'}:{radius:5,height:30,x:mode==='variable'?'holeX':25,y:25,z:-5});
  const cut=await cad(id,'boolean.cut',{}, {targetBody:box.bodyId,toolBody:tool.bodyId});let rim;
  for(const edge of cut.edges){const m=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'edge',selectionId:edge.edgeId});if(m.curveType==='circle'&&Math.abs(m.centroid[2]-20)<1e-7){rim=edge.edgeId;break;}}
  const detail=await cad(id,'detail.fillet',{radius:1},{bodyId:box.bodyId,edgeId:rim});return {bodyId:box.bodyId,cut:cut.features.at(-1).id,featureId:detail.features.at(-1).id};
}
function selection(id,response){const p=response.inputPreview,edge=p.presentation.edges.find(edge=>edge.points.every((value,i)=>i%3===2||Math.abs(value)<1e-7));assert.ok(edge);return {documentId:id,featureId:p.featureId,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:p.kind,inputFingerprint:p.inputFingerprint,index:Number(edge.edgeId.split('-').at(-1))};}
function sameProject(before,after){for(const key of ['revision','stateToken','stateSequence','features','variables','materials','coordinateSystems','bodyMetadata','entityIdentities'])assert.deepEqual(after[key],before[key],key+' changed before commit');}

for(const mode of ['variable','coordinate'])test(mode+' changes and repaired input commit once, with side-effect-free inspection and Undo/Redo',async()=>{
  const id=mode+'_proposal',f=await fixture(id,mode),before=await cad(id,'document.view');
  const operation=mode==='variable'?'variable.set':'coordinate.set',parameters=mode==='variable'?{name:'holeX',type:'length',expression:'200 mm'}:{id:'hole_frame',name:'Hole Frame',origin:[200,25,-5],xAxis:[1,0,0],yAxis:[0,1,0]};
  const failed=await raw(id,operation,parameters);assert.equal(failed.code,'FEATURE_SELECTION_UNRESOLVED');assert.equal(failed.details.featureId,f.featureId);sameProject(before,await cad(id,'document.view'));
  const response=await cad(id,'feature.input.preview',{proposal:{operation,parameters}},{featureId:f.featureId});assert.equal(response.proposalOperation,operation);assert.equal(response.inputPreview.presentation.stats.edgeCount,12);sameProject(before,await cad(id,'document.view'));
  const changed={...parameters,selectionEdits:[selection(id,response)]};
  const invalid=await raw(id,'feature.input.preview',{proposal:{operation,parameters}},{featureId:'missing'});assert.equal(invalid.ok,false);sameProject(before,await cad(id,'document.view'));
  await cad(id,operation,changed,{}, {preview:true});sameProject(before,await cad(id,'document.view'));
  const result=await cad(id,operation,changed);assert.equal(result.revision,before.revision+1);assert.notEqual(result.features.at(-1).stringParameters['selection.edgeId'],before.features.at(-1).stringParameters['selection.edgeId']);
  if(mode==='variable'){assert.equal(result.variables.find(v=>v.name==='holeX').value,200);assert.equal(result.variables.find(v=>v.name==='doubleX').value,400);}else assert.deepEqual(result.coordinateSystems.find(c=>c.id==='hole_frame').origin,[200,25,-5]);
  const measured=await cad(id,'geometry.measure',{}, {bodyId:f.bodyId});assert.ok(Math.abs(measured.volume-(200000-(1-Math.PI/4)*20))<1e-5);
  const undo=await cad(id,'document.undo');for(const key of ['features','variables','materials','coordinateSystems'])assert.deepEqual(undo[key],before[key]);const redo=await cad(id,'document.redo');assert.deepEqual(redo.features,result.features);
});

test('suppress, restore and delete can repair downstream inputs atomically without applying lifecycle state during inspection',async()=>{
  for(const action of ['suppress','restore','delete']){
    const id='lifecycle_'+action,f=await fixture(id);
    if(action==='restore'){await cad(id,'feature.suppress',{}, {featureId:f.featureId});await cad(id,'feature.suppress',{}, {featureId:f.cut});}
    const featureId=action==='restore'?f.featureId:f.cut,operation='feature.'+action,before=await cad(id,'document.view');
    const failed=await raw(id,operation,{}, {featureId});assert.equal(failed.code,'FEATURE_SELECTION_UNRESOLVED',JSON.stringify(failed));
    const response=await cad(id,'feature.input.preview',{proposal:{operation,inputs:{featureId},parameters:{}}},{featureId:f.featureId});assert.equal(response.proposalOperation,operation);assert.equal(response.inputPreview.presentation.stats.edgeCount,12);sameProject(before,await cad(id,'document.view'));
    const result=await cad(id,operation,{selectionEdits:[selection(id,response)]},{featureId});assert.equal(result.revision,before.revision+1);assert.equal(result.features.find(f=>f.id===featureId)?.state,action==='delete'?undefined:action==='suppress'?'suppressed':'valid');
    const undo=await cad(id,'document.undo');assert.deepEqual(undo.features,before.features);
  }
});

test('integer counts and dimensionless direction expressions retain their units throughout variable-driven replay',async()=>{
  const id='parameter_dimensions';await cad(id,'variable.set',{name:'N',type:'integer',expression:'2'});await cad(id,'variable.set',{name:'DX',type:'dimensionless',expression:'1'});
  const box=await cad(id,'primitive.box',{width:'10 mm',depth:10,height:10});const pattern=await cad(id,'pattern.linear',{count:'N',spacing:'40 mm',directionX:'DX',directionY:0,directionZ:0},{bodyId:box.bodyId});assert.equal(pattern.features.at(-1).stringParameters['expr.count'],'N');assert.equal(pattern.features.at(-1).stringParameters['expr.directionX'],'DX');
  const increased=await cad(id,'variable.set',{name:'N',type:'integer',expression:'3'});assert.equal(increased.bodyCount,3);
  const direction=await cad(id,'variable.set',{name:'DX',type:'dimensionless',expression:'2'});assert.equal(direction.bodyCount,3);
  const invalid=await raw(id,'variable.set',{name:'N',type:'integer',expression:'2.5'});assert.equal(invalid.ok,false);sameProject(direction,await cad(id,'document.view'));
});

test('a read-only input request cannot stage arbitrary document mutations',async()=>{
  const id='proposal_whitelist',f=await fixture(id),before=await cad(id,'document.view');
  for(const operation of ['body.delete','document.new','step.import','feature.input.preview']){
    const result=await raw(id,'feature.input.preview',{proposal:{operation,inputs:{bodyId:f.bodyId},parameters:{}}},{featureId:f.featureId});assert.equal(result.code,'INPUT_PROPOSAL_UNSUPPORTED');sameProject(before,await cad(id,'document.view'));
  }
  const missing=await raw(id,'feature.input.preview',{proposal:{operation:'feature.restore',parameters:{}}},{featureId:f.featureId});assert.equal(missing.code,'INVALID_INPUT_PROPOSAL');sameProject(before,await cad(id,'document.view'));
});

test('variable-driven pattern resizing replays a source consumed by a later Boolean instead of requiring a live source Body',async()=>{
  const id='consumed_pattern_source';await cad(id,'variable.set',{name:'N',type:'integer',expression:'2'});
  const source=await cad(id,'primitive.box',{width:'10 mm',depth:10,height:10});await cad(id,'pattern.linear',{count:'N',spacing:40,directionX:1,directionY:0,directionZ:0},{bodyId:source.bodyId});
  const target=await cad(id,'primitive.box',{width:100,depth:20,height:20,x:-5,y:-5,z:-5});const cut=await cad(id,'boolean.cut',{}, {targetBody:target.bodyId,toolBody:source.bodyId});assert.equal(cut.bodyCount,2);assert.equal(cut.bodyMetadata.some(body=>body.bodyId===source.bodyId),false);
  const updated=await cad(id,'variable.set',{name:'N',type:'integer',expression:'3'});assert.equal(updated.bodyCount,3);assert.equal(updated.features.find(f=>f.type==='pattern.linear').outputBodies.length,3);
  const undone=await cad(id,'document.undo');assert.deepEqual(undone.features,cut.features);assert.equal(undone.bodyCount,2);
});

test('rectangular counts enforce their own bounds and circular angle expressions preserve angle units on replay',async()=>{
  const id='rectangular_dimensions';await cad(id,'variable.set',{name:'NX',type:'integer',expression:'2'});const box=await cad(id,'primitive.box',{width:'10 mm',depth:10,height:10});
  await cad(id,'pattern.rectangular',{countX:'NX',countY:2,spacingX:40,spacingY:40,directionX:1,directionY:0,directionZ:0,direction2X:0,direction2Y:1,direction2Z:0},{bodyId:box.bodyId});
  const changed=await cad(id,'variable.set',{name:'NX',type:'integer',expression:'3'});assert.equal(changed.bodyCount,6);const invalid=await raw(id,'variable.set',{name:'NX',type:'integer',expression:'21'});assert.equal(invalid.code,'INVALID_PARAMETER');sameProject(changed,await cad(id,'document.view'));
  const circular='circular_dimensions';await cad(circular,'variable.set',{name:'A',type:'angle',expression:'90 deg'});const source=await cad(circular,'primitive.box',{width:'10 mm',depth:10,height:10,x:20});
  const pattern=await cad(circular,'pattern.circular',{count:2,angleDegrees:'A',axisX:0,axisY:0,axisZ:1,originX:0,originY:0,originZ:0},{bodyId:source.bodyId});assert.equal(pattern.features.at(-1).stringParameters['expr.angleDegrees'],'A');
  const rotated=await cad(circular,'variable.set',{name:'A',type:'angle',expression:'180 deg'}),other=rotated.features.at(-1).outputBodies[1],measured=await cad(circular,'geometry.measure',{}, {bodyId:other});
  const centroid=rotated.bodyMetadata.find(body=>body.bodyId===other).centroid;assert.ok(Math.abs(measured.volume-1000)<1e-6);
  assert.ok(Math.abs(centroid[0]+25)<1e-6);assert.ok(Math.abs(centroid[1]+5)<1e-6);
});

test('suppressed patterns defer output allocation until restore while retaining their variable expressions',async()=>{
  const id='suppressed_pattern_variables';await cad(id,'variable.set',{name:'N',type:'integer',expression:'2'});const box=await cad(id,'primitive.box',{width:'10 mm',depth:10,height:10});
  const result=await cad(id,'pattern.linear',{count:'N',spacing:40,directionX:1,directionY:0,directionZ:0},{bodyId:box.bodyId}),featureId=result.features.at(-1).id;
  await cad(id,'feature.suppress',{}, {featureId});const changed=await cad(id,'variable.set',{name:'N',type:'integer',expression:'4'});assert.equal(changed.bodyCount,1);assert.deepEqual(changed.features.at(-1).outputBodies,result.features.at(-1).outputBodies);
  const restored=await cad(id,'feature.restore',{}, {featureId});assert.equal(restored.bodyCount,4);assert.equal(restored.features.at(-1).stringParameters['expr.count'],'N');
});
