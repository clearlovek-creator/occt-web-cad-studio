import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MESH_MCP_TOOLS,callMeshMcpTool} from '../gateway/cad-mcp-mesh-tasks.mjs';
import {createCadMcpHandler,listCadMcpTools} from '../gateway/cad-mcp-server.mjs';
import {ProjectMeshService,isProjectMeshRoute} from '../gateway/project-mesh-service.mjs';
import {meshAgentSummary,meshAgentPageQuery} from '../shared/mesh-agent-summary.mjs';

const doc='current',id='mesh-'+randomUUID(),other='mesh-'+randomUUID(),requestId=randomUUID(),failedStateToken='a'.repeat(64),checkpointToken='b'.repeat(64);
const descriptor=(overrides={})=>({jobId:id,documentId:doc,kind:'discrete-tetra',state:'failed',revision:3,createdAt:'2026-11-20T00:00:00Z',visible:false,requestedVisible:false,freshness:{status:'current'},...overrides});
const summary=(overrides={})=>meshAgentSummary(descriptor(overrides));
const attempt=()=>({version:1,requestId,originKind:'native',originHandle:id,originJobId:id,originDocumentId:doc,checkpointJobId:id,failedStateToken,checkpointToken,originRecordSha256:'c'.repeat(64)});
const args={jobId:id,requestId,failedStateToken,checkpointToken};
const packet=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const run=(name,input,fetchImpl,options={})=>callMeshMcpTool({tool:MESH_MCP_TOOLS.find(tool=>tool.name==='mesh_jobs__'+name),args:input,root:'http://cad.test/api',documentId:doc,fetchImpl,...options});

