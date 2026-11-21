import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {normalizeMeshOptimization,validateMeshOptimizationReport} from '../shared/mesh-optimization.mjs';
import {normalizeMeshSizing,validateMeshSizingReport} from '../shared/mesh-sizing.mjs';import {normalizeMeshStrategyOptions} from '../shared/mesh-strategy.mjs';
import {meshStrategyHash,validateMeshStrategyExecution} from '../gateway/mesh-strategy-proof.mjs';import {buildMeshCommand} from '../gateway/mesh-routes.mjs';
import {emptyMeshSizingDraft,meshSizingDraftFromTask,meshSizingFromDraft,updateSizingTarget,captureSizingTarget} from '../app/model/mesh-sizing-draft.ts';import {ProjectMeshTaskStore} from '../app/model/project-mesh-task-store.ts';
const optimization={version:1,method:'netgen',iterations:5},target={kind:'body',bodyId:'body-1',bodyIdentity:'a'.repeat(32),topologyIdentity:'b'.repeat(32),topologyRevision:1},sizing={version:1,globalSize:2,rules:[{id:'film',size:.1,target,transitionDistance:2}]};
const summary=()=>({version:2,status:'complete',qualityName:'minSICN',threshold:.2,tetraCount:10,finiteCount:10,badCount:0,invalidCount:0,invertedCount:0,degenerateCount:0,unsupportedElementCount:0,minQuality:.3,maxQuality:.9,averageQuality:.6});
test('optimization is opt-in, typed, bounded and transported unchanged to the actual native request',()=>{
  assert.equal(normalizeMeshOptimization(undefined),undefined);assert.deepEqual(normalizeMeshOptimization(optimization),optimization);assert.deepEqual(buildMeshCommand('mesh.create',{inputPath:'a.brep',outputPath:'a.msh',optimization}).parameters.optimization,optimization);
  for(const value of [null,true,'netgen',{}, {...optimization,method:'Netgen'},{...optimization,iterations:0},{...optimization,iterations:6},{...optimization,iterations:1.5},{...optimization,iterations:'5'},{...optimization,extra:1}])assert.throws(()=>normalizeMeshOptimization(value),{code:'MESH_OPTIMIZATION_INVALID'});
});
test('optimization execution is required when requested, absent by default and consistent with final quality',()=>{
  const mesh={quality:summary()},report={...optimization,before:summary(),after:summary()};validateMeshOptimizationReport(report,optimization,mesh);validateMeshOptimizationReport(undefined,undefined,mesh);
  assert.throws(()=>validateMeshOptimizationReport(undefined,optimization,mesh));assert.throws(()=>validateMeshOptimizationReport(report,undefined,mesh));
  for(const change of [r=>r.iterations=3,r=>r.after.badCount=1,r=>r.after.minQuality=.1,r=>r.before.status='partial',r=>r.before.finiteCount=0,r=>r.before.averageQuality=NaN,r=>r.before.minQuality=.8]){const wrong=structuredClone(report);change(wrong);assert.throws(()=>validateMeshOptimizationReport(wrong,optimization,mesh),{code:'MESH_OPTIMIZATION_REPORT_INVALID'});}
});
test('a worse optimization report is not falsely called an improvement or accepted by the report validator alone',()=>{
  const before={...summary(),minQuality:.8,averageQuality:.85},after=summary();validateMeshOptimizationReport({...optimization,before,after},optimization,{quality:after});assert.ok(after.minQuality<before.minQuality,'Actual regression must remain visible; admission is independently recomputed');
});
test('transition widths are positive finite model lengths and preserve exact source identity',()=>{
  assert.deepEqual(normalizeMeshSizing(sizing),sizing);for(const distance of [null,0,-1,'2',NaN,Infinity,1e7])assert.throws(()=>normalizeMeshSizing({...sizing,rules:[{...sizing.rules[0],transitionDistance:distance}]}),{code:'MESH_SIZING_INVALID'});
});
test('transition execution must use the requested distance and proven source surfaces, without inventing an unrequested field',()=>{
  const mesh={render:{ownership:{assignments:[{bodyId:'body-1',volumeTag:1}]}},boundaryMapping:{sourceFaces:[{source:{bodyId:'body-1',cadFaceId:'face-1-1'},surfaceTags:[5]}]}},report={version:1,strategy:'min-restrict-v1',globalSize:2,rules:[{id:'film',size:.1,target,volumeTags:[1],surfaceTags:[5],transition:{distance:2,sampling:100,basis:'source-surfaces-distance-v1'}}]};validateMeshSizingReport(report,sizing,mesh);
  for(const change of [r=>delete r.rules[0].transition,r=>r.rules[0].transition.distance=1,r=>r.rules[0].transition.sampling=20,r=>r.rules[0].transition.basis='nearby-body',r=>r.rules[0].transition.extra=true]){const wrong=structuredClone(report);change(wrong);assert.throws(()=>validateMeshSizingReport(wrong,sizing,mesh),{code:'MESH_SIZING_REPORT_INVALID'});}
  const legacy=structuredClone(sizing);delete legacy.rules[0].transitionDistance;assert.throws(()=>validateMeshSizingReport(report,legacy,mesh),{code:'MESH_SIZING_REPORT_INVALID'});
});
test('transition drafts survive task reuse and retargeting, but blank and invalid widths are distinguished',()=>{
  const view={bodyMetadata:[{...target,name:'Film'}]},draft=meshSizingDraftFromTask('one',sizing,view);assert.equal(draft.rules[0].transitionDistance,'2');assert.deepEqual(meshSizingFromDraft(draft,'one',view),sizing);const moved=updateSizingTarget(draft,'film',captureSizingTarget(view,'body-1'),'unused');assert.equal(moved.rules[0].transitionDistance,'2');moved.rules[0].transitionDistance='';assert.equal(meshSizingFromDraft(moved,'one',view).rules[0].transitionDistance,undefined);moved.rules[0].transitionDistance='0';assert.throws(()=>meshSizingFromDraft(moved,'one',view));assert.equal(emptyMeshSizingDraft('one').rules.length,0);
});
test('named strategy execution pins both gradation and optimization while preserving old definitions unchanged',()=>{
  const legacy={repairMode:'strict',qualityThreshold:.2};assert.deepEqual(normalizeMeshStrategyOptions(legacy),legacy);const row={strategyId:'mesh-strategy-'+randomUUID(),name:'Thin film',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),options:{...legacy,sizing,optimization}},ref={strategyId:row.strategyId,revision:1,definitionHash:meshStrategyHash(row)},execution={...row.options,strategySnapshot:row,strategyRef:ref};validateMeshStrategyExecution(execution);
  assert.throws(()=>validateMeshStrategyExecution({...execution,optimization:{...optimization,iterations:1}}));const wrong=structuredClone(execution);wrong.sizing.rules[0].transitionDistance=1;assert.throws(()=>validateMeshStrategyExecution(wrong));
});
test('workspace optimization restores exact iteration settings from a strategy without network writes',async t=>{
  let posts=0;const store=new ProjectMeshTaskStore({documentId:'one',apiRoot:'/api',fetchImpl:async(_url,init)=>{if(init?.method==='POST')posts++;return new Response(JSON.stringify({ok:true,jobs:[]}));}});store.start();t.after(store.stop);await store.refresh();store.setSetupOptimization(optimization);const off=store.subscribe(()=>{});off();await store.refresh();assert.equal(store.getSnapshot().setupOptimization.iterations,5);const row={options:{repairMode:'strict',qualityThreshold:.2,optimization:{...optimization,iterations:3}}};store.loadStrategy(row,{});assert.equal(store.getSnapshot().setupOptimization.iterations,3);store.loadStrategy({options:{repairMode:'strict',qualityThreshold:.2}},{});assert.equal(store.getSnapshot().setupOptimization,undefined);assert.equal(posts,0);
});
