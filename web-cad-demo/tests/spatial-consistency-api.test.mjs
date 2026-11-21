import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-spatial-consistency-')),api='http://127.0.0.1:8899/api',states=new Map();let gateway;
async function start(){gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8899',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Spatial API gateway startup timeout')),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){if(!gateway)return;const child=gateway;gateway=null;const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}
before(start);after(async()=>{await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function request(route,body){const response=await fetch(api+route,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)}),result=await response.json();assert.ok(response.ok&&result.ok,JSON.stringify({route,status:response.status,code:result.code,error:result.error}));return result;}
async function cad(id,operation,parameters={},inputs={}){const state=states.get(id),result=await request('/commands',{documentId:id,operation,parameters,inputs,baseRevision:state?.revision||0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})});states.set(id,result);return result;}
const query=(documentId,kind='geometry-tree',bodyId)=>request('/agent/model/query',{documentId,kind,bodyId});
const near=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected}`);

test('Body measurement counts shared topological edges once and remains independent of display triangulation',async()=>{
  const id='measurement_unique_edges',box=await cad(id,'primitive.box',{width:2,depth:3,height:5}),before=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId});
  assert.equal(before.edgeLengthPolicy,'unique-topological-edges');near(before.length,4*(2+3+5));near(before.volume,30);near(before.area,62);
  let sum=0;for(const edge of box.edges)sum+=(await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'edge',selectionId:edge.edgeId})).length;near(sum,before.length);
  await cad(id,'body.presentation',{}, {bodyId:box.bodyId});const after=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId});assert.equal(after.length,before.length);assert.equal(after.stateToken,before.stateToken);
  const cylinder=await cad(id,'primitive.cylinder',{radius:3,height:7,x:20}),round=await cad(id,'geometry.measure',{}, {bodyId:cylinder.bodyId});near(round.length,4*Math.PI*3+7);assert.equal(round.edgeLengthPolicy,'unique-topological-edges');
});
test('BRep spatial policy is consistent across metadata, precise Body/Face/Edge measurements, presentation and gateway restore',async()=>{
  const id='spatial_roundtrip',box=await cad(id,'primitive.box',{width:191,depth:75,height:57,x:-155,y:-134}),before=await cad(id,'document.summary');assert.equal(before.spatialPolicy.version,1);assert.deepEqual(before.bodyMetadata[0].bounds,{min:[-155,-134,0],max:[36,-59,57]});
  const body=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId});assert.deepEqual(body.bounds,before.bodyMetadata[0].bounds);assert.equal(body.obb.source,'occt-brep-obb');assert.equal(body.obb.exact,false);assert.equal(body.obb.minimum,false);assert.equal(body.obb.triangulationUsed,false);assert.equal(body.obb.toleranceExpanded,false);
  const firstFace=box.triangleFaceIds[0],firstEdge=box.edges[0].edgeId,face=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'face',selectionId:firstFace}),edge=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'edge',selectionId:firstEdge});
  for(let pass=0;pass<3;pass++)await cad(id,'body.presentation',{}, {bodyId:box.bodyId});assert.deepEqual((await cad(id,'document.summary')).bodyMetadata,before.bodyMetadata);
  await stop();await start();const restored=await cad(id,'document.summary');assert.equal(restored.stateToken,before.stateToken);assert.deepEqual(restored.bodyMetadata,before.bodyMetadata);assert.deepEqual((await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'face',selectionId:firstFace})).bounds,face.bounds);assert.deepEqual((await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'edge',selectionId:firstEdge})).bounds,edge.bounds);
});
test('sub-micrometre placement is not rounded to zero and Sheet/Wire centers use the appropriate mass dimension',async()=>{
  const id='spatial_precision',x=.00000012345678912345,y=-500.987654321,z=12.00000012345,radius=1.23456789123,created=await cad(id,'surface.disk',{radius,x,y,z}),metadata=created.bodyMetadata[0],measured=await cad(id,'geometry.measure',{}, {bodyId:created.bodyId,selectionType:'face',selectionId:created.triangleFaceIds[0]});
  near(metadata.centroid[0],x,1e-14);near(metadata.centroid[1],y);near(metadata.centroid[2],z);near(measured.centroid[0],x,1e-14);near(measured.centroid[1],y);near(measured.area,Math.PI*radius**2,1e-12);near(metadata.area,measured.area,1e-12);assert.deepEqual(metadata.bounds,measured.bounds);
  const circle=created.edges[0].edgeId,edge=await cad(id,'geometry.measure',{}, {bodyId:created.bodyId,selectionType:'edge',selectionId:circle});near(edge.radius,radius,1e-14);near(edge.center[0],x,1e-14);near(edge.center[2],z,1e-14);
});
test('Agent measurement cache cannot reuse an abandoned branch that has the same revision and Body/Face IDs',async()=>{
  const id='spatial_cache_branch',box=await cad(id,'primitive.box',{width:5,depth:7,height:9});const first=await cad(id,'transform.translate',{dx:10,dy:0,dz:0},{bodyId:box.bodyId}),old=await query(id,'body',box.bodyId);near(old.query.body.spatial.bounds.min[0],10);await cad(id,'document.undo');const second=await cad(id,'transform.translate',{dx:0,dy:20,dz:0},{bodyId:box.bodyId});assert.equal(second.revision,first.revision);assert.notEqual(second.bodyMetadata[0].topologyIdentity,first.bodyMetadata[0].topologyIdentity);const current=await query(id,'body',box.bodyId);near(current.query.body.spatial.bounds.min[0],0);near(current.query.body.spatial.bounds.min[1],20);assert.notDeepEqual(current.query.body.spatial.bounds,old.query.body.spatial.bounds);
});
test('complete model perception uses current analytic metadata without N extra measurements; detailed Body queries retain guarded caching',async()=>{
  const id='spatial_query_cost';for(let index=0;index<20;index++)await cad(id,'primitive.cylinder',{radius:2.123456789,height:7.987654321,x:index*10});const before=await request('/health'),first=await query(id),after=await request('/health');assert.equal(first.query.spatial.status,'complete');assert.equal(first.query.spatial.totalBodyCount,20);assert.deepEqual(first.query.spatial.sources,{metadata:20,measurement:0});assert.equal(after.runtime.geometryMeasureRequests,before.runtime.geometryMeasureRequests);assert.ok(first.query.bodies.every(body=>body.spatial.boundsPolicyVersion===1&&body.spatial.boundsSource==='occt-brep-optimal'&&body.spatial.obb.exact===false));assert.ok(first.query.spatial.relations.length<=32);assert.equal(first.query.spatial.boundsPolicy.triangulationUsed,false);
  const bodyId=first.query.bodies[0].bodyId,detail=await query(id,'body',bodyId),measured=await request('/health');assert.equal(detail.query.body.spatial.obb.source,'occt-brep-obb');assert.equal(measured.runtime.geometryMeasureRequests,after.runtime.geometryMeasureRequests+1);await query(id,'body',bodyId);assert.equal((await request('/health')).runtime.geometryMeasureRequests,measured.runtime.geometryMeasureRequests);
  await cad(id,'property.type.create',{key:'MetadataOnly',fields:[]});await query(id,'body',bodyId);assert.equal((await request('/health')).runtime.geometryMeasureRequests,measured.runtime.geometryMeasureRequests,'A property-only edit may reuse exactly the same geometry identity');
});
test('new min/max alignment is based on analytic bounds and retains its explicit stored translation on replay',async()=>{
  const id='spatial_align',body=await cad(id,'primitive.cylinder',{radius:3.123456789,height:8.7654321,x:.0000001234,y:11.123456789,z:-2.123456789});
  const aligned=await cad(id,'transform.align',{mode:'min',targetX:100,targetY:200,targetZ:300},{bodyId:body.bodyId});aligned.bodyMetadata[0].bounds.min.forEach((value,index)=>near(value,[100,200,300][index],1e-9));const translation=aligned.features.at(-1).numberParameters;await cad(id,'document.undo');const restored=await cad(id,'document.redo');assert.deepEqual(restored.features.at(-1).numberParameters,translation);assert.deepEqual(restored.bodyMetadata,aligned.bodyMetadata);
});

test('sub-micrometre BRep separation and closest points are not rounded into a false zero gap',async()=>{
  const id='spatial_relation_precision',a=await cad(id,'primitive.box',{width:1,depth:1,height:1}),gap=.00000023456789123,b=await cad(id,'primitive.box',{width:1,depth:1,height:1,x:1+gap}),relation=await cad(id,'geometry.relation',{tolerance:1e-9},{bodyA:a.bodyId,bodyB:b.bodyId});assert.equal(relation.relation,'disjoint');assert.ok(relation.distance>0);near(relation.distance,gap,1e-12);near(relation.closestPoints[1][0]-relation.closestPoints[0][0],gap,1e-12);assert.equal(relation.tolerance,1e-9);
});
