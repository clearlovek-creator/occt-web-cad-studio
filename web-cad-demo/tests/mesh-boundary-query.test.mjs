import test from 'node:test';
import assert from 'node:assert/strict';
import {queryMeshBoundary,validateMeshBoundary} from '../gateway/mesh-boundary-query.mjs';

function fixture(){
  const source={version:1,documentId:'test',revision:4,bodies:[{bodyId:'body-1',kind:'solid',bodyIdentity:'a'.repeat(32),topologyIdentity:'b'.repeat(32),topologyRevision:4},{bodyId:'body-2',kind:'solid',bodyIdentity:'c'.repeat(32),topologyIdentity:'d'.repeat(32),topologyRevision:3}]};
  const a={...source.bodies[0],cadFaceId:'face-4-1'},b={...source.bodies[1],cadFaceId:'face-3-1'};
  const mapping={version:1,backend:'occt-history',repairMode:'conservative',complete:true,sourceFaces:[{source:a,state:'mapped',surfaceTags:[1,2]},{source:b,state:'mapped',surfaceTags:[2]}],surfaces:[{surfaceTag:1,meshFaceId:'mesh-face-1',area:3,elementCount:2,adjacentSolidIds:['solid-1'],sources:[a]},{surfaceTag:2,meshFaceId:'mesh-face-2',area:4,elementCount:3,adjacentSolidIds:['solid-1','solid-2'],sources:[a,b]}]};
  const job={source};
  const schema={types:[{typeId:'port',name:'端口'}],instances:[{instanceId:'port-1',name:'端口1',typeId:'port',state:'active',target:{...a,kind:'face',topologyId:a.cadFaceId},value:{frequency:3,enabled:true}},{instanceId:'old',name:'编号相同但身份不同',state:'active',target:{...a,kind:'face',bodyIdentity:'0'.repeat(32),topologyId:a.cadFaceId},value:{}},{instanceId:'review',name:'待复核',state:'needs-review',target:{...a,kind:'face',topologyId:a.cadFaceId},stateReason:'面分裂',value:{frequency:5}}]};
  return {source,mapping,job,schema};
}
test('boundary query preserves one-to-many and shared-surface provenance, joining only identity-qualified active properties',()=>{
  const {mapping,job,schema}=fixture(),original=JSON.stringify({mapping,schema});
  const result=queryMeshBoundary(mapping,job,{bodyId:'body-1'},schema,true);
  assert.equal(result.sourceFaces.length,1);assert.deepEqual(result.sourceFaces[0].surfaceTags,[1,2]);assert.equal(result.surfaces.length,2);assert.equal(result.surfaces[1].sources.length,2);
  assert.deepEqual(result.sourceFaces[0].properties.map(p=>p.instanceId),['port-1']);assert.equal(result.sourceFaces[0].properties[0].value.frequency,3);assert.equal(result.unresolvedProperties[0].reason,'面分裂');
  assert.equal(JSON.stringify({mapping,schema}),original);assert.equal(result.propertyStatus,'current');
  assert.deepEqual(queryMeshBoundary(mapping,job,{},schema,false).sourceFaces.flatMap(face=>face.properties),[],'Current properties must never attach to historical mesh geometry');
  assert.equal(queryMeshBoundary(mapping,job,{},null,true).propertyStatus,'unavailable');
  assert.throws(()=>queryMeshBoundary(mapping,job,{cadFaceId:'face-4-1'}),/必须指定/);assert.throws(()=>queryMeshBoundary(mapping,job,{bodyId:'missing'}),/不属于/);
});
test('boundary relation rejects forged identities, missing reverse edges and contradictory completeness',()=>{
  for(const mutate of [m=>m.sourceFaces[0].source.topologyIdentity='0'.repeat(32),m=>m.surfaces[1].sources=[],m=>m.sourceFaces[0].surfaceTags=[1,3],m=>m.surfaces[0].surfaceTag=2,m=>m.complete=false,m=>m.sourceFaces[0].state='removed']){
    const {mapping,source}=fixture();mutate(mapping);assert.throws(()=>validateMeshBoundary(mapping,source),/来源无效/);
  }
  const {mapping,source}=fixture();mapping.complete=false;mapping.sourceFaces.push({source:{...mapping.sourceFaces[0].source,cadFaceId:'face-4-2'},state:'unresolved',surfaceTags:[]});assert.equal(validateMeshBoundary(mapping,source).complete,false);
});

test('one active collection attaches once to every matching mesh source, while an incomplete collection attaches nowhere',()=>{
  const {mapping,job,schema}=fixture(),targets=mapping.sourceFaces.map(face=>({...face.source,kind:'face',topologyId:face.source.cadFaceId}));
  schema.instances=[{instanceId:'set',typeId:'port',name:'多个边界',state:'active',target:null,targets,value:{frequency:8}}];
  const result=queryMeshBoundary(mapping,job,{},schema,true);assert.deepEqual(result.sourceFaces.map(face=>face.properties.map(item=>item.instanceId)),[['set'],['set']]);
  schema.instances[0].state='needs-review';schema.instances[0].stateReason='一个成员已删除';const partial=queryMeshBoundary(mapping,job,{},schema,true);assert.ok(partial.sourceFaces.every(face=>!face.properties.length));assert.equal(partial.unresolvedProperties[0].instanceId,'set');
  assert.ok(queryMeshBoundary(mapping,job,{},schema,false).sourceFaces.every(face=>!face.properties.length));
});
