import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../app/modeling/feature-input.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {validateFeatureInput,validateReferenceInput,featureInputRequest,featureSelectionEdit,coordinateSelectionEdit,inputEdgeSegments,sweepInputSlots,changeRepairSource}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const fixture=()=>({ok:true,documentId:'test',revision:3,stateToken:'a'.repeat(64),inputPreview:{featureId:'feature-3',featureType:'detail.shell',sourceBodyId:'body-1',sourceBodyIdentity:'b'.repeat(32),sourceFeatureId:'feature-2',kind:'face',inputFingerprint:'c'.repeat(64),selectionState:'resolved',resolvedIndex:1,diagnostic:'',presentation:{bodyId:'body-1',topologyRevision:0,positions:[0,0,0,1,0,0,0,1,0],normals:[0,0,1,0,0,1,0,0,1],indices:[0,1,2],triangleFaceIds:['face-0-1'],edges:[{edgeId:'edge-0-1',points:[0,0,0,1,0,0]}],stats:{faceCount:1,edgeCount:1,triangleCount:1}}}});
test('historical inspection carries the original operation without executing it and rejects an old worker ignoring that proposal',()=>{
  const request={operation:'variable.set',parameters:{name:'holeX',type:'length',expression:'200 mm'},baseRevision:7,baseStateToken:'old',options:{preview:true}};
  assert.deepEqual(featureInputRequest({request,targetFeatureId:'feature-3',documentId:'test',stateToken:'old'}),{operation:'feature.input.preview',inputs:{featureId:'feature-3'},parameters:{proposal:{operation:'variable.set',inputs:{},parameters:request.parameters}}});
  const value=fixture();assert.throws(()=>validateFeatureInput(value,'test','feature-3','variable.set'),/未按本次修改/);
  value.proposalOperation='coordinate.set';assert.throws(()=>validateFeatureInput(value,'test','feature-3','variable.set'),/未按本次修改/);
  value.proposalOperation='variable.set';assert.equal(validateFeatureInput(value,'test','feature-3','variable.set'),value);
});
test('historical input validation binds the document, feature, identity and exact rendered topology',()=>{
  const value=fixture();assert.equal(validateFeatureInput(value,'test','feature-3'),value);
  const edit=featureSelectionEdit(value,1);assert.deepEqual(edit,{documentId:'test',featureId:'feature-3',sourceBodyId:'body-1',sourceBodyIdentity:'b'.repeat(32),sourceFeatureId:'feature-2',kind:'face',inputFingerprint:'c'.repeat(64),index:1});
  assert.throws(()=>featureSelectionEdit(value,2),/实际显示/);assert.throws(()=>validateFeatureInput(value,'other','feature-3'),/来源不符/);assert.throws(()=>validateFeatureInput(value,'test','feature-4'),/来源不符/);
  value.inputPreview.presentation.stats.truncated=true;assert.throws(()=>featureSelectionEdit(value,1),/截断/);
});
test('malformed and foreign historical buffers never become selectable',()=>{
  const variants=[v=>v.revision=-1,v=>v.stateToken='invalid',v=>v.inputPreview.sourceBodyIdentity='invalid',v=>v.inputPreview.presentation.positions[0]=NaN,v=>v.inputPreview.presentation.indices[1]=99,v=>v.inputPreview.presentation.triangleFaceIds[0]='face-3-1',v=>v.inputPreview.presentation.bodyId='foreign',v=>v.inputPreview.presentation.topologyRevision=3,v=>v.inputPreview.selectionState='guessed',v=>v.inputPreview.resolvedIndex=2,v=>v.inputPreview.presentation.stats.truncated='false',v=>v.inputPreview.presentation.edges.push(v.inputPreview.presentation.edges[0])];
  for(const mutate of variants){const value=fixture();mutate(value);assert.throws(()=>validateFeatureInput(value,'test','feature-3'),/来源不符/);}
});
test('edge segments retain an exact owner per rendered segment',()=>{
  assert.deepEqual(inputEdgeSegments([{edgeId:'edge-0-7',points:[0,0,0,1,0,0,2,0,0]},{edgeId:'edge-0-9',points:[3,0,0,4,0,0]}]),{positions:[0,0,0,1,0,0,1,0,0,2,0,0,3,0,0,4,0,0],topology:[7,7,9]});
  const value=fixture();value.inputPreview.kind='edge';assert.equal(featureSelectionEdit(value,1).kind,'edge');
});

