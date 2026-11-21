import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../app/model/feature-graph.ts',import.meta.url),'utf8'),js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2017}}).outputText;
const {buildStructuredBodyHistory,unrepresentedSuppressedFeatures,featureOutputName}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const feature=(id,type,inputs,outputs,state='valid',strings={})=>({id,type,inputFeatures:inputs,outputBodies:outputs,state,computedRevision:1,numberParameters:{},stringParameters:strings});

test('suppressed generated features without a live history remain discoverable by feature identity',()=>{
  const base=feature('base','surface.disk',[],['body-1']),loft=feature('loft','detail.loft',['base'],['body-2'],'suppressed'),sweep=feature('sweep','detail.sweep',['base'],['body-3'],'suppressed'),features=[base,loft,sweep];
  assert.deepEqual(unrepresentedSuppressedFeatures(features,[buildStructuredBodyHistory(features,'body-1')]).map(f=>f.id),['loft','sweep']);
  assert.deepEqual(unrepresentedSuppressedFeatures(features,[]).map(f=>f.id),['loft','sweep']);assert.deepEqual(unrepresentedSuppressedFeatures([base],[]),[]);
});

test('a reachable suppressed unary feature or pattern is not duplicated, even when its Body is collapsed or hidden',()=>{
  const base=feature('base','primitive.box',[],['body-1']),move=feature('move','transform.translate',['base'],['body-1'],'suppressed'),pattern=feature('pattern','pattern.linear',['move'],['body-1','body-2'],'suppressed'),features=[base,move,pattern],histories=new Map([['body-1',buildStructuredBodyHistory(features,'body-1')]]);
  assert.deepEqual(unrepresentedSuppressedFeatures(features,histories.values()),[]);
});

test('suppressed history nested under a Boolean input is reachable independently of UI expansion',()=>{
  const a=feature('a','primitive.box',[],['body-1']),b=feature('b','primitive.cylinder',[],['body-2']),move=feature('move','transform.translate',['b'],['body-2'],'suppressed'),cut=feature('cut','boolean.cut',['a','move'],['body-1'],'valid',{targetBody:'body-1',toolBody:'body-2'}),features=[a,b,move,cut];
  assert.deepEqual(unrepresentedSuppressedFeatures(features,[buildStructuredBodyHistory(features,'body-1')]),[]);
});

test('recovery labels use stored output metadata without inventing live geometry',()=>{
  const f=feature('loft','detail.loft',[],['body-2'],'suppressed',{'outputBodyMeta.body-2.name':'Transition'});assert.equal(featureOutputName(f),'Transition');delete f.stringParameters['outputBodyMeta.body-2.name'];f.stringParameters['lifecycleBodyMeta.body-2.name']='Recovered';assert.equal(featureOutputName(f),'Recovered');f.stringParameters={};assert.equal(featureOutputName(f),'Loft');assert.deepEqual(f.outputBodies,['body-2']);
});

test('consumed Boolean inputs keep their snapshot names and old files fall back without altering the graph',()=>{
  const a=feature('a','primitive.box',[],['body-1']),b=feature('b','primitive.cylinder',[],['body-2']),cut=feature('cut','boolean.cut',['a','b'],['body-1'],'valid',{targetBody:'body-1',toolBody:'body-2','inputBodyMeta.body-2.name':'Boring tool'}),features=[a,b,cut],before=structuredClone(features);
  assert.equal(buildStructuredBodyHistory(features,'body-1').at(-1).inputBodies[0].name,'Boring tool');assert.deepEqual(features,before);delete cut.stringParameters['inputBodyMeta.body-2.name'];assert.equal(buildStructuredBodyHistory(features,'body-1').at(-1).inputBodies[0].name,undefined);
});
