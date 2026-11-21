import test from 'node:test';
import assert from 'node:assert/strict';
import {compareProjectAudits,capturePiContextAudit} from '../scripts/audit-project-state.mjs';
const fixture=()=>({format:'web-cad-project-audit',version:2,documentId:'project',revision:5,stateToken:'token',stateSequence:7,bodyCount:1,featureCount:1,featureDigest:'features',identityDigest:'ids',dataDigest:'values',typeDigest:'types',instanceDigest:'instances',pendingTransactions:0,activeMeshJobs:0,pi:[],piContexts:[],checkpoints:{'history/project/state.xbf':'abc'},spatialPolicy:null,bodies:[{bodyId:'body-1',kind:'solid',name:'Example',visible:true,bodyIdentity:'original',volume:6,centroid:[.5,1,1.5],bounds:{min:[-1e-7,-1e-7,-1e-7],max:[1.0000001,2.0000001,3.0000001]}}]});
test('deployment audit protects every persisted checkpoint and project identity, even during an explicit spatial policy transition',()=>{
  const before=fixture(),after=structuredClone(before);after.spatialPolicy={version:1};after.bodies[0].bounds={min:[0,0,0],max:[1,2,3]};after.bodies[0].area=22;assert.doesNotThrow(()=>compareProjectAudits(before,after,{allowSpatialPolicyTransition:true}));assert.throws(()=>compareProjectAudits(before,after));
  for(const mutate of [report=>report.checkpoints['history/project/state.xbf']='changed',report=>report.stateToken='changed',report=>report.bodies[0].bodyIdentity='new',report=>report.bodies[0].volume=7,report=>report.bodies[0].centroid[0]=2,report=>report.bodies[0].bounds.max[0]=3]){const bad=structuredClone(after);mutate(bad);assert.throws(()=>compareProjectAudits(before,bad,{allowSpatialPolicyTransition:true}));}
});
test('ordinary release audits require exact derived metadata and refuse an already-v1 baseline under the one-time transition override',()=>{
  const before=fixture();before.spatialPolicy={version:1};before.bodies[0].area=22;assert.doesNotThrow(()=>compareProjectAudits(before,structuredClone(before)));const bad=structuredClone(before);bad.bodies[0].bounds.min[0]+=1e-13;assert.throws(()=>compareProjectAudits(before,bad));assert.throws(()=>compareProjectAudits(before,before,{allowSpatialPolicyTransition:true}));
});

function withContext(){const report=fixture();report.pi=[{id:'webcad-project',running:true,streaming:false,compacting:false,pending:0}];report.piContexts=[{id:'webcad-project',documentId:'project',messageCount:18,messagesDigest:'a'.repeat(64),entryCount:20,entriesDigest:'b'.repeat(64)}];return report;}
test('online and idle is not sufficient: an empty resumed context fails deployment comparison',()=>{
  const before=withContext(),after=structuredClone(before);after.piContexts[0].messageCount=0;after.piContexts[0].messagesDigest='c'.repeat(64);
  assert.throws(()=>compareProjectAudits(before,after),/Pi context/);
});
test('deployment comparison protects full Pi branches even if resolved visible messages remain the same',()=>{
  const before=withContext(),after=structuredClone(before);after.piContexts[0].entriesDigest='d'.repeat(64);
  assert.throws(()=>compareProjectAudits(before,after),/Pi context/);
  const missing=structuredClone(before);delete missing.piContexts;assert.throws(()=>compareProjectAudits(before,missing),/Pi context/);
});
test('legacy online-only reports cannot masquerade as context-aware deployment certification',()=>{
  const before=fixture();before.version=1;delete before.piContexts;
  assert.throws(()=>compareProjectAudits(before,structuredClone(before)),/legacy|Legacy/);
});

test('explicit legacy comparison reports its weaker scope and cannot disable v2 context checking',()=>{
  const old=fixture();old.version=1;delete old.piContexts;const current=fixture();
  assert.deepEqual(compareProjectAudits(old,current,{allowLegacyPiAudit:true}),{piContextCompared:false});
  assert.deepEqual(compareProjectAudits(current,structuredClone(current)),{piContextCompared:true});
  const before=withContext(),after=structuredClone(before);after.piContexts=[];
  assert.throws(()=>compareProjectAudits(before,after,{allowLegacyPiAudit:true}),/Pi context/);
});

