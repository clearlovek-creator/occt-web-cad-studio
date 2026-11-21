import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectGeometry} from './helpers/generated-topology-fixtures.mjs';
import {listCadMcpTools} from '../gateway/cad-mcp-server.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-curve-sweep-路径-')),fixtures=fs.mkdtempSync(path.join(os.tmpdir(),'cad-curve-fixtures-')),api='http://127.0.0.1:8891/api',states=new Map();let gateway;
before(async()=>{gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8891',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let diagnostics='';const timer=setTimeout(()=>reject(Error('Gateway startup timeout '+diagnostics)),20000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>diagnostics+=chunk);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});});
after(async()=>{const ended=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await ended;for(const directory of [data,fixtures]){assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});}});
async function raw(id,operation,parameters={},inputs={},options={}){const state=states.get(id),result=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,options,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})})}).then(r=>r.json());if(result.ok&&!options.preview)states.set(id,result);return result;}
async function cad(...args){const result=await raw(...args);assert.equal(result.ok,true,JSON.stringify(result));return result;}
async function fixture(id,operation='detail.sweep'){const profile=await cad(id,'surface.disk',{radius:2}),route=await cad(id,'surface.disk',{radius:20}),result=await cad(id,operation,{placement:'align-start'}, {bodyId:profile.bodyId,faceId:profile.triangleFaceIds[0],pathBodyId:route.bodyId,pathEdgeIds:[route.edges[0].edgeId]});return {profile,route,result,featureId:result.features.at(-1).id};}
const near=(a,b)=>Math.abs(a-b)<1e-4;
for(const operation of ['detail.sweep','detail.pipe'])test(`${operation} constructs the exact real circle, preserves sources and recomputes profile/path dimensions`,async()=>{
  const id='curve_'+operation.split('.')[1],f=await fixture(id,operation),measured=await cad(id,'geometry.measure',{}, {bodyId:f.result.bodyId});assert.ok(near(measured.volume,160*Math.PI**2),JSON.stringify(measured));assert.equal(f.result.bodyCount,3);assert.equal(f.result.features.at(-1).stringParameters.sweepVersion,'2');assert.equal(f.result.features.at(-1).inputFeatures.length,2);
  const face=await selectGeometry(cad,id,f.result,'face',()=>true),type=await cad(id,'property.type.create',{key:'SweepWall',targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]}),instance=(await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Wall',value:{marker:7},target:{kind:'face',bodyId:f.result.bodyId,topologyId:face}})).instance;
  await cad(id,'feature.update',{radius:30},{featureId:f.route.features.at(-1).id});await cad(id,'feature.update',{radius:3},{featureId:f.profile.features.at(-1).id});assert.ok(near((await cad(id,'geometry.measure',{}, {bodyId:f.result.bodyId})).volume,540*Math.PI**2));const current=(await cad(id,'property.instance.list')).instances.find(item=>item.instanceId===instance.instanceId);assert.equal(current.state,'active',JSON.stringify(current));
  const before=await cad(id,'document.view');await cad(id,'feature.update',{sweepDefinition:{reverse:true}},{featureId:f.featureId},{preview:true});assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);await cad(id,'feature.update',{sweepDefinition:{reverse:true}},{featureId:f.featureId});await cad(id,'document.undo');assert.deepEqual((await cad(id,'document.view')).features,before.features);
});
test('a path later transformed and consumed by Boolean remains its original historical route through replay',async()=>{
  const id='curve_history',f=await fixture(id);await cad(id,'transform.translate',{dx:100,dy:0,dz:0},{bodyId:f.route.bodyId});const other=await cad(id,'surface.disk',{radius:25,x:110});await cad(id,'boolean.fuse',{}, {targetBody:other.bodyId,toolBody:f.route.bodyId});
  await cad(id,'feature.update',{radius:3},{featureId:f.profile.features.at(-1).id});const measured=await cad(id,'geometry.measure',{}, {bodyId:f.result.bodyId});assert.ok(near(measured.volume,360*Math.PI**2));const presentation=await cad(id,'body.presentation',{}, {bodyId:f.result.bodyId});assert.ok(Math.max(...presentation.positions.filter((_,index)=>index%3===0))<24,'The final translated path Body must not replace its original historical circle');
});
test('suppress/save/open/restore keeps the curved sweep definition, Body identity and Face attributes',async()=>{
  const id='curve_lifecycle',f=await fixture(id),face=f.result.triangleFaceIds[0],type=await cad(id,'property.type.create',{key:'Boundary',targetScope:'face',association:'required',fields:[]}),instance=(await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Curved wall',value:{},target:{kind:'face',bodyId:f.result.bodyId,topologyId:face}})).instance;
  await cad(id,'feature.suppress',{}, {featureId:f.featureId});const saved=await fetch(api+`/documents/${id}/project/save`,{method:'POST'});assert.equal(saved.status,200);const copy=id+'_copy',opened=await fetch(api+`/documents/${copy}/project/open`,{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:Buffer.from(await saved.arrayBuffer())});assert.equal(opened.status,200,await opened.text());await cad(copy,'document.summary');await cad(copy,'feature.restore',{}, {featureId:f.featureId});assert.ok(near((await cad(copy,'geometry.measure',{}, {bodyId:f.result.bodyId})).volume,160*Math.PI**2));assert.equal((await cad(copy,'property.instance.list')).instances.find(item=>item.instanceId===instance.instanceId).state,'active');
});
test('invalid paths, incompatible placement, stale input IDs and cyclic definitions never partially change the project',async()=>{
  const id='curve_invalid',f=await fixture(id),before=await cad(id,'document.view');
  const requests=[['detail.sweep',{placement:'actual'},{bodyId:f.profile.bodyId,faceId:f.profile.triangleFaceIds[0],pathBodyId:f.route.bodyId,pathEdgeIds:[f.route.edges[0].edgeId]}],['detail.sweep',{placement:'align-start'},{bodyId:f.profile.bodyId,faceId:f.profile.triangleFaceIds[0],pathBodyId:f.route.bodyId,pathEdgeIds:[f.route.edges[0].edgeId,f.route.edges[0].edgeId]}],['feature.update',{sweepDefinition:{profile:{bodyId:f.result.bodyId,faceId:f.result.triangleFaceIds[0]}}},{featureId:f.featureId}]];
  requests.push(['feature.update',{radius:25},{featureId:f.profile.features.at(-1).id}]);
  for(const args of requests){assert.equal((await raw(id,...args)).ok,false);assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);assert.deepEqual((await cad(id,'document.view')).features,before.features);}
});

