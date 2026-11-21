import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {importTestTypeScript} from './helpers/import-typescript.mjs';
import {namingUpgradeAdvice,namingUpgradeArchivePolicy,namingUpgradeCapability,namingUpgradeOutcomeUnknown,parseNamingUpgradeReceipt,parseNamingUpgradeUndo,sameNamingUpgradeState} from '../app/model/imported-naming-upgrade.ts';
const owner={documentId:'default',revision:3,stateToken:'a'.repeat(64),stateSequence:7};
const report=(preview=true)=>({ok:true,documentId:'default',revision:preview?3:4,stateToken:(preview?'a':'b').repeat(64),stateSequence:preview?7:8,bodyCount:1,importedNamingUpgrade:{version:1,preview,sourceCount:1,bodyCount:1,historicalOutputCount:2,referenceCount:1,geometryUnchanged:true,topologyIdentitiesUnchanged:true,changed:!preview}});

test('naming preview and commit receipts prove their own exact state, counters, invariants and distinct mutation outcome',()=>{
  assert.equal(parseNamingUpgradeReceipt(report(),owner,true).stamp.stateToken,owner.stateToken);
  assert.equal(parseNamingUpgradeReceipt(report(false),owner,false).report.changed,true);
  for(const preview of [true,false]){
    const value=report(preview);
    for(const patch of [{documentId:'other'},{revision:99},{stateToken:'bad'},{stateSequence:-1},{bodyCount:2},{ok:false}])assert.throws(()=>parseNamingUpgradeReceipt({...value,...patch},owner,preview));
    for(const patch of [{version:2},{preview:!preview},{changed:preview},{geometryUnchanged:false},{topologyIdentitiesUnchanged:false},{referenceCount:10001},{sourceCount:-1},{historicalOutputCount:0.5}])assert.throws(()=>parseNamingUpgradeReceipt({...value,importedNamingUpgrade:{...value.importedNamingUpgrade,...patch}},owner,preview));
  }
  assert.throws(()=>parseNamingUpgradeReceipt({...report(),stateToken:'b'.repeat(64)},owner,true));
  assert.throws(()=>parseNamingUpgradeReceipt({...report(false),stateToken:owner.stateToken},owner,false));
  assert.throws(()=>parseNamingUpgradeReceipt({...report(false),stateSequence:7},owner,false));
});

test('no-op upgrade cannot advertise a new revision or state, and Undo is bound to the exact upgrade generation',()=>{
  const value=report(false);value.revision=3;value.stateSequence=7;value.stateToken=owner.stateToken;Object.assign(value.importedNamingUpgrade,{sourceCount:0,changed:false});
  assert.equal(parseNamingUpgradeReceipt(value,owner,false).report.changed,false);
  assert.throws(()=>parseNamingUpgradeReceipt({...value,revision:4},owner,false));
  const undo={ok:true,documentId:'default',revision:2,stateToken:'c'.repeat(64),stateSequence:8};assert.equal(parseNamingUpgradeUndo(undo,owner).revision,2);
  for(const patch of [{revision:3},{stateToken:owner.stateToken},{documentId:'other'},{stateSequence:7}])assert.throws(()=>parseNamingUpgradeUndo({...undo,...patch},owner));
});

test('same native R with a changed engineering token, another project or a newer sequence invalidates the old preview',()=>{
  assert.equal(sameNamingUpgradeState(owner,{...owner}),true);
  for(const patch of [{stateToken:'b'.repeat(64)},{documentId:'other'},{revision:2},{stateSequence:8},{stateToken:null}])assert.equal(sameNamingUpgradeState(owner,{...owner,...patch}),false);
});

test('upgrade availability is not inferred from a healthy service or new-import support',()=>{
  const feature={version:1,basis:'immutable-step-brep-v1',sourceFingerprintAlgorithm:'sha256-chain-1m-v1',upgrade:{version:1,basis:'unchanged-dual-replay-v1',archivedRecovery:false}};
  const value={ok:true,capabilities:{nativeGeometry:{version:1,source:'native-handshake',ready:true,workerInstance:'11111111-1111-4111-8111-111111111111',features:{'immutable-step-topology-v1':feature}}}};
  assert.equal(namingUpgradeCapability(value),true);assert.equal(namingUpgradeCapability({ok:true}),false);
  for(const patch of [{ready:false},{source:'installed-file'},{workerInstance:'bad'}])assert.equal(namingUpgradeCapability({...value,capabilities:{nativeGeometry:{...value.capabilities.nativeGeometry,...patch}}}),false);
  for(const patch of [{upgrade:undefined},{basis:'index'},{upgrade:{...feature.upgrade,archivedRecovery:true}}])assert.equal(namingUpgradeCapability({...value,capabilities:{nativeGeometry:{...value.capabilities.nativeGeometry,features:{'immutable-step-topology-v1':{...feature,...patch}}}}}),false);
});

