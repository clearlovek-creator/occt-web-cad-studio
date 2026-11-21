import { ObservedCommandClient } from "./helpers/observed-command-client.mjs";
const observedClient=new ObservedCommandClient();
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {before,after,test} from 'node:test';
import {resolvePropertySchema} from '../gateway/property-associations.mjs';

const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-entity-identity-'));
const api='http://127.0.0.1:8867/api';let gateway;
const revisions=new Map();
async function start(){gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8867',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('identity test gateway startup timeout')),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){if(!gateway)return;const exited=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await exited;gateway=null;}
before(start);after(async()=>{await stop();const resolved=path.resolve(data);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('cad-entity-identity-'));fs.rmSync(resolved,{recursive:true,force:true});});
async function raw(id,operation,parameters={},inputs={}){const response=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(observedClient.prepare({documentId:id,operation,parameters,inputs,baseRevision:revisions.get(id)||0}))});const result=await response.json();observedClient.observe(result,id);if(result.ok&&Number.isSafeInteger(result.revision))revisions.set(id,result.revision);return result;}
async function cad(...args){const result=await raw(...args);assert.equal(result.ok,true,JSON.stringify(result));return result;}
const bodies=result=>result.bodies || result.bodyMetadata;
async function tags(id,result,label='Tag'){
  const body=bodies(result).find(body=>(body.id||body.bodyId)===result.bodyId);const records=[];
  for(const kind of ['body','face','edge']){
    const type=await cad(id,'property.type.create',{key:label+kind,targetScope:kind,association:'required',fields:[{key:'priority',type:'int'}]});
    const created=await cad(id,'property.instance.create',{typeId:type.type.typeId,value:{priority:7},target:{kind,bodyId:result.bodyId,...(kind==='body'?{}:{topologyId:`${kind}-${body.topologyRevision}-1`})}});
    assert.match(created.instance.target.bodyIdentity,/^[a-f0-9]{32}$/);if(kind!=='body')assert.match(created.instance.target.topologyIdentity,/^[a-f0-9]{32}$/);
    records.push(created.instance);
  }return records;
}

test('unified undo removes later property edits; reused Body display IDs cannot reactivate retained old anchors',async()=>{
  const id='identity_branch';await cad(id,'primitive.box',{width:20,depth:20,height:20});
  const previous=await cad(id,'primitive.box',{width:10,depth:10,height:10,x:30}),records=await tags(id,previous);
  const retained=(await cad(id,'property.type.list')).propertySchema;
  await cad(id,'body.delete',{}, {bodyId:previous.bodyId});assert.ok((await cad(id,'property.instance.list')).instances.every(item=>item.state==='orphaned'));
  await cad(id,'document.undo');assert.deepEqual((await cad(id,'property.instance.list')).instances.map(item=>item.target),records.map(item=>item.target));
  await cad(id,'document.redo');assert.ok((await cad(id,'property.instance.list')).instances.every(item=>item.state==='orphaned'));
  await cad(id,'document.undo');
  for(let step=0;step<6;step++)await cad(id,'document.undo');
  assert.equal((await cad(id,'property.instance.list')).instances.length,0,'Undo must also remove the six later type/instance creation commands');
  await cad(id,'document.undo');
  const redoneBody=await cad(id,'document.redo');assert.equal(bodies(redoneBody).find(item=>item.bodyId===previous.bodyId).bodyIdentity,records[0].target.bodyIdentity);assert.equal((await cad(id,'property.instance.list')).instances.length,0);
  await cad(id,'document.undo');const replacement=await cad(id,'primitive.cylinder',{radius:5,height:10,x:30});
  assert.equal(replacement.bodyId,previous.bodyId,'The test must really reuse the display ID on an abandoned branch');
  assert.equal(replacement.revision,previous.revision);assert.notEqual(bodies(replacement).find(item=>item.bodyId===replacement.bodyId).bodyIdentity,records[0].target.bodyIdentity);
  const resolved=resolvePropertySchema(retained,await cad(id,'document.summary')).instances;assert.equal(resolved.length,3);assert.ok(resolved.every(item=>item.state==='orphaned'&&item.value.priority===7));
  const fresh=await tags(id,replacement,'Fresh');for(let index=0;index<fresh.length;index++){const forged=await raw(id,'property.instance.retarget',{instanceId:fresh[index].instanceId,target:records[index].target});assert.equal(forged.ok,false);assert.equal(forged.code,'PROPERTY_TARGET_INVALID');}
});

