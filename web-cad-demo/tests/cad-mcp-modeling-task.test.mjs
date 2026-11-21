import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {executeMcpModelingTask} from '../gateway/cad-mcp-modeling-task.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const response=(payload,status=200)=>new Response(JSON.stringify(payload),{status});
function fixture() {
  const calls=[],token='a'.repeat(64),now=new Date().toISOString();let task,command;
  const f={calls,command:{documentId:'doc',operation:'primitive.box',parameters:{width:'boardWidth',depth:3,height:4}},
    phase(phase,patch={}){task={...task,phase,sequence:task.sequence+1,cancellable:['reserved','queued','executing'].includes(phase),...patch};return task;},
    success(){f.phase('succeeded',{revision:9,stateToken:token,cancellable:false});return {ok:true,documentId:'doc',requestId:'gateway-later-view',revision:9,stateToken:token,bodyCount:2,modelingTask:task};},
    packet(value=task,status=200){return response({ok:true,documentId:'doc',modelingTask:value},status);},
    get task(){return task;},get input(){return command;}};
  f.fetch=async(url,init={})=>{
    calls.push({url,init});
    if(url.endsWith('/modeling-tasks')) {
      command=JSON.parse(init.body).command;
      task={version:1,taskId:randomUUID(),documentId:'doc',operation:command.operation,requestKey:command.requestId,phase:'reserved',sequence:1,createdAt:now,updatedAt:now,cancelRequested:false,cancellable:true,reportDurable:true};
      return f.reserve?f.reserve():f.packet(task,201);
    }
    if(url.endsWith('/commands')){assert.equal(init.headers['X-Cad-Task-Id'],task.taskId);assert.deepEqual(JSON.parse(init.body),command);return f.submit?f.submit(init):response(f.success());}
    if(url.endsWith('/cancel')){assert.equal(init.method,'POST');assert.equal(init.body,'{}');return f.cancel?f.cancel():f.packet(f.phase('cancelled',{execution:'not-started',cancelRequested:true,cancellable:false}),202);}
    if(url.endsWith('/result'))return f.receipt();
    return f.status?f.status():f.packet();
  };
  f.run=options=>executeMcpModelingTask({root:'http://unit/api',command:f.command,fetchImpl:f.fetch,pollMs:1,...options});
  f.count=suffix=>calls.filter(row=>row.url.endsWith(suffix)).length;
  return f;
}