test('unknown mutation outcomes remain distinct from proven source, state or reference rejection',()=>{
  for(const code of [undefined,'NETWORK_ERROR','INVALID_RESPONSE','WORKER_TIMEOUT','PROJECT_ROLLBACK_FAILED'])assert.equal(namingUpgradeOutcomeUnknown(code),true);
  for(const code of ['IMPORT_NAMING_UPGRADE_ARCHIVED_REFERENCES','IMPORT_NAMING_UPGRADE_REFERENCE_MISSING','STEP_REPLAY_SOURCE_CHANGED','PROJECT_STATE_CONFLICT']){assert.equal(namingUpgradeOutcomeUnknown(code),false);assert.notEqual(namingUpgradeAdvice(code).title,'验证或升级未完成');}
  assert.match(namingUpgradeAdvice('IMPORT_NAMING_UPGRADE_ARCHIVED_REFERENCES').text,/不要.*删除/);
});
test('archived receipt counts are complete, bounded and distinct from already-active model references',()=>{
  const value=report(),withArchive=patch=>({...value,importedNamingUpgrade:{...value.importedNamingUpgrade,...patch}}),counts={archivedSourceCount:2,archivedProofCount:1,archivedReferenceCount:3};
  assert.equal(parseNamingUpgradeReceipt(value,owner,true).report.archivedSourceCount,0);
  assert.equal(parseNamingUpgradeReceipt(withArchive(counts),owner,true).report.archivedProofCount,1);
  assert.equal(parseNamingUpgradeReceipt(withArchive({...counts,archivedProofCount:0}),owner,true).report.archivedSourceCount,2,'dormant coordinates need no removed-Body archive');
  for(const patch of [{archivedSourceCount:undefined},{archivedProofCount:null},{archivedReferenceCount:-1},{archivedSourceCount:65},{archivedProofCount:257},{archivedReferenceCount:640001},{archivedSourceCount:0},{sourceCount:0}])assert.throws(()=>parseNamingUpgradeReceipt(withArchive({...counts,...patch}),owner,true));
});
test('UI distinguishes precise archived re-certification from legacy refusal and rejects unknown or unbounded claims',()=>{
  const upgrade={version:1,basis:'unchanged-dual-replay-v1',archivedRecovery:'exact-recertification-v1',maxArchivedSources:64,maxArchivedProofs:256};
  const value=patch=>({ok:true,capabilities:{nativeGeometry:{version:1,source:'native-handshake',ready:true,workerInstance:'11111111-1111-4111-8111-111111111111',features:{'immutable-step-topology-v1':{version:1,basis:'immutable-step-brep-v1',sourceFingerprintAlgorithm:'sha256-chain-1m-v1',upgrade:{...upgrade,...patch}}}}}});
  assert.equal(namingUpgradeArchivePolicy(value({})),'exact-recertification-v1');assert.equal(namingUpgradeCapability(value({})),true);
  assert.equal(namingUpgradeArchivePolicy(value({archivedRecovery:false})),'none');
  for(const patch of [{archivedRecovery:true},{archivedRecovery:'anything'},{maxArchivedSources:0},{maxArchivedSources:65},{maxArchivedProofs:257},{maxArchivedProofs:undefined}])assert.equal(namingUpgradeArchivePolicy(value(patch)),'unsupported');
  for(const code of ['IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED','IMPORT_NAMING_UPGRADE_ARCHIVE_LIMIT','INVALID_SUSPENDED_TOPOLOGY']){assert.equal(namingUpgradeOutcomeUnknown(code),false);assert.notEqual(namingUpgradeAdvice(code).title,'验证或升级未完成');}
  assert.match(namingUpgradeAdvice('IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED').text,/整次升级未提交/);
});

test('the actual maintenance panel starts without an implicit request or enabled mutation and uses existing source navigation',async()=>{
  const {ImportedNamingUpgradePanel}=await importTestTypeScript('../app/ImportedNamingUpgradePanel.tsx',import.meta.url);
  const html=renderToStaticMarkup(React.createElement(ImportedNamingUpgradePanel,{documentId:'default',geometry:null,blocked:false,onModel:()=>{},onSources:()=>{},onHistory:()=>{}}));
  assert.match(html,/旧工程引用升级/);assert.match(html,/请先载入工程/);assert.match(html,/<button[^>]*disabled=""[^>]*>升级引用<\/button>/);assert.match(html,/不会自动重发/);assert.doesNotMatch(html,/确认执行|<dialog/);
});
