import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(fs.readFileSync(new URL('../app/modeling/loft-loops.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2017}}).outputText;
const {parseFaceBoundaries,loopMappingIssue,initialLoftSections,loftSectionInputs,loftVersionKind}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const presentation={topologyRevision:4,triangleFaceIds:['face-4-1'],edges:[1,2,3,4].map(index=>({edgeId:`edge-4-${index}`}))};
const summary=()=>({version:1,faceId:'face-4-1',complete:true,valid:true,planar:true,loops:[{loopId:'loop-1',role:'outer',closed:true,length:100,edgeIds:['edge-4-1']},{loopId:'loop-2',role:'inner',closed:true,length:10,edgeIds:['edge-4-2','edge-4-3']},{loopId:'loop-3',role:'inner',closed:true,length:5,edgeIds:['edge-4-4']}]});
test('boundary information binds the exact displayed Face and every displayed edge, rejecting foreign or duplicate loops',()=>{
  assert.equal(parseFaceBoundaries(summary(),'face-4-1',presentation).loops.length,3);
  for(const mutate of [value=>value.faceId='face-3-1',value=>value.loops[1].edgeIds=['edge-4-99'],value=>value.loops[1].edgeIds=['edge-4-1'],value=>value.loops[1].edgeIds.push('edge-4-2'),value=>value.loops[2].loopId='loop-2',value=>value.loops[1].closed='true',value=>value.loops[1].length=NaN]){const value=summary();mutate(value);assert.throws(()=>parseFaceBoundaries(value,'face-4-1',presentation));}
});
test('hole correspondence remains explicit, one-to-one, closed and complete; a different edge of the same loop is equivalent',()=>{
  assert.equal(loopMappingIssue(summary(),['edge-4-2','edge-4-4']),null);assert.equal(loopMappingIssue(summary(),['edge-4-3','edge-4-4'],2),null);
  for(const seeds of [[],['',''],['edge-4-2'],['edge-4-2','edge-4-3'],['edge-4-1','edge-4-4']])assert.ok(loopMappingIssue(summary(),seeds));
  assert.ok(loopMappingIssue(summary(),['edge-4-2','edge-4-4'],1));for(const flag of ['complete','planar','valid'])assert.ok(loopMappingIssue({...summary(),[flag]:false},['edge-4-2','edge-4-4']));
});
test('v3 is a real Loft and saved sections retain their identities without leaking or rewriting opaque selectors',()=>{
  const rows=[1,2].map(index=>({sectionId:`section-${index}`,bodyId:`body-${index}`,featureId:`feature-${index}`,holeSelectors:['opaque-a','opaque-b']})),feature={stringParameters:{loftVersion:'3',loftSections:JSON.stringify(rows)}};
  assert.equal(loftVersionKind(feature),'real');const restored=initialLoftSections(feature);assert.deepEqual(restored.map(row=>row.holeCount),[2,2]);assert.deepEqual(loftSectionInputs(restored),[{sectionId:'section-1'},{sectionId:'section-2'}]);assert.equal(JSON.stringify(restored).includes('opaque'),false);
  assert.equal(loftVersionKind({stringParameters:{}}),'legacy');assert.equal(loftVersionKind({stringParameters:{loftVersion:'99'}}),'unsupported');assert.throws(()=>initialLoftSections({stringParameters:{loftVersion:'99'}}));
});
test('new sections serialize complete mappings and cannot mix hole counts or silently fill corrupt saved definitions',()=>{
  const rows=[1,2].map(index=>({key:String(index),bodyId:`body-${index}`,faceId:`face-${index}-1`,holeCount:2,holeEdgeIds:[`edge-${index}-2`,`edge-${index}-4`]}));assert.equal(loftSectionInputs(rows)[0].holeEdgeIds.length,2);
  assert.throws(()=>loftSectionInputs([rows[0],{...rows[1],holeCount:0}]));assert.throws(()=>loftSectionInputs([rows[0],{...rows[1],holeEdgeIds:['edge-2-2','edge-2-2']}]));
  for(const loftSections of ['broken','[]',JSON.stringify([{sectionId:'section-1',bodyId:'body-1',featureId:'feature-1'},{sectionId:'section-2',bodyId:'body-2',featureId:'feature-2'}])])assert.throws(()=>initialLoftSections({stringParameters:{loftVersion:'3',loftSections}}));
});
