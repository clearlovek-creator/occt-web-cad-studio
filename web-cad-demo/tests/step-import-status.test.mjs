import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {StepImportStore} from '../gateway/step-import-store.mjs';
import {activeStepImport,normalizeStepImportStatus,stepImportReport} from '../shared/step-import-status.mjs';
const token='a'.repeat(64);
function fixture(t,options={}){const data=fs.mkdtempSync(path.join(os.tmpdir(),'step-ledger-'));t.after(()=>{assert.ok(data.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});return {data,store:new StepImportStore(data,{ownerInstanceId:'owner-a',onWarning:()=>{},...options})};}

test('STEP phase admission is bounded per project and process, request IDs never reupload',t=>{
  const {store}=fixture(t,{maxActive:2});const first=store.begin('doc','first','C:\\incoming\\零件.step');
  assert.equal(first.fileName,'零件.step');assert.equal(first.phase,'receiving');assert.equal(first.sequence,1);
  assert.throws(()=>store.begin('doc','again'),e=>e.code==='STEP_IMPORT_BUSY');store.begin('other','first');
  assert.throws(()=>store.begin('third','first'),e=>e.code==='STEP_IMPORT_BUSY');
  for(const phase of ['queued','preparing','converting','committing'])store.advance('doc','first',phase);
  assert.throws(()=>store.advance('doc','first','receiving'),e=>e.code==='INVALID_STEP_IMPORT_PHASE');
  const complete=store.advance('doc','first','complete',{revision:1,stateToken:token,report:{bodyCount:2,modelLengthUnit:'mm'}});
  assert.equal(complete.sequence,6);assert.equal(complete.report.bodyCount,2);assert.equal(store.active.size,1);
  assert.throws(()=>store.begin('doc','first'),e=>e.code==='STEP_IMPORT_REQUEST_EXISTS');
  assert.equal(store.get('doc','first').phase,'complete');assert.equal(store.get('doc','missing'),null);
  for(const [id,request] of [['../escape','ok'],['doc','bad/id'],['doc','x'.repeat(161)]])assert.throws(()=>store.begin(id,request),e=>e.code==='INVALID_STEP_IMPORT_ID');
});

test('unfinished records are diagnosed read-only after restart, never restarted or rewritten',t=>{
  const {store,data}=fixture(t);store.begin('doc','before-crash');store.advance('doc','before-crash','converting');
  const file=store.file('doc','before-crash'),bytes=fs.readFileSync(file),recovered=new StepImportStore(data,{ownerInstanceId:'owner-b'}).get('doc','before-crash');
  assert.equal(recovered.phase,'interrupted');assert.equal(recovered.recovered,true);assert.match(recovered.error,/没有重新上传或重放/);assert.deepEqual(fs.readFileSync(file),bytes);
});

test('verified accepted outcome recovers a lost final report, but malformed outcome cannot claim completion',t=>{
  let outcome;const {store,data}=fixture(t);store.begin('doc','accepted');store.advance('doc','accepted','committing');
  const recovered=new StepImportStore(data,{ownerInstanceId:'owner-b',resolveOutcome:()=>outcome});
  for(const invalid of [{ok:true},{ok:true,documentId:'elsewhere',revision:1,stateToken:token},{ok:true,documentId:'doc',revision:-1,stateToken:token}]){outcome=invalid;assert.notEqual(recovered.get('doc','accepted').phase,'complete');}
  outcome={ok:true,documentId:'doc',revision:1,stateToken:token,stepImport:{bodyCount:5,sourcePath:'secret'}};
  const result=recovered.get('doc','accepted');assert.equal(result.phase,'complete');assert.equal(result.stateToken,token);assert.equal(result.report.bodyCount,5);assert.equal(result.report.sourcePath,undefined);
});

test('terminal report write failure cannot change a successful geometry result into failure',t=>{
  let outcome=null;const {store}=fixture(t,{resolveOutcome:()=>outcome});store.begin('doc','complete');store.advance('doc','complete','committing');
  const persist=store.persist.bind(store);store.persist=()=>{throw Error('injected disk error');};
  const result=store.advance('doc','complete','complete',{revision:2,stateToken:token});assert.equal(result.phase,'complete');assert.equal(result.reportDurable,false);assert.equal(store.active.size,0);
  store.persist=persist;outcome={ok:true,documentId:'doc',revision:2,stateToken:token};assert.equal(store.get('doc','complete').phase,'complete');
});

test('active report write failure has an actionable domain code before the next import stage',t=>{
  const {store}=fixture(t);store.begin('doc','disk-failure');store.persist=()=>{throw Error('private directory path');};
  assert.throws(()=>store.advance('doc','disk-failure','queued'),e=>e.code==='STEP_IMPORT_REPORT_UNAVAILABLE'&&!e.message.includes('private directory path'));
});

test('unknown outcomes stay unknown without an accepted transaction; current interrupted status is not success',t=>{
  const {store}=fixture(t);store.begin('doc','uncertain');const result=store.advance('doc','uncertain','unknown',{code:'PROJECT_ROLLBACK_FAILED',error:'recover first'});
  assert.equal(result.phase,'unknown');assert.equal(store.get('doc','uncertain').phase,'unknown');assert.equal(store.get('doc','uncertain').code,'PROJECT_ROLLBACK_FAILED');
  store.begin('doc','stopping');store.interruptActive();assert.equal(store.get('doc','stopping').phase,'interrupted');
});

test('stored record shape is validated strictly and corrupt evidence is never removed',t=>{
  const {store}=fixture(t);store.begin('doc','corrupt');store.advance('doc','corrupt','failed');const file=store.file('doc','corrupt'),original=JSON.parse(fs.readFileSync(file));
  for(const patch of [{createdAt:0},{updatedAt:[]},{fileName:'../secret.step'},{ownerInstanceId:[]},{bytes:-1},{revision:'1'},{error:{}},{stateToken:'invalid'},{reportDurable:'yes'}]){
    fs.writeFileSync(file,JSON.stringify({...original,...patch}));const bytes=fs.readFileSync(file);
    assert.throws(()=>store.get('doc','corrupt'),e=>e.code==='STEP_IMPORT_REPORT_UNAVAILABLE');assert.deepEqual(fs.readFileSync(file),bytes);
  }
  fs.writeFileSync(file,'x'.repeat(65537));assert.throws(()=>store.get('doc','corrupt'),e=>e.code==='STEP_IMPORT_REPORT_UNAVAILABLE');
});

test('retention removes only old managed records; report responses exclude private fields',t=>{
  const {store}=fixture(t,{limit:3});for(let i=0;i<8;i++){store.begin('doc','record-'+i);store.advance('doc','record-'+i,'failed',{error:'diagnostic'});}
  assert.equal(store.records('doc').length,3);const latest=store.latest('doc');assert.equal(latest.requestId,'record-7');
  const file=store.file('doc',latest.requestId),raw=JSON.parse(fs.readFileSync(file));raw.providerApiKey='never-public';raw.report={bodyCount:2,sourcePath:'never-public'};fs.writeFileSync(file,JSON.stringify(raw));
  const result=store.get('doc',latest.requestId);assert.equal(result.ownerInstanceId,undefined);assert.ok(!JSON.stringify(result).includes('never-public'));
  fs.writeFileSync(path.join(store.directory('doc'),'notes.txt'),'retain');store.cleanup('doc');assert.equal(fs.readFileSync(path.join(store.directory('doc'),'notes.txt'),'utf8'),'retain');
});

test('public status normalizes identities and bounded diagnostics without leaking arbitrary fields',()=>{
  const record={version:1,documentId:'doc',requestId:'request',phase:'complete',sequence:2,fileName:'part.step',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),ownerInstanceId:'secret',report:{bodyCount:2,invalidBodyCount:-1,sourceLengthUnits:['mm',12],modelLengthUnit:'mm',apiKey:'secret'}};
  const result=normalizeStepImportStatus(record,'doc','request');assert.equal(result.ownerInstanceId,undefined);assert.equal(result.report.invalidBodyCount,undefined);assert.deepEqual(result.report.sourceLengthUnits,['mm']);assert.ok(!JSON.stringify(result).includes('secret'));
  for(const value of [{...record,documentId:'other'},{...record,requestId:'other'},{...record,phase:'invented'},{...record,sequence:-1}])assert.throws(()=>normalizeStepImportStatus(value,'doc','request'));
  assert.equal(activeStepImport('complete'),false);assert.equal(activeStepImport('converting'),true);assert.equal(stepImportReport(null),null);
});
