import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelingController} from '../app/modeling/modeling-controller.ts';
import {CommandEditSession} from '../app/modeling/command-edit-session.ts';
const reply=(revision,sequence,token,extra={})=>new Response(JSON.stringify({ok:true,documentId:'default',revision,stateSequence:sequence,stateToken:token,positions:[],bodyId:'body-1',...extra}));

test('historical input queries retain the edit lease and full replay previews never replace the live model',async()=>{
  const requests=[],responses=[reply(3,7,'live'),reply(3,7,'live',{positions:undefined,inputPreview:{featureId:'feature-3'}}),reply(3,7,'live',{positions:[999,999,999],features:[{id:'proposed'}],preview:{state:'preview'}})];
  const controller=new ModelingController({fetchImpl:async(_url,init)=>{requests.push(JSON.parse(init.body));return responses.shift();}});
  await controller.execute({operation:'document.view'});const before=controller.getSnapshot().model,session=new CommandEditSession(controller);
  await session.execute({operation:'feature.input.preview',inputs:{featureId:'feature-3'}});
  assert.equal(requests.at(-1).baseStateToken,'live');assert.equal(requests.at(-1).baseRevision,3);
  const proposed=await session.execute({operation:'feature.update',options:{preview:true}});
  assert.deepEqual(proposed.positions,[999,999,999]);assert.equal(controller.getSnapshot().model,before);assert.equal(session.getBaseline().stateToken,'live');assert.equal(session.isStale(),false);
});

test('a conflict during historical input loading freezes the original lease without a silent retry',async()=>{
  let calls=0;const controller=new ModelingController({fetchImpl:async()=>++calls===1?reply(3,7,'old'):new Response(JSON.stringify({ok:false,code:'PROJECT_STATE_CONFLICT',error:'The same revision has a new property event'}),{status:409})});
  await controller.execute({operation:'document.view'});const session=new CommandEditSession(controller);
  await assert.rejects(session.execute({operation:'feature.input.preview',inputs:{featureId:'feature-3'}}),error=>error.code==='PROJECT_STATE_CONFLICT');
  assert.equal(session.isStale(),true);assert.equal(session.getBaseline().stateToken,'old');assert.equal(session.isBusy(),false);assert.equal(calls,2);
  await assert.rejects(session.execute({operation:'feature.input.preview'}));assert.equal(calls,2);
});

test('naming verification uses the original lease as a state-bound read and does not advance it',async()=>{
  const requests=[],responses=[reply(3,7,'live'),reply(3,7,'live',{positions:undefined,importedNamingUpgrade:{preview:true}})];
  const controller=new ModelingController({fetchImpl:async(_url,init)=>{requests.push(JSON.parse(init.body));return responses.shift();}});
  await controller.execute({operation:'document.view'});const session=new CommandEditSession(controller);await session.execute({operation:'document.naming.preview'});
  assert.equal(requests.at(-1).baseRevision,3);assert.equal(requests.at(-1).baseStateToken,'live');assert.equal(session.getBaseline().stateToken,'live');assert.equal(session.isStale(),false);
});

test('an editor never rebases an old draft when another command changes the engineering state',async()=>{
  const requests=[],responses=[reply(1,1,'a'),reply(2,2,'b'),reply(3,3,'c'),reply(4,4,'d')];
  const controller=new ModelingController({fetchImpl:async(_url,init)=>{requests.push(JSON.parse(init.body));return responses.shift();}});
  await controller.execute({operation:'document.view'});const old=new CommandEditSession(controller);
  await controller.execute({operation:'variable.set'});
  await assert.rejects(old.execute({operation:'feature.update',parameters:{width:99}}),error=>error.code==='PROJECT_STATE_CONFLICT');
  assert.equal(requests.length,2);assert.equal(old.getBaseline().stateToken,'a');
  const fresh=new CommandEditSession(controller);await fresh.execute({operation:'feature.update',baseRevision:1});assert.equal(requests.at(-1).baseRevision,2);assert.equal(requests.at(-1).baseStateToken,'b');
  await fresh.execute({operation:'transform.translate'});assert.equal(requests.at(-1).baseStateToken,'c');assert.equal(requests.at(-1).baseRevision,3);assert.equal(fresh.isStale(),false);
});