test('coordinate repair binds its owner and exact historical output, never a different feature preview or raw index',()=>{
  const value=fixture();value.inputPreview.coordinateSystemId='attached';value.inputPreview.featureType='coordinate.face';value.inputPreview.featureId=value.inputPreview.sourceFeatureId;value.proposalOperation='feature.update';
  const proposal={request:{operation:'feature.update',parameters:{height:30},inputs:{featureId:'feature-1'}},targetCoordinateId:'attached',sourceFeatureId:'feature-2',sourceBodyId:'body-1'};
  assert.equal(validateReferenceInput(value,'test',proposal),value);
  assert.deepEqual(featureInputRequest(proposal).inputs,{coordinateSystemId:'attached',sourceFeatureId:'feature-2',sourceBodyId:'body-1'});
  const edit=coordinateSelectionEdit(value,1);assert.equal(edit.coordinateSystemId,'attached');assert.equal(edit.featureId,undefined);assert.equal(edit.inputFingerprint,'c'.repeat(64));
  assert.throws(()=>validateReferenceInput(value,'test',{...proposal,targetCoordinateId:'other'}),/来源不符/);
  assert.throws(()=>validateReferenceInput(value,'test',{...proposal,sourceBodyId:'other'}),/来源不符/);
  assert.throws(()=>validateReferenceInput(value,'test',{request:proposal.request,targetFeatureId:'feature-2'}),/引用对象不符/);
  assert.throws(()=>coordinateSelectionEdit(value,99),/实际显示/);
  value.inputPreview.presentation.stats.truncated=true;assert.throws(()=>coordinateSelectionEdit(value,1),/截断/);
});

test('Loft inspection and repairs bind an exact section slot, not merely the owning feature',()=>{
  const value=fixture();value.inputPreview.featureType='detail.loft';value.inputPreview.sectionId='section-2';value.proposalOperation='feature.update';
  const proposal={request:{operation:'feature.update',inputs:{featureId:'feature-1'},parameters:{x:8}},targetFeatureId:'feature-3',targetSectionId:'section-2',sourceFeatureId:'feature-2',sourceBodyId:'body-1'};
  assert.equal(validateReferenceInput(value,'test',proposal),value);assert.deepEqual(featureInputRequest(proposal).inputs,{featureId:'feature-3',sectionId:'section-2',sourceFeatureId:'feature-2',sourceBodyId:'body-1'});
  assert.equal(featureSelectionEdit(value,1).sectionId,'section-2');
  for(const change of [{targetSectionId:'section-1'},{sourceFeatureId:'other'},{sourceBodyId:'other'}])assert.throws(()=>validateReferenceInput(value,'test',{...proposal,...change}),/来源不符/);
  assert.throws(()=>validateReferenceInput(value,'test',{request:proposal.request,targetFeatureId:'feature-3'}),/引用对象不符/);
  assert.throws(()=>coordinateSelectionEdit(value,1),/面坐标系/);
  value.inputPreview.kind='edge';assert.throws(()=>featureSelectionEdit(value,1),/放样截面/);
});

test('Loft hole edits use only distinct rendered historical edge indexes with the required slot count',()=>{
  const value=fixture();Object.assign(value.inputPreview,{featureType:'detail.loft',sectionId:'section-1',requiredHoleCount:1,selectedHoleIndexes:[0]});
  assert.equal(validateFeatureInput(value,'test','feature-3'),value);assert.deepEqual(featureSelectionEdit(value,1,[1]).holeIndexes,[1]);
  for(const indexes of [[],[99],[1,1]])assert.throws(()=>featureSelectionEdit(value,1,indexes),/孔对应/);
  value.inputPreview.requiredHoleCount=17;assert.throws(()=>validateFeatureInput(value,'test','feature-3'));
});