test('reusing a revision on the same Body changes topology identity but retains the Body identity',async()=>{
  const id='identity_topology',base=await cad(id,'primitive.box',{width:20,depth:20,height:20}),original=await tags(id,base,'Base');
  const moved=await cad(id,'transform.translate',{dx:20,dy:0,dz:0},{bodyId:base.bodyId}),branch=await tags(id,moved,'Branch');
  const retained=(await cad(id,'property.type.list')).propertySchema;
  retained.instances=retained.instances.map(instance=>({...instance,target:instance.association?.anchor||instance.target}));
  for(let step=0;step<6;step++)await cad(id,'document.undo');
  await cad(id,'document.undo');const changed=await cad(id,'transform.translate',{dx:0,dy:25,dz:0},{bodyId:base.bodyId});
  assert.equal(changed.revision,moved.revision);const current=bodies(changed)[0];assert.equal(current.bodyIdentity,branch[0].target.bodyIdentity);assert.notEqual(current.topologyIdentity,branch[1].target.topologyIdentity);
  const persisted=(await cad(id,'property.instance.list')).instances;assert.equal(persisted.length,3);assert.ok(persisted.every(item=>item.state==='active'));
  const resolved=resolvePropertySchema(retained,await cad(id,'document.summary')).instances;
  for(const item of original)assert.equal(resolved.find(next=>next.instanceId===item.instanceId).state,'active');
  assert.equal(resolved.find(item=>item.instanceId===branch[0].instanceId).state,'active');
  for(const item of branch.slice(1)){const next=resolved.find(next=>next.instanceId===item.instanceId);assert.equal(next.state,'needs-review');assert.equal(next.association.candidates.length,0);}
  for(let index=1;index<3;index++){const rejected=await raw(id,'property.instance.retarget',{instanceId:original[index].instanceId,target:branch[index].target});assert.equal(rejected.code,'PROPERTY_TARGET_INVALID');}
  const before=bodies(await cad(id,'document.summary'))[0];
  const failed=await raw(id,'feature.update',{width:0},{featureId:base.features[0].id});assert.equal(failed.ok,false);
  const after=bodies(await cad(id,'document.summary'))[0];assert.equal(after.bodyIdentity,before.bodyIdentity);assert.equal(after.topologyIdentity,before.topologyIdentity);
});

test('deleted IDs stay reserved across restart and project package identity survives opening',async()=>{
  const id='identity_restart',box=await cad(id,'primitive.box',{width:10,depth:10,height:10}),records=await tags(id,box);
  const saved=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(saved.status,200);const bytes=Buffer.from(await saved.arrayBuffer());
  await cad(id,'body.delete',{}, {bodyId:box.bodyId});await stop();await start();
  const replacement=await cad(id,'primitive.box',{width:30,depth:30,height:30});assert.notEqual(replacement.bodyId,box.bodyId);assert.ok((await cad(id,'property.instance.list')).instances.every(item=>item.state==='orphaned'));
  const opened=await fetch(api+'/documents/identity_portable/project/open',{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:bytes});assert.equal(opened.status,200,await opened.text());
  const portable=(await cad('identity_portable','property.instance.list')).instances;assert.deepEqual(portable.map(item=>item.target),records.map(item=>item.target));assert.ok(portable.every(item=>item.state==='active'));
});

test('legacy unqualified anchors retain their values and require explicit retargeting',async()=>{
  const id='identity_legacy',box=await cad(id,'primitive.box',{width:20,depth:20,height:20}),records=await tags(id,box);
  await stop();const file=path.join(data,'property-schemas',id+'.json'),schema=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const item of schema.instances){delete item.target.bodyIdentity;delete item.target.topologyIdentity;}fs.writeFileSync(file,JSON.stringify(schema));
  // A legacy gateway had no paired property checkpoints. Editing only today's
  // live JSON must not override a certified modern checkpoint on restart.
  const manifestFile=path.join(data,'history',id,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));delete manifest.projectData;fs.writeFileSync(manifestFile,JSON.stringify(manifest));await start();
  let instances=(await cad(id,'property.instance.list')).instances;assert.ok(instances.every(item=>item.state==='needs-review'&&item.value.priority===7));
  await cad(id,'property.instance.retarget',{instanceId:records[1].instanceId,target:records[1].target});instances=(await cad(id,'property.instance.list')).instances;assert.equal(instances.find(item=>item.instanceId===records[1].instanceId).state,'active');
});
