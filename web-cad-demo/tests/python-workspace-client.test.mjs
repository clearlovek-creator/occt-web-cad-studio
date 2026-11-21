import test from 'node:test';
import assert from 'node:assert/strict';
import {PythonAgentClient} from '../app/modeling/python-agent-client.ts';
import {ModelingController} from '../app/modeling/modeling-controller.ts';
import {idleWorkspaceResponse,activatedWorkspaceResponse} from './helpers/workspace-activation-fixture.mjs';

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const state=(runId='old-run',documentId='alpha',status='waiting_user',runVersion=1)=>({run_id:runId,document_id:documentId,project_id:'web-demo',user_id:'web-user',status,run_version:runVersion,document_revision:0,waiting_request_id:'question-1',waiting_approval_id:'approval-1'});
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const pathOf=url=>new URL(url,'http://local').pathname;
function setup(handler,change=()=>{}){const client=new PythonAgentClient('/py',handler,'web-demo','web-user',change);client.setDocumentId('alpha');return client;}
function creationStatus(body,status='waiting_user',version=1){return {...state(body.client_run_id,body.document_id,status,version),client_creation:body};}
async function storage(action){const previous=globalThis.window,values=new Map(),impl={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};globalThis.window={localStorage:impl,sessionStorage:impl};try{return await action(values);}finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}}
const snapshot=id=>({ok:true,documentId:id,revision:1,stateToken:'a'.repeat(64),stateSequence:1,features:[],positions:[]});

test('same-workspace geometry read preserves an unconfirmed Python Run and its durable recovery binding',async()=>storage(async values=>{
  let body,posts=0;const controller=new ModelingController({apiRoot:'/api',documentId:'alpha',agentBackend:'python',agentApiRoot:'/py',fetchImpl:async(url,init)=>{const p=pathOf(url);if(p.endsWith('/view'))return json({...snapshot('alpha'),workspaceRead:{protocolVersion:1,operation:'project.read',documentId:'alpha',requestId:init.headers['X-Request-Id']}});if(init.method==='POST'){posts++;body=JSON.parse(init.body);throw Error('lost reply');}return json({detail:'unknown'},404);}});
  await controller.loadAgentConversation();await assert.rejects(controller.streamAgentRun('preserve this request'),{code:'PYTHON_AGENT_RESULT_UNCONFIRMED'});const before=controller.getSnapshot(),bytes=values.get('modeling-agent:python:alpha');assert.match(bytes,new RegExp(body.client_run_id));await controller.restoreWorkspace('alpha');assert.equal(controller.getSnapshot().agentConversation,before.agentConversation);assert.equal(controller.getSnapshot().agentRun,before.agentRun);assert.equal(values.get('modeling-agent:python:alpha'),bytes);assert.equal(posts,1);await assert.rejects(controller.restoreWorkspace('beta'),{code:'PYTHON_AGENT_BUSY'});
}));

test('Python creation captures its ID before POST and a lost reply recovers only by exact scoped GET',async()=>{
  const calls=[];let original,client,recorded;
  client=setup(async(url,init)=>{calls.push({url,method:init.method});if(init.method==='POST'){original=JSON.parse(init.body);assert.equal(recorded.pending.runId,original.client_run_id);throw Error('reply lost after server creation');}const u=new URL(url,'http://local');assert.equal(u.searchParams.get('document_id'),'alpha');assert.equal(u.searchParams.get('project_id'),'web-demo');assert.equal(u.searchParams.get('user_id'),'web-user');return json(creationStatus(original));},()=>recorded=client.getRecoveryState());
  const result=await client.run('Original request');assert.equal(result.responseAction,'observed');assert.match(original.client_run_id,/^py-run-/);assert.deepEqual(calls.map(value=>value.method),['POST','GET']);assert.equal(client.getRecoveryState().pending,null);assert.equal(client.getActiveStatus().run_id,original.client_run_id);assert.equal(client.blocksWorkspaceSwitch(),false);
});

test('an unknown original creation survives client recreation and neither send nor clear can forget it',async()=>{
  const calls=[];let original,available=false;
  const fetcher=async(url,init)=>{calls.push(init.method);if(init.method==='POST'){original=JSON.parse(init.body);throw Error('lost');}if(!available)return json({detail:'missing'},404);return json(creationStatus(original));};
  const first=setup(fetcher);await assert.rejects(first.run('create'),{code:'PYTHON_AGENT_RESULT_UNCONFIRMED'});const saved=first.getRecoveryState();assert.equal(saved.unconfirmed,true);const second=setup(fetcher);second.restoreRecoveryState(saved);assert.equal(second.blocksWorkspaceSwitch(),true);await assert.rejects(second.run('do not repeat'),{code:'PYTHON_AGENT_RESULT_UNCONFIRMED'});assert.throws(()=>second.clear(),{code:'PYTHON_AGENT_BUSY'});available=true;await second.refreshActiveRun();assert.equal(second.getRecoveryState().pending,null);assert.equal(second.blocksWorkspaceSwitch(),false);assert.equal(calls.filter(value=>value==='POST').length,1);
});

