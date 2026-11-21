import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PropertySchemaStore} from '../gateway/property-schema-store.mjs';
import {resolvePropertySchema} from '../gateway/property-associations.mjs';
import {selectionStateProblem} from '../gateway/selection-precondition.mjs';
import {validateBatchSelectionProvenance} from '../gateway/batch-selection-provenance.mjs';
import {listCadMcpTools} from '../gateway/cad-mcp-server.mjs';
import {toolCallsToModelingPlan} from '../gateway/llm/cad-tools.mjs';
const bodyIdentity='a'.repeat(32),oldTopology='b'.repeat(32),newTopology='c'.repeat(32);
const anchor=(index,revision=1)=>({kind:'face',bodyId:'body-1',topologyId:`face-${revision}-${index}`,topologyRevision:revision,bodyIdentity,topologyIdentity:revision===1?oldTopology:newTopology});
const view=(revision=1,features=[])=>({revision,bodyMetadata:[{bodyId:'body-1',bodyIdentity,topologyIdentity:revision===1?oldTopology:newTopology,topologyRevision:revision,faceCount:8,edgeCount:16}],features,entityIdentities:{'body-1':{bodyIdentity,topologyIdentity:revision===1?oldTopology:newTopology}}});
const lineage=(source,destinations)=>({computedRevision:2,topologyLineage:{version:1,basis:'occt-history',state:'current',resultRevision:2,entries:[{sourceBodyId:source.bodyId,sourceTopologyId:source.topologyId,sourceBodyIdentity:source.bodyIdentity,sourceTopologyIdentity:source.topologyIdentity,inputPreserved:false,destinations}]}});
function schema(policy='review',anchors=[anchor(1)]){return {schemaVersion:2,types:[{typeId:'set',targetScope:'face',association:'required',targetMode:'multiple',splitPolicy:policy}],instances:[{instanceId:'boundary',typeId:'set',state:'active',target:null,targets:anchors,value:{enabled:true}}]};}

test('multiple associations use an explicit v2 schema, preserve legacy bytes and reject incomplete/duplicate edits atomically',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-property-sets-'));try{const store=new PropertySchemaStore(root),old=store.createType('legacy',{key:'Old',targetScope:'face',association:'required',fields:[]});store.createInstance('legacy',{typeId:old.typeId,target:anchor(1),value:{}});const bytes=fs.readFileSync(store.filePath('legacy'));new PropertySchemaStore(root).list('legacy');assert.deepEqual(fs.readFileSync(store.filePath('legacy')),bytes);assert.equal(store.list('legacy').schemaVersion,1);
    const type=store.createType('new',{key:'Boundary',targetScope:'face',association:'required',targetMode:'multiple',splitPolicy:'all-descendants',fields:[]}),instance=store.createInstance('new',{typeId:type.typeId,targets:[anchor(1),anchor(2)],value:{}});assert.equal(store.list('new').schemaVersion,2);assert.equal(instance.targets.length,2);assert.equal(instance.target,null);const before=store.list('new'),disk=fs.readFileSync(store.filePath('new'));
    for(const targets of [[],[null],[anchor(1),anchor(1)],[{kind:'edge',bodyId:'body-1',topologyId:'edge-1-1'}],Array.from({length:257},(_,i)=>anchor(i+1))])assert.throws(()=>store.updateInstance('new',{instanceId:instance.instanceId,name:'Must not leak',targets}));assert.deepEqual(store.list('new'),before);assert.deepEqual(fs.readFileSync(store.filePath('new')),disk);
    assert.throws(()=>store.updateType('new',{typeId:type.typeId,splitPolicy:'review'}),/immutable/);assert.throws(()=>store.validateSnapshot({...before,schemaVersion:1}),/schemaVersion 2/);assert.throws(()=>store.updateInstance('legacy',{instanceId:store.list('legacy').instances[0].instanceId,targets:[anchor(1)]}),/multiple-target/);
    const exported=store.exportTypes('new');assert.equal(exported.schemaVersion,2);store.importTypes('copy',{package:exported});assert.equal(store.list('copy').types[0].splitPolicy,'all-descendants');assert.throws(()=>store.importTypes('bad',{package:{...exported,schemaVersion:1}}),/Invalid/);
  }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});

