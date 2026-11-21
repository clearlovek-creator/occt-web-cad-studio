import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ModelingTaskClient} from '../app/modeling/modeling-task-client.ts';
import {ModelingController} from '../app/modeling/modeling-controller.ts';

const taskId = randomUUID(), stamp = new Date().toISOString();
const task = (phase = 'reserved', sequence = 1, extra = {}) => ({version: 1, taskId, documentId: 'default', operation: 'primitive.box', requestKey: 'request-1', phase, sequence, createdAt: stamp, updatedAt: stamp, cancelRequested: ['stopping', 'rolling-back', 'cancelled'].includes(phase), cancellable: ['reserved', 'queued', 'executing'].includes(phase), reportDurable: true, ...extra});
const request = () => ({protocolVersion: 1, documentId: 'default', requestId: 'request-1', operation: 'primitive.box', parameters: {width: 1, depth: 2, height: 3}});
const json = (payload, status = 200) => new Response(JSON.stringify(payload), {status, headers: {'content-type': 'application/json'}});
const packet = status => ({ok: true, status: 200, payload: {ok: true, documentId: 'default', bodyId: 'created-body', revision: 2, modelingTask: status}});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const options = {pollMs: 60000, recoveryMs: 10};

test('explicit original receipt inspection uses GET only and refuses foreign or uncommitted results',async()=>{const calls=[];let phase='succeeded',foreign=false;const client=new ModelingTaskClient('/api',async(url,init)=>{calls.push({url,method:init?.method||'GET'});return json(url.endsWith('/result')?{ok:true,result:{ok:true,documentId:foreign?'other':'default',revision:8}}:url.endsWith('/modeling-tasks')?{ok:true,tasks:[task(phase,7)]}:{ok:true,modelingTask:task(phase,7)});},()=>{},options);try{await client.restore('default');assert.equal((await client.readResult(taskId)).revision,8);foreign=true;await assert.rejects(client.readResult(taskId),error=>error.payload.code==='MODELING_TASK_PROTOCOL');assert.equal(calls.every(call=>call.method==='GET'),true);const other=new ModelingTaskClient('/api',async()=>json({ok:true,tasks:[task('failed',8,{unchanged:true})]}),()=>{},options);try{await other.restore('default');await assert.rejects(other.readResult(taskId));}finally{other.dispose();}}finally{client.dispose();}});

test('known HTTP rejection abandons only an unclaimed reservation and never sends an execution cancellation', async () => {
  const calls = [], observations = [];
  const client = new ModelingTaskClient('/api', async (url, init) => {
    calls.push({url, method: init?.method || 'GET'});
    return json({ok: true, modelingTask: url.endsWith('/abandon') ? task('failed', 2, {code: 'MODELING_TASK_NOT_SUBMITTED', execution: 'not-started'}) : task()}, 200);
  }, value => observations.push(value), options);
  try {
    const result = await client.run(request(), async () => ({ok: false, status: 413, payload: {ok: false, documentId: 'default', code: 'REQUEST_TOO_LARGE', error: 'too large'}}));
    assert.equal(result.status, 413); assert.equal(result.payload.code, 'REQUEST_TOO_LARGE');
    assert.equal(calls.filter(call => call.url.endsWith('/abandon')).length, 1);
    assert.equal(calls.some(call => call.url.endsWith('/cancel')), false);
    assert.equal(observations.at(-1)[0].task.phase, 'failed'); assert.equal(client.hasPending('default'), false);
  } finally { client.dispose(); }
});

test('task client freezes registration and submitted input, binds the task header and never mutates while registering', async () => {
  const reserved = deferred(), snapshots = [], calls = [], original = request();
  const client = new ModelingTaskClient('/api', async (url, init) => { calls.push({url, init}); return reserved.promise; }, value => snapshots.push(value), options);
  try {
    const running = client.run(original, async (headers, frozen) => { assert.equal(headers['X-Cad-Task-Id'], taskId); assert.equal(frozen.parameters.width, 1); return packet(task('succeeded', 7)); });
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/documents/default/modeling-tasks');
    original.parameters.width = 99; reserved.resolve(json({ok: true, modelingTask: task()}, 201));
    const result = await running; assert.equal(result.payload.bodyId, 'created-body');
    assert.equal(JSON.parse(calls[0].init.body).command.parameters.width, 1);
    assert.equal(snapshots.at(-1)[0].task.phase, 'succeeded'); assert.equal(client.hasPending('default'), false);
  } finally { client.dispose(); }
});