test('old Face/Edge display IDs cannot be refreshed into valid curve inputs by borrowing a newer state token',async()=>{
  const id='curve_stale_ids',f=await fixture(id);
  await cad(id,'feature.update',{radius:21},{featureId:f.route.features.at(-1).id});
  await cad(id,'feature.update',{radius:2.5},{featureId:f.profile.features.at(-1).id});
  const before=await cad(id,'document.view'),profile=await cad(id,'body.presentation',{}, {bodyId:f.profile.bodyId}),route=await cad(id,'body.presentation',{}, {bodyId:f.route.bodyId});
  assert.notEqual(route.edges[0].edgeId,f.route.edges[0].edgeId);
  assert.notEqual(profile.triangleFaceIds[0],f.profile.triangleFaceIds[0]);
  for(const inputs of [
    {bodyId:profile.bodyId,faceId:profile.triangleFaceIds[0],pathBodyId:route.bodyId,pathEdgeIds:[f.route.edges[0].edgeId]},
    {bodyId:profile.bodyId,faceId:f.profile.triangleFaceIds[0],pathBodyId:route.bodyId,pathEdgeIds:[route.edges[0].edgeId]},
  ]){
    const rejected=await raw(id,'detail.sweep',{placement:'align-start'},inputs);
    assert.equal(rejected.ok,false,JSON.stringify({ok:rejected.ok,code:rejected.code,revision:rejected.revision}));
    assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
    assert.deepEqual((await cad(id,'document.view')).features,before.features);
  }
});

