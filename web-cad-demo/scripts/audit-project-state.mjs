/* Read-only deployment guard. Never loads providers or replays Agent prompts. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validatePiContexts(report){
  assert.ok(Array.isArray(report.piContexts),'Pi context audit is missing');
  const ids=[];
  for(const item of report.piContexts){
    assert.ok(item&&typeof item.id==='string'&&typeof item.documentId==='string','Pi context identity is missing');
    for(const key of ['messageCount','entryCount'])assert.ok(Number.isSafeInteger(item[key])&&item[key]>=0,'Pi context count is invalid');
    for(const key of ['messagesDigest','entriesDigest'])assert.match(item[key]||'',/^[0-9a-f]{64}$/,'Pi context digest is invalid');
    ids.push(item.id);
  }
  assert.equal(new Set(ids).size,ids.length,'Pi context identities are duplicated');
  assert.deepEqual([...ids].sort(),report.pi.filter(item=>item.running).map(item=>item.id).sort(),'Pi context audit must cover every running session');
}
export function compareProjectAudits(before,after,{allowSpatialPolicyTransition=false,allowLegacyPiAudit=false}={}){
  assert.equal(before.format,'web-cad-project-audit');assert.equal(after.format,before.format);
  assert.ok(after.version===2&&(before.version===2||allowLegacyPiAudit&&before.version===1),'Legacy deployment audit has no Pi context proof; capture a v2 baseline or explicitly allow legacy comparison');
  validatePiContexts(after);
  if(before.version===2){validatePiContexts(before);assert.deepEqual(after.piContexts,before.piContexts,'Pi context or full history changed during deployment');}
  for(const key of ['documentId','revision','stateToken','stateSequence','bodyCount','featureCount','featureDigest','identityDigest','dataDigest','typeDigest','instanceDigest','pendingTransactions','activeMeshJobs','pi'])assert.deepEqual(after[key],before[key],`Project audit changed ${key}`);
  const changed=[...new Set([...Object.keys(before.checkpoints),...Object.keys(after.checkpoints)])].filter(file=>before.checkpoints[file]!==after.checkpoints[file]);assert.equal(changed.length,0,`Persisted geometry/property/history files changed: ${changed.slice(0,10).join(', ')}`);
  if(!allowSpatialPolicyTransition){assert.deepEqual(after.bodies,before.bodies);assert.deepEqual(after.spatialPolicy,before.spatialPolicy);return {piContextCompared:before.version===2};}
  assert.ok(!before.spatialPolicy||before.spatialPolicy.version===0,'Policy transition guard is only for a legacy baseline');assert.equal(after.spatialPolicy?.version,1);
  const derived=new Set(['bounds','volume','area','centroid']);const stable=body=>Object.fromEntries(Object.entries(body).filter(([key])=>!derived.has(key)));
  assert.deepEqual(after.bodies.map(stable),before.bodies.map(stable),'Policy changes must not alter identities, topology counts, names or display settings');
  for(let index=0;index<before.bodies.length;index++){
    const a=before.bodies[index],b=after.bodies[index];assert.ok(Number.isFinite(b.volume)&&Number.isFinite(b.area));
    assert.ok(Math.abs(a.volume-b.volume)<=1e-11*Math.max(1,Math.abs(a.volume)),'Volume differs beyond legacy 12-digit serialization precision');
    if(a.kind==='solid')a.centroid.forEach((value,axis)=>assert.ok(Math.abs(value-b.centroid[axis])<=1e-11*Math.max(1,Math.abs(value)),'Solid center changed beyond legacy serialization precision'));
    if(a.bounds&&b.bounds)for(let axis=0;axis<3;axis++){const tolerance=1e-9*Math.max(1,Math.abs(a.bounds.min[axis]),Math.abs(a.bounds.max[axis]));assert.ok(b.bounds.min[axis]>=a.bounds.min[axis]-tolerance&&b.bounds.max[axis]<=a.bounds.max[axis]+tolerance,'Analytic AABB must remain inside the former conservative envelope');}
  }
  return {piContextCompared:before.version===2};
}
export async function capturePiContextAudit(request,id,initial){
  const route=`/pi/sessions/${encodeURIComponent(id)}/commands`;
  const idle=state=>assert.ok(state&&state.isStreaming===false&&state.isCompacting===false&&state.pendingMessageCount===0,'Active or incomplete Pi state prevents context audit');
  idle(initial.response?.data);
  const history=await request(route,{command:{type:'get_messages'}}),entries=await request(route,{command:{type:'get_entries'}}),confirmed=await request(route,{command:{type:'get_state'}});
  idle(confirmed.response?.data);
  for(const value of [initial,history,entries,confirmed]){
    assert.equal(value.response?.success,true,'Pi context RPC failed');
    assert.equal(typeof value.streamId,'string','Pi context stream identity is missing');
    assert.ok(Number.isSafeInteger(value.eventCursor),'Pi context event cursor is missing');
    assert.equal(value.streamId,initial.streamId,'Pi process changed during context audit');
    assert.equal(value.eventCursor,initial.eventCursor,'Pi events changed during context audit');
    assert.equal(value.documentId,initial.documentId,'Pi project changed during context audit');
  }
  assert.equal(typeof initial.documentId,'string','Pi context project is missing');
  assert.equal(typeof initial.response.data.sessionId,'string','Native Pi session identity is missing');
  assert.equal(confirmed.response.data.sessionId,initial.response.data.sessionId,'Native Pi session changed during context audit');
  const messages=history.response.data?.messages,tree=entries.response.data?.entries;
  assert.ok(Array.isArray(messages)&&Array.isArray(tree),'Pi context reply must contain native messages and entries');
  assert.equal(messages.length,initial.response.data.messageCount,'Pi context message count changed during audit');
  assert.equal(messages.length,confirmed.response.data.messageCount,'Pi context message count changed during audit');
  return {id,documentId:initial.documentId,messageCount:messages.length,messagesDigest:digest(messages),entryCount:tree.length,entriesDigest:digest(tree)};
}
async function main(){
  const api=process.env.CAD_AUDIT_API||'http://127.0.0.1:8788/api',data=path.resolve(process.env.CAD_AUDIT_DATA_DIR||path.join(root,'.data')),documentId=process.env.CAD_AUDIT_DOCUMENT||'default';
  const argument=name=>{const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;};
  async function request(route,body,allowMissing=false){const response=await fetch(api+route,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)}),payload=await response.json();if(allowMissing&&payload.code==='PI_SESSION_NOT_FOUND')return null;assert.ok(response.ok&&payload.ok,`Audit read failed: ${route} HTTP ${response.status}`);return payload;}
  const health=await request('/health');assert.equal(health.worker,true);const command=operation=>request('/commands',{documentId,operation});
  const summary=await command('document.summary'),types=await command('property.type.list'),instances=await command('property.instance.list');
  const entries=directory=>fs.existsSync(directory)?fs.readdirSync(directory,{withFileTypes:true}):[];
  let pendingTransactions=0;for(const directory of ['project-transactions','document-transactions'])pendingTransactions+=entries(path.join(data,directory)).filter(item=>item.isFile()).length;assert.equal(pendingTransactions,0,'Pending transaction journal prevents deployment');
  let activeMeshJobs=0;for(const doc of entries(path.join(data,'mesh-jobs')).filter(item=>item.isDirectory()))for(const job of entries(path.join(data,'mesh-jobs',doc.name)).filter(item=>item.isDirectory())){const file=path.join(data,'mesh-jobs',doc.name,job.name,'metadata.json');if(fs.existsSync(file)){const state=JSON.parse(fs.readFileSync(file,'utf8')).state;if(!['complete','failed','cancelled','interrupted'].includes(state))activeMeshJobs++;}}assert.equal(activeMeshJobs,0,'Active or unknown mesh state prevents deployment');
  const pi=[],piContexts=[];for(const session of entries(path.join(data,'pi-sessions')).filter(item=>item.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){const result=await request(`/pi/sessions/${encodeURIComponent(session.name)}/commands`,{command:{type:'get_state'}},true);if(!result){pi.push({id:session.name,running:false});continue;}piContexts.push(await capturePiContextAudit(request,session.name,result));pi.push({id:session.name,running:true,streaming:false,compacting:false,pending:0});}
  const checkpoints={};async function hashDirectory(directory){for(const entry of entries(directory).sort((a,b)=>a.name<b.name?-1:1)){const file=path.join(directory,entry.name);assert.ok(!entry.isSymbolicLink(),'Protected project data contains a symbolic link; audit cannot silently skip it');if(entry.isDirectory())await hashDirectory(file);else if(entry.isFile()){const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);checkpoints[path.relative(data,file).replaceAll('\\','/')]=hash.digest('hex');}}}for(const directory of ['history','property-schemas'])await hashDirectory(path.join(data,directory));
  const report={format:'web-cad-project-audit',version:2,documentId,revision:summary.revision,stateToken:summary.stateToken,stateSequence:summary.stateSequence,bodyCount:summary.bodyCount,featureCount:summary.featureCount,featureDigest:digest(summary.features||[]),identityDigest:digest(summary.entityIdentities||{}),dataDigest:digest([summary.variables,summary.coordinateSystems,summary.materials]),typeDigest:digest(types.types),instanceDigest:digest(instances.instances),bodies:summary.bodyMetadata||[],spatialPolicy:summary.spatialPolicy||null,checkpoints,pendingTransactions,activeMeshJobs,pi,piContexts};
  const confirmed=await command('document.summary');assert.equal(confirmed.stateToken,summary.stateToken,'Project changed during audit; capture an idle baseline again');assert.equal(types.stateToken,summary.stateToken,'Property types were read from a different project state');assert.equal(instances.stateToken,summary.stateToken,'Property instances were read from a different project state');
  const baseline=argument('--baseline');let comparison=null;if(baseline)comparison=compareProjectAudits(JSON.parse(fs.readFileSync(path.resolve(baseline),'utf8')),report,{allowSpatialPolicyTransition:process.argv.includes('--allow-spatial-policy-transition'),allowLegacyPiAudit:process.argv.includes('--allow-legacy-pi-audit')});
  const output=argument('--output');if(output){const file=path.resolve(output);assert.ok(file.startsWith(path.join(root,'.artifacts')+path.sep)&&file.endsWith('.json'),'Audit output must be a JSON artifact, never project data');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(report,null,2));}
  console.log(JSON.stringify({ok:true,revision:report.revision,bodies:report.bodyCount,protectedFiles:Object.keys(checkpoints).length,compared:Boolean(baseline),piContextCaptured:true,piContextCompared:comparison?.piContextCompared||false,...(comparison&&!comparison.piContextCompared?{warning:'Legacy baseline did not capture Pi context; CAD-only comparison is not full deployment certification'}:{}),policy:report.spatialPolicy?.version||0,piIdle:true}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
