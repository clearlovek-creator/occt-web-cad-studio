import test from 'node:test';
import assert from 'node:assert/strict';
import {selectionBindingPaths,selectionStateProblem} from '../gateway/selection-precondition.mjs';
import {validateBatchSelectionProvenance} from '../gateway/batch-selection-provenance.mjs';
import {ObservedCommandClient} from './helpers/observed-command-client.mjs';
import {failedBatchResults} from '../gateway/batch-outcome.mjs';

test('historical coordinate rebindings require an observed project token just like feature input repairs',()=>{
  assert.ok(selectionBindingPaths('feature.update',{parameters:{coordinateSelectionEdits:[{coordinateSystemId:'attached'}]}}).includes('parameters.coordinateSelectionEdits'));
  assert.ok(selectionBindingPaths('variable.set',{parameters:{coordinateSelectionEdits:{$ref:'step.result.edits'}}}).includes('parameters.coordinateSelectionEdits'));
});
test('Loft section lists and definition changes require observed state and batch source provenance',()=>{
  for(const [operation,fields] of [['detail.loft',{inputs:{sections:[]}}],['feature.update',{parameters:{loftDefinition:{sections:[]}}}]])assert.equal(selectionStateProblem(operation,fields).code,'SELECTION_STATE_REQUIRED');
  const root=view(),changed=view('identity-a','topology-b'),literal={inputs:{sections:[{bodyId:'body-1',faceId:'face-1-1'}]}};
  assert.throws(()=>validateBatchSelectionProvenance('detail.loft',literal,literal,root,new Map(),changed),{code:'BATCH_SELECTION_STALE'});
  const refs={inputs:{sections:[{bodyId:{$ref:'fresh.bodyId'},faceId:{$ref:'fresh.triangleFaceIds.0'}}]}};
  assert.doesNotThrow(()=>validateBatchSelectionProvenance('detail.loft',refs,literal,root,new Map([['fresh',changed]]),changed));
  const edit={parameters:{loftDefinition:{sections:literal.inputs.sections}}};assert.throws(()=>validateBatchSelectionProvenance('feature.update',edit,edit,root,new Map(),changed),{code:'BATCH_SELECTION_STALE'});
});

test('selection policy covers feature inputs, coordinates, every geometry association and historical repairs without blocking read-only or unassociated data',()=>{
  const writes=[
    ['detail.fillet',{inputs:{bodyId:'b',edgeId:'edge-1-1'}}],['detail.shell',{inputs:{bodyId:'b',faceId:'face-1-1'}}],
    ['coordinate.set',{parameters:{kind:'face',preserveReference:true}}],['coordinate.set',{parameters:{copyReferenceFrom:'frame'}}],
    ['property.set',{inputs:{kind:'body',bodyId:'b'}}],['property.delete',{inputs:{kind:'edge',bodyId:'b',topologyId:'edge-1-1'}}],
    ...['create','update','retarget'].map(action=>['property.instance.'+action,{parameters:{target:{kind:'face',bodyId:'b',topologyId:'face-1-1'}}}]),
    ['feature.update',{parameters:{selectionEdits:[{}]}}],['variable.set',{parameters:{selectionEdits:{$ref:'repair.result'}}}],
    ['property.instance.create',{parameters:{target:{$ref:'first.instance.target'}}}],
  ];
  for(const [operation,fields] of writes){assert.ok(selectionBindingPaths(operation,fields).length,operation);assert.equal(selectionStateProblem(operation,fields).code,'SELECTION_STATE_REQUIRED');assert.equal(selectionStateProblem(operation,{...fields,baseStateToken:'a'.repeat(64)}),null);}
  for(const [operation,fields] of [['geometry.measure',{inputs:{selectionType:'face',selectionId:'face-1-1'}}],['property.list',{inputs:{kind:'face'}}],['primitive.box',{}],['coordinate.set',{parameters:{kind:'cartesian'}}],['property.instance.create',{parameters:{target:null}}],['property.instance.update',{parameters:{value:{x:3}}}],['property.instance.update',{inputs:{target:{kind:'body'}},parameters:{target:null}}]])assert.equal(selectionStateProblem(operation,fields),null,operation);
});

