import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {stopTestChild} from './helpers/stop-test-child.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-step-import-integrity-')),fixtures=path.join(data,'fixtures'),api='http://127.0.0.1:8913/api',states=new Map();let gateway;
before(async()=>{
  const worker=process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe'),env={...process.env,PATH:[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:\\msys64\\ucrt64\\bin',process.env.PATH].join(path.delimiter)};
  const generated=spawnSync(path.join(path.dirname(worker),'step_import_tests.exe'),['--fixture-output',fixtures],{env,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(generated.status,0,generated.error?.message||generated.stderr||generated.stdout);
  gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8913',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('STEP integrity Gateway timeout: '+output)),15000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>output+=chunk);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
});
after(async()=>{await stopTestChild(gateway);assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function raw(id,operation,parameters={},inputs={}){const state=states.get(id),response=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,...(state?{baseRevision:state.revision,baseStateToken:state.stateToken}:{})})}),payload=await response.json();if(payload.ok)states.set(id,payload);return payload;}
async function cad(...args){const result=await raw(...args);assert.equal(result.ok,true,JSON.stringify(result));return result;}
async function upload(id,file){const response=await fetch(api+`/documents/${id}/imports/step`,{method:'POST',headers:{'Content-Type':'application/step'},body:fs.readFileSync(file)}),result=await response.json();if(result.ok)states.set(id,result);return result;}

test('mixed STEP preserves Solid, Sheet, Wire and point bodies, then exports and reimports without extra source roots',async()=>{
  const imported=await upload('mixed',path.join(fixtures,'mixed.step'));assert.equal(imported.ok,true,JSON.stringify(imported));assert.equal(imported.bodyCount,5);assert.deepEqual([imported.stepImport.solidCount,imported.stepImport.sheetCount,imported.stepImport.wireCount,imported.stepImport.otherCount],[2,1,1,1]);assert.equal(imported.stepImport.modelLengthUnit,'mm');assert.equal(imported.stepImport.assemblyHierarchyRetained,false);assert.equal(imported.features[0].numberParameters.decompositionVersion,2);assert.equal(imported.features[0].stringParameters.sourceFingerprintAlgorithm,'sha256-chain-1m-v1');assert.equal(imported.presentationMode,'lazy');
  const exported=await fetch(api+'/documents/mixed/exports/step',{method:'POST'}).then(r=>r.json());assert.equal(exported.ok,true);const bytes=await fetch(new URL(exported.downloadUrl,api)).then(r=>r.arrayBuffer());const response=await fetch(api+'/documents/mixed_roundtrip/imports/step',{method:'POST',headers:{'Content-Type':'application/step'},body:bytes}),restored=await response.json();assert.equal(restored.ok,true,JSON.stringify(restored));assert.equal(restored.bodyCount,5);
});

test('STEP import failure preserves the existing geometry, variables, typed data and exact undo baseline',async()=>{
  const id='failed_import';await cad(id,'primitive.box',{width:11,depth:12,height:13});await cad(id,'variable.set',{name:'keep',type:'dimensionless',expression:'7'});const type=await cad(id,'property.type.create',{key:'KeepType',association:'none',targetScope:'project',fields:[{key:'frequency',type:'double'}]});await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Keep',value:{frequency:3}});const baseline=await cad(id,'document.summary');
  const response=await fetch(api+`/documents/${id}/imports/step`,{method:'POST',headers:{'Content-Type':'application/step'},body:'not a STEP file'}),failed=await response.json();assert.equal(failed.ok,false);assert.equal(failed.code,'STEP_READ_FAILED');const after=await cad(id,'document.summary');assert.equal(after.stateToken,baseline.stateToken);assert.equal(after.revision,baseline.revision);assert.equal(after.bodyCount,baseline.bodyCount);assert.deepEqual(after.features,baseline.features);assert.deepEqual(after.variables,baseline.variables);assert.equal((await cad(id,'property.instance.list')).instances.length,1);assert.deepEqual(fs.readdirSync(path.join(data,'document-transactions')),[]);
});

test('multiple imported bodies survive feature edits, Undo/Redo and a portable project package with remapped retained sources',async()=>{
  const id='recompute',imported=await upload(id,path.join(fixtures,'solids.step'));assert.equal(imported.ok,true);const moved=await cad(id,'transform.translate',{dx:2,dy:0,dz:0},{bodyId:'body-1'}),feature=moved.features.at(-1).id;await cad(id,'feature.update',{dx:4},{featureId:feature});const baseline=await cad(id,'document.summary');assert.equal(baseline.bodyCount,2);await cad(id,'document.undo');assert.equal((await cad(id,'document.summary')).bodyCount,2);await cad(id,'document.redo');
  const packed=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(packed.status,200);const bytes=await packed.arrayBuffer(),response=await fetch(api+'/documents/package_copy/project/open',{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:bytes}),opened=await response.json();assert.equal(opened.ok,true,JSON.stringify(opened));states.set('package_copy',opened);const edited=await cad('package_copy','feature.update',{dx:6},{featureId:feature});assert.equal(edited.bodyCount,2);assert.equal(edited.features[0].stringParameters.sourceFingerprint,imported.features[0].stringParameters.sourceFingerprint);assert.notEqual(edited.features[0].stringParameters.sourcePath,imported.features[0].stringParameters.sourcePath);
});

test('a byte-changed retained STEP refuses replay even when body count is unchanged and does not commit partial edits',async()=>{
  const id='changed_source',imported=await upload(id,path.join(fixtures,'solids.step'));assert.equal(imported.ok,true);const moved=await cad(id,'transform.translate',{dx:2,dy:0,dz:0},{bodyId:'body-1'}),feature=moved.features.at(-1).id,before=await cad(id,'document.summary'),source=before.features[0].stringParameters.sourcePath;
  assert.ok(path.resolve(source).startsWith(path.resolve(data)+path.sep));fs.appendFileSync(source,'\n');const changed=fs.readFileSync(source),failed=await raw(id,'feature.update',{dx:4},{featureId:feature});assert.equal(failed.ok,false);assert.equal(failed.code,'STEP_REPLAY_SOURCE_CHANGED');const after=await cad(id,'document.summary');assert.equal(after.stateToken,before.stateToken);assert.deepEqual(after.features,before.features);assert.deepEqual(fs.readFileSync(source),changed);assert.deepEqual(fs.readdirSync(path.join(data,'document-transactions')),[]);
});