test('foreign creation receipts or modified original parameters never replace the pending identity',async()=>{
  for(const patch of [{document_id:'foreign'},{project_id:'foreign'},{user_id:'foreign'},{run_id:'other'},{client_creation:{message:'other'}}]){
    let body;const client=setup(async(url,init)=>{if(init.method==='POST')body=JSON.parse(init.body);return json({...creationStatus(body),...patch});});await assert.rejects(client.run('original'),{code:'PYTHON_AGENT_RESULT_UNCONFIRMED'});assert.equal(client.getRecoveryState().pending.runId,body.client_run_id);assert.equal(client.getActiveStatus(),null);
  }
});

test('creation binding comparison is independent of JSON key order',async()=>{
  let body;const client=setup(async(url,init)=>{if(init.method==='POST')body=JSON.parse(init.body);const current=creationStatus(body);current.client_creation=Object.fromEntries(Object.entries(body).reverse());return json(current);});assert.equal((await client.run('preserve values')).status.document_id,'alpha');
});

test('status and recovery values exposed to UI callers cannot mutate the internal Run binding',async()=>{
  const paths=[],client=setup(async(url)=>{paths.push(pathOf(url));return json(state('bound-run','alpha','completed',3));});const original=state('bound-run','alpha','waiting_approval',2);client.restoreStatus(original);original.run_id='foreign';const exposed=client.getActiveStatus();exposed.run_id='foreign';exposed.document_id='beta';const cache=client.getRecoveryState();cache.run.run_id='other';const result=await client.run('approve',true);assert.equal(result.status.status,'completed');assert.ok(paths.every(path=>path.includes('/bound-run')));
});

test('a document change fences a delayed Python POST before any follow-up GET or current-owner callback',async()=>{
  const hold=deferred(),calls=[],changes=[];let body,client;
  client=setup(async(url,init)=>{calls.push(init.method);body=JSON.parse(init.body);return hold.promise;},()=>changes.push(client.getRecoveryState()));
  const pending=client.run('alpha only'),rejected=assert.rejects(pending,{code:'PYTHON_AGENT_DOCUMENT_CHANGED'});await tick();client.setDocumentId('beta');const before=changes.length;hold.resolve(json(creationStatus(body)));await rejected;assert.deepEqual(calls,['POST']);assert.equal(changes.length,before);assert.equal(client.getActiveStatus(),null);assert.equal(client.getRecoveryState().documentId,'beta');
});

test('a second Python send while a request is pending cannot create another Run',async()=>{
  const hold=deferred();let body,posts=0;
  const client=setup(async(url,init)=>{if(init.method==='POST'){posts++;body=JSON.parse(init.body);return hold.promise;}return json(creationStatus(body));});const pending=client.run('first');await tick();await assert.rejects(client.run('second'),{code:'PYTHON_AGENT_BUSY'});hold.resolve(json(creationStatus(body)));await pending;assert.equal(posts,1);
});

test('lost response and approval writes cannot be cleared by a GET of the pre-submit version',async()=>{
  for(const kind of ['waiting_user','waiting_approval']){
    let version=2,posts=0;const client=setup(async(url,init)=>{if(init.method==='POST'){posts++;throw Error('accepted reply missing');}return json(state('bound-run','alpha',version===2?kind:'completed',version));});client.restoreStatus(state('bound-run','alpha',kind,2));
    await assert.rejects(client.run('answer',true),{code:'PYTHON_AGENT_RESULT_UNCONFIRMED'});assert.equal(client.getRecoveryState().pending.runVersion,2);await assert.rejects(client.run('must not resend',true),{code:'PYTHON_AGENT_RESULT_UNCONFIRMED'});version=3;assert.equal((await client.refreshActiveRun()).status,'completed');assert.equal(posts,1);assert.equal(client.blocksWorkspaceSwitch(),false);
  }
});

