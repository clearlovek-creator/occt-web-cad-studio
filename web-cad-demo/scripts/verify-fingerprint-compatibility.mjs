/* Cross-version engineering proof: old frozen native writes, new native restores. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {selectBackendRelease,validateBackendRelease} from '../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../gateway/native-runtime-release.mjs';
import {selectNativeTestRuntime,assertNativeTestRoles} from './test-native-runtime.mjs';
import {selectGeometry} from '../tests/helpers/generated-topology-fixtures.mjs';
const root=path.resolve(import.meta.dirname,'..'),area=path.join(root,'.artifacts/fingerprint-cross-version-final');fs.mkdirSync(area,{recursive:true});
const oldRoot=path.join(root,'.artifacts/archive-naming-backend-releases'),newRoot=path.join(root,'.artifacts/fingerprint-streaming-backend-releases');
const oldRelease=selectBackendRelease(oldRoot),newRelease=selectBackendRelease(newRoot),runtime=selectNativeTestRuntime(root);
assert.notEqual(oldRelease.native.sha256,newRelease.native.sha256,'Must exercise distinct old and new native releases');assert.equal(oldRelease.sourceSha256,newRelease.sourceSha256,'This comparison isolates native evidence changes');
assertNativeTestRoles(runtime.manifest,validateNativeRuntime(path.join(newRelease.directory,'native'),newRelease.native).roles);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cad-fingerprint-compat-')),checks=[];let current=null,verified=false;
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
const gatewayPort=await freePort(),frontendPort=await freePort(),api=`http://127.0.0.1:${gatewayPort}/api`;
async function manage(action,stage){
  const release=stage==='old'?oldRelease:newRelease,releaseRoot=stage==='old'?oldRoot:newRoot;
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/start-web-cad-demo.ps1'),'-Action',action,'-Service','Gateway','-GatewayPort',String(gatewayPort),'-FrontendPort',String(frontendPort),'-DataDirectory',path.join(scratch,stage+'-data'),'-RuntimeDirectory',path.join(scratch,stage+'-runtime'),'-GatewayReleaseRoot',releaseRoot,'-GatewayReleaseId',release.releaseId,'-AsJson'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1'}});let output='',error='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error=(error+bytes).slice(-8192));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,error+'\n'+output);const value=JSON.parse(output),gateway=value.Services.find(item=>item.Name==='gateway');assert.equal(gateway.State,action==='Start'?'ready':'stopped');if(action==='Stop')assert.equal(gateway.LastStopMode,'graceful');return value;
}
async function request(route,body,method){const response=await fetch(api+route,{...(body===undefined?{}:{method:method||'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.ok,true);return value;}
async function cad(id,operation,parameters={},inputs={}){const state=await request('/documents/'+id);return request('/commands',{documentId:id,operation,parameters,inputs,baseRevision:state.revision,baseStateToken:state.stateToken});}
const check=async(name,run)=>{await run();checks.push(name);console.log('PASS '+name);};
const near=(a,b)=>Math.abs(a-b)<1e-5,id='portable_evidence';let original,rawOriginal,typedOriginal,featureId,bodyId,instances=[],packageBytes;
try{
  current='old';await manage('Start',current);
  await check('old frozen native creates persistent imported roots and archived Face/Edge evidence through normal engineering APIs',async()=>{
    const health=await request('/health');assert.equal(health.backendRelease.releaseId,oldRelease.releaseId);
    await cad('source','primitive.box',{width:30,depth:40,height:20});const exported=await request('/documents/source/exports/step',{},'POST'),bytes=Buffer.from(await fetch(new URL(exported.downloadUrl,api)).then(response=>response.arrayBuffer()));
    const response=await fetch(api+'/documents/'+id+'/imports/step',{method:'POST',headers:{'content-type':'application/step'},body:bytes});assert.equal(response.status,200,await response.text());
    const imported=await cad(id,'document.summary');assert.equal(imported.features[0].numberParameters.importNamingVersion,1);
    const pattern=await cad(id,'pattern.linear',{count:2,spacing:20,directionX:1,directionY:0,directionZ:0},{bodyId:imported.activeBodyId});featureId=pattern.features.at(-1).id;bodyId=pattern.features.at(-1).outputBodies.at(-1);
    const view=await cad(id,'body.presentation',{}, {bodyId}),face=await selectGeometry(cad,id,view,'face',m=>near(m.centroid[2],20)),edge=await selectGeometry(cad,id,view,'edge',m=>near(m.centroid[0],20)&&near(m.centroid[1],0)&&near(m.length,20));
    for(const [kind,topologyId] of [['face',face],['edge',edge]]){
      await cad(id,'property.set',{key:'crossVersionMarker',type:'int',value:91},{kind,bodyId,topologyId});const type=await cad(id,'property.type.create',{key:'OldEvidence'+kind,targetScope:kind,association:'required',fields:[{key:'marker',type:'int'}]});const created=await cad(id,'property.instance.create',{typeId:type.type.typeId,value:{marker:91},target:{kind,bodyId,topologyId}});instances.push(created.instance.instanceId);
    }
    await cad(id,'coordinate.set',{id:'old_evidence_frame',name:'Old Face frame',kind:'face',referenceBodyId:bodyId,referenceTopologyId:face});await cad(id,'feature.suppress',{}, {featureId});
    original=await cad(id,'document.summary');rawOriginal=(await cad(id,'property.list')).propertyRecords;typedOriginal=(await cad(id,'property.instance.list')).instances;assert.ok(typedOriginal.every(item=>item.state!=='active'));
    const saved=await fetch(api+'/documents/'+id+'/project/save',{method:'POST'});assert.equal(saved.status,200);packageBytes=Buffer.from(await saved.arrayBuffer());fs.writeFileSync(path.join(area,'old-native-archived-evidence.webcad'),packageBytes);
  });
  await manage('Stop',current);current=null;current='new';await manage('Start',current);
  await check('new frozen native opens the old package without rewriting topology identities, raw/typed targets or dormant frames',async()=>{
    const health=await request('/health');assert.equal(health.backendRelease.releaseId,newRelease.releaseId);
    const response=await fetch(api+'/documents/'+id+'/project/open',{method:'POST',headers:{'content-type':'application/vnd.webcad.project'},body:packageBytes});assert.equal(response.status,200,await response.text());const loaded=await cad(id,'document.summary');
    for(const key of ['revision','entityIdentities','bodyMetadata','coordinateSystems'])assert.deepEqual(loaded[key],original[key],key);assert.deepEqual((await cad(id,'property.list')).propertyRecords,rawOriginal);assert.deepEqual((await cad(id,'property.instance.list')).instances,typedOriginal);
  });
  await check('new native resolves old archived proofs and inherited constructor roots after explicit restore and parameter editing',async()=>{
    await cad(id,'feature.restore',{}, {featureId});await cad(id,'feature.update',{spacing:30},{featureId});
    for(const [index,kind] of ['face','edge'].entries()){
      const record=(await cad(id,'property.instance.list')).instances.find(item=>item.instanceId===instances[index]);assert.equal(record.state,'active');assert.deepEqual(record.value,{marker:91});const measured=await cad(id,'geometry.measure',{}, {bodyId:record.target.bodyId,selectionType:kind,selectionId:record.target.topologyId});assert.ok(near(measured.centroid[0],kind==='face'?45:30));assert.ok(near(kind==='face'?measured.area:measured.length,kind==='face'?1200:20));
    }
    const frame=(await cad(id,'document.summary')).coordinateSystems.find(item=>item.id==='old_evidence_frame');assert.equal(frame.referenceState,'resolved');assert.ok(near(frame.origin[0],45));
    const raw=(await cad(id,'property.list')).propertyRecords,active=raw.filter(item=>item.state==='active'),restored=(await cad(id,'property.instance.list')).instances;assert.equal(active.length,rawOriginal.length);
    for(const item of active){const originalRecord=rawOriginal.find(old=>old.kind===item.kind),typed=restored.find(record=>record.target.kind===item.kind);assert.ok(originalRecord&&typed);assert.equal(item.bodyId,typed.target.bodyId);assert.equal(item.topologyId,typed.target.topologyId);assert.deepEqual(item.values,originalRecord.values);}
    for(const old of rawOriginal){const retained=raw.find(item=>item.kind===old.kind&&item.bodyId===old.bodyId&&item.topologyId===old.topologyId);assert.ok(retained,'Original raw attribute history was discarded');assert.equal(retained.state,'superseded');assert.deepEqual(retained.values,old.values);}
  });
  await check('Undo/Redo preserves the restored old evidence instead of requiring a naming migration',async()=>{const before=await cad(id,'document.summary');await cad(id,'document.undo');await cad(id,'document.redo');const after=await cad(id,'document.summary');assert.deepEqual(after.entityIdentities,before.entityIdentities);assert.equal(after.features[0].numberParameters.importNamingVersion,1);assert.ok((await cad(id,'property.instance.list')).instances.every(item=>item.state==='active'));});
  validateBackendRelease(oldRelease.directory);validateBackendRelease(newRelease.directory);verified=true;
  const result={ok:true,checks,passed:checks.length,oldBackend:oldRelease.releaseId,newBackend:newRelease.releaseId,oldNativeSha256:oldRelease.native.sha256,newNativeSha256:newRelease.native.sha256,testManifestSha256:runtime.manifestSha256,projectSha256:crypto.createHash('sha256').update(packageBytes).digest('hex'),paidProviderCalls:0,scope:'Private frozen pre-streaming native creates the actual portable project and proofs; frozen streaming native opens and restores them through unchanged Gateway APIs. Imported constructor roots, archived raw/typed Face/Edge targets, dormant Face frame, actual measurements and Undo/Redo; not all historical OCCT versions.'};fs.writeFileSync(path.join(area,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  if(current)await manage('Stop',current);
  if(verified){assert.equal(path.dirname(scratch),path.resolve(os.tmpdir()));assert.match(path.basename(scratch),/^cad-fingerprint-compat-/);fs.rmSync(scratch,{recursive:true,force:true});}else console.error('Preserved cross-version diagnostics: '+scratch);
}
