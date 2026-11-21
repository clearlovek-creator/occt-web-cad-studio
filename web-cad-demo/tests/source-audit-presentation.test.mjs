import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../app/model/source-audit.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {parseSourceAudit,activeSourceAudit,sourceStatusLabel}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const fixture=()=>({ok:true,documentId:'project',audit:{jobId:'sources-test',documentId:'project',state:'complete',phase:'complete',createdAt:new Date(0).toISOString(),completedCheckpoints:1,totalCheckpoints:1,coverageComplete:true,integrityOK:true,stale:false,scope:'current-undo-redo',cleanupAvailable:false,assets:[{assetId:'asset',fileName:'中文.step',status:'verified',referenceCount:1,currentReferences:1,undoReferences:0,redoReferences:0,references:[{featureId:'feature-1',scope:'current',checkpoint:'current.xbf',status:'verified',featureState:'valid'}]}],issues:[]}});

test('source presentation validates project identity, real counts, status and bounded reference details',()=>{
  const value=fixture();assert.equal(parseSourceAudit(value,'project').assets[0].fileName,'中文.step');assert.equal(activeSourceAudit(value.audit),false);
  for(const state of ['queued','running','stopping'])assert.equal(activeSourceAudit({...value.audit,state}),true);
  assert.equal(sourceStatusLabel('legacy-unverified'),'旧来源未认证');assert.equal(sourceStatusLabel('missing'),'文件缺失');
  assert.equal(parseSourceAudit({ok:true,documentId:'project',audit:null},'project'),null);
  assert.throws(()=>parseSourceAudit(value,'other'),/当前工程/);
  for(const change of [{cleanupAvailable:true},{scope:'all-projects'},{totalCheckpoints:0},{completedCheckpoints:-1},{state:'success'},{assets:Array(1001).fill(value.audit.assets[0])},{error:{}},{stateToken:'bad'}])assert.throws(()=>parseSourceAudit({...value,audit:{...value.audit,...change}},'project'));
  for(const change of [{referenceCount:9},{status:'safe-to-delete'},{sha256:'invalid'},{references:Array(21).fill(value.audit.assets[0].references[0])}])assert.throws(()=>parseSourceAudit({...value,audit:{...value.audit,assets:[{...value.audit.assets[0],...change}]}},'project'));
});

test('partial reports retain missing, modified and legacy evidence without inventing cleanup eligibility',()=>{
  for(const status of ['legacy-unverified','changed','unverified','missing','untrusted','unreadable']){
    const value=fixture();value.audit.integrityOK=false;value.audit.assets[0].status=status;value.audit.assets[0].references[0].status=status;
    assert.equal(parseSourceAudit(value,'project').assets[0].status,status);assert.equal(parseSourceAudit(value,'project').cleanupAvailable,false);
  }
  const value=fixture();value.audit.coverageComplete=false;value.audit.integrityOK=false;value.audit.issues.push({code:'SOURCE_SNAPSHOT_CHECKSUM',message:'检查点无法核对',checkpoint:'undo.xbf'});assert.equal(parseSourceAudit(value,'project').issues.length,1);
  value.audit.state='failed';value.audit.code='SOURCE_AUDIT_LIMIT';value.audit.totalCheckpoints=129;assert.equal(parseSourceAudit(value,'project').code,'SOURCE_AUDIT_LIMIT','A declared budget failure must remain readable, not become a protocol error');
});

test('storage reports preserve cross-project and recovery roles without being accepted as current-project reports',()=>{
  const value=fixture();value.documentId=value.audit.documentId='@storage';value.audit.scope='storage';value.audit.totalCheckpoints=500;value.audit.completedCheckpoints=500;
  const row=value.audit.assets[0];Object.assign(row,{referenceCount:4,currentReferences:1,recoveryReferences:1,quarantineReferences:1,retainedReferences:1,projectCount:2,projects:['A','B']});row.references.push({featureId:'feature-2',documentId:'B',scope:'recovery',checkpoint:'B/rollback.xbf',status:'verified',featureState:'valid'});
  assert.equal(parseSourceAudit(value,'@storage').assets[0].projectCount,2);assert.throws(()=>parseSourceAudit(value,'project'));
  row.projectCount=1;assert.throws(()=>parseSourceAudit(value,'@storage'),/工程归属/);row.projectCount=2;
  value.audit.assets.push({assetId:'retained',fileName:'retained.step',status:'unreferenced',referenceCount:0,currentReferences:0,undoReferences:0,redoReferences:0,references:[]});assert.equal(parseSourceAudit(value,'@storage').assets[1].status,'unreferenced');
});
