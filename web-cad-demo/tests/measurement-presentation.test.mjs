import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
async function source(name){const text=await readFile(new URL(`../app/modeling/${name}.ts`,import.meta.url),'utf8');return import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText).toString('base64'));}
const {engineeringNumber:format,fullPrecisionNumber:full}=await source('engineering-number');
const {measurementTargetKey:key,measurementState:status,measurementMatches:matches,compactMeasurement:compact,measurementRows:rows}=await source('measurement');

test('engineering display preserves tiny nonzero values, finite extremes, signs and clear missing data',()=>{
  for(const [value,expected] of [[0,'0'],[-0,'0'],[12.3456789123,'12.345679'],[1e-4,'0.0001'],[1.23456789123e-7,'123.45679e-9'],[-1.23456789123e-7,'-123.45679e-9'],[1e7,'10e+6'],[1.23456789123e12,'1.2345679e+12'],[Number.MIN_VALUE,'4.9406565e-324'],[Number.MAX_VALUE,'179.76931e+306']])assert.equal(format(value),expected,String(value));
  for(const value of [undefined,null,NaN,Infinity,-Infinity,'0','1e-9',{},[]])assert.equal(format(value),'—');
  for(const digits of [1,2,8,15])for(const value of [Number.MIN_VALUE,Number.MAX_VALUE,-Number.MIN_VALUE,-Number.MAX_VALUE])assert.doesNotMatch(format(value,digits),/NaN|Infinity|^0$/);
  for(const digits of [0,16,1.5,NaN])assert.throws(()=>format(1,digits),RangeError);
  assert.equal(full(1.23456789123e-7),'1.23456789123e-7');assert.equal(full(-0),'0');assert.equal(full(null),'—');
});

test('engineering exponents are multiples of three and the displayed approximation remains bounded',()=>{
  for(let exponent=-300;exponent<=300;exponent+=7)for(const sign of [-1,1]){
    const value=sign*1.234567891234*10**exponent,text=format(value),display=Number(text);
    assert.ok(Number.isFinite(display)&&display!==0);assert.ok(Math.abs((display-value)/value)<5e-8,`${value}: ${text}`);
    if(text.includes('e'))assert.equal(Math.abs(Number(text.split('e')[1])%3),0);
  }
  assert.equal(format(9999999.99),'10e+6');assert.equal(format(.0000999999999),'0.0001');
});

const target={documentId:'doc',bodyId:'body-1',selectionType:'face',selectionId:'face-5-2'},result={...target,stateToken:'token-A',revision:5,area:1.23456789123e-7,perimeter:.00123456789123,centroid:[1e-9,-2,3],bounds:{min:[0,0,0],max:[1,2,3]}};
test('measurement results bind to the complete document state and selection, never just the revision or topology index',()=>{
  const snapshot={target,stateToken:'token-A',result};assert.equal(status(snapshot,{...target},'token-A'),'current');
  assert.equal(status(snapshot,{...target,selectionId:'face-5-3'},'token-A'),'different-target');
  for(const different of [{...target,documentId:'other'},null])assert.equal(status(snapshot,different,'token-A'),'stale');
  assert.equal(status(snapshot,target,'token-B'),'stale');assert.equal(status(snapshot,target,null),'stale');
  assert.equal(matches(result,target,'token-A'),true);
  for(const bad of [{...result,bodyId:'body-2'},{...result,selectionId:'face-5-3'},{...result,selectionType:'edge'},{...result,documentId:'other'},{...result,stateToken:'token-B'},{...result,stateToken:undefined}])assert.equal(matches(bad,target,'token-A'),false);
  assert.notEqual(key({...target,bodyId:'body-2'}),key(target));assert.notEqual(key({...target,selectionType:'edge'}),key(target));
});

test('compact measurement exports full numeric values with correct dimensions and no document trees or render buffers',()=>{
  const value=compact({...result,bodyMetadata:[{secret:'unrelated'}],positions:[1,2,3],materials:[{}]});
  assert.equal(value.area,result.area);assert.equal(value.perimeter,result.perimeter);assert.deepEqual(value.centroid,result.centroid);
  for(const excluded of ['bodyMetadata','positions','materials'])assert.equal(excluded in value,false);
  const faceRows=rows(value);assert.equal(faceRows.find(row=>row.key==='area').unit,'mm²');assert.equal(faceRows.find(row=>row.key==='perimeter').unit,'mm');assert.equal(faceRows.find(row=>row.key==='bounds-min').vector,true);
  const bodyRows=rows({...value,selectionType:'body',volume:1e-15,length:2e-7,edgeLengthPolicy:'unique-topological-edges'});assert.equal(bodyRows.find(row=>row.key==='volume').unit,'mm³');assert.equal(bodyRows.find(row=>row.key==='length').label,'拓扑边总长');assert.match(rows({...value,selectionType:'body'}).find(row=>row.key==='length').label,/旧口径/);
  const edgeRows=rows({...value,selectionType:'edge',radius:1e-8,endpoints:[[0,0,0],[1,2,3]],center:[1,2,3],curveType:'circle'});assert.ok(edgeRows.some(row=>row.key==='center'));assert.equal(edgeRows.filter(row=>row.key.startsWith('endpoint-')).length,2);assert.equal(edgeRows.find(row=>row.key==='curveType').text,true);
});
