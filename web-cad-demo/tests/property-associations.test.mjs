import test from "node:test";
import assert from "node:assert/strict";
import {checkPropertyTarget,resolvePropertySchema} from "../gateway/property-associations.mjs";
const anchor={kind:"face",bodyId:"body-1",topologyId:"face-1-6",topologyRevision:1};
const schema={types:[],instances:[{instanceId:"port",state:"active",target:anchor,value:{frequency:3}}]};
const feature=(revision,source,destinations,extra={})=>({computedRevision:revision,topologyLineage:{version:1,basis:"occt-history",state:"current",resultRevision:revision,entries:[{sourceBodyId:source.bodyId,sourceTopologyId:source.topologyId,inputPreserved:false,destinations,...extra}]}});
const body=(id,revision)=>({id,topologyRevision:revision,faceCount:12,edgeCount:24});

test("property anchors follow chained exact lineage and are not overwritten by reads",()=>{
  const next={bodyId:"body-1",topologyId:"face-3-8"},last={bodyId:"body-1",topologyId:"face-5-2"};
  const view={bodies:[body("body-1",5)],features:[feature(3,anchor,[next]),feature(5,next,[last])]};
  const resolved=resolvePropertySchema(schema,view).instances[0];
  assert.equal(resolved.state,"active");assert.equal(resolved.target.topologyId,"face-5-2");assert.equal(resolved.association.status,"remapped");
  assert.deepEqual(schema.instances[0].target,anchor);
  const undo=resolvePropertySchema(schema,{bodies:[body("body-1",1)],features:[]}).instances[0];assert.equal(undo.target.topologyId,anchor.topologyId);assert.equal(undo.state,"active");
});
test("one-to-many references require review; current retained inputs remain attached to their original Body",()=>{
  const view={bodies:[body("body-1",3),body("body-2",3)],features:[feature(3,anchor,[{bodyId:"body-1",topologyId:"face-3-1"},{bodyId:"body-2",topologyId:"face-3-1"}])]};
  const split=resolvePropertySchema(schema,view).instances[0];assert.equal(split.state,"needs-review");assert.equal(split.association.candidates.length,2);assert.deepEqual(split.target,anchor);
  const kept=resolvePropertySchema(schema,{...view,bodies:[body("body-1",1),body("body-2",3)]}).instances[0];assert.equal(kept.state,"active");assert.equal(kept.target.bodyId,"body-1");assert.equal(kept.association.status,"verified");
});
test("deleted, unknown and stale lineage never falls back to equal face indexes",()=>{
  const view={bodies:[body("body-1",3)],features:[]};
  assert.equal(resolvePropertySchema(schema,view).instances[0].state,"needs-review");
  view.features=[feature(3,anchor,[])];assert.equal(resolvePropertySchema(schema,view).instances[0].state,"orphaned");
  view.features=[{...feature(3,anchor,[{bodyId:"body-1",topologyId:"face-3-6"}]),computedRevision:4}];assert.equal(resolvePropertySchema(schema,view).instances[0].state,"needs-review");
  assert.equal(checkPropertyTarget({...anchor,topologyId:"face-3-9999",topologyRevision:3},view).ok,false);
  assert.equal(checkPropertyTarget({...anchor,topologyId:"face-03-6",topologyRevision:3},view).ok,false);
  assert.equal(checkPropertyTarget({...anchor,topologyId:"face-3-06",topologyRevision:3},view).ok,false);
  assert.equal(resolvePropertySchema(schema,{ok:false}).instances[0].state,"needs-review");
});

test("historical Boolean evidence requires a semantic recompute bridge even when stored on an earlier feature",()=>{
  const oldOutput={bodyId:"body-1",topologyId:"face-3-8"},current={bodyId:"body-2",topologyId:"face-7-4"};
  const previous={...feature(3,anchor,[oldOutput]),computedRevision:7};
  const evolution={computedRevision:7,topologyEvolutions:{version:1,basis:"semantic-topology-v1",entries:[{sourceBodyId:oldOutput.bodyId,sourceTopologyId:oldOutput.topologyId,state:"mapped",resultRevision:7,destinations:[current]}]}};
  const view={revision:7,bodies:[body("body-2",7)],features:[evolution,previous]};
  assert.equal(resolvePropertySchema(schema,view).instances[0].target.bodyId,"body-2");
  view.features=[previous];assert.equal(resolvePropertySchema(schema,view).instances[0].state,"needs-review");
});

test("reused Body IDs and reused topology revisions cannot reactivate an old property",()=>{
  const original={...anchor,bodyIdentity:'a'.repeat(32),topologyIdentity:'b'.repeat(32)};
  const records={types:[],instances:[{instanceId:'old',state:'active',target:original,value:{priority:7}}]};
  const replacement={...body('body-1',1),bodyIdentity:'c'.repeat(32),topologyIdentity:'d'.repeat(32)};
  let resolved=resolvePropertySchema(records,{bodies:[replacement],features:[]}).instances[0];
  assert.equal(resolved.state,'orphaned');assert.equal(resolved.association.candidates.length,0);
  replacement.bodyIdentity=original.bodyIdentity;
  resolved=resolvePropertySchema(records,{bodies:[replacement],features:[]}).instances[0];
  assert.equal(resolved.state,'needs-review');assert.equal(resolved.association.candidates.length,0);
  const legacy=resolvePropertySchema(schema,{bodies:[replacement],features:[]}).instances[0];assert.equal(legacy.state,'needs-review');assert.match(legacy.stateReason,/持久对象身份/);
  const canonical=checkPropertyTarget(anchor,{bodies:[replacement]});assert.equal(canonical.ok,true);assert.equal(canonical.target.bodyIdentity,replacement.bodyIdentity);assert.equal(canonical.target.topologyIdentity,replacement.topologyIdentity);
  assert.equal(checkPropertyTarget(original,{bodies:[body('body-1',1)]}).ok,false,'A downgraded worker cannot silently discard identity evidence');
});

test("identity-qualified lineage cannot cross into a different destination incarnation",()=>{
  const original={...anchor,bodyIdentity:'a'.repeat(32),topologyIdentity:'b'.repeat(32)};
  const destination={bodyId:'body-2',topologyId:'face-3-1',bodyIdentity:'c'.repeat(32),topologyIdentity:'d'.repeat(32)};
  const operation=feature(3,original,[destination]);Object.assign(operation.topologyLineage.entries[0],{sourceBodyIdentity:original.bodyIdentity,sourceTopologyIdentity:original.topologyIdentity});
  const view={bodies:[{...body('body-2',3),...destination,id:'body-2'}],features:[operation]};
  const records={types:[],instances:[{state:'active',target:original,value:{enabled:true}}]};
  assert.equal(resolvePropertySchema(records,view).instances[0].state,'active');
  view.bodies[0].bodyIdentity='e'.repeat(32);assert.equal(resolvePropertySchema(records,view).instances[0].state,'orphaned');
  assert.deepEqual(records.instances[0].target,original);
});