test('a lost mutation response recovers the exact original durable receipt using GET only', async () => {
  const calls = [], receipt = {ok: true, documentId: 'default', bodyId: 'original-body', revision: 8}; let submissions = 0;
  const client = new ModelingTaskClient('/api', async (url, init) => {
    calls.push({url, method: init?.method || 'GET'});
    if (init?.method === 'POST') return json({ok: true, modelingTask: task()}, 201);
    return url.endsWith('/result') ? json({ok: true, result: receipt}) : json({ok: true, modelingTask: task('succeeded', 7)});
  }, () => {}, options);
  try {
    const result = await client.run(request(), async () => { submissions++; throw Error('reply lost'); });
    assert.equal(submissions, 1); assert.deepEqual(result.payload, {...receipt, modelingTask: task('succeeded', 7)});
    assert.equal(calls.filter(call => call.method === 'POST').length, 1, 'Only reservation is POSTed by the control client');
    assert.ok(calls.some(call => call.url.endsWith('/result')));
  } finally { client.dispose(); }
});

test('an existing committed reservation is reconciled without submitting a second mutation', async () => {
  let submitted = false;
  const client = new ModelingTaskClient('/api', async url => url.endsWith('/result') ? json({ok: true, result: {ok: true, documentId: 'default', revision: 8}}) : json({ok: true, modelingTask: task('succeeded', 7)}), () => {}, options);
  try { const result = await client.run(request(), async () => { submitted = true; return packet(task('succeeded', 7)); }); assert.equal(result.ok, true); assert.equal(submitted, false); }
  finally { client.dispose(); }
});

test('a committed task with an unreadable receipt is not mislabeled unexecuted or automatically repeated', async () => {
  const observed = []; let submissions = 0;
  const client = new ModelingTaskClient('/api', async (url, init) => init?.method === 'POST' ? json({ok: true, modelingTask: task()}, 201) : url.endsWith('/result') ? json({ok: false, code: 'MODELING_TASK_RESULT_EXPIRED', error: 'expired'}, 410) : json({ok: true, modelingTask: task('succeeded', 7)}), value => observed.push(value), options);
  try {
    await assert.rejects(client.run(request(), async () => { submissions++; throw Error('lost'); }), error => error.payload.code === 'MODELING_TASK_RECEIPT_UNAVAILABLE' && error.payload.modelingTask.phase === 'succeeded');
    assert.equal(submissions, 1); assert.match(observed.at(-1)[0].notice, /已提交/);
  } finally { client.dispose(); }
});

test('late status replies cannot regress a cancellation and the original request remains pending until the final result', async () => {
  const response = deferred(), stale = deferred(), observations = []; let reads = 0, cancels = 0;
  const client = new ModelingTaskClient('/api', async (url, init) => {
    if (url.endsWith('/cancel')) { cancels++; return json({ok: true, modelingTask: task('stopping', 5)}); }
    if (init?.method === 'POST') return json({ok: true, modelingTask: task()}, 201);
    reads++; return reads === 1 ? json({ok: true, modelingTask: task('executing', 4)}) : stale.promise;
  }, value => observations.push(value), options);
  try {
    const running = client.run(request(), () => response.promise);
    await new Promise(resolve => setImmediate(resolve)); await client.refresh(taskId);
    const old = client.refresh(taskId); await client.cancel(taskId);
    stale.resolve(json({ok: true, modelingTask: task('executing', 4)})); await old;
    assert.equal(observations.at(-1)[0].task.phase, 'stopping'); assert.equal(client.hasPending('default'), true); assert.equal(cancels, 1);
    await assert.rejects(client.cancel(taskId)); assert.equal(cancels, 1);
    response.resolve({ok: false, status: 409, payload: {ok: false, documentId: 'default', code: 'WORKER_CANCELLED', error: 'cancelled', modelingTask: task('cancelled', 7)}});
    const result = await running; assert.equal(result.payload.modelingTask.phase, 'cancelled'); assert.equal(client.hasPending('default'), false);
  } finally { client.dispose(); }
});

test('restoration validates the whole list before publishing and never restores a foreign project status', async () => {
  const observed = [];
  const client = new ModelingTaskClient('/api', async () => json({ok: true, tasks: [task('executing', 4), task('queued', 2, {taskId: randomUUID(), documentId: 'other'})]}), value => observed.push(value), options);
  try { await assert.rejects(client.restore('default')); assert.deepEqual(observed, []); }
  finally { client.dispose(); }
});

test('reservation failure is a proven not-sent outcome and cannot fall back to a legacy mutation', async () => {
  let submitted = false;
  const client = new ModelingTaskClient('/api', async () => { throw Error('connection lost'); }, () => {}, options);
  try { await assert.rejects(client.run(request(), async () => { submitted = true; return packet(task()); }), error => error.payload.execution === 'not-started'); assert.equal(submitted, false); }
  finally { client.dispose(); }
});

