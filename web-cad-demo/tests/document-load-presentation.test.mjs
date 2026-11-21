import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../app/modeling/document-load.ts',import.meta.url),'utf8'),js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {documentLoadLabel:label,parseDocumentLoad:parse}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
test('load phases describe real work without pretending to know a completion percentage',()=>{
  for(const phase of ['waiting','checking','restoring-geometry','restoring-project-data','finalizing','ready','failed']){const text=label({state:'loading',phase});assert.ok(text.length>1);assert.doesNotMatch(text,/%/);}
  assert.equal(label({state:'failed',phase:'unknown'}),'载入失败');assert.equal(label({state:'unloaded',phase:'unknown'}),'尚未载入');
});
test('load status parsing rejects malformed states, finite-negative timings and non-text errors',()=>{
  for(const value of [null,undefined,'loading',{},[],{state:'surprise',phase:'ready'},{state:'ready'}])assert.equal(parse(value),null);
  const status=parse({state:'loading',phase:'restoring-geometry',elapsedMs:-1,error:{secret:1},recovered:'yes'});assert.equal(status.elapsedMs,undefined);assert.equal(status.error,null);assert.equal(status.recovered,false);
  assert.equal(parse({state:'loading',phase:'checking',elapsedMs:Infinity}).elapsedMs,undefined);assert.equal(parse({state:'loading',phase:'checking',elapsedMs:2500}).elapsedMs,2500);
});
