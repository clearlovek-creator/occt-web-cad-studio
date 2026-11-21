import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../app/modeling/feature-input.ts',import.meta.url),'utf8'),js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {validateSweepSourcePresentation}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const wire=()=>({bodyId:'wire',topologyRevision:4,positions:[],normals:[],indices:[],triangleFaceIds:[],edges:[{edgeId:'edge-4-1',points:[0,0,0,0,0,20]}],stats:{faceCount:0,edgeCount:1,triangleCount:0}});
test('real edge-only paths are accepted without inventing a Face mesh or mutating the source',()=>{const p=wire(),before=JSON.stringify(p);assert.equal(validateSweepSourcePresentation(p,'wire'),p);assert.equal(JSON.stringify(p),before);});
test('incomplete, wrong-owner, nonfinite and out-of-range source displays cannot bind a sweep selection',()=>{
  assert.throws(()=>validateSweepSourcePresentation(wire(),'another-body'));
  for(const mutate of [p=>p.edges[0].points.push(NaN),p=>p.edges[0].edgeId='edge-3-1',p=>p.edges[0].edgeId='edge-4-2',p=>p.edges.push({...p.edges[0]}),p=>p.stats.truncated=true,p=>p.stats.faceCount=-1,p=>p.indices=[0,1,2]]){const p=wire();mutate(p);assert.throws(()=>validateSweepSourcePresentation(p,'wire'));}
});