test('review and all-descendants policies differ only for complete verified fanout, and reads never replace stored anchors',()=>{
  const destinations=[anchor(2,2),anchor(3,2)],geometry=view(2,[lineage(anchor(1),destinations)]),strict=schema(),following=schema('all-descendants'),before=JSON.stringify(following);
  const a=resolvePropertySchema(strict,geometry).instances[0],b=resolvePropertySchema(following,geometry).instances[0];assert.equal(a.state,'needs-review');assert.equal(a.association.candidates.length,2);assert.equal(b.state,'active');assert.deepEqual(b.targets.map(t=>t.topologyId),['face-2-2','face-2-3']);assert.equal(b.association.members[0].candidateCount,2);assert.equal(JSON.stringify(following),before);assert.deepEqual(resolvePropertySchema(following,view()).instances[0].targets,following.instances[0].targets);
  geometry.features[0].topologyLineage.state='stale';assert.equal(resolvePropertySchema(following,geometry).instances[0].state,'needs-review');
});

test('one missing member never makes a partial set active, while proven merging deduplicates the same destination',()=>{
  const collection=schema('all-descendants',[anchor(1),anchor(2)]),target=anchor(4,2),geometry=view(2,[lineage(anchor(1),[target]),lineage(anchor(2),[])]),resolved=resolvePropertySchema(collection,geometry).instances[0];assert.equal(resolved.state,'needs-review');assert.deepEqual(resolved.targets,collection.instances[0].targets);assert.equal(resolved.association.candidates.length,1);assert.deepEqual(resolved.association.members.map(m=>m.state),['active','orphaned']);
  geometry.features[1]=lineage(anchor(2),[target]);const merged=resolvePropertySchema(collection,geometry).instances[0];assert.equal(merged.state,'active');assert.equal(merged.targets.length,1);assert.deepEqual(merged.association.members.map(m=>m.candidateIndexes),[[0],[0]]);
  geometry.bodyMetadata[0].bodyIdentity='d'.repeat(32);geometry.entityIdentities['body-1'].bodyIdentity='d'.repeat(32);assert.notEqual(resolvePropertySchema(collection,geometry).instances[0].state,'active');
});

test('collection writes need an observed token and each batch member keeps its producer provenance',()=>{
  assert.equal(selectionStateProblem('property.instance.create',{parameters:{targets:[anchor(1)]}}).code,'SELECTION_STATE_REQUIRED');const root=view(),changed=view(2),resolved={parameters:{targets:[anchor(1,2)]}},raw={parameters:{targets:[{bodyId:{$ref:'made.bodyId'},kind:'face',topologyId:{$ref:'made.faceId'}}]}};assert.doesNotThrow(()=>validateBatchSelectionProvenance('property.instance.create',raw,resolved,root,new Map([['made',changed]]),changed));assert.throws(()=>validateBatchSelectionProvenance('property.instance.create',resolved,resolved,root,new Map(),changed),error=>error.code==='BATCH_SELECTION_STALE');
});

test('unbounded descendant fanout never silently truncates an active collection',()=>{
  const geometry=view(2,[lineage(anchor(1),Array.from({length:258},(_,index)=>anchor(index+1,2)))]);geometry.bodyMetadata[0].faceCount=300;
  const result=resolvePropertySchema(schema('all-descendants'),geometry).instances[0];assert.equal(result.state,'needs-review');assert.equal(result.association.candidates.length,256);assert.equal(result.association.candidatesTruncated,true);assert.ok(result.association.candidateCount>256);assert.deepEqual(result.targets,[anchor(1)]);
});

test('existing Agent tools describe collection policy and preserve complete targets and explicit single-target clearing',()=>{
  const tools=listCadMcpTools(),type=tools.find(tool=>tool.name==='property__type__create'),retarget=tools.find(tool=>tool.name==='property__instance__retarget');
  assert.deepEqual(type.inputSchema.properties.parameters.properties.splitPolicy.enum,['review','all-descendants']);assert.equal(retarget.inputSchema.properties.parameters.properties.targets.maxItems,256);assert.ok(!retarget.inputSchema.properties.parameters.required?.includes('target'));assert.match(retarget.description,/never target/);
  const plan=toolCallsToModelingPlan([{name:'create_property_instance',arguments:{typeId:'set',name:'Boundary',value:{},targets:[anchor(1),anchor(2)],baseStateToken:'f'.repeat(64)}},{name:'retarget_property_instance',arguments:{instanceId:'legacy',target:null,baseStateToken:'f'.repeat(64)}}]);
  assert.deepEqual(plan.steps[0].parameters.targets,[anchor(1),anchor(2)]);assert.equal(plan.steps[1].parameters.target,null);
});
