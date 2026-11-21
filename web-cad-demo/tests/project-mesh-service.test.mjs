import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ProjectMeshService} from '../gateway/project-mesh-service.mjs';
import {meshStrategyHash} from '../gateway/mesh-strategy-proof.mjs';
test('a strategy changed between request lookup and source export is rejected before any export or worker starts',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-strategy-race-')),strategy={strategyId:'mesh-strategy-00000000-0000-4000-8000-000000000001',name:'Pinned',revision:1,createdAt:'2026-11-17T00:00:00Z',updatedAt:'2026-11-17T00:00:00Z',options:{repairMode:'strict',qualityThreshold:0}},ref={strategyId:strategy.strategyId,revision:1,definitionHash:meshStrategyHash(strategy)},calls=[];let lookups=0;const service=new ProjectMeshService({dataDir:root,serializeDocument:async(_id,action)=>action(),getMeshStrategy:async(_id,value)=>{assert.deepEqual(value,ref);if(++lookups===2)throw Object.assign(Error('definition changed'),{code:'MESH_STRATEGY_CONFLICT'});return structuredClone(strategy);},command:async operation=>{calls.push(operation);return {ok:true,documentId:'one',revision:1,bodyCount:1,bodyMetadata:[]};},worker:{request:async()=>{throw Error('worker must not start');}}});try{const result=await service.create('one',{strategyRef:ref});assert.equal(result.payload.ok,false);assert.equal(result.payload.code,'MESH_STRATEGY_CONFLICT');assert.equal(lookups,2);assert.equal(calls.includes('mesh.prepare'),false);assert.equal([...service.jobs.values()][0].state,'failed');}finally{await service.closeAndWait();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-mesh-strategy-race-/);fs.rmSync(root,{recursive:true,force:true});}});
test('shutdown ownership includes per-job native clients even when the shared worker has no live process',()=>{
  const shared={},a={},b={},service=Object.create(ProjectMeshService.prototype);service.worker={children:new Set([shared])};service.jobs=new Map([['one',{client:{children:new Set([a])}}],['two',{client:{children:new Set([a,b])}}],['old',{}]]);assert.deepEqual(service.ownedChildren(),new Set([shared,a,b]));
});

test('geometry can change while meshing; the result remains a hidden historical artifact',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-service-'));
  let view={ok:true,documentId:'test',revision:2,bodyCount:1,bodyMetadata:[{bodyId:'body-1',kind:'solid',bodyIdentity:'a'.repeat(32),topologyIdentity:'b'.repeat(32),topologyRevision:2,volume:10,centroid:[0,0,0]}]};
  let finish,started;const running=new Promise(resolve=>started=resolve);const calls=[];
  const service=new ProjectMeshService({dataDir:root,serializeDocument:async(_id,action)=>action(),command:async(operation,fields)=>{calls.push(operation);if(operation==='document.summary')return structuredClone(view);fs.writeFileSync(fields.parameters.path,'BREP fixture');fs.writeFileSync(fields.parameters.manifestPath,JSON.stringify({...view,format:'brep',bodies:view.bodyMetadata}));return {ok:true};},worker:{request:async command=>{started();return new Promise(resolve=>finish=()=>resolve({ok:true,requestId:command.requestId,mesh:{dimension:3,nodeCount:4,elementCount:1,render:{kind:'wire',positions:[],groups:[{kind:'solid',bodyId:'body-1',groupId:'solid-1',wirePositions:[0,0,0,1,1,1]}]}}}));}}});
  try{
    const work=service.create('test',{});await running;assert.equal([...service.jobs.values()][0].state,'running');assert.deepEqual(calls,['document.summary','mesh.prepare']);
    view.bodyMetadata[0].topologyIdentity='c'.repeat(32);view.revision=3;finish();
    const done=await work;assert.equal(done.status,200);assert.equal(done.payload.meshJob.freshness.status,'stale');assert.equal(done.payload.meshJob.visible,false);
    const show=await service.handle('POST',`/api/mesh/jobs/${done.payload.meshJob.jobId}/visibility`,{visible:true});assert.equal(show.status,409);assert.equal(show.payload.code,'MESH_SOURCE_STALE');
    assert.deepEqual(fs.readdirSync(path.join(root,'mesh-sources')),[]);
  }finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