test('each mutation binds one generated request key and original frozen command to one task, preserving expressions and native diagnostic IDs',async()=>{
  const f=fixture(),before=structuredClone(f.command);f.command.requestId='caller-cannot-reuse-old-key';before.requestId=f.command.requestId;
  const result=await f.run();assert.equal(result.ok,true);assert.equal(result.requestId,'gateway-later-view');assert.equal(result.modelingTask.requestKey,f.input.requestId);assert.notEqual(f.input.requestId,f.command.requestId);assert.equal(f.count('/modeling-tasks'),1);assert.equal(f.count('/commands'),1);assert.deepEqual(f.command,before);
});
test('a stopped tool cannot register or submit a task',async()=>{const f=fixture(),abort=new AbortController();abort.abort();await assert.rejects(f.run({signal:abort.signal}),{code:'MCP_CANCELLED_BEFORE_SEND',outcome:'not-started'});assert.equal(f.calls.length,0);});
test('stop while registration is pending cancels only the original reservation and never sends the geometry command',async()=>{
  const f=fixture(),held=deferred(),entered=deferred(),abort=new AbortController();f.reserve=async()=>{entered.resolve();await held.promise;return f.packet(f.task,201);};
  const work=f.run({signal:abort.signal});await entered.promise;abort.abort();held.resolve();await assert.rejects(work,{code:'MCP_CANCELLED_BEFORE_EXECUTION',outcome:'not-started'});assert.equal(f.count('/commands'),0);assert.equal(f.count('/cancel'),1);
});
test('stop of sent native work waits for an authoritative restored terminal result, not the cancel acknowledgement',async()=>{
  const f=fixture(),entered=deferred(),held=deferred(),cancelled=deferred(),abort=new AbortController();let settled=false;
  f.submit=async init=>{f.phase('executing');entered.resolve(init);return held.promise;};f.cancel=()=>{f.phase('stopping',{cancelRequested:true,cancellable:false});cancelled.resolve();return f.packet(f.task,202);};
  const work=f.run({signal:abort.signal});work.then(()=>settled=true,()=>settled=true);const init=await entered.promise;abort.abort();await cancelled.promise;await turn();assert.equal(settled,false);assert.equal(init.signal.aborted,false,'Aborting HTTP observation would not cancel the native kernel');
  f.phase('cancelled',{restored:true,cancellable:false,code:'WORKER_CANCELLED'});held.resolve(response({ok:false,code:'WORKER_CANCELLED',modelingTask:f.task},409));await assert.rejects(work,{outcome:'restored',code:'WORKER_CANCELLED'});assert.equal(f.count('/cancel'),1);assert.equal(f.count('/commands'),1);
});
test('stop during recovery-point preparation waits for a cancellable phase and never sends a duplicate cancellation',async()=>{
  const f=fixture(),entered=deferred(),held=deferred(),cancelled=deferred(),abort=new AbortController();let observations=0;
  f.submit=()=>{f.phase('preparing');entered.resolve();return held.promise;};f.status=()=>{if(++observations===2)f.phase('executing');return f.packet();};f.cancel=()=>{assert.equal(f.task.phase,'executing');f.phase('cancelled',{cancelRequested:true,cancellable:false,restored:true});cancelled.resolve();return f.packet(f.task,202);};
  const work=f.run({signal:abort.signal});await entered.promise;abort.abort();await cancelled.promise;held.resolve(response({ok:false,modelingTask:f.task},409));await assert.rejects(work,{outcome:'restored'});assert.equal(observations,2);assert.equal(f.count('/cancel'),1);
});
test('a protected or completed commit remains successful after late stop; no cancellation is sent',async()=>{
  const f=fixture(),entered=deferred(),held=deferred(),abort=new AbortController();f.submit=()=>{f.phase('committing');entered.resolve();return held.promise;};
  const work=f.run({signal:abort.signal});await entered.promise;abort.abort();await turn();held.resolve(response(f.success()));assert.equal((await work).ok,true);assert.equal(f.count('/cancel'),0);
});
test('a lost cancellation acknowledgement is never resent and does not overwrite a trustworthy original commit',async()=>{
  const f=fixture(),entered=deferred(),held=deferred(),cancelled=deferred(),abort=new AbortController();f.submit=()=>{f.phase('executing');entered.resolve();return held.promise;};f.cancel=()=>{cancelled.resolve();throw Error('lost reply');};
  const work=f.run({signal:abort.signal});await entered.promise;abort.abort();await cancelled.promise;held.resolve(response(f.success()));assert.equal((await work).ok,true);assert.equal(f.count('/cancel'),1);assert.equal(f.count('/commands'),1);
});
test('a lost command reply recovers only its exact original durable task receipt without re-execution',async()=>{
  const f=fixture();let result;f.submit=()=>{result=f.success();throw Error('reply lost');};f.receipt=()=>response({ok:true,result});
  assert.equal((await f.run()).ok,true);assert.equal(f.count('/commands'),1);assert.equal(f.count('/modeling-tasks'),1);assert.equal(f.count('/result'),1);
});
test('an unknown or non-proven cancelled task never becomes a false rollback or automatic retry',async()=>{
  for(const phase of ['unknown','cancelled']){const f=fixture();f.submit=()=>{f.phase(phase,{cancellable:false});throw Error('lost reply');};await assert.rejects(f.run(),error=>error.outcome==='unknown'&&!error.retryableByModel);assert.equal(f.count('/commands'),1);assert.equal(f.count('/result'),0);}
});
test('unknown registration and old unsupported servers fail closed without direct-command fallback',async()=>{
  for(const type of ['lost','old']){const f=fixture();f.reserve=()=>{if(type==='lost')throw Error('lost');return response({ok:false,code:'ROUTE_NOT_FOUND',error:'No task support'},404);};await assert.rejects(f.run(),error=>error.outcome==='not-started'&&!error.retryableByModel);assert.equal(f.count('/modeling-tasks'),1);assert.equal(f.count('/commands'),0);}
});
test('foreign document, request key and operation reservations cannot authorize a mutation',async()=>{
  for(const patch of [{documentId:'other'},{requestKey:'other'},{operation:'body.delete'}]){const f=fixture();f.reserve=()=>f.packet({...f.task,...patch},201);await assert.rejects(f.run(),{code:'MCP_TASK_REGISTRATION_UNCONFIRMED',outcome:'not-started'});assert.equal(f.count('/commands'),0);}
});
test('mismatching committed geometry identity cannot be adopted even with a plausible task and ok flag',async()=>{
  for(const patch of [{documentId:'foreign'},{revision:10},{stateToken:'b'.repeat(64)}]){const f=fixture();f.submit=()=>response({...f.success(),...patch});await assert.rejects(f.run(),{code:'MCP_TASK_RESULT_UNCONFIRMED',outcome:'unknown'});assert.equal(f.count('/commands'),1);}
});
test('registration header, stream and ignored-fetch deadlines remain bounded without a second POST',async()=>{
  for(const type of ['header','stream','never']){const f=fixture();f.reserve=()=>type==='never'?new Promise(()=>{}):type==='header'?new Response('{}',{headers:{'content-length':'65537'}}):new Response(new ReadableStream({pull(){}}));await assert.rejects(f.run({controlMs:15}),{code:'MCP_TASK_REGISTRATION_UNCONFIRMED',outcome:'not-started'});assert.equal(f.count('/modeling-tasks'),1);assert.equal(f.count('/commands'),0);}
});
test('the command is captured before asynchronous registration so later caller mutation cannot change the submitted payload',async()=>{
  const f=fixture(),held=deferred(),entered=deferred();f.reserve=async()=>{entered.resolve();await held.promise;return f.packet(f.task,201);};
  const work=f.run();await entered.promise;f.command.parameters.width='changed outside';held.resolve();assert.equal((await work).ok,true);assert.equal(f.input.parameters.width,'boardWidth');
});
test('known pre-execution argument errors preserve structured parameter guidance rather than becoming an unavailable-model error',async()=>{
  const f=fixture();f.reserve=()=>response({ok:false,code:'INVALID_ARGUMENT',error:'width is required',fieldPath:'parameters.width',retryableByModel:true},400);
  await assert.rejects(f.run(),error=>error.outcome==='not-started'&&error.fieldPath==='parameters.width'&&error.retryableByModel===true);assert.equal(f.count('/commands'),0);
});