test('task-aware controller keeps busy through confirmed cancellation, journals it neutrally and never accepts it as a model', async () => {
  const pending = deferred(); let current = task(), requestKey;
  const controller = new ModelingController({taskControl: true, fetchImpl: async (url, init) => {
    if (url.endsWith('/modeling-tasks')) { requestKey = JSON.parse(init.body).command.requestId; current = task('reserved', 1, {requestKey}); return json({ok: true, modelingTask: current}, 201); }
    if (url.endsWith('/commands')) return pending.promise;
    if (url.endsWith('/cancel')) { current = task('stopping', 5, {requestKey}); return json({ok: true, modelingTask: current}); }
    return json({ok: true, modelingTask: current});
  }});
  try {
    const execution = controller.execute({operation: 'primitive.box', parameters: {width: 1, depth: 2, height: 3}});
    const failed = assert.rejects(execution, error => error.code === 'WORKER_CANCELLED');
    await new Promise(resolve => setImmediate(resolve));
    // This deterministic status read is equivalent to the first execution poll.
    current = task('executing', 4, {requestKey}); await controller.checkModelingTask(taskId);
    await controller.cancelModelingTask(taskId); assert.equal(controller.getSnapshot().busy, true);
    current = task('cancelled', 7, {requestKey}); pending.resolve(json({ok: false, documentId: 'default', code: 'WORKER_CANCELLED', error: '已取消，原工程已恢复。', modelingTask: current}, 409));
    await failed; assert.equal(controller.getSnapshot().busy, false); assert.equal(controller.getSnapshot().error, null); assert.equal(controller.getSnapshot().model, null); assert.equal(controller.getSnapshot().commandLog.at(-1).status, 'cancelled');
  } finally { controller.disposeTaskTracking(); }
});

test('batch client binds batch identity rather than transport identity, freezes all steps and recovers the original aggregate without resubmission', async () => {
  const reservation=deferred(),input={protocolVersion:1,operation:'project.batch',documentId:'default',requestId:'transport-1',batchId:'batch-1',steps:[{operation:'primitive.box',parameters:{width:3,depth:4,height:5}}]},calls=[];
  const status=(phase,sequence)=>task(phase,sequence,{operation:'project.batch',requestKey:'batch-1'}),receipt={ok:true,documentId:'default',revision:3,batchId:'batch-1',batch:{state:'committed',count:1},results:[{ok:true,bodyId:'original-body'}]};let submissions=0;
  const client=new ModelingTaskClient('/api',async(url,init)=>{calls.push({url,method:init?.method||'GET'});if(init?.method==='POST')return reservation.promise;return url.endsWith('/result')?json({ok:true,result:receipt}):json({ok:true,modelingTask:status('succeeded',7)});},()=>{},options);
  try{
    const running=client.run(input,async(headers,frozen)=>{submissions++;assert.equal(headers['X-Cad-Task-Id'],taskId);assert.equal(frozen.steps[0].parameters.width,3);throw Error('original batch reply lost');});
    input.steps[0].parameters.width=99;reservation.resolve(json({ok:true,modelingTask:status('reserved',1)},201));const result=await running;assert.deepEqual(result.payload,{...receipt,modelingTask:status('succeeded',7)});assert.equal(submissions,1);assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.equal(calls.some(call=>call.url.endsWith('/cancel')),false);
  }finally{client.dispose();}
});

test('task-aware batch controller uses its dedicated endpoint and reports confirmed cancellation without accepting provisional steps',async()=>{
  const pending=deferred();let current,requestKey;const calls=[];
  const controller=new ModelingController({taskControl:true,fetchImpl:async(url,init)=>{
    calls.push(url);
    if(url.endsWith('/modeling-tasks')){const input=JSON.parse(init.body).command;requestKey=input.batchId;assert.equal(input.operation,'project.batch');current=task('reserved',1,{operation:'project.batch',requestKey});return json({ok:true,modelingTask:current},201);}
    if(url.endsWith('/command-batches')){assert.equal(init.headers['X-Cad-Task-Id'],taskId);return pending.promise;}
    if(url.endsWith('/cancel')){current=task('stopping',5,{operation:'project.batch',requestKey});return json({ok:true,modelingTask:current});}
    return json({ok:true,modelingTask:current});
  }});
  try{
    const execution=controller.executeBatch([{operation:'variable.set',parameters:{name:'size',type:'length',expression:'3 mm'}},{operation:'primitive.box',parameters:{width:'size',depth:4,height:5}}]),failed=assert.rejects(execution,error=>error.code==='WORKER_CANCELLED');await new Promise(resolve=>setImmediate(resolve));
    current=task('executing',4,{operation:'project.batch',requestKey});await controller.checkModelingTask(taskId);await controller.cancelModelingTask(taskId);assert.equal(controller.getSnapshot().busy,true);
    current=task('cancelled',7,{operation:'project.batch',requestKey});pending.resolve(json({ok:false,documentId:'default',code:'WORKER_CANCELLED',error:'整批已取消并恢复。',modelingTask:current},409));await failed;
    assert.equal(controller.getSnapshot().busy,false);assert.equal(controller.getSnapshot().error,null);assert.equal(controller.getSnapshot().model,null);assert.equal(controller.getSnapshot().commandLog.at(-1).operation,'project.batch');assert.equal(controller.getSnapshot().commandLog.at(-1).status,'cancelled');assert.equal(calls.some(url=>url==='/api/commands'),false);
  }finally{controller.disposeTaskTracking();}
});
