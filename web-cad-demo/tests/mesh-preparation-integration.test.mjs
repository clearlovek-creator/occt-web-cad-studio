import { ObservedCommandClient } from "./helpers/observed-command-client.mjs";
const observedClient=new ObservedCommandClient();
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root=path.resolve(import.meta.dirname,'..'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-preparation-中文-')),api='http://127.0.0.1:8871/api';
let gateway;const revisions=new Map();
async function start(){gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8871',GEOMETRY_DATA_DIR:directory},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let errors='';const timer=setTimeout(()=>reject(new Error('startup timeout '+errors)),20000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>errors+=chunk);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){if(!gateway)return;const child=gateway;gateway=null;const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}
before(start);after(async()=>{await stop();fs.rmSync(directory,{recursive:true,force:true});});
async function post(url,body={}){const response=await fetch(api+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(observedClient.prepare(body, "", url))});return {status:response.status,...observedClient.observe(await response.json(),body.documentId)};}
async function cad(id,operation,parameters={},inputs={}){const result=await post('/commands',{documentId:id,operation,parameters,inputs,baseRevision:revisions.get(id)||0});assert.equal(result.ok,true,JSON.stringify(result));if(Number.isSafeInteger(result.revision))revisions.set(id,result.revision);return result;}
const get=async url=>(await fetch(api+url)).json();
const job=async(id,options={})=>post(`/documents/${id}/mesh/jobs`,options);

test('repair preview is a persistent read-only task and its exact certified BREP can be used for meshing',async()=>{
  const id='preview_reuse',box=await cad(id,'primitive.box',{width:12,depth:10,height:8});await cad(id,'primitive.box',{width:10,depth:10,height:8,x:8});
  const before=await cad(id,'document.summary'),preview=await job(id,{kind:'preparation'});
  assert.equal(preview.ok,true,JSON.stringify(preview));assert.equal(preview.meshJob.kind,'preparation');assert.equal(preview.mesh,undefined);assert.equal(preview.preparation.diagnostics.status,'ready');assert.ok(preview.preparation.preview.positions.length>0);assert.equal(preview.preparation.diagnostics.deepCheck,true);
  const after=await cad(id,'document.summary');for(const key of ['revision','bodyCount','featureCount','features','bodyMetadata','entityIdentities','variables','materials','coordinateSystems'])assert.deepEqual(after[key],before[key],key+' must not change during preparation');
  const key=preview.meshJob.jobId,recordPath=path.join(directory,'mesh-jobs',id,key),brep=fs.readFileSync(path.join(recordPath,'prepared.brep'));
  assert.equal((await post(`/mesh/jobs/${key}/visibility`,{visible:true})).code,'MESH_PREPARATION_NOT_MESH');
  await cad(id,'body.update',{name:'Renamed only'},{bodyId:box.bodyId});
  const meshed=await job(id,{preparationJobId:key,repairMode:'conservative'});assert.equal(meshed.ok,true,JSON.stringify(meshed));assert.equal(meshed.meshJob.preparationJobId,key);assert.equal(meshed.meshJob.revision,preview.meshJob.revision);assert.equal(meshed.meshJob.freshness.status,'current');assert.ok(meshed.mesh.quality.tetraCount>0);assert.equal(meshed.mesh.boundaryMapping.complete,true);
  assert.deepEqual(fs.readFileSync(path.join(recordPath,'prepared.brep')),brep);
  await stop();await start();const recovered=await get(`/mesh/jobs/${key}`);assert.equal(recovered.ok,true);assert.equal(recovered.meshJob.recovered,true);assert.deepEqual(recovered.preparation,preview.preparation);
  const second=await job(id,{preparationJobId:key,repairMode:'conservative'});assert.equal(second.ok,true,JSON.stringify(second));assert.equal(second.meshJob.freshness.status,'current');
});

test('preview reuse rejects changed geometry, the wrong repair mode and a damaged snapshot',async()=>{
  const id='preview_guards',box=await cad(id,'primitive.box',{width:10,depth:10,height:10}),preview=await job(id,{kind:'preparation',deepCheck:false});assert.equal(preview.ok,true,JSON.stringify(preview));
  assert.equal((await job(id,{preparationJobId:preview.meshJob.jobId,repairMode:'aggressive'})).code,'MESH_PREPARATION_REFERENCE_INVALID');
  await cad(id,'feature.update',{height:12},{featureId:box.features[0].id});assert.equal((await job(id,{preparationJobId:preview.meshJob.jobId})).code,'MESH_PREPARATION_STALE');
  await cad(id,'document.undo');fs.appendFileSync(path.join(directory,'mesh-jobs',id,preview.meshJob.jobId,'prepared.brep'),'corrupted');
  const rejected=await job(id,{preparationJobId:preview.meshJob.jobId});assert.equal(rejected.ok,false);assert.match(rejected.error,/校验失败/);
  const list=await get(`/documents/${id}/mesh/jobs`);assert.equal(list.jobs.find(item=>item.jobId===preview.meshJob.jobId).state,'failed');
});

test('a blocked sheet-only preparation retains its diagnostic report across reload and service restart',async()=>{
  const id='preview_blocked';await cad(id,'surface.rectangle',{width:10,height:10});
  const result=await job(id,{kind:'preparation'});assert.equal(result.ok,false);assert.equal(result.meshJob.state,'failed');assert.equal(result.meshJob.preparationSummary.reportAvailable,true);
  const report=await get(`/mesh/jobs/${result.meshJob.jobId}`);assert.equal(report.ok,true);assert.equal(report.preparation.diagnostics.status,'blocked');assert.equal(report.preparation.diagnostics.bodies[0].before.openBoundaryEdgeCount,4);assert.equal(report.preparation.preview,null);assert.equal(report.mesh,undefined);
  await stop();await start();const recovered=await get(`/mesh/jobs/${result.meshJob.jobId}`);assert.deepEqual(recovered.preparation,report.preparation);assert.equal(recovered.meshJob.state,'failed');
});

test('full-project preparation reports unsupported section wires instead of silently dropping their geometry',async()=>{
  const id='preview_wire',a=await cad(id,'primitive.box',{width:10,depth:10,height:10}),b=await cad(id,'primitive.box',{width:10,depth:10,height:10,x:5,y:3,z:2});
  await cad(id,'boolean.section',{}, {targetBody:a.bodyId,toolBody:b.bodyId});
  const before=await cad(id,'document.summary');assert.equal(before.bodyMetadata[0].kind,'wire');
  const result=await job(id,{kind:'preparation',deepCheck:false});assert.equal(result.ok,false);assert.equal(result.code,'MESH_UNSUPPORTED_FREE_TOPOLOGY');
  const report=await get(`/mesh/jobs/${result.meshJob.jobId}`);assert.equal(report.preparation.diagnostics.bodies[0].kind,'wire');assert.equal(report.preparation.diagnostics.status,'blocked');assert.equal(report.mesh,undefined);
  const after=await cad(id,'document.summary');for(const key of ['revision','features','bodyMetadata','entityIdentities'])assert.deepEqual(after[key],before[key]);
});
