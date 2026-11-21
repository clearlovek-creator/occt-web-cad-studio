import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ModelingTaskClient,modelingTaskSourceDocument,modelingTaskTouchesDocument} from '../app/modeling/modeling-task-client.ts';
import {normalizeProjectCreateInput,normalizeProjectCreateTask,normalizeProjectCreateReceipt} from '../shared/project-create-input.mjs';

const stamp=new Date().toISOString(),options={pollMs:60000,recoveryMs:0};
const command=(extra={})=>({protocolVersion:1,operation:'project.create',documentId:'new-target',sourceDocumentId:'default',requestId:'create-1',name:'新工程',sourceRevision:40,sourceStateSequence:4,sourceStateToken:'4'.repeat(64),...extra});
const status=(input,phase='reserved',extra={})=>({version:1,taskId:randomUUID(),documentId:input.documentId,operation:'project.create',requestKey:input.requestId,phase,sequence:phase==='reserved'?1:8,createdAt:stamp,updatedAt:stamp,cancelRequested:false,cancellable:['reserved','queued','executing'].includes(phase),reportDurable:true,...extra});
const row=(input,task,canCreate=task.phase==='reserved')=>({modelingTask:task,projectCreate:{version:1,taskId:task.taskId,...input,canCreate}});
const receipt=(input,task)=>({ok:true,documentId:input.documentId,requestId:input.requestId,revision:1,stateSequence:1,stateToken:'a'.repeat(64),bodyCount:0,featureCount:0,features:[],bodies:[],bodyMetadata:[],variables:[],propertyRecords:[],coordinateSystems:[{id:'global'}],materials:[],stats:{faceCount:0,edgeCount:0,triangleCount:0},propertySchema:{types:[],instances:[]},...row(input,task,false)});
const json=(value,code=200)=>new Response(JSON.stringify({ok:true,...value}),{status:code,headers:{'Content-Type':'application/json'}});
const packet=value=>({ok:true,status:200,payload:value});
const list=(items,extra={})=>({sourceDocumentId:'default',total:items.length,items,active:items.filter(value=>!['succeeded','failed','cancelled','unknown'].includes(value.modelingTask.phase)),attention:[],nextCursor:null,...extra});
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('create binding accepts its own public DTO as the comparison baseline but raw input remains strict',()=>{
  const input=command(),task=status(input),binding=row(input,task).projectCreate;
  assert.deepEqual(normalizeProjectCreateTask(binding,task,'default',binding),binding);
  assert.throws(()=>normalizeProjectCreateInput(binding));
  for(const patch of [{sourceRevision:41},{sourceStateSequence:5},{sourceStateToken:'b'.repeat(64)},{name:'different'},{sourceDocumentId:'other'}])assert.throws(()=>normalizeProjectCreateTask({...binding,...patch},task,'default',binding));
});

test('creation receipts require exact source/task/request identity and a complete empty metadata view, not invented vertex arrays',()=>{
  const input=command(),task=status(input,'succeeded'),value=receipt(input,task);
  assert.deepEqual(normalizeProjectCreateReceipt(value,task,input),value);assert.equal(value.positions,undefined);
  assert.throws(()=>normalizeProjectCreateReceipt(value,task));
  const invalid=[{requestId:'gateway-view-id'},{documentId:'other'},{revision:-1},{stateSequence:-1},{stateToken:'invalid'},{bodyCount:1},{featureCount:1},{features:[{}]},{bodies:[{}]},{bodyMetadata:undefined},{variables:[{}]},{propertyRecords:[{}]},{stats:{faceCount:0,edgeCount:0,triangleCount:1}},{materials:undefined},{coordinateSystems:undefined},{propertySchema:{types:[{}],instances:[]}},{propertySchema:{types:[],instances:[{}]}},{projectCreate:{...value.projectCreate,taskId:randomUUID()}},{projectCreate:{...value.projectCreate,sourceStateToken:'b'.repeat(64)}}];
  for(const patch of invalid)assert.throws(()=>normalizeProjectCreateReceipt({...value,...patch},task,input),JSON.stringify(patch));
  assert.throws(()=>normalizeProjectCreateReceipt(value,{...task,phase:'committing'},input));
  assert.throws(()=>normalizeProjectCreateReceipt(value,{...task,revision:2},input));
  assert.throws(()=>normalizeProjectCreateReceipt(value,{...task,stateToken:'b'.repeat(64)},input));
});

