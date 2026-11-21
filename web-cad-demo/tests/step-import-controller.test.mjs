import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelingController} from '../app/modeling/modeling-controller.ts';
import {idleWorkspaceResponse,activatedWorkspaceResponse} from './helpers/workspace-activation-fixture.mjs';
const token='a'.repeat(64),nextToken='b'.repeat(64),stamp=new Date().toISOString();
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const model=(revision=5,stateSequence=5,documentId='default')=>({ok:true,documentId,revision,stateSequence,stateToken:token,positions:[],bodyId:'original'});
const status=(requestId,phase='converting',sequence=3,documentId='default')=>({version:1,documentId,requestId,fileName:'part.step',phase,sequence,createdAt:stamp,updatedAt:stamp});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('STEP imports freeze document and baseline, journal the request and keep busy through concurrent reads',async()=>{
  const pending=deferred(),calls=[];const controller=new ModelingController({fetchImpl:async(url,init)=>{calls.push({url,init});return url.endsWith('/imports/step')?pending.promise:json(model());}});
  await controller.execute({operation:'document.view'});const file=new File(['STEP bytes'],'零件.step'),importing=controller.importStep(file);
  const upload=calls.at(-1),requestId=upload.init.headers['X-Request-Id'];
  assert.equal(upload.init.headers['X-Base-State-Token'],token);assert.equal(upload.init.headers['X-Base-Revision'],'5');assert.equal(decodeURIComponent(upload.init.headers['X-File-Name']),'零件.step');assert.equal(upload.init.body,file);
  assert.equal(controller.hasPendingMutation(),true);await assert.rejects(controller.restoreWorkspace('other'),/尚未完成/);await assert.rejects(controller.importStep(file),/尚未完成/);
  await controller.execute({operation:'document.summary'});assert.equal(controller.getSnapshot().busy,true);
  pending.resolve(json({...model(1,6),stateToken:nextToken,bodyId:'imported',stepImportStatus:{...status(requestId,'complete',6),stateToken:nextToken,revision:1}}));await importing;
  const state=controller.getSnapshot();assert.equal(state.busy,false);assert.equal(state.revision,1,'STEP may reset native revision; increasing stateSequence is authoritative');assert.equal(state.model.bodyId,'imported');assert.equal(state.stepImportStatus.phase,'complete');assert.equal(state.commandLog.find(item=>item.requestId===requestId).status,'success');
});

test('a lost HTTP import reply preserves the model and never resubmits its bytes',async()=>{
  let uploads=0,requestId;const controller=new ModelingController({fetchImpl:async(url,init)=>{if(url.endsWith('/imports/step')){uploads++;requestId=init.headers['X-Request-Id'];throw Error('lost response');}if(url.includes('/status'))return json({ok:true,documentId:'default',stepImportStatus:{...status(requestId,'complete',6),stateToken:nextToken,revision:1}});return json(model());}});
  await controller.execute({operation:'document.view'});const before=controller.getSnapshot().model;
  await assert.rejects(controller.importStep(new Blob(['bytes'])),e=>e.code==='STEP_IMPORT_RESULT_UNKNOWN'&&e.recoverable===false);
  assert.equal(controller.getSnapshot().stepImportStatus.phase,'unknown');assert.equal(controller.getSnapshot().model,before);await controller.refreshStepImportStatus(requestId);
  assert.equal(controller.getSnapshot().stepImportStatus.phase,'complete');assert.equal(controller.getSnapshot().model,before,'Polling does not fabricate a geometry view');assert.equal(uploads,1);
});

test('a completion already observed by polling is not regressed when the HTTP reply is lost',async()=>{
  const pending=deferred();let requestId;const controller=new ModelingController({fetchImpl:async(url,init)=>{if(url.endsWith('/imports/step')){requestId=init.headers['X-Request-Id'];return pending.promise;}if(url.includes('/status'))return json({ok:true,documentId:'default',stepImportStatus:{...status(requestId,'complete',6),revision:1,stateToken:nextToken}});return json(model());}});
  await controller.execute({operation:'document.view'});const importing=controller.importStep(new Blob(['bytes']));const rejected=assert.rejects(importing,e=>e.code==='STEP_IMPORT_RESULT_UNKNOWN');
  await controller.refreshStepImportStatus(requestId);assert.equal(controller.getSnapshot().busy,true,'Original POST remains pending until its actual result');pending.reject(Error('lost'));await rejected;
  assert.equal(controller.getSnapshot().stepImportStatus.phase,'complete');assert.equal(controller.getSnapshot().busy,false);assert.match(controller.getSnapshot().stepImportNotice,/后台记录显示已完成/);
});

test('STEP parse failure leaves the full existing model and records failure without retry',async()=>{
  let uploads=0;const controller=new ModelingController({fetchImpl:async url=>{if(url.endsWith('/imports/step')){uploads++;return json({ok:false,code:'STEP_READ_FAILED',error:'bad STEP'},400);}return json(model());}});
  await controller.execute({operation:'document.view'});const before=controller.getSnapshot().model;await assert.rejects(controller.importStep(new Blob(['bad'])),e=>e.code==='STEP_READ_FAILED');
  assert.equal(controller.getSnapshot().model,before);assert.equal(controller.getSnapshot().stepImportStatus.phase,'failed');assert.equal(controller.getSnapshot().busy,false);assert.equal(uploads,1);assert.equal(controller.getSnapshot().commandLog.at(-1).status,'error');
});