function contextRpcFixture(){
  const envelope=data=>({documentId:'project',streamId:'process-1',eventCursor:7,response:{success:true,data}});
  const initial=envelope({sessionId:'native-1',messageCount:1,isStreaming:false,isCompacting:false,pendingMessageCount:0});
  const history=envelope({messages:[{role:'user',content:'Private transcript: never print or persist plaintext in the audit'}]});
  const entries=envelope({entries:[{id:'branch-1',parentId:null,type:'message',message:history.response.data.messages[0]},{id:'branch-2',parentId:null,type:'message',message:{role:'user',content:'An alternate branch'}}]});
  const confirmed=structuredClone(initial),calls=[];
  const request=async(route,body)=>{calls.push({route,type:body.command.type});return ({get_messages:history,get_entries:entries,get_state:confirmed})[body.command.type];};
  return {initial,history,entries,confirmed,calls,request};
}
test('context capture reads native resolved messages and full branches without exposing transcript or session paths',async()=>{
  const f=contextRpcFixture(),report=await capturePiContextAudit(f.request,'webcad-project',f.initial);
  assert.deepEqual(f.calls.map(call=>call.type),['get_messages','get_entries','get_state']);
  assert.ok(f.calls.every(call=>call.route==='/pi/sessions/webcad-project/commands'));
  assert.equal(report.messageCount,1);assert.equal(report.entryCount,2);
  assert.match(report.messagesDigest,/^[0-9a-f]{64}$/);assert.match(report.entriesDigest,/^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(report).includes('Private transcript'));assert.ok(!JSON.stringify(report).includes('native-1'));
  const migrated=contextRpcFixture();migrated.initial.response.data.sessionId='native-migrated';migrated.confirmed.response.data.sessionId='native-migrated';
  assert.deepEqual(await capturePiContextAudit(migrated.request,'webcad-project',migrated.initial),report,'Native cross-cwd fork may change only the session header identity, not context or branches');
});
test('context capture rejects a changed process, project, event cursor or native session while reading',async()=>{
  for(const mutate of [f=>f.history.streamId='process-2',f=>f.entries.documentId='other',f=>f.confirmed.eventCursor=8,f=>f.confirmed.response.data.sessionId='another-session']){
    const f=contextRpcFixture();mutate(f);await assert.rejects(capturePiContextAudit(f.request,'webcad-project',f.initial),/changed during context audit/);
  }
});
test('context capture rejects a busy or incomplete state and inconsistent native message counts',async()=>{
  for(const mutate of [f=>f.initial.response.data.isStreaming=true,f=>delete f.initial.response.data.isCompacting,f=>f.confirmed.response.data.pendingMessageCount=1,f=>f.history.response.data.messages=[],f=>f.confirmed.response.data.messageCount=2]){
    const f=contextRpcFixture();mutate(f);await assert.rejects(capturePiContextAudit(f.request,'webcad-project',f.initial),/prevents context audit|message count changed/);
  }
});
test('context capture refuses missing protocol evidence and malformed native history instead of certifying an empty fallback',async()=>{
  for(const mutate of [f=>delete f.initial.streamId,f=>delete f.history.eventCursor,f=>f.entries.response.success=false,f=>f.entries.response.data.entries=null,f=>f.history.response.data.messages={messages:[]}]){
    const f=contextRpcFixture();mutate(f);await assert.rejects(capturePiContextAudit(f.request,'webcad-project',f.initial));
  }
});
test('context comparison refuses missing, malformed, duplicated or partially covered session digests',()=>{
  const before=withContext();
  for(const mutate of [f=>f.piContexts[0].messagesDigest='not-a-hash',f=>f.piContexts[0].messageCount=-1,f=>f.piContexts.push(structuredClone(f.piContexts[0])),f=>f.piContexts[0].id='other-session']){
    const after=structuredClone(before);mutate(after);assert.throws(()=>compareProjectAudits(before,after),/Pi context/);
  }
});