test('incomplete create input is rejected before registration or any creation submission',async()=>{
  let requests=0,submissions=0;const client=new ModelingTaskClient('/api',async()=>{requests++;throw Error('must not request');},()=>{},options);
  try{for(const patch of [{documentId:'default'},{sourceStateToken:undefined},{sourceRevision:undefined},{sourceStateSequence:undefined},{path:'C:/private'}])await assert.rejects(client.run(command(patch),async()=>{submissions++;}),error=>error.payload.code==='PROJECT_CREATE_TASK_ARGUMENTS'&&error.payload.execution==='not-started');assert.equal(requests,0);assert.equal(submissions,0);}finally{client.dispose();}
});

test('one frozen new-project input binds one target submission while both source and target remain pending',async()=>{
  const input=command(),original=structuredClone(input),registered=status(input),hold=deferred(),calls=[],observed=[];let submissions=0;
  const client=new ModelingTaskClient('/api',async(url,init)=>{calls.push({url,init});return hold.promise;},value=>observed.push(value),options);
  try{
    const pending=client.run(input,async(headers,frozen)=>{submissions++;assert.equal(headers['X-Cad-Task-Id'],registered.taskId);assert.deepEqual(frozen,original);assert.equal(client.hasPending('default'),true);assert.equal(client.hasPending('new-target'),true);return packet(receipt(original,{...registered,phase:'succeeded',sequence:8,cancellable:false}));});
    input.name='changed';input.sourceRevision=99;hold.resolve(json(row(original,registered),201));const result=await pending;
    assert.equal(result.payload.ok,true);assert.equal(submissions,1);assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/documents/new-target/project/create/tasks');assert.deepEqual(JSON.parse(calls[0].init.body).command,original);
    const item=observed.at(-1)[0];assert.equal(item.projectCreate.canCreate,false);assert.equal(modelingTaskSourceDocument(item),'default');assert.equal(modelingTaskTouchesDocument(item,'new-target'),true);assert.equal(modelingTaskTouchesDocument(item,'foreign'),false);assert.equal(client.hasPending('default'),false);
  }finally{client.dispose();}
});

test('foreign or altered create registrations never authorize a submission or fallback command',async()=>{
  const input=command();
  for(const patch of [{sourceDocumentId:'foreign'},{documentId:'foreign'},{requestId:'foreign'},{sourceRevision:41},{name:'altered'},{taskId:randomUUID()},{canCreate:'true'}]){
    const task=status(input);let submissions=0,requests=0;const client=new ModelingTaskClient('/api',async()=>{requests++;const value=row(input,task);value.projectCreate={...value.projectCreate,...patch};return json(value,201);},()=>{},options);
    try{await assert.rejects(client.run(input,async()=>{submissions++;}));assert.equal(submissions,0);assert.equal(requests,1);}finally{client.dispose();}
  }
});

test('a concurrent call returning the same reserved task cannot submit its creation twice',async()=>{
  const input=command(),task=status(input),hold=deferred();let submissions=0;
  const client=new ModelingTaskClient('/api',async(url,init)=>json(init?.method==='POST'?row(input,task):{modelingTask:task}),()=>{},options);
  try{
    const first=client.run(input,async()=>{submissions++;return hold.promise;});await tick();
    await assert.rejects(client.run(input,async()=>{submissions++;throw Error('must not resubmit');}),error=>error.payload.code==='MODELING_TASK_RESULT_UNCONFIRMED');assert.equal(submissions,1);
    hold.resolve(packet(receipt(input,{...task,phase:'succeeded',sequence:8,cancellable:false})));assert.equal((await first).payload.ok,true);assert.equal(submissions,1);assert.equal(client.hasPending('default'),false);
  }finally{client.dispose();}
});