test('a planar annular Face keeps its hole along the real curved pipe',async()=>{
  const id='curve_holes',tube=await cad(id,'primitive.tube',{outerRadius:4,innerRadius:2,height:5}),face=await selectGeometry(cad,id,tube,'face',m=>near(m.centroid[2],5)),route=await cad(id,'surface.disk',{radius:30}),result=await cad(id,'detail.pipe',{placement:'align-start'},{bodyId:tube.bodyId,faceId:face,pathBodyId:route.bodyId,pathEdgeIds:[route.edges[0].edgeId]});
  assert.ok(near((await cad(id,'geometry.measure',{}, {bodyId:result.bodyId})).volume,720*Math.PI**2));assert.equal((await cad(id,'geometry.check',{}, {bodyId:result.bodyId})).valid,true);
  const inner=await selectGeometry(cad,id,result,'face',m=>near(m.area,240*Math.PI**2)),type=await cad(id,'property.type.create',{key:'InnerWall',targetScope:'face',association:'required',fields:[]}),instance=(await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Inner wall',value:{},target:{kind:'face',bodyId:result.bodyId,topologyId:inner}})).instance;
  await cad(id,'feature.update',{innerRadius:1.5},{featureId:tube.features.at(-1).id});assert.equal((await cad(id,'property.instance.list')).instances.find(item=>item.instanceId===instance.instanceId).state,'active');assert.ok(near((await cad(id,'geometry.measure',{}, {bodyId:result.bodyId})).volume,825*Math.PI**2));
});
test('existing MCP tools expose bounded real path inputs and Agent queries receive only reference summaries',async()=>{
  for(const name of ['detail__sweep','detail__pipe']){const schema=listCadMcpTools().find(tool=>tool.name===name).inputSchema;assert.equal(schema.properties.inputs.properties.pathEdgeIds.maxItems,32);assert.equal(schema.anyOf.length,2);assert.ok(schema.properties.parameters.properties.placement.enum.includes('align-start'));}
  const id='curve_context',f=await fixture(id),response=await fetch(api+'/agent/model/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,kind:'geometry-tree'})}).then(r=>r.json());assert.equal(response.ok,true);const feature=response.query.features.find(item=>item.id===f.featureId);assert.equal(feature.stringParameters.sweepPath,undefined);assert.equal(feature.stringParameters.sweepProfile,undefined);assert.equal(feature.inputSelections.length,2);assert.equal(feature.inputSelections.find(item=>item.kind==='ordered-edge-path').edgeCount,1);assert.doesNotMatch(JSON.stringify(feature),/neighborhood|fingerprint|\"selector\"/);
});
test('align-start transforms an eccentric hole with the whole profile instead of recentering it',async()=>{
  const id='curve_eccentric',plate=await cad(id,'surface.rectangle',{width:20,height:20}),tool=await cad(id,'primitive.cylinder',{radius:1,height:10,x:3,y:2,z:-5}),cut=await cad(id,'boolean.cut',{}, {targetBody:plate.bodyId,toolBody:tool.bodyId}),profileFace=cut.triangleFaceIds[0],source=await cad(id,'geometry.measure',{}, {bodyId:cut.bodyId,selectionType:'face',selectionId:profileFace}),route=await cad(id,'primitive.box',{width:10,depth:10,height:20,x:50,y:50}),edge=await selectGeometry(cad,id,route,'edge',m=>near(m.length,20)&&near(m.centroid[0],50)&&near(m.centroid[1],50)),result=await cad(id,'detail.pipe',{placement:'align-start'},{bodyId:cut.bodyId,faceId:profileFace,pathBodyId:route.bodyId,pathEdgeIds:[edge]});
  assert.ok(near((await cad(id,'geometry.measure',{}, {bodyId:result.bodyId})).volume,(400-Math.PI)*20));const wall=await selectGeometry(cad,id,result,'face',m=>near(m.area,40*Math.PI)),measured=await cad(id,'geometry.measure',{}, {bodyId:result.bodyId,selectionType:'face',selectionId:wall});assert.ok(near(Math.hypot(measured.centroid[0]-50,measured.centroid[1]-50),Math.hypot(3-source.centroid[0],2-source.centroid[1])),'The eccentric hole must retain its offset after alignment');
});

test('imported true arcs, spatial B-splines and G1 multi-edge wires generate by their actual path length',async()=>{
  const worker=process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe'),env={...process.env},inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;env.PATH=[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  const made=spawnSync(path.join(path.dirname(worker),'curve_sweep_tests.exe'),['--fixture-output',fixtures],{env,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(made.status,0,made.stdout+'\n'+made.stderr);
  for(const kind of ['arc','spline','g1']){
    const id='curve_import_'+kind,uploaded=await fetch(api+`/documents/${id}/imports/step`,{method:'POST',headers:{'Content-Type':'application/step'},body:fs.readFileSync(path.join(fixtures,kind+'.step'))}),route=await uploaded.json();assert.equal(route.ok,true,JSON.stringify(route));states.set(id,route);const routeId=route.bodyId||route.activeBodyId||route.bodyMetadata?.[0]?.bodyId,profile=await cad(id,'surface.disk',{radius:.5}),view=await cad(id,'body.presentation',{}, {bodyId:routeId});assert.ok(view.edges.length);let length=0;for(const edge of view.edges)length+=(await cad(id,'geometry.measure',{}, {bodyId:routeId,selectionType:'edge',selectionId:edge.edgeId})).length;
    const result=await cad(id,'detail.sweep',{placement:'align-start'},{bodyId:profile.bodyId,faceId:profile.triangleFaceIds[0],pathBodyId:routeId,pathEdgeIds:view.edges.map(edge=>edge.edgeId)}),measured=await cad(id,'geometry.measure',{}, {bodyId:result.bodyId});assert.ok(Math.abs(measured.volume-Math.PI*.25*length)<1e-3,JSON.stringify({kind,length,volume:measured.volume}));await cad(id,'feature.update',{sweepDefinition:{frame:'frenet'}},{featureId:result.features.at(-1).id});assert.equal((await cad(id,'geometry.check',{}, {bodyId:result.bodyId})).valid,true);
  }
});