test('five mesh tools share the native catalog and require retained identity rather than CAD selection tokens',()=>{
  const tools=listCadMcpTools().filter(tool=>tool.name.startsWith('mesh_jobs__'));assert.equal(tools.length,5);
  for(const tool of tools){assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.annotations.readOnlyHint,['mesh_jobs__list','mesh_jobs__get'].includes(tool.name));}
  const resume=tools.find(tool=>tool.name.endsWith('resume_optimization'));assert.deepEqual(resume.inputSchema.required,['jobId','requestId','failedStateToken','checkpointToken']);assert.match(resume.description,/Accepted is NOT completed/);
});
test('read-only summary strips full source geometry, mesh arrays and local paths without mutating the original',()=>{
  const raw=descriptor({source:{bodies:Array(100).fill({triangles:Array(1000).fill(1)})},mesh:{nodes:[1,2],outputPath:'C:/private/file'},error:'x'.repeat(1000)}),before=JSON.stringify(raw),result=meshAgentSummary(raw);
  assert.equal(JSON.stringify(raw),before);assert.ok(JSON.stringify(result).length<1000);assert.equal(result.error.length,500);assert.equal(result.source,undefined);assert.equal(result.mesh,undefined);assert.equal(JSON.stringify(result).includes('private'),false);
});
test('bounded list uses only the active document and validates exact pagination',async()=>{
  const calls=[];const result=await run('list',{limit:1},async(url,init)=>{calls.push({url,init});return packet({ok:true,version:1,documentId:doc,page:{offset:0,limit:1,total:2,nextOffset:1},jobs:[summary()]});});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'http://cad.test/api/documents/current/mesh/jobs?summary=1&offset=0&limit=1');assert.equal(calls[0].init.method,undefined);assert.equal(result.status,'observed');assert.equal(result.emptyIsNotExecutionProof,true);
});
test('request lookup accepts a completion identity even when a prior optimization identity is also retained',async()=>{
  const recovery={version:1,state:'complete',requestId,failedStateToken},job=summary({state:'complete',optimizationAttempt:{...attempt(),requestId:randomUUID()},completionRecovery:recovery});
  const result=await run('list',{requestId},async()=>packet({ok:true,version:1,documentId:doc,page:{offset:0,limit:20,total:1,nextOffset:null},jobs:[job]}));assert.equal(result.jobs[0].completionRecovery.requestId,requestId);
});
test('get never requests the global job route or downloads material arrays',async()=>{
  let route;const result=await run('get',{jobId:id},async url=>{route=url;return packet({ok:true,documentId:doc,meshJob:summary()});});assert.equal(route,'http://cad.test/api/documents/current/mesh/jobs/'+id);assert.equal(result.meshJob.jobId,id);
});
test('explicit optimization sends one retained request and returns accepted, not completed',async()=>{
  const calls=[];const result=await run('resume_optimization',args,async(url,init)=>{calls.push({url,init});return packet({ok:true,documentId:doc,meshJob:summary({jobId:other,state:'queued',optimizationAttempt:attempt()})},202);});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'http://cad.test/api/documents/current/mesh/jobs/'+id+'/resume-optimization');assert.deepEqual(JSON.parse(calls[0].init.body),{requestId,failedStateToken,checkpointToken});assert.equal(result.status,'accepted');assert.equal(result.meshJob.state,'queued');assert.equal(result.meshJob.visible,false);assert.equal(result.meshRequest.requestId,requestId);
});
test('completion recovery and cancel retain their exact task binding',async()=>{
  let body;const result=await run('recover_completion',{jobId:id,requestId,failedStateToken},async(_url,init)=>{body=JSON.parse(init.body);return packet({ok:true,documentId:doc,meshJob:summary({state:'complete',completionRecovery:{version:1,state:'complete',requestId,failedStateToken}})});});assert.deepEqual(body,{requestId,failedStateToken});assert.equal(result.meshJob.state,'complete');
  const cancelled=await run('cancel',{jobId:id},async(_url,init)=>{assert.deepEqual(JSON.parse(init.body),{});return packet({ok:true,documentId:doc,meshJob:summary({state:'cancelling'})});});assert.equal(cancelled.meshJob.state,'cancelling');assert.equal(cancelled.status,'accepted');
});
for(const [label,input] of [['path',{jobId:'../elsewhere'}],['foreign scope',{jobId:id,documentId:'other'}],['missing request',{jobId:id,failedStateToken,checkpointToken}],['bad identity',{...args,requestId:'new'}],['extra retry',{...args,retry:true}]])test('invalid optimization '+label+' is rejected before fetch',async()=>{
  let calls=0;await assert.rejects(run('resume_optimization',input,async()=>{calls++;}),error=>error.outcome==='not-started');assert.equal(calls,0);
});
for(const [label,fetcher] of [['network',async()=>{throw Error('offline');}],['non-JSON',async()=>new Response('Not Found')],['HTTP failure',async()=>packet({ok:false,code:'MESH_BUSY',error:'busy'},503)],['wrong document',async()=>packet({ok:true,documentId:'other',meshJob:summary()})],['wrong origin',async()=>packet({ok:true,documentId:doc,meshJob:summary({jobId:other,optimizationAttempt:{...attempt(),originHandle:other}})})],['oversized body',async()=>new Response('{}',{headers:{'content-length':String(256*1024+1)}})]])test('optimization '+label+' remains unknown without replay and preserves lookup identity',async()=>{
  let calls=0;await assert.rejects(run('resume_optimization',args,async(...input)=>{calls++;return fetcher(...input);}),error=>error.outcome==='unknown'&&error.meshRequest.requestId===requestId&&error.retryableByModel===false);assert.equal(calls,1);
});
test('an expired observation bounds an uncooperative fetch and cancels its later body, without another POST',async()=>{
  let release,calls=0,cancelled=false;const late=new Promise(resolve=>release=resolve);await assert.rejects(run('resume_optimization',args,async()=>{calls++;await late;return new Response(new ReadableStream({cancel(){cancelled=true;}}));},{timeoutMs:10}),error=>error.outcome==='unknown');release();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);assert.equal(cancelled,true);
});
test('already-aborted calls never send and abort after dispatch never claims cancellation completed',async()=>{
  const controller=new AbortController();controller.abort();let count=0;await assert.rejects(run('cancel',{jobId:id},async()=>count++,{signal:controller.signal}),error=>error.outcome==='not-started');assert.equal(count,0);
  const running=new AbortController();await assert.rejects(run('cancel',{jobId:id},async()=>{running.abort();return new Promise(()=>{});},{signal:running.signal}),error=>error.outcome==='unknown');
});
test('MCP errors return mesh request identity and Plan compatibility blocks controls before dispatch',async()=>{
  const handler=createCadMcpHandler({documentId:doc,fetchImpl:async()=>{throw Error('offline');}}),reply=await handler({id:1,method:'tools/call',params:{name:'mesh_jobs__resume_optimization',arguments:args}}),error=JSON.parse(reply.result.content[0].text);assert.equal(reply.result.isError,true);assert.equal(error.meshRequest.requestId,requestId);assert.equal(error.outcome,'unknown');assert.equal(error.retryableByModel,false);
  let calls=0;const plan=createCadMcpHandler({documentId:doc,mode:'plan',fetchImpl:async()=>{calls++;return packet({ok:true,documentId:doc,meshJob:summary()});}});assert.equal((await plan({id:1,method:'tools/call',params:{name:'mesh_jobs__get',arguments:{jobId:id}}})).result.isError,false);assert.equal((await plan({id:2,method:'tools/call',params:{name:'mesh_jobs__cancel',arguments:{jobId:id}}})).result.isError,true);assert.equal(calls,1);
});
function host(){
  const service=Object.create(ProjectMeshService.prototype);Object.assign(service,{jobs:new Map([[id,descriptor()],[other,descriptor({jobId:other,documentId:'foreign'})]]),activeRequests:new Set(),assets:null,catalogAccess:async()=>null,catalogStatus:()=>({state:'ready'}),reconcileWorkerStops:async()=>{},safeLive:async()=>({}),live:async()=>({}),descriptor:job=>job});return service;
}
test('scoped routes bind ownership before any delegated mutation and retain the document access fence',async()=>{
  const service=host(),calls=[];service.handleRequest=async(method,route,input)=>{calls.push({method,route,input,active:[...service.activeRequests]});return {status:202,payload:{ok:true,meshJob:descriptor({state:'cancelling'})}};};
  const rejected=await service.handle('POST','/api/documents/foreign/mesh/jobs/'+id+'/cancel',{});assert.equal(rejected.status,404);assert.equal(calls.length,0);
  const accepted=await service.handle('POST','/api/documents/current/mesh/jobs/'+id+'/cancel',{});assert.equal(accepted.status,202);assert.equal(calls[0].route,'/api/mesh/jobs/'+id+'/cancel');assert.equal(calls[0].active[0].documentId,doc);assert.equal(service.activeRequests.size,0);assert.equal(accepted.payload.meshJob.version,1);
});
test('scoped summary does not read material files and refuses disappearance across its live observation',async()=>{
  const service=host();service.readResult=()=>{throw Error('must not read files');};let result=await service.handle('GET','/api/documents/current/mesh/jobs/'+id);assert.equal(result.payload.meshJob.jobId,id);
  service.safeLive=async()=>{service.jobs.delete(id);return {};};result=await service.handle('GET','/api/documents/current/mesh/jobs/'+id);assert.equal(result.status,404);
});
test('summary pagination filters the document and request before constructing only the selected descriptors',async()=>{
  const service=host();let count=0;service.descriptor=job=>{count++;return job;};for(let i=0;i<10;i++)service.jobs.set('job-'+i,descriptor({jobId:'job-'+i,createdAt:'2026-11-20T00:00:'+String(i).padStart(2,'0')+'Z'}));
  const result=await service.handle('GET','/api/documents/current/mesh/jobs',{summary:'1',offset:'2',limit:'3'});assert.equal(result.payload.jobs.length,3);assert.equal(count,3);assert.equal(result.payload.page.total,11);assert.equal(result.payload.page.nextOffset,5);assert.ok(result.payload.jobs.every(job=>job.documentId===doc));
  const job=service.jobs.get(id);job.completionRecoveryReceipt={requestId,failedStateToken};job.state='complete';job.optimizationRecovery=attempt();job.optimizationRecovery.requestId=randomUUID();
  service.descriptor=job=>{count++;const {optimizationRecovery,...stored}=job;return {...stored,...(optimizationRecovery?{optimizationAttempt:optimizationRecovery}:{}),...(service.completionRecoveryInfo(job)?{completionRecovery:service.completionRecoveryInfo(job)}:{})};};
  count=0;const found=await service.handle('GET','/api/documents/current/mesh/jobs',{summary:'1',requestId});assert.equal(found.payload.jobs.length,1);assert.equal(count,1);
});
test('summary query budgets and scoped route allowlist reject malformed input',()=>{
  for(const value of [{summary:'1',limit:'51'},{summary:'1',offset:'-1'},{summary:'1',limit:0},{summary:'1',path:'x'},{summary:'1',requestId:'x'}])assert.throws(()=>meshAgentPageQuery(value));
  assert.equal(isProjectMeshRoute('GET','/api/documents/current/mesh/jobs/'+id),true);assert.equal(isProjectMeshRoute('POST','/api/documents/current/mesh/jobs/'+id+'/resume-optimization'),true);assert.equal(isProjectMeshRoute('DELETE','/api/documents/current/mesh/jobs/'+id),false);
});