test('lost registration discovers the reserved create by source using GET only and never submits again',async()=>{
  const input=command(),task=status(input),calls=[],observed=[];let submissions=0;
  const client=new ModelingTaskClient('/api',async(url,init)=>{calls.push({url,method:init?.method||'GET'});if(init?.method==='POST')throw Error('lost reply');return json(list([row(input,task)]));},value=>observed.push(value),options);
  try{await assert.rejects(client.run(input,async()=>{submissions++;}),error=>error.payload.execution==='not-started');assert.equal(submissions,0);assert.deepEqual(calls.map(value=>value.method),['POST','GET']);assert.equal(calls[1].url,'/api/documents/default/project/create-tasks?limit=50');assert.equal(observed.at(-1)[0].external,true);assert.equal(client.hasPending('default'),true);}finally{client.dispose();}
});

test('lost creation reply reads only the original task and original receipt, with no second creation',async()=>{
  const input=command(),task=status(input),done={...task,phase:'succeeded',sequence:8,cancellable:false},calls=[];let submissions=0;
  const client=new ModelingTaskClient('/api',async(url,init)=>{calls.push({url,method:init?.method||'GET'});return json(init?.method==='POST'?row(input,task):url.endsWith('/result')?{result:receipt(input,done)}:{modelingTask:done});},()=>{},options);
  try{const value=await client.run(input,async()=>{submissions++;throw Error('reply lost after commit');});assert.equal(value.payload.projectCreate.taskId,task.taskId);assert.equal(submissions,1);assert.deepEqual(calls.map(value=>value.method),['POST','GET','GET']);assert.ok(calls[1].url.endsWith('/'+task.taskId));assert.ok(calls[2].url.endsWith('/'+task.taskId+'/result'));}finally{client.dispose();}
});

test('successful status cannot substitute for an invalid or foreign original creation receipt',async()=>{
  const input=command(),task=status(input),done={...task,phase:'succeeded',sequence:8,cancellable:false},observed=[];let submissions=0;
  const bad={...receipt(input,done),projectCreate:{...row(input,done,false).projectCreate,sourceDocumentId:'foreign'}};
  const client=new ModelingTaskClient('/api',async(url,init)=>json(init?.method==='POST'?row(input,task):url.endsWith('/result')?{result:bad}:{modelingTask:done}),value=>observed.push(value),options);
  try{await assert.rejects(client.run(input,async()=>{submissions++;return packet(bad);}),error=>error.payload.code==='MODELING_TASK_RECEIPT_UNAVAILABLE'&&error.payload.modelingTask.phase==='succeeded');assert.equal(submissions,1);assert.match(observed.at(-1)[0].notice,/已提交/);}finally{client.dispose();}
});

test('a previous-owner reserved task remains checkable but canCreate:false never authorizes resubmission',async()=>{
  const input=command(),task=status(input,'reserved',{execution:'not-started',interrupted:true});let submissions=0;
  const client=new ModelingTaskClient('/api',async(url,init)=>json(init?.method==='POST'?row(input,task,false):{modelingTask:task}),()=>{},options);
  try{await assert.rejects(client.run(input,async()=>{submissions++;}),error=>error.payload.code==='MODELING_TASK_RESULT_UNCONFIRMED');assert.equal(submissions,0);assert.equal(client.hasPending('default'),true);}finally{client.dispose();}
});

test('a stale reserved registration cannot submit after source discovery has already proved completion',async()=>{
  const input=command(),task=status(input),done={...task,phase:'succeeded',sequence:8,cancellable:false};let submissions=0;
  const client=new ModelingTaskClient('/api',async(url,init)=>json(init?.method==='POST'?row(input,task):url.includes('/project/create-tasks')?list([row(input,done,false)]):url.endsWith('/result')?{result:receipt(input,done)}:{modelingTask:done}),()=>{},options);
  try{await client.restoreProjectCreates('default');const value=await client.run(input,async()=>{submissions++;throw Error('stale reply must not authorize a submission');});assert.equal(value.payload.ok,true);assert.equal(submissions,0);}finally{client.dispose();}
});

