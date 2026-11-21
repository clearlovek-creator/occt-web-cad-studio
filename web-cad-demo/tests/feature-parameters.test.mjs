import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../app/modeling/feature-parameters.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {editableNumberEntries}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
test('pattern instance totals are derived, not editable parameters',()=>{
  assert.deepEqual(editableNumberEntries({type:'pattern.rectangular',numberParameters:{count:6,countX:3,countY:2}}),[['countX',3],['countY',2]]);
  assert.deepEqual(editableNumberEntries({type:'pattern.mirror',numberParameters:{count:2,normalX:1}}),[['normalX',1]]);
  assert.deepEqual(editableNumberEntries({type:'pattern.linear',numberParameters:{count:3,spacing:20}}),[['count',3],['spacing',20]]);
});
test('feature parameter fields hide internal matrices but retain Torus major/minor radii',()=>{
  assert.deepEqual(editableNumberEntries({numberParameters:{majorRadius:30,minorRadius:5,m11:1,m14:4,csOriginX:7,x:10,height:20}}),[['majorRadius',30],['minorRadius',5],['x',10],['height',20]]);
});