test('same-revision late responses and higher native revisions cannot overwrite a newer Undo generation',async()=>{
  const pending=[],controller=new ModelingController({fetchImpl:()=>new Promise(resolve=>pending.push(resolve))});
  const old=controller.execute({operation:'document.view'}),newer=controller.execute({operation:'property.type.create'});
  pending[1](reply(5,11,'new',{history:{eventId:'new'}}));await newer;pending[0](reply(5,10,'old',{history:{eventId:'old'}}));await old;
  assert.equal(controller.getSnapshot().stateToken,'new');assert.equal(controller.getSnapshot().history.eventId,'new');
  const undo=controller.execute({operation:'document.undo'});pending[2](reply(4,12,'undo'));await undo;
  assert.equal(controller.getSnapshot().revision,4);assert.equal(controller.getSnapshot().stateSequence,12);
  assert.equal(controller.adoptModel({ok:true,revision:5,stateSequence:11,stateToken:'late',positions:[]}),false);
  assert.equal(controller.getSnapshot().stateToken,'undo');
});

test('read-only refreshes do not renew an edit lease; batches use one precondition and one journal record',async()=>{
  const requests=[],responses=[reply(1,1,'a'),reply(1,2,'b'),reply(3,3,'c')];
  const controller=new ModelingController({fetchImpl:async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return responses.shift();}});
  await controller.execute({operation:'document.view'});const old=new CommandEditSession(controller);await old.execute({operation:'document.summary'});
  assert.equal(old.isStale(),true);assert.equal(old.getBaseline().stateToken,'a');
  const fresh=new CommandEditSession(controller);await fresh.executeBatch([{operation:'material.set',parameters:{name:'M'}},{operation:'material.property.set',parameters:{value:9}}]);
  assert.match(requests.at(-1).url,/command-batches$/);assert.equal(requests.at(-1).body.baseStateToken,'b');assert.equal(requests.at(-1).body.steps.length,2);
  const journal=controller.getSnapshot().commandLog.at(-1);assert.equal(journal.operation,'project.batch');assert.equal(journal.status,'success');assert.equal(JSON.stringify(journal).includes('material.property.set'),false);
});

test('server conflicts are not automatically retried and never advance the edit baseline',async()=>{
  let calls=0;const controller=new ModelingController({fetchImpl:async()=>++calls===1?reply(1,1,'a'):new Response(JSON.stringify({ok:false,code:'PROJECT_STATE_CONFLICT',error:'changed'}),{status:409})});
  await controller.execute({operation:'document.view'});const session=new CommandEditSession(controller);
  await assert.rejects(session.execute({operation:'variable.set'}),error=>error.code==='PROJECT_STATE_CONFLICT');assert.equal(calls,2);assert.equal(session.getBaseline().stateToken,'a');assert.equal(session.isBusy(),false);
  assert.equal(session.isStale(),true);await assert.rejects(session.execute({operation:'variable.set'}));assert.equal(calls,2,'A conflict must require explicit reload, not a second request with renewed preconditions');
});

test('a form opened over older displayed geometry cannot borrow a newer controller token; duplicate submissions are blocked',async()=>{
  let resolve,calls=0;const controller=new ModelingController({fetchImpl:async()=>{calls++;return calls===1?reply(2,2,'new'):new Promise(done=>resolve=done);}});
  await controller.execute({operation:'document.view'});
  const oldPixels=new CommandEditSession(controller,{documentId:'default',revision:2,stateToken:'old'});assert.equal(oldPixels.isStale(),true);await assert.rejects(oldPixels.execute({operation:'body.delete'}));assert.equal(calls,1);
  const fresh=new CommandEditSession(controller),first=fresh.execute({operation:'variable.set'});await assert.rejects(fresh.execute({operation:'variable.set'}),error=>error.code==='EDITOR_BUSY');assert.equal(calls,2);resolve(reply(3,3,'done'));await first;
  assert.equal(fresh.isBusy(),false);assert.equal(controller.acceptsState({stateSequence:-1}),false);
});