const view=(body='identity-a',topology='topology-a')=>({bodyMetadata:[{bodyId:'body-1'}],entityIdentities:{'body-1':{bodyIdentity:body,topologyIdentity:topology}},coordinateSystems:[],features:[]});
test('curved sweep paths and definition replacements require observed state and qualify each Edge producer',()=>{
  const root=view(),current=view('identity-a','topology-b'),literal={inputs:{bodyId:'body-1',pathBodyId:'body-1',pathEdgeIds:['edge-1-1']}};
  assert.equal(selectionStateProblem('detail.sweep',literal).code,'SELECTION_STATE_REQUIRED');assert.equal(selectionStateProblem('feature.update',{parameters:{sweepDefinition:{reverse:true}}}).code,'SELECTION_STATE_REQUIRED');
  assert.throws(()=>validateBatchSelectionProvenance('detail.sweep',literal,literal,root,new Map(),current),{code:'BATCH_SELECTION_STALE'});
  const fresh={inputs:{...literal.inputs,pathBodyId:{$ref:'fresh.bodyId'},pathEdgeIds:[{$ref:'fresh.edges.0.edgeId'}]}};
  assert.doesNotThrow(()=>validateBatchSelectionProvenance('detail.sweep',fresh,literal,root,new Map([['fresh',current]]),current));
  const edit={parameters:{sweepDefinition:{path:{bodyId:'body-1',edgeIds:['edge-1-1']}}}};
  assert.throws(()=>validateBatchSelectionProvenance('feature.update',edit,edit,root,new Map(),current),{code:'BATCH_SELECTION_STALE'});
});
test('batch selection IDs are qualified by entry or producer identity, never by matching R/Face display IDs',()=>{
  const old=view(),fresh=view('identity-b','topology-b'),operation='coordinate.set';
  const literal={parameters:{kind:'face',referenceBodyId:'body-1',referenceTopologyId:'face-1-1'}};
  assert.throws(()=>validateBatchSelectionProvenance(operation,literal,literal,old,new Map(),fresh),{code:'BATCH_SELECTION_STALE'});
  const refs={parameters:{kind:'face',referenceBodyId:{$ref:'new.bodyId'},referenceTopologyId:{$ref:'new.triangleFaceIds.0'}}};
  assert.doesNotThrow(()=>validateBatchSelectionProvenance(operation,refs,literal,old,new Map([['new',fresh]]),fresh));
  assert.throws(()=>validateBatchSelectionProvenance(operation,{parameters:{...refs.parameters,referenceTopologyId:'face-1-1'}},literal,old,new Map([['new',fresh]]),fresh),{code:'BATCH_SELECTION_STALE'});
});
test('Body association may survive topology changes but Face/Edge selection requires the observed topology identity',()=>{
  const old=view(),changed=view('identity-a','topology-b');
  const body={inputs:{kind:'body',bodyId:'body-1'}};assert.doesNotThrow(()=>validateBatchSelectionProvenance('property.set',body,body,old,new Map(),changed));
  const face={inputs:{kind:'face',bodyId:'body-1',topologyId:'face-1-1'}};assert.throws(()=>validateBatchSelectionProvenance('property.set',face,face,old,new Map(),changed),{code:'BATCH_SELECTION_STALE'});
});

test('migration fixtures carry only observed snapshots, never query, retry, replace explicit preconditions or accept error/late-response tokens',()=>{
  const client=new ObservedCommandClient(),request={documentId:'doc',operation:'detail.fillet',inputs:{bodyId:'body-1',edgeId:'edge-1-1'}};
  assert.equal(client.prepare(request),request,'A client with no observation must not invent a token');
  client.observe({ok:true,stateToken:'a'.repeat(64),stateSequence:1},'doc');const prepared=client.prepare(request);assert.equal(prepared.baseStateToken,'a'.repeat(64));assert.equal(request.baseStateToken,undefined);
  client.observe({ok:false,currentStateToken:'b'.repeat(64),stateToken:'b'.repeat(64),stateSequence:2},'doc');assert.equal(client.prepare(request).baseStateToken,'a'.repeat(64));
  client.observe({ok:true,stateToken:'c'.repeat(64),stateSequence:3},'doc');client.observe({ok:true,stateToken:'a'.repeat(64),stateSequence:1},'doc');assert.equal(client.prepare(request).baseStateToken,'c'.repeat(64));
  const stale={...request,baseStateToken:'a'.repeat(64)};assert.equal(client.prepare(stale),stale);
  assert.equal(client.prepare({...request,documentId:'other'}).baseStateToken,undefined);assert.equal(client.prepare(request,'other-server').baseStateToken,undefined);
});

test('a failed atomic batch reports every provisional success as rolled back and never returns its transient geometry as committed data',()=>{
  const provisional=[{ok:true,bodyId:'temporary',positions:[1,2,3]},{ok:false,code:'INVALID_PARAMETER',error:'bad value'}],original=JSON.stringify(provisional);
  const result=failedBatchResults([{operation:'primitive.box'},{operation:'detail.fillet'},{operation:'coordinate.set'}],provisional,{code:'BATCH_ROLLED_BACK',revision:7});
  assert.deepEqual(result.map(item=>item.status),['rolled-back','failed','not-executed']);assert.ok(result.every(item=>item.ok===false && item.bodyId===undefined && item.positions===undefined));assert.equal(result[1].causeCode,'INVALID_PARAMETER');assert.equal(JSON.stringify(provisional),original);
});