test('curved sweep repair proof is bound to the exact input slot and supports real wire-only historical outputs',()=>{
  const value=fixture();Object.assign(value.inputPreview,{featureType:'detail.pipe',kind:'edge',sweepInputId:'path-2'});value.proposalOperation='feature.update';
  const p=value.inputPreview.presentation;Object.assign(p,{positions:[],normals:[],indices:[],triangleFaceIds:[],stats:{faceCount:0,edgeCount:1,triangleCount:0}});
  const proposal={request:{operation:'feature.update',inputs:{featureId:'feature-1'},parameters:{dx:5}},targetFeatureId:'feature-3',targetSweepInputId:'path-2',sourceFeatureId:'feature-2',sourceBodyId:'body-1'};
  assert.equal(validateReferenceInput(value,'test',proposal),value);assert.equal(featureInputRequest(proposal).inputs.sweepInputId,'path-2');assert.equal(featureSelectionEdit(value,1).sweepInputId,'path-2');
  for(const change of [{targetSweepInputId:'path-1'},{targetSectionId:'section-1'},{sourceBodyId:'other'},{sourceFeatureId:'other'}])assert.throws(()=>validateReferenceInput(value,'test',{...proposal,...change}),/来源不符/);
  assert.throws(()=>validateReferenceInput(value,'test',{request:proposal.request,targetFeatureId:'feature-3'}),/引用对象不符/);
  assert.throws(()=>coordinateSelectionEdit(value,1),/面坐标系/);value.inputPreview.kind='face';assert.throws(()=>featureSelectionEdit(value,1),/曲线扫掠/);
});

test('curve input lists retain explicit keys and expose deterministic distinct keys for pre-slot v2 files',()=>{
  const feature={stringParameters:{sweepVersion:'2',sweepProfile:JSON.stringify({bodyId:'profile',featureId:'source-profile'}),sweepPath:JSON.stringify({bodyId:'wire',featureId:'source-wire',edges:[{}, {inputId:'path-99'}]})}};
  const before=JSON.stringify(feature),slots=sweepInputSlots(feature);assert.deepEqual(slots.map(item=>item.inputId),['profile','legacy-path-1','path-99']);assert.deepEqual(slots.map(item=>item.kind),['face','edge','edge']);assert.equal(JSON.stringify(feature),before);assert.deepEqual(sweepInputSlots(undefined),[]);
});

test('changing a shared path source clears only that feature path draft, preserving profile and unrelated staged repairs',()=>{
  const edits=[{featureId:'sweep',sweepInputId:'path-old'},{featureId:'sweep',sweepInputId:'profile'},{featureId:'loft',sectionId:'section-1'},{featureId:'another',sweepInputId:'path-other'}],proposal={request:{operation:'feature.update',parameters:{dx:8,selectionEdits:edits,coordinateSelectionEdits:[{coordinateSystemId:'local'}]}},targetFeatureId:'sweep',targetSweepInputId:'path-next'},before=JSON.stringify(proposal),changed=changeRepairSource(proposal,'new-feature','new-body');
  assert.deepEqual(changed.request.parameters.selectionEdits,edits.slice(1));assert.equal(changed.sourceBodyId,'new-body');assert.equal(changed.request.parameters.dx,8);assert.deepEqual(changed.request.parameters.coordinateSelectionEdits,proposal.request.parameters.coordinateSelectionEdits);assert.equal(JSON.stringify(proposal),before);
  assert.deepEqual(changeRepairSource({...proposal,targetSweepInputId:'profile'},'new-feature','new-body').request.parameters.selectionEdits,edits);
});
