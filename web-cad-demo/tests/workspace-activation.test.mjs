import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWorkspaceActivation,normalizeWorkspaceActivationProof} from '../shared/workspace-activation.mjs';
import {ModelingController} from '../app/modeling/modeling-controller.ts';
import {idleWorkspaceResponse,activatedWorkspaceResponse} from './helpers/workspace-activation-fixture.mjs';
const input=patch=>({protocolVersion:1,operation:'project.activate',documentId:'target',sourceDocumentId:'default',requestId:'switch-1',sourceRevision:4,sourceStateToken:'a'.repeat(64),sourceStateSequence:5,...patch});
const snapshot=(id='default',patch={})=>({ok:true,documentId:id,revision:4,stateToken:'a'.repeat(64),stateSequence:5,features:[],bodyMetadata:[],...patch});
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const hold=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('activation canonicalizes exact source/target/request/state and rejects partial or hidden inputs',()=>{
  const value=input();assert.deepEqual(normalizeWorkspaceActivation(Object.fromEntries(Object.entries(value).reverse())),value);assert.notEqual(normalizeWorkspaceActivation(value),value);
  for(const patch of [{extra:1},{requestId:undefined},{sourceDocumentId:'../source'},{documentId:'x'.repeat(65)},{sourceRevision:-1},{sourceRevision:null},{sourceStateToken:null},{sourceStateSequence:null},{sourceStateToken:'bad'},{sourceStateSequence:1.5},{operation:'document.create'}])assert.throws(()=>normalizeWorkspaceActivation(input(patch)));
  assert.deepEqual(normalizeWorkspaceActivation(input({sourceRevision:null,sourceStateToken:null,sourceStateSequence:null})).sourceRevision,null);
  assert.equal(normalizeWorkspaceActivation(input({documentId:'default'})).documentId,'default','Reloading the same workspace uses one barrier');
});
test('activation proof must bind every original field and cannot be replaced by an unrelated successful view',()=>{
  const original=input();assert.deepEqual(normalizeWorkspaceActivationProof(original,original),original);
  for(const patch of [{documentId:'other'},{sourceDocumentId:'other'},{requestId:'other'},{sourceRevision:5},{sourceStateToken:'b'.repeat(64)},{sourceStateSequence:6}])assert.throws(()=>normalizeWorkspaceActivationProof(input(patch),original));
  assert.throws(()=>normalizeWorkspaceActivationProof(undefined,original));
});
async function fixture(options={}){const calls=[];const controller=new ModelingController({taskControl:true,fetchImpl:async(url,init)=>{url=String(url);calls.push({url,init});if(url.endsWith('/commands'))return json(snapshot());if(url.endsWith('/activity'))return options.activity?options.activity(url):idleWorkspaceResponse(url);if(url.endsWith('/activate'))return options.activate?options.activate(url,init):activatedWorkspaceResponse(snapshot('target'),init);throw Error('Unexpected '+url);}});if(options.loaded!==false)await controller.execute({operation:'document.view'});controller.setSelection({kind:'body',bodyId:'source-box'});return {controller,calls};}
test('source and target Pi busy or unknown states block both restore and file open before any write',async()=>{
  for(const blocked of ['default','target'])for(const status of ['busy','unknown']){
    const f=await fixture({activity:async url=>{const response=await idleWorkspaceResponse(url).json();if(response.documentId===blocked)response.activity.status=status;return json(response);}}),before=f.controller.getSnapshot();
    try{await assert.rejects(f.controller.restoreWorkspace('target'),{code:'PI_DOCUMENT_NOT_IDLE'});assert.equal(f.calls.some(call=>call.init?.method==='POST'&&!call.url.endsWith('/commands')),false);assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.getSnapshot().selection,before.selection);assert.equal(f.controller.hasWorkspaceTransfer(),false);}finally{f.controller.disposeTaskTracking();}
  }
  const f=await fixture({activity:async url=>{const value=await idleWorkspaceResponse(url).json();value.activity.status='busy';return json(value);}});try{await assert.rejects(f.controller.openProject(new File(['bytes'],'model.cadproj')),{code:'PI_DOCUMENT_NOT_IDLE'});assert.equal(f.calls.some(call=>call.url.includes('/project/open')),false);}finally{f.controller.disposeTaskTracking();}
});
test('restore sends one exact source-bound request and atomically adopts only a matching proof',async()=>{
  const held=hold(),f=await fixture({activate:()=>held.promise}),before=f.controller.getSnapshot();try{
    const pending=f.controller.restoreWorkspace('target');await tick();const call=f.calls.find(call=>call.url.endsWith('/activate')),command=JSON.parse(call.init.body).command;
    assert.equal(command.sourceDocumentId,'default');assert.equal(command.sourceRevision,4);assert.equal(command.sourceStateSequence,5);assert.equal(call.init.headers['X-Request-Id'],command.requestId);assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.hasWorkspaceTransfer(),true);await assert.rejects(f.controller.execute({operation:'body.delete'}),{code:'WORKSPACE_TRANSFER_BUSY'});
    held.resolve(activatedWorkspaceResponse(snapshot('target'),call.init));await pending;assert.equal(f.controller.getSnapshot().documentId,'target');assert.equal(f.controller.getSnapshot().selection,null);assert.equal(f.calls.filter(call=>call.url.endsWith('/activate')).length,1);assert.equal(f.controller.getSnapshot().busy,false);
  }finally{f.controller.disposeTaskTracking();}
});
test('missing or mismatched activation proofs never fall back to a source-less activation or adopt the target',async()=>{
  for(const transform of [()=>undefined,command=>({...command,sourceDocumentId:'foreign'}),command=>({...command,requestId:'foreign'}),command=>({...command,sourceStateSequence:99})]){
    const f=await fixture({activate:(_url,init)=>json({...snapshot('target'),workspaceActivation:transform(JSON.parse(init.body).command)})}),before=f.controller.getSnapshot();try{await assert.rejects(f.controller.restoreWorkspace('target'),{code:'WORKSPACE_ACTIVATION_UNCONFIRMED'});assert.equal(f.controller.getSnapshot().model,before.model);assert.equal(f.controller.getSnapshot().documentId,'default');assert.equal(f.calls.filter(call=>call.url.endsWith('/activate')).length,1);}finally{f.controller.disposeTaskTracking();}
  }
});
test('an unloaded source uses explicit null baseline while a loaded incomplete model cannot silently downgrade to it',async()=>{
  const unloaded=await fixture({loaded:false});try{await unloaded.controller.restoreWorkspace('target');const command=JSON.parse(unloaded.calls.find(call=>call.url.endsWith('/activate')).init.body).command;assert.equal(command.sourceRevision,null);assert.equal(command.sourceStateToken,null);assert.equal(command.sourceStateSequence,null);}finally{unloaded.controller.disposeTaskTracking();}
  const controller=new ModelingController({fetchImpl:async()=>json({ok:true,documentId:'default',revision:4,features:[]})});await controller.execute({operation:'document.view'});await assert.rejects(controller.restoreWorkspace('target'),{code:'WORKSPACE_SOURCE_UNCONFIRMED'});
});
test('source changes during preflight or target read reject late activation without reverting the current source',async()=>{
  for(const phase of ['preflight','view']){const held=hold(),f=await fixture(phase==='preflight'?{activity:url=>held.promise.then(()=>idleWorkspaceResponse(url))}:{activate:()=>held.promise});try{const pending=f.controller.restoreWorkspace('target'),checked=assert.rejects(pending,{code:'WORKSPACE_TRANSFER_SUPERSEDED'});await tick();const newer=snapshot('default',{revision:5,stateSequence:6,stateToken:'b'.repeat(64)});f.controller.adoptModel(newer);const call=f.calls.find(call=>call.url.endsWith('/activate'));held.resolve(phase==='preflight'?undefined:activatedWorkspaceResponse(snapshot('target'),call.init));await checked;assert.equal(f.controller.getSnapshot().model,newer);assert.equal(f.controller.getSnapshot().documentId,'default');}finally{f.controller.disposeTaskTracking();}}
});
test('same-document restore is a proven read, never an activation or an idle-Pi preflight',async()=>{
  const calls=[],controller=new ModelingController({fetchImpl:async(url,init)=>{calls.push(String(url));return json({...snapshot(),workspaceRead:{protocolVersion:1,operation:'project.read',documentId:'default',requestId:init.headers['X-Request-Id']}});}});
  await controller.restoreWorkspace('default');assert.equal(controller.getSnapshot().revision,4);assert.equal(calls.length,1);assert.match(calls[0],/\/projects\/default\/view$/);assert.equal(controller.hasWorkspaceTransfer(),false);
});