test('source discovery validates a whole page and existing bindings before publishing any new task',async()=>{
  const input=command(),task=status(input),other=command({documentId:'other-target',sourceDocumentId:'foreign'}),observed=[];let phase=0;
  const client=new ModelingTaskClient('/api',async()=>json(list(phase===0?[row(input,task),row(other,status(other))]:phase===1?[row(input,task)]:[row({...input,name:'rebound'},task)])),value=>observed.push(value),options);
  try{await assert.rejects(client.restoreProjectCreates('default'));assert.deepEqual(observed,[]);phase=1;await client.restoreProjectCreates('default');assert.equal(observed.length,1);phase=2;await assert.rejects(client.restoreProjectCreates('default'));assert.equal(observed.length,1);assert.equal(observed[0][0].projectCreate.name,input.name);}finally{client.dispose();}
});

test('source discovery coalesces concurrent reads, batches publication and ignores late results after disposal',async()=>{
  const input=command(),task=status(input),hold=deferred(),observed=[];let requests=0;
  const client=new ModelingTaskClient('/api',async()=>{requests++;return hold.promise;},value=>observed.push(value),options);
  const first=client.restoreProjectCreates('default'),second=client.restoreProjectCreates('default');assert.equal(first,second);assert.equal(requests,1);client.dispose();hold.resolve(json(list([row(input,task)])));await first;assert.deepEqual(observed,[]);await client.restoreProjectCreates('default');assert.equal(requests,1);
});

test('invalid list counts, cursors and conflicting attention targets publish no create task',async()=>{
  const input=command(),task=status(input),page=list([row(input,task)]);
  for(const patch of [{total:0},{nextCursor:randomUUID()},{items:[],active:[],nextCursor:task.taskId},{attention:[{taskId:task.taskId,documentId:'foreign',needsRead:true}]}]){
    const observed=[],client=new ModelingTaskClient('/api',async()=>json({...page,...patch}),value=>observed.push(value),options);
    try{await assert.rejects(client.restoreProjectCreates('default'));assert.deepEqual(observed,[]);}finally{client.dispose();}
  }
});

test('identical source discovery emits nothing and an older page cannot revive create permission or regress completion',async()=>{
  const input=command(),task=status(input),done={...task,phase:'succeeded',sequence:8,cancellable:false},observed=[];let page=list([row(input,task)]);
  const client=new ModelingTaskClient('/api',async()=>json(page),value=>observed.push(value),options);
  try{await client.restoreProjectCreates('default');await client.restoreProjectCreates('default');assert.equal(observed.length,1);page=list([row(input,done,false)]);await client.restoreProjectCreates('default');assert.equal(observed.length,2);page=list([row(input,task)]);await client.restoreProjectCreates('default');assert.equal(observed.length,2);assert.equal(observed.at(-1)[0].task.phase,'succeeded');assert.equal(observed.at(-1)[0].projectCreate.canCreate,false);}finally{client.dispose();}
});

test('attention lookup validates exact target and task before publication, deduplicates identities and never mutates',async()=>{
  const input=command(),task=status(input,'unknown'),identity={taskId:task.taskId,documentId:input.documentId,needsRead:true},observed=[],calls=[];let bad=true;
  const client=new ModelingTaskClient('/api',async(url,init)=>{calls.push({url,init});return json(url.includes('/project/create/tasks/')?row(input,bad?{...task,taskId:randomUUID()}:task,false):list([],{total:1,attention:[identity,identity]}));},value=>observed.push(value),options);
  try{await assert.rejects(client.restoreProjectCreates('default'));assert.deepEqual(observed,[]);bad=false;await client.restoreProjectCreates('default');assert.equal(observed.length,1);assert.equal(calls.length,4);assert.equal(observed[0][0].task.taskId,task.taskId);assert.ok(calls.every(value=>!value.init?.method));}finally{client.dispose();}
});

