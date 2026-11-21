import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalizeProjectCreateInput,projectCreateCanonical,normalizeProjectCreateTask} from '../shared/project-create-input.mjs';
import {ModelingTaskService} from '../gateway/modeling-task-service.mjs';
import {ProjectCreateTasks} from '../gateway/project-create-tasks.mjs';
const input=()=>({protocolVersion:1,operation:'project.create',documentId:'new-target',sourceDocumentId:'default',requestId:randomUUID(),name:'新工程',sourceRevision:7,sourceStateToken:'a'.repeat(64),sourceStateSequence:9});
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-project-create-contract-')),service=new ModelingTaskService(root,{onWarning(){}});let executions=0;const tasks=new ProjectCreateTasks({tasks:service,sourceExists:id=>id==='default',targetExists:()=>false,execute:async()=>{executions++;throw Error('must not execute');}});return {root,service,tasks,executions:()=>executions,clean(){assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-project-create-contract-/);fs.rmSync(root,{recursive:true,force:true});}};}
test('fresh project contract preserves complete source identity and canonicalizes only the requested name',()=>{
  const value=input();assert.deepEqual(normalizeProjectCreateInput(value),value);assert.equal(normalizeProjectCreateInput({...value,name:'  新工程  '}).name,'新工程');assert.equal(projectCreateCanonical(value),projectCreateCanonical({...value,name:' 新工程 '}));
});
test('new project binding rejects overwrite identities, incomplete baselines, unknown parameters and unsafe names',()=>{
  for(const patch of [{documentId:'default'},{sourceDocumentId:'../escape'},{requestId:''},{operation:'document.create'},{sourceRevision:undefined},{sourceStateSequence:undefined},{sourceStateToken:undefined},{sourceStateToken:'invalid'},{name:' '},{name:'a\n'},{path:'C:/private'},{sourceRevision:-1},{sourceStateSequence:1.5}])assert.throws(()=>normalizeProjectCreateInput({...input(),...patch}));
});
test('registration atomically persists original source/name with the task and never executes or rewrites its binding',()=>{
  const f=fixture();try{const value=input(),registered=f.tasks.register(value.documentId,value),file=path.join(f.root,'modeling-tasks',registered.modelingTask.taskId+'.json'),before=fs.readFileSync(file);assert.equal(registered.projectCreate.canCreate,true);assert.deepEqual(normalizeProjectCreateTask(registered.projectCreate,registered.modelingTask,'default',value),registered.projectCreate);assert.equal(f.executions(),0);assert.equal(f.tasks.register(value.documentId,value).modelingTask.taskId,registered.modelingTask.taskId);assert.deepEqual(fs.readFileSync(file),before);assert.throws(()=>f.tasks.register(value.documentId,{...value,name:'changed'}),{code:'MODELING_TASK_CONFLICT'});assert.deepEqual(fs.readFileSync(file),before);assert.equal(f.tasks.list('default').total,1);assert.equal(f.tasks.list('other').total,0);}finally{f.clean();}
});
test('source existence and fresh target checks fail before reservation and generic tasks cannot be mistaken for create bindings',()=>{
  const f=fixture();try{assert.throws(()=>f.tasks.register('new-target',{...input(),sourceDocumentId:'missing'}),{code:'PROJECT_CREATE_SOURCE_NOT_FOUND'});f.tasks.targetExists=()=>true;assert.throws(()=>f.tasks.register('new-target',input()),{code:'PROJECT_CREATE_TARGET_EXISTS'});assert.equal(f.service.records.size,0);assert.equal(f.executions(),0);}finally{f.clean();}
});
test('restart keeps unsubmitted create tasks explicitly not-started and cannot silently execute them under a new process',async()=>{
  const f=fixture();try{const value=input(),registered=f.tasks.register(value.documentId,value),next=new ModelingTaskService(f.root,{onWarning(){}}),tasks=new ProjectCreateTasks({tasks:next,sourceExists:()=>true,targetExists:()=>false,execute:()=>{throw Error('must not run');}}),restored=tasks.get(value.documentId,registered.modelingTask.taskId);assert.equal(restored.projectCreate.canCreate,false);assert.equal(restored.modelingTask.execution,'not-started');assert.equal(restored.modelingTask.cancellable,true);await assert.rejects(tasks.create(value.documentId,registered.modelingTask.taskId,{'x-request-id':value.requestId},value),{code:'MODELING_TASK_ALREADY_SUBMITTED'});assert.equal(next.cancel(value.documentId,registered.modelingTask.taskId).phase,'cancelled');}finally{f.clean();}
});
test('foreign task, altered request key and unsupported canCreate states cannot authorize execution',()=>{
  const f=fixture();try{const value=input(),registered=f.tasks.register(value.documentId,value);for(const patch of [{documentId:'foreign'},{sourceDocumentId:'other'},{requestId:'other'},{taskId:randomUUID()},{canCreate:'true'}])assert.throws(()=>normalizeProjectCreateTask({...registered.projectCreate,...patch},registered.modelingTask,'default',value));assert.throws(()=>normalizeProjectCreateTask(registered.projectCreate,{...registered.modelingTask,phase:'succeeded'},'default',value));}finally{f.clean();}
});
test('source discovery pages completed identities independently of all active work and rejects stale cursors',()=>{
  const f=fixture();try{for(let index=0;index<6;index++)f.tasks.register('target-'+index,{...input(),documentId:'target-'+index});f.tasks.sourceExists=()=>true;f.tasks.register('other-target',{...input(),documentId:'other-target',sourceDocumentId:'other'});const page=f.tasks.list('default',{limit:2});assert.equal(page.total,6);assert.equal(page.items.length,2);assert.equal(page.active.length,6);assert.equal(page.attention.length,0);const next=f.tasks.list('default',{limit:2,after:page.nextCursor});assert.equal(next.items.length,2);assert.ok(next.items.every(row=>!page.items.some(old=>old.modelingTask.taskId===row.modelingTask.taskId)));assert.throws(()=>f.tasks.list('default',{after:randomUUID()}),{code:'PROJECT_CREATE_CURSOR_EXPIRED'});for(const limit of [0,101,1.5])assert.throws(()=>f.tasks.list('default',{limit}),{code:'PROJECT_CREATE_TASK_ARGUMENTS'});}finally{f.clean();}
});
test('tampered persisted create metadata cannot be rebound or silently repaired after restart',()=>{
  const f=fixture();try{const value=input(),registered=f.tasks.register(value.documentId,value),file=path.join(f.root,'modeling-tasks',registered.modelingTask.taskId+'.json'),record=JSON.parse(fs.readFileSync(file,'utf8'));record.projectCreateInput.sourceDocumentId='other';fs.writeFileSync(file,JSON.stringify(record));const before=fs.readFileSync(file);assert.throws(()=>new ModelingTaskService(f.root,{onWarning(){}}),{code:'MODELING_TASK_INVALID'});assert.deepEqual(fs.readFileSync(file),before);assert.equal(f.executions(),0);}finally{f.clean();}
});
