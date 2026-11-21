import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-reference-repair-中文-')),api='http://127.0.0.1:8874/api';let gateway;
before(async()=>{gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8874',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let stderr='';const timer=setTimeout(()=>reject(new Error('startup timeout '+stderr)),20000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>stderr+=chunk);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});});
after(async()=>{if(gateway){const end=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await end;}assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
const states=new Map();
async function raw(id,operation,parameters={},inputs={},options){const state=states.get(id);const response=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{}),...(options?{options}:{})})});const result=await response.json();if(result.ok && !options?.preview)states.set(id,result);return result;}
async function cad(...args){const result=await raw(...args);assert.equal(result.ok,true,JSON.stringify(result));return result;}
const index=id=>Number(id.split('-').at(-1));
function repair(id,preview,selectedIndex){return {documentId:id,featureId:preview.featureId,sourceBodyId:preview.sourceBodyId,sourceBodyIdentity:preview.sourceBodyIdentity,sourceFeatureId:preview.sourceFeatureId,kind:preview.kind,inputFingerprint:preview.inputFingerprint,index:selectedIndex};}
function faceAtZ(p,z){for(let triangle=0;triangle<p.triangleFaceIds.length;triangle++){const vertices=p.indices.slice(triangle*3,triangle*3+3);if(vertices.every(vertex=>Math.abs(p.positions[vertex*3+2]-z)<1e-7))return index(p.triangleFaceIds[triangle]);}throw new Error('No face at Z='+z);}

test('a vanished hole edge is repaired against the proposed pre-Fillet input, atomically with its upstream edit',async()=>{
  const id='edge_repair',box=await cad(id,'primitive.box',{width:100,depth:100,height:20}),tool=await cad(id,'primitive.cylinder',{radius:5,height:30,x:25,y:25,z:-5});
  const toolFeature=tool.features.at(-1).id,cut=await cad(id,'boolean.cut',{}, {targetBody:box.bodyId,toolBody:tool.bodyId});
  let rim;for(const edge of cut.edges){const measure=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'edge',selectionId:edge.edgeId});if(measure.curveType==='circle' && Math.abs(measure.centroid[2]-20)<1e-7){rim=edge.edgeId;break;}}
  assert.ok(rim);const fillet=await cad(id,'detail.fillet',{radius:1},{bodyId:box.bodyId,edgeId:rim}),feature=fillet.features.at(-1).id,before=await cad(id,'document.view');
  const failed=await raw(id,'feature.update',{x:200},{featureId:toolFeature});assert.equal(failed.code,'FEATURE_SELECTION_UNRESOLVED');assert.equal(failed.details.featureId,feature);assert.equal(failed.details.selectionKind,'edge');
  const inspected=await cad(id,'feature.input.preview',{changes:{x:200}},{featureId:feature,editedFeatureId:toolFeature}),preview=inspected.inputPreview;
  assert.equal(inspected.features,undefined,'Inspection must not look like a live model response');assert.equal(preview.selectionState,'unresolved');assert.equal(preview.kind,'edge');assert.equal(preview.presentation.stats.edgeCount,12);assert.match(preview.inputFingerprint,/^[a-f0-9]{64}$/);
  const repeated=await cad(id,'feature.input.preview',{changes:{x:200}},{featureId:feature,editedFeatureId:toolFeature});assert.equal(repeated.inputPreview.inputFingerprint,preview.inputFingerprint);
  const unchanged=await cad(id,'document.view');for(const key of ['revision','stateToken','stateSequence','features','entityIdentities'])assert.deepEqual(unchanged[key],before[key],key+' changed during inspection');
  const selected=preview.presentation.edges.find(edge=>{const points=edge.points;return points.length>3 && points.every((value,i)=>i%3===2 || Math.abs(value)<1e-7);});assert.ok(selected);const edit=repair(id,preview,index(selected.edgeId));
  for(const tamper of [{inputFingerprint:'0'.repeat(64)},{sourceBodyIdentity:'0'.repeat(32)},{documentId:'foreign'}]){
    const rejected=await raw(id,'feature.update',{x:200,selectionEdits:[{...edit,...tamper}]},{featureId:toolFeature});assert.equal(rejected.code,'STALE_SELECTION_REPAIR',JSON.stringify(rejected));assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  }
  const proposed=await cad(id,'feature.update',{x:200,selectionEdits:[edit]},{featureId:toolFeature},{preview:true});assert.equal(proposed.preview.state,'preview');assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  const committed=await cad(id,'feature.update',{x:200,selectionEdits:[edit]},{featureId:toolFeature});assert.equal(committed.revision,before.revision+1);assert.notEqual(committed.features.at(-1).stringParameters['selection.edgeId'],before.features.at(-1).stringParameters['selection.edgeId']);
  const volume=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId});assert.ok(Math.abs(volume.volume-(200000-(1-Math.PI/4)*20))<1e-5,JSON.stringify(volume));
  const undo=await cad(id,'document.undo');assert.deepEqual(undo.features,before.features);const redo=await cad(id,'document.redo');assert.equal(redo.features.at(-1).stringParameters['selection.edgeId'],committed.features.at(-1).stringParameters['selection.edgeId']);
});