test('bounded create discovery loads at most 120 identities and reports remaining attention without writes',async()=>{
  const inputs=Array.from({length:122},(_,index)=>command({documentId:'target-'+index,requestId:'create-'+index})),rows=inputs.map(input=>row(input,status(input,'unknown'),false)),byId=new Map(rows.map(value=>[value.modelingTask.taskId,value])),observed=[];let reads=0;
  const client=new ModelingTaskClient('/api',async url=>{reads++;return json(url.includes('/project/create/tasks/')?byId.get(url.split('/').at(-1)):list(rows.slice(0,50),{total:122,attention:rows.map(value=>({taskId:value.modelingTask.taskId,documentId:value.modelingTask.documentId,needsRead:true}))}));},value=>observed.push(value),options);
  try{assert.deepEqual(await client.restoreProjectCreates('default'),{omitted:2});assert.equal(reads,71);assert.equal(observed.length,1);assert.equal(observed[0].length,120);}finally{client.dispose();}
});

test('generic target registry discovery never publishes create tasks without their mandatory source binding',async()=>{
  const input=command(),task=status(input),observed=[];const client=new ModelingTaskClient('/api',async()=>json({tasks:[task]}),value=>observed.push(value),options);
  try{await client.restore(input.documentId);assert.deepEqual(observed,[]);assert.equal(client.hasPending(input.documentId),false);}finally{client.dispose();}
});

test('source-discovered cancellation is sent once to the bound target and preserves unknown stop outcomes',async()=>{
  const input=command(),task=status(input),calls=[],observed=[];
  const client=new ModelingTaskClient('/api',async(url,init)=>{calls.push({url,method:init?.method||'GET'});if(init?.method==='POST')throw Error('cancel reply lost');return json(list([row(input,task)]));},value=>observed.push(value),options);
  try{await client.restoreProjectCreates('default');await assert.rejects(client.cancel(task.taskId));assert.match(calls.at(-1).url,new RegExp('/documents/new-target/modeling-tasks/'+task.taskId+'/cancel$'));assert.equal(calls.filter(value=>value.method==='POST').length,1);assert.match(observed.at(-1)[0].notice,/尚未确认/);await assert.rejects(client.cancel(task.taskId));assert.equal(calls.filter(value=>value.method==='POST').length,1);assert.equal(client.hasPending('default'),true);}finally{client.dispose();}
});

test('create discovery rejects an over-capacity page atomically instead of publishing only some tasks',async()=>{
  const generic=Array.from({length:128},(_,index)=>status(command({documentId:'default',requestId:'generic-'+index}),'executing',{operation:'primitive.box'})),input=command(),task=status(input),observed=[];let reads=0;
  const client=new ModelingTaskClient('/api',async url=>{if(url.includes('/project/create-tasks'))return json(list([row(input,task)]));return json({tasks:++reads===1?generic.slice(0,100):generic.slice(100)});},value=>observed.push(value),options);
  try{await client.restore('default');await client.restore('default');const count=observed.length;await assert.rejects(client.restoreProjectCreates('default'),error=>error.payload.code==='MODELING_TASK_CLIENT_CAPACITY');assert.equal(observed.length,count);assert.equal(observed.at(-1).length,128);assert.equal(observed.at(-1).some(value=>value.projectCreate),false);}finally{client.dispose();}
});

test('reserved creation can be cancelled from the source without executing the target or clearing its binding',async()=>{
  const input=command(),task=status(input),observed=[];let posted=0;
  const client=new ModelingTaskClient('/api',async(url,init)=>{if(init?.method==='POST'){posted++;return json({modelingTask:{...task,phase:'cancelled',sequence:3,cancellable:false,cancelRequested:true,execution:'not-started'}});}return json(list([row(input,task)]));},value=>observed.push(value),options);
  try{await client.restoreProjectCreates('default');await client.cancel(task.taskId);assert.equal(posted,1);assert.equal(client.hasPending('default'),false);assert.equal(observed.at(-1)[0].projectCreate.canCreate,false);assert.equal(observed.at(-1)[0].projectCreate.sourceDocumentId,'default');assert.equal(observed.at(-1)[0].task.execution,'not-started');await tick();}finally{client.dispose();}
});