test('late lower versions cannot revive a completed Python Run during a concurrent read and approval',async()=>{
  const hold=deferred();let firstGet=true;
  const client=setup(async(url,init)=>{if(init.method==='GET'&&firstGet){firstGet=false;return hold.promise;}return json(state('run','alpha','completed',3));});client.restoreStatus(state('run','alpha','waiting_approval',2));
  // Start the write first; a concurrent read is permitted but cannot regress it.
  const writing=client.run('approve',true);const reading=client.refreshActiveRun();await tick();hold.resolve(json(state('run','alpha','waiting_approval',2)));const [write,read]=await Promise.all([writing,reading]);assert.equal(write.status.status,'completed');assert.equal(read.status,'completed');assert.equal(client.getActiveStatus(),null);
});

test('invalid cached pending identities fail closed and are not adopted into another workspace',()=>{
  for(const pending of [{runId:'../x',kind:'create'},{runId:'run',kind:'approval'},{runId:'other',kind:'approval',runVersion:1}]){const client=setup(async()=>{throw Error('not called');});assert.throws(()=>client.restoreRecoveryState({version:1,documentId:'alpha',run:state('run'),pending}),{code:'PYTHON_AGENT_RECOVERY_INVALID'});assert.equal(client.blocksWorkspaceSwitch(),true);assert.throws(()=>client.clear(),{code:'PYTHON_AGENT_BUSY'});}
});

test('known executing and external-wait Runs block switches while dormant Runs keep their identity without starting new work',async()=>{
  for(const status of ['created','running','waiting_external','paused']){let calls=0;const client=setup(async()=>{calls++;throw Error('not called');});client.restoreStatus(state('run','alpha',status));assert.equal(client.blocksWorkspaceSwitch(),status!=='paused');await assert.rejects(client.run('do not replace'),{code:'PYTHON_AGENT_BUSY'});assert.throws(()=>client.clear(),{code:'PYTHON_AGENT_BUSY'});assert.equal(calls,0);}
});

test('404 and malformed read replies retain original Run ownership and require a successful read before new writes',async()=>{
  let available=false;const client=setup(async()=>available?json(state('run')):json({detail:'Run missing'},404));client.restoreStatus(state('run'));await assert.rejects(client.refreshActiveRun(),error=>error.status===404);assert.equal(client.blocksWorkspaceSwitch(),true);assert.equal(client.getRecoveryState().run.run_id,'run');assert.equal(client.getRecoveryState().unconfirmed,true);available=true;await client.refreshActiveRun();assert.equal(client.blocksWorkspaceSwitch(),false);
});

test('native UTF-8/JSON and response-byte limits cannot silently lose the pending creation',async()=>{
  for(const response of [()=>new Response(new Uint8Array([255])),()=>new Response('x'.repeat(4*1024*1024+1))]){let posts=0;const client=setup(async(url,init)=>{if(init.method==='POST')posts++;return response();});await assert.rejects(client.run('create'),{code:'PYTHON_AGENT_RESULT_UNCONFIRMED'});assert.equal(client.getRecoveryState().pending.kind,'create');assert.equal(posts,1);}
});

test('controller activation changes the underlying Python document and preserves separate source/target conversations and Runs',async()=>storage(async values=>{
  const runs=new Map(),posts=[],getScopes=[];const controller=new ModelingController({apiRoot:'/api',documentId:'alpha',agentBackend:'python',agentApiRoot:'/py',fetchImpl:async(url,init)=>{const p=pathOf(url);if(p.endsWith('/activity'))return idleWorkspaceResponse(url);if(p.endsWith('/activate'))return activatedWorkspaceResponse(snapshot(p.split('/')[3]),init);if(init.method==='POST'){const body=JSON.parse(init.body);posts.push(body);const current=creationStatus(body);runs.set(body.client_run_id,current);return json(current);}const parsed=new URL(url,'http://local');getScopes.push(parsed.searchParams.get('document_id'));return json(runs.get(p.split('/').at(-1)));}});
  await controller.loadAgentConversation();await controller.appendAgentMessage({role:'user',content:'alpha private'});await controller.streamAgentRun('alpha plan');const alpha=values.get('modeling-agent:python:alpha');await controller.restoreWorkspace('beta');assert.equal(values.get('modeling-agent:python:alpha'),alpha);await controller.loadAgentConversation();await controller.appendAgentMessage({role:'user',content:'beta private'});await controller.streamAgentRun('beta plan');assert.deepEqual(posts.map(body=>body.document_id),['alpha','beta']);assert.equal(controller.getSnapshot().agentConversation.documentId,'beta');assert.doesNotMatch(values.get('modeling-agent:python:beta'),/alpha private/);await controller.restoreWorkspace('alpha');const restored=await controller.loadAgentConversation();assert.equal(restored.messages[0].content,'alpha private');assert.equal(controller.getSnapshot().agentRun.run_id,posts[0].client_run_id);assert.equal(getScopes.at(-1),'alpha');
}));

