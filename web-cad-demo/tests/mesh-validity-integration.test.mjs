import { ObservedCommandClient } from "./helpers/observed-command-client.mjs";
const observedClient=new ObservedCommandClient();
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {before,after,test} from 'node:test';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-validity-'));
const api='http://127.0.0.1:8869/api';let gateway;const revisions=new Map();
before(async()=>{gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8869',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('mesh test startup timeout')),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});});
after(async()=>{if(gateway){const exited=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await exited;}assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function post(url,body={}){const response=await fetch(api+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(observedClient.prepare(body, "", url))});return {status:response.status,...observedClient.observe(await response.json(),body.documentId)};}
async function cad(id,operation,parameters={},inputs={}){const result=await post('/commands',{documentId:id,operation,parameters,inputs,baseRevision:revisions.get(id)||0});assert.equal(result.ok,true,JSON.stringify(result));if(Number.isInteger(result.revision))revisions.set(id,result.revision);return result;}
async function job(id,options={}){const result=await post(`/documents/${id}/mesh/jobs`,options);assert.equal(result.ok,true,JSON.stringify(result));return result;}
const get=async id=>(await fetch(api+`/mesh/jobs/${id}`)).json();

test('metadata preserves a mesh; new Bodies and geometry edits invalidate it; exact Undo restores it',async()=>{
  const id='mesh_validity',box=await cad(id,'primitive.box',{width:10,depth:10,height:10}),mesh=await job(id),key=mesh.meshJob.jobId;
  assert.equal((await post(`/mesh/jobs/${key}/visibility`,{visible:true})).meshJob.visible,true);
  await cad(id,'body.update',{visible:false,name:'Renamed'}, {bodyId:box.bodyId});assert.equal((await get(key)).meshJob.freshness.status,'current');
  await cad(id,'primitive.box',{width:5,depth:5,height:5,x:30});let stale=(await get(key)).meshJob;assert.equal(stale.freshness.status,'stale');assert.equal(stale.visible,false);assert.equal(stale.requestedVisible,true);
  assert.equal((await post(`/mesh/jobs/${key}/visibility`,{visible:true})).status,409);
  await cad(id,'document.undo');assert.equal((await get(key)).meshJob.visible,true);
  const moved=await cad(id,'transform.translate',{dx:5,dy:0,dz:0},{bodyId:box.bodyId}),movedMesh=await job(id);
  await cad(id,'document.undo');const branch=await cad(id,'transform.translate',{dx:0,dy:5,dz:0},{bodyId:box.bodyId});assert.equal(branch.revision,moved.revision);
  assert.equal((await get(movedMesh.meshJob.jobId)).meshJob.freshness.status,'stale','Reused revision must not reactivate another topology state');
});

test('nested overlapping volumes keep every Body owner and shared-node conformity; exported MSH keeps Body groups',async()=>{
  const id='mesh_nested';await cad(id,'primitive.box',{width:20,depth:30,height:10});await cad(id,'primitive.box',{width:40,depth:30,height:10});
  const mesh=await job(id),groups=mesh.mesh.render.groups;
  assert.deepEqual([...new Set(groups.map(group=>group.bodyId))].sort(),['body-1','body-2']);assert.deepEqual(mesh.mesh.render.ownership.unmappedBodyIds,[]);
  const shared=groups.find(group=>groups.some(other=>other.bodyId!==group.bodyId&&other.solidId===group.solidId));assert.ok(shared,'Overlap must retain multiple source owners');
  const volume=id=>groups.filter(group=>group.bodyId===id).reduce((sum,group)=>sum+group.volume,0);
  assert.ok(Math.abs(volume('body-1')-6000)<1e-6,'Inner Body must not inherit outer-only fragments: '+JSON.stringify(groups.map(({bodyId,solidId,solidIndex,volume})=>({bodyId,solidId,solidIndex,volume}))));
  assert.ok(Math.abs(volume('body-2')-12000)<1e-6,'Outer Body must include its shared and exclusive fragments');
  assert.equal(new Set(groups.map(group=>group.groupId)).size,groups.length);
  assert.ok(mesh.mesh.conformity.interfaceCount>0);assert.equal(mesh.mesh.conformity.nonConformalCount,0);assert.ok(mesh.mesh.conformity.interfaces.every(item=>item.nodeCount>0&&item.missingNodeReferences===0));
  const bytes=fs.readFileSync(mesh.mesh.outputPath,'utf8');assert.match(bytes,/Body\/body-1/);assert.match(bytes,/Body\/body-2/);
});

test('touching Bodies share actual interface node references after per-source repair',async()=>{
  const id='mesh_contact';await cad(id,'primitive.box',{width:10,depth:10,height:10});await cad(id,'primitive.box',{width:10,depth:10,height:10,x:10});
  const mesh=await job(id);assert.equal(mesh.mesh.conformity.nonConformalCount,0);
  assert.ok(mesh.mesh.conformity.interfaces.some(item=>item.bodyIds.includes('body-1')&&item.bodyIds.includes('body-2')&&item.missingNodeReferences===0&&item.nodeCount>0));
});

test('aggressive repair preserves partial-overlap ownership and each Body volume',async()=>{
  const id='mesh_partial_overlap';await cad(id,'primitive.box',{width:20,depth:10,height:10});await cad(id,'primitive.box',{width:20,depth:10,height:10,x:10});
  const mesh=await job(id,{repairMode:'aggressive'}),groups=mesh.mesh.render.groups;
  for(const bodyId of ['body-1','body-2'])assert.ok(Math.abs(groups.filter(group=>group.bodyId===bodyId).reduce((sum,group)=>sum+group.volume,0)-2000)<1e-6,bodyId+' physical ownership volume');
  assert.equal(new Set(groups.map(group=>group.solidId)).size,3);assert.equal(mesh.mesh.conformity.nonConformalCount,0);
});

test('mesh boundary API resolves current Face instances, refreshes values without remeshing and isolates historical geometry',async()=>{
  const id='mesh_face_properties',box=await cad(id,'primitive.box',{width:20,depth:20,height:20});
  const type=await cad(id,'property.type.create',{key:'Port',name:'端口',targetScope:'face',association:'required',fields:[{key:'frequency',type:'double'},{key:'enabled',type:'bool'}]});
  const face=`face-${box.bodyMetadata[0].topologyRevision}-1`;
  const instance=await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Port1',value:{frequency:3,enabled:true},target:{kind:'face',bodyId:box.bodyId,topologyId:face}});
  const result=await job(id),key=result.meshJob.jobId;
  const boundary=async()=>(await fetch(api+`/mesh/jobs/${key}/boundary?bodyId=${box.bodyId}&cadFaceId=${face}`)).json();
  let report=await boundary();assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.boundary.sourceFaces.length,1);assert.equal(report.boundary.sourceFaces[0].properties[0].value.frequency,3);
  await cad(id,'property.instance.update',{value:{frequency:5,enabled:false}},{instanceId:instance.instance.instanceId});
  report=await boundary();assert.equal(report.meshJob.freshness.status,'current');assert.equal(report.boundary.sourceFaces[0].properties[0].value.frequency,5);assert.equal((await (await fetch(api+`/documents/${id}/mesh/jobs`)).json()).jobs.length,1);
  await cad(id,'feature.update',{height:25},{featureId:box.features[0].id});
  report=await boundary();assert.equal(report.meshJob.freshness.status,'stale');assert.equal(report.boundary.propertyStatus,'source-stale');assert.deepEqual(report.boundary.sourceFaces[0].properties,[]);
  const next=await job(id),current=await (await fetch(api+`/mesh/jobs/${next.meshJob.jobId}/boundary`)).json();assert.equal(current.boundary.propertyStatus,'current');assert.equal(current.boundary.sourceFaces.flatMap(face=>face.properties).find(p=>p.instanceId===instance.instance.instanceId).value.frequency,5);
});
