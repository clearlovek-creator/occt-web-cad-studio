import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
const transpile=file=>ts.transpileModule(fs.readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const drag='data:text/javascript;base64,'+Buffer.from(transpile('../app/modeling/grid-drag.ts')).toString('base64');
const source=transpile('../app/modeling/construction-frame.ts').replace('"./grid-drag"',JSON.stringify(drag));
const {constructionFrame,constructionToWorld,worldToConstruction,constructionDragCommand,snappedConstructionPoint,GLOBAL_CONSTRUCTION_COORDINATE,dragDimension}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('a construction plane follows translated and rotated coordinate axes in both directions',()=>{
  const frame=constructionFrame({id:'local',name:'Local',origin:[100,200,50],xAxis:[0,1,0],yAxis:[0,0,1]});assert.deepEqual(frame.z,[1,0,0]);
  assert.deepEqual(constructionToWorld(frame,[10,20,30]),[130,210,70]);assert.deepEqual(worldToConstruction(frame,[130,210,70]),[10,20,30]);
  assert.deepEqual(snappedConstructionPoint(frame,[100,210.24,220.26],.5),[10,170.5,0]);
});
test('all fourteen primitives preserve their chosen coordinate and the native placement without changing preview dimensions',()=>{
  const frame=constructionFrame({id:'skew',name:'Legacy skew',origin:[100,200,300],xAxis:[2,0,0],yAxis:[1,2,0]});assert.equal(frame.legacyPlacement,true);
  for(const kind of ['box','cylinder','cone','sphere','torus','wedge','prism','pyramid','tube','surface-rectangle','surface-disk','surface-cylinder','surface-cone','surface-sphere']){
    const command=constructionDragCommand(kind,{x:10,y:20},{x:40,y:60},.5,15,frame);assert.equal(command.parameters.coordinateSystemId,'skew');
    const native=[100+command.parameters.x+command.parameters.y,200+command.parameters.y*2,300];
    const shape=kind.replace('surface-',''),centered=['rectangle','pyramid'].includes(shape);
    assert.deepEqual(native,constructionToWorld(frame,centered?[25,40,0]:[10,20,0]),kind);
    assert.equal(command.preview.width,['box','wedge','pyramid','rectangle'].includes(shape)?30:100);
  }
});
test('global commands stay compatible; fractional snapping and readouts never round a valid submillimeter height to zero',()=>{
  const frame=constructionFrame(GLOBAL_CONSTRUCTION_COORDINATE);const command=constructionDragCommand('box',{x:0,y:0},{x:.4,y:.6},.1,.2,frame);
  assert.equal(frame.legacyPlacement,false);assert.equal(command.parameters.height,.2);assert.equal(dragDimension(.2),'0.2');assert.equal(dragDimension(1.00000000001),'1');
  assert.equal(constructionDragCommand('box',{x:0,y:0},{x:0,y:0},1,20,frame),null);
});
test('invalid and nearly parallel axes are rejected instead of substituting Global',()=>{
  assert.throws(()=>constructionFrame({...GLOBAL_CONSTRUCTION_COORDINATE,associationMode:'associative',referenceState:'unresolved'}),/引用失效/);
  for(const value of [{origin:[NaN,0,0]},{xAxis:[0,0,0]},{yAxis:[1,0,0]},{xAxis:[1e200,0,0]}])assert.throws(()=>constructionFrame({...GLOBAL_CONSTRUCTION_COORDINATE,...value}));
});