test('a production bridge interruption keeps STEP outcome unknown until a read-only status confirms it',async()=>{
  let uploads=0,requestId;
  const controller=new ModelingController({fetchImpl:async(url,init)=>{
    if(url.endsWith('/imports/step')){uploads++;requestId=init.headers['X-Request-Id'];return json({ok:false,code:'FRONTEND_GATEWAY_UNAVAILABLE',error:'后台连接中断，未重发请求。',recoverable:false},503);}
    if(url.includes('/imports/step/status'))return json({ok:true,documentId:'default',stepImportStatus:{...status(requestId,'complete',6),revision:1,stateToken:nextToken}});
    return json(model());
  }});
  await controller.execute({operation:'document.view'});const before=controller.getSnapshot().model;
  await assert.rejects(controller.importStep(new Blob(['bytes'])),error=>error.code==='FRONTEND_GATEWAY_UNAVAILABLE'&&error.recoverable===false);
  assert.equal(controller.getSnapshot().stepImportStatus.phase,'unknown');assert.equal(controller.getSnapshot().model,before);assert.equal(uploads,1);
  await controller.refreshStepImportStatus(requestId);assert.equal(controller.getSnapshot().stepImportStatus.phase,'complete');assert.equal(uploads,1,'Status reconciliation cannot resend a STEP upload');
});

test('a failed HTTP import response preserves its verified unchanged diagnostics without waiting for polling',async()=>{
  const controller=new ModelingController({fetchImpl:async(url,init)=>{if(url.endsWith('/imports/step'))return json({ok:false,code:'STEP_READ_FAILED',error:'bad STEP',stepImportStatus:{...status(init.headers['X-Request-Id'],'failed',5),unchanged:true,error:'bad STEP'}},400);return json(model());}});
  await controller.execute({operation:'document.view'});await assert.rejects(controller.importStep(new Blob(['bad'])));assert.equal(controller.getSnapshot().stepImportStatus.unchanged,true);assert.equal(controller.getSnapshot().stepImportStatus.sequence,5);
});

test('malformed or foreign success replies cannot be adopted as a completed import',async()=>{
  for(const payload of [undefined,{},model(1,6,'other')]){
    const controller=new ModelingController({fetchImpl:async url=>url.endsWith('/imports/step')?(payload===undefined?new Response('Not Found',{status:404}):json(payload)):json(model())});
    await controller.execute({operation:'document.view'});const before=controller.getSnapshot().model;await assert.rejects(controller.importStep(new Blob(['bytes'])),e=>e.code==='STEP_IMPORT_RESULT_UNKNOWN');
    assert.equal(controller.getSnapshot().model,before);assert.equal(controller.getSnapshot().stepImportStatus.phase,'unknown');
  }
});

test('phase polls cannot regress completion or replace a newer request and old poll failures stay scoped',async()=>{
  let reply,delayOnce=true;const delayed=deferred();const controller=new ModelingController({fetchImpl:async url=>{if(url.includes('old-error')&&delayOnce){delayOnce=false;return delayed.promise;}return json({ok:true,documentId:'default',stepImportStatus:reply});}});
  reply=status('old-error');await controller.refreshStepImportStatus();const oldError=controller.refreshStepImportStatus('old-error');const handled=assert.rejects(oldError);
  reply={...status('new','complete',6),createdAt:new Date(Date.parse(stamp)+1000).toISOString()};await controller.refreshStepImportStatus();
  delayed.reject(Error('obsolete poll failure'));await handled;assert.equal(controller.getSnapshot().stepImportNotice,null);
  reply={...status('new','unknown',7),createdAt:new Date(Date.parse(stamp)+1000).toISOString()};await controller.refreshStepImportStatus('new');assert.equal(controller.getSnapshot().stepImportStatus.phase,'complete');
  reply=status('old-error','converting',99);await controller.refreshStepImportStatus('old-error');assert.equal(controller.getSnapshot().stepImportStatus.requestId,'new');
});

test('late status snapshots for another document do not overwrite the activated workspace',async()=>{
  const pending=deferred();const controller=new ModelingController({fetchImpl:async(url,init)=>url.endsWith('/activity')?idleWorkspaceResponse(url):url.endsWith('/activate')?activatedWorkspaceResponse(model(2,2,'other'),init):pending.promise});
  const loading=controller.refreshStepImportStatus();await controller.restoreWorkspace('other');pending.resolve(json({ok:true,documentId:'default',stepImportStatus:status('old','complete',6)}));await loading;
  assert.equal(controller.getSnapshot().documentId,'other');assert.equal(controller.getSnapshot().stepImportStatus,null);
});

test('a status read from the wrong engineering document is rejected even when its report is null',async()=>{
  const controller=new ModelingController({fetchImpl:async()=>json({ok:true,documentId:'other',stepImportStatus:null})});
  await assert.rejects(controller.refreshStepImportStatus(),/工程/);assert.equal(controller.getSnapshot().stepImportStatus,null);
});
