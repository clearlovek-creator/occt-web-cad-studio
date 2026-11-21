import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {normalizeProjectOpenInput,projectOpenCanonical} from '../shared/project-open-input.mjs';
import {ModelingTaskService} from '../gateway/modeling-task-service.mjs';
import {ProjectOpenTasks} from '../gateway/project-open-tasks.mjs';
const input=(patch={})=>({protocolVersion:1,operation:'project.open',documentId:'new-target',sourceDocumentId:'old',requestId:'open-1',fileName:'工程.cadproj',expectedBytes:4,sourceRevision:2,sourceStateSequence:3,sourceStateToken:'a'.repeat(64),...patch});
const meta=value=>{const digest=createHash('sha256').update(projectOpenCanonical(value)).digest('hex');return {documentId:value.documentId,operation:'project.open',requestKey:value.requestId,digest,outcomeFingerprint:digest};};
function fixture(t){const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-file-task-contract-'));t.after(()=>{assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-file-task-contract-/);fs.rmSync(data,{recursive:true,force:true});});return {data,tasks:new ModelingTaskService(data,{onWarning:()=>{}})};}
test('project-open metadata normalization is deterministic and rejects paths, secrets, foreign operations and malformed source state',()=>{
  const value=input(),reordered=Object.fromEntries(Object.entries(value).reverse());assert.deepEqual(normalizeProjectOpenInput(reordered),value);assert.equal(projectOpenCanonical(reordered),projectOpenCanonical(value));assert.notEqual(normalizeProjectOpenInput(value),value);
  for(const patch of [{apiKey:'not-a-key'},{parameters:{path:'C:/private'}},{documentId:'old'},{sourceDocumentId:'../old'},{requestId:'bad request'},{fileName:'../file.cadproj'},{fileName:' '},{expectedBytes:0},{expectedBytes:1.1},{sourceRevision:-1},{sourceStateSequence:true},{sourceStateToken:'z'.repeat(64)},{operation:'step.import'}])assert.throws(()=>normalizeProjectOpenInput(input(patch)));
  assert.throws(()=>normalizeProjectOpenInput(value,3));
});
test('file binding and task identity persist atomically while public task DTOs never expose the private input record',t=>{
  const f=fixture(t),value=input(),metadata=meta(value),record=f.tasks.reserve({...metadata,apiKey:'not-a-key'},{projectOpenInput:value});value.expectedBytes=8;
  const saved=JSON.parse(fs.readFileSync(f.tasks.file(record.taskId),'utf8'));assert.equal(saved.projectOpenInput.expectedBytes,4);assert.equal(JSON.stringify(record).includes('projectOpenInput'),false);assert.equal(JSON.stringify(saved).includes('not-a-key'),false);
  const restarted=new ModelingTaskService(f.data,{onWarning:()=>{}}),restored=restarted.get('new-target',record.taskId);assert.equal(restored.phase,'reserved');assert.equal(restored.execution,'not-started');assert.equal(restored.cancellable,true);assert.equal(restarted.cancel('new-target',record.taskId).phase,'cancelled');
});
test('changed persisted attachment metadata cannot survive restart or be adopted with the old task digest',t=>{
  const f=fixture(t),value=input(),record=f.tasks.reserve(meta(value),{projectOpenInput:value}),file=f.tasks.file(record.taskId),saved=JSON.parse(fs.readFileSync(file,'utf8'));saved.projectOpenInput.expectedBytes++;
  fs.writeFileSync(file,JSON.stringify(saved));const before=fs.readFileSync(file);assert.throws(()=>new ModelingTaskService(f.data,{onWarning:()=>{}}),{code:'MODELING_TASK_INVALID'});assert.deepEqual(fs.readFileSync(file),before);assert.throws(()=>f.tasks.reserve(meta(input()),{projectOpenInput:input({expectedBytes:9})}),{code:'MODELING_TASK_INVALID'});
});
test('incoming file task listing pages immutable identities and returns all live tasks without reading unrelated history',t=>{
  const f=fixture(t),service=new ProjectOpenTasks({tasks:f.tasks,inputs:{maxBytes:8},maxBytes:10,targetExists:()=>false,sourceExists:()=>true,execute:()=>{throw Error('Registration must not execute');}}),records=[];
  for(let index=0;index<3;index++)records.push(service.register('target-'+index,input({documentId:'target-'+index,requestId:'open-'+index})));
  service.register('foreign-target',input({documentId:'foreign-target',sourceDocumentId:'foreign'}));assert.throws(()=>service.register('too-large',input({documentId:'too-large',expectedBytes:9})),{code:'PROJECT_OPEN_TASK_ARGUMENTS'});
  const first=service.list('old',{limit:2}),second=service.list('old',{limit:2,after:first.nextCursor});assert.equal(first.total,3);assert.equal(first.items.length,2);assert.equal(first.active.length,3);assert.equal(second.items.length,1);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.items,...second.items].map(row=>row.projectOpen.taskId)).size,3);
  assert.throws(()=>service.list('old',{after:randomUUID()}),{code:'PROJECT_OPEN_CURSOR_EXPIRED'});assert.throws(()=>service.list('old',{limit:101}),{code:'PROJECT_OPEN_TASK_ARGUMENTS'});assert.throws(()=>service.get('foreign-target',records[0].modelingTask.taskId),{code:'MODELING_TASK_NOT_FOUND'});
});