test('controller recreation retains an unknown creation and blocks switching, clearing and reposting until scoped recovery succeeds',async()=>storage(async values=>{
  let body,available=false,posts=0,activations=0;const fetcher=async(url,init)=>{if(pathOf(url).endsWith('/activity'))return idleWorkspaceResponse(url);if(pathOf(url).endsWith('/activate')){activations++;return activatedWorkspaceResponse(snapshot('beta'),init);}if(init.method==='POST'){posts++;body=JSON.parse(init.body);throw Error('lost');}return available?json(creationStatus(body)):json({detail:'not yet readable'},404);};
  const make=()=>new ModelingController({apiRoot:'/api',documentId:'alpha',agentBackend:'python',agentApiRoot:'/py',fetchImpl:fetcher});const first=make();await first.loadAgentConversation();await assert.rejects(first.streamAgentRun('original'),{code:'PYTHON_AGENT_RESULT_UNCONFIRMED'});assert.equal(JSON.parse(values.get('modeling-agent:python:alpha')).recovery.pending.runId,body.client_run_id);const second=make();await assert.rejects(second.restoreWorkspace('beta'),{code:'PYTHON_AGENT_BUSY'});await assert.rejects(second.createAgentConversation(),{code:'PYTHON_AGENT_BUSY'});await assert.rejects(second.deleteAgentConversation(second.getSnapshot().agentConversation.id),{code:'PYTHON_AGENT_BUSY'});assert.equal(activations,0);available=true;await second.loadAgentConversation();await second.restoreWorkspace('beta');assert.equal(activations,1);assert.equal(posts,1);
}));

test('a late Python conversation refresh cannot overwrite the new workspace, error state or cache key',async()=>storage(async values=>{
  const hold=deferred();let body,holding=false;const controller=new ModelingController({apiRoot:'/api',documentId:'alpha',agentBackend:'python',agentApiRoot:'/py',fetchImpl:async(url,init)=>{if(pathOf(url).endsWith('/activity'))return idleWorkspaceResponse(url);if(pathOf(url).endsWith('/activate'))return activatedWorkspaceResponse(snapshot('beta'),init);if(init.method==='POST'){body=JSON.parse(init.body);return json(creationStatus(body));}if(holding)return hold.promise;return json(creationStatus(body));}});
  await controller.loadAgentConversation();await controller.streamAgentRun('source');holding=true;const pending=controller.loadAgentConversation(),rejected=assert.rejects(pending,{code:'PYTHON_AGENT_DOCUMENT_CHANGED'});await tick();const alpha=values.get('modeling-agent:python:alpha');await controller.restoreWorkspace('beta');hold.resolve(json(creationStatus(body)));await rejected;assert.equal(controller.getSnapshot().documentId,'beta');assert.equal(controller.getSnapshot().agentConversation,null);assert.equal(controller.getSnapshot().agentProviderError,null);assert.equal(values.get('modeling-agent:python:alpha'),alpha);assert.equal(values.has('modeling-agent:python:beta'),false);
}));

test('invalid Python source cache is preserved byte-for-byte and cannot be erased by starting or switching a conversation',async()=>storage(async values=>{
  const key='modeling-agent:python:alpha',bytes=JSON.stringify({conversation:{id:'foreign',documentId:'beta',messages:[]}});values.set(key,bytes);let calls=0;const controller=new ModelingController({documentId:'alpha',agentBackend:'python',fetchImpl:async()=>{calls++;throw Error('not called');}});assert.match(controller.getSnapshot().agentConversationError,/保留/);await assert.rejects(controller.loadAgentConversation(),{code:'PYTHON_AGENT_RECOVERY_INVALID'});await assert.rejects(controller.restoreWorkspace('beta'),{code:'PYTHON_AGENT_BUSY'});assert.equal(values.get(key),bytes);assert.equal(calls,0);
}));

test('browser storage refusal prevents Python mutation before POST and keeps the original cache unchanged',async()=>storage(async values=>{
  let calls=0;const controller=new ModelingController({documentId:'alpha',agentBackend:'python',fetchImpl:async()=>{calls++;throw Error('must not send');}});await controller.loadAgentConversation();const key='modeling-agent:python:alpha',before=values.get(key);window.localStorage.setItem=()=>{throw Error('quota');};await assert.rejects(controller.streamAgentRun('do not send without recovery'),{code:'PYTHON_AGENT_RECOVERY_WRITE_FAILED'});assert.equal(calls,0);assert.equal(values.get(key),before);assert.equal(controller.getSnapshot().busy,false);
}));
