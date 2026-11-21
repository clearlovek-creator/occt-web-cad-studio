import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';
import {denyWindowsFileReplacement} from './helpers/windows-file-sharing.mjs';

test('real OCCT/Gmsh completion survives Windows metadata sharing denial and restart without remeshing',{skip:process.platform!=='win32',timeout:90000},async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-completion-api-'));let gateway,lock,retain=false;
  try{
    gateway=await gatedGeometryGateway(data,{GEOMETRY_WORKER_TIMEOUT_MS:'60000',MESH_WORKER_TIMEOUT_MS:'60000'});await gateway.until(async()=>(await gateway.get('/mesh/catalog')).meshCatalog.state==='ready','Catalog not ready');
    await gateway.cad('primitive.box',{width:6,depth:6,height:6});const before=await gateway.cad('document.summary');gateway.tell('arm-mesh-exit');await gateway.event('mesh-exit-armed');
    const accepted=await gateway.post('/documents/default/mesh/jobs',{background:true,qualityThreshold:0,sizing:{version:1,globalSize:3,rules:[]}});assert.equal(accepted.status,202);const id=accepted.value.meshJob.jobId;await gateway.event('mesh-exit-held');
    const file=path.join(data,'mesh-jobs','default',id,'metadata.json'),receipt=path.join(path.dirname(file),'completion.json'),bytes=fs.readFileSync(file);assert.equal(fs.existsSync(receipt),false);lock=await denyWindowsFileReplacement(file);gateway.tell('release-mesh-exit');
    const complete=await gateway.until(async()=>{const job=(await gateway.get('/documents/default/mesh/jobs')).jobs.find(job=>job.jobId===id);if(['failed','interrupted','cancelled'].includes(job.state))assert.fail(JSON.stringify(job));return job.state==='complete'?job:null;},'Locked completion was not committed',20000);
    assert.equal(complete.persistence.metadataSynchronized,false);assert.equal(complete.visible,false);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(JSON.parse(fs.readFileSync(receipt)).record.state,'complete');assert.equal(gateway.events.filter(event=>event.type==='fixture.mesh-start').length,1);
    const result=await gateway.get('/mesh/jobs/'+id);assert.equal(result.ok,true);assert.equal(result.mesh.admission.usable,true);const output=path.join(data,'meshes',id+'.msh'),outputBytes=fs.readFileSync(output),digest=crypto.createHash('sha256').update(outputBytes).digest('hex');assert.equal((await gateway.cad('document.summary')).stateToken,before.stateToken);
    await lock.release();lock=null;assert.equal(await gateway.stop(),0);gateway=null;
    gateway=await gatedGeometryGateway(data);await gateway.until(async()=>(await gateway.get('/mesh/catalog')).meshCatalog.state==='ready','Restarted catalog not ready');
    const restored=(await gateway.get('/documents/default/mesh/jobs')).jobs.find(job=>job.jobId===id);assert.equal(restored.state,'complete');assert.equal(restored.visible,false);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(gateway.events.filter(event=>event.type==='fixture.mesh-start').length,0);
    const reread=await gateway.get('/mesh/jobs/'+id);assert.equal(reread.ok,true);assert.equal(reread.mesh.admission.usable,true);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'),digest);assert.deepEqual(reread.mesh.sourceInventory,result.mesh.sourceInventory);
    assert.equal((await gateway.cad('document.summary')).stateToken,before.stateToken);
  }catch(error){if(error.retainData)retain=true;throw error;}
  finally{
    let cleanupError;
    if(lock)try{await lock.release();}catch(error){retain=true;cleanupError=error;}
    if(gateway)try{gateway.tell('release-mesh-exit');assert.equal(await gateway.stop(),0);}catch(error){retain=true;cleanupError??=error;}
    if(cleanupError)throw cleanupError;assert.equal(retain,false,'Owned exit unconfirmed; retain '+data);assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-mesh-completion-api-/);fs.rmSync(data,{recursive:true,force:true});
  }
});

test('process exit after the completion receipt but before metadata replacement restores the original mesh without recomputation',{timeout:90000},async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-completion-crash-'));let gateway,retain=false;
  try{
    gateway=await gatedGeometryGateway(data);await gateway.until(async()=>(await gateway.get('/mesh/catalog')).meshCatalog.state==='ready','Catalog not ready');await gateway.cad('primitive.box',{width:6,depth:6,height:6});const before=await gateway.cad('document.summary');gateway.tell('exit-mesh-completion');await gateway.event('mesh-completion-exit-armed');
    const exited=new Promise(resolve=>gateway.child.once('close',resolve)),accepted=await gateway.post('/documents/default/mesh/jobs',{background:true,qualityThreshold:0,sizing:{version:1,globalSize:3,rules:[]}});assert.equal(accepted.status,202);const id=accepted.value.meshJob.jobId;await gateway.event('mesh-completion-published-exit');assert.equal(await exited,88);gateway=null;
    const directory=path.join(data,'mesh-jobs','default',id),metadata=fs.readFileSync(path.join(directory,'metadata.json')),receipt=fs.readFileSync(path.join(directory,'completion.json'));assert.equal(JSON.parse(metadata).state,'running');assert.equal(JSON.parse(receipt).record.state,'complete');
    gateway=await gatedGeometryGateway(data);await gateway.until(async()=>(await gateway.get('/mesh/catalog')).meshCatalog.state==='ready','Recovered catalog not ready');const jobs=await gateway.get('/documents/default/mesh/jobs'),job=jobs.jobs.find(job=>job.jobId===id);assert.equal(job.state,'complete');assert.equal(job.visible,false);assert.equal(gateway.events.filter(event=>event.type==='fixture.mesh-start').length,0);assert.deepEqual(fs.readFileSync(path.join(directory,'metadata.json')),metadata);assert.deepEqual(fs.readFileSync(path.join(directory,'completion.json')),receipt);
    const result=await gateway.get('/mesh/jobs/'+id);assert.equal(result.ok,true);assert.equal(result.mesh.admission.usable,true);assert.equal((await gateway.cad('document.summary')).stateToken,before.stateToken);
  }catch(error){retain=true;throw error;}
  finally{if(gateway)try{assert.equal(await gateway.stop(),0);}catch(error){retain=true;throw error;}if(!retain){assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-mesh-completion-crash-/);fs.rmSync(data,{recursive:true,force:true});}else console.error('Retained completion crash diagnostics: '+data);}
});