test('a Face input can be explicitly changed in historical context and persists across Undo/Redo',async()=>{
  const id='face_repair',box=await cad(id,'primitive.box',{width:30,depth:30,height:30});let top;
  for(const faceId of new Set(box.triangleFaceIds)){const m=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'face',selectionId:faceId});if(Math.abs(m.centroid[2]-30)<1e-7){top=faceId;break;}}
  const shell=await cad(id,'detail.shell',{thickness:2,inward:true},{bodyId:box.bodyId,faceId:top}),feature=shell.features.at(-1).id;
  const input=await cad(id,'feature.input.preview',{}, {featureId:feature});assert.equal(input.inputPreview.selectionState,'resolved');assert.equal(input.inputPreview.presentation.stats.faceCount,6);
  const edit=repair(id,input.inputPreview,faceAtZ(input.inputPreview.presentation,0));
  const changed=await cad(id,'feature.update',{selectionEdits:[edit]},{featureId:feature});assert.notEqual(changed.features.at(-1).stringParameters['selection.faceId'],shell.features.at(-1).stringParameters['selection.faceId']);
  let topArea=0;for(const faceId of new Set(changed.triangleFaceIds)){const m=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'face',selectionId:faceId});if(Math.abs(m.centroid[2]-30)<1e-7)topArea+=m.area;}
  assert.ok(Math.abs(topArea-900)<1e-6,'The opening must move to the bottom, not an index in the final shell');
  await cad(id,'document.undo');const restored=await cad(id,'document.redo');assert.equal(restored.features.at(-1).stringParameters['selection.faceId'],changed.features.at(-1).stringParameters['selection.faceId']);
  const empty=await raw(id,'feature.input.preview',{}, {featureId:''});assert.equal(empty.ok,false);assert.equal((await cad(id,'document.view')).stateToken,restored.stateToken);
});

test('a proposed pattern expansion inspected before a downstream feature allocates no live Body IDs or identities',async()=>{
  const id='pattern_input_read',box=await cad(id,'primitive.box',{width:30,depth:30,height:30});
  const patterned=await cad(id,'pattern.linear',{count:2,spacing:50,directionX:1,directionY:0,directionZ:0},{bodyId:box.bodyId}),pattern=patterned.features.at(-1).id;
  const presentation=await cad(id,'body.presentation',{}, {bodyId:patterned.bodyId});
  const shell=await cad(id,'detail.shell',{thickness:2,inward:true},{bodyId:patterned.bodyId,faceId:presentation.triangleFaceIds[0]}),feature=shell.features.at(-1).id,before=await cad(id,'document.view');
  for(let pass=0;pass<3;pass++){
    const read=await cad(id,'feature.input.preview',{changes:{count:5}},{featureId:feature,editedFeatureId:pattern});assert.equal(read.inputPreview.presentation.stats.faceCount,6);
  }
  const after=await cad(id,'document.view');for(const key of ['stateToken','stateSequence','revision','features','bodyMetadata','entityIdentities'])assert.deepEqual(after[key],before[key],key+' changed during read-only pattern replay');
  assert.ok(Array.isArray(before.bodyMetadata));
  const next=await cad(id,'primitive.box',{width:10,depth:10,height:10,x:200});assert.equal(Number(next.bodyId.split('-').at(-1)),Math.max(...before.bodyMetadata.map(body=>Number(body.bodyId.split('-').at(-1))))+1,'Inspection must not consume IDs needed by the next real body');
});

test('several failed downstream references accumulate against one proposed edit and commit in one history event',async()=>{
  const id='two_reference_repairs',a=await cad(id,'primitive.box',{width:100,depth:100,height:20}),b=await cad(id,'primitive.box',{width:100,depth:100,height:20}),tool=await cad(id,'primitive.cylinder',{radius:5,height:30,x:25,y:25,z:-5}),editedFeature=tool.features.at(-1).id;
  const features=[];
  for(const target of [a.bodyId,b.bodyId]){
    const cut=await cad(id,'boolean.cut',{keepTool:true},{targetBody:target,toolBody:tool.bodyId});let rim;
    for(const edge of cut.edges){const m=await cad(id,'geometry.measure',{}, {bodyId:target,selectionType:'edge',selectionId:edge.edgeId});if(m.curveType==='circle'&&Math.abs(m.centroid[2]-20)<1e-7){rim=edge.edgeId;break;}}
    const detail=await cad(id,'detail.fillet',{radius:1},{bodyId:target,edgeId:rim});features.push(detail.features.at(-1).id);
  }
  const before=await cad(id,'document.view');const changes={x:200,selectionEdits:[]};
  for(const featureId of features){
    const failed=await raw(id,'feature.update',changes,{featureId:editedFeature},{preview:true});assert.equal(failed.code,'FEATURE_SELECTION_UNRESOLVED');assert.equal(failed.details.featureId,featureId);
    const input=await cad(id,'feature.input.preview',{changes},{featureId,editedFeatureId:editedFeature}),p=input.inputPreview;
    const edge=p.presentation.edges.find(edge=>edge.points.every((value,i)=>i%3===2||Math.abs(value)<1e-7));assert.ok(edge);changes.selectionEdits.push(repair(id,p,index(edge.edgeId)));
  }
  const checked=await cad(id,'feature.update',changes,{featureId:editedFeature},{preview:true});assert.equal(checked.bodyPresentations.length,3);assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
  const result=await cad(id,'feature.update',changes,{featureId:editedFeature});assert.equal(result.revision,before.revision+1);
  for(const featureId of features)assert.notEqual(result.features.find(f=>f.id===featureId).stringParameters['selection.edgeId'],before.features.find(f=>f.id===featureId).stringParameters['selection.edgeId']);
  const undo=await cad(id,'document.undo');assert.deepEqual(undo.features,before.features);
});
