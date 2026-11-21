import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';
import {selectBackendRelease} from '../gateway/backend-release.mjs';

const root=path.resolve(import.meta.dirname,'..');
const product=process.env.CAD_TEST_GATEWAY_RELEASE_ROOT?path.join(selectBackendRelease(path.resolve(root,process.env.CAD_TEST_GATEWAY_RELEASE_ROOT),process.env.CAD_TEST_GATEWAY_RELEASE_ID).directory,'runtime'):root;
const {CadMcpProcessClient}=await import(pathToFileURL(path.join(product,'gateway/cad-mcp-process-client.mjs')).href);
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cad-mcp-task-api-'));
function clean(data){assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-mcp-task-api-/);fs.rmSync(data,{recursive:true,force:true});}
async function seed(f) {
  const box=await f.cad('primitive.box',{width:10,depth:20,height:30});
  const type=await f.cad('property.type.create',{key:'McpCancellation',targetScope:'body',association:'required',fields:[{key:'enabled',type:'bool'}]});
  await f.cad('property.instance.create',{typeId:type.type.typeId,value:{enabled:true},target:{kind:'body',bodyId:box.bodyId}});
  await f.cad('property.set',{key:'marker',type:'int',value:42},{kind:'body',bodyId:box.bodyId});
  return {model:await f.cad('document.summary'),raw:(await f.cad('property.list')).propertyRecords,typed:(await f.cad('property.instance.list')).instances};
}
async function restored(f,before) {
  const model=await f.cad('document.summary');
  for(const key of ['revision','features','bodyMetadata','entityIdentities','coordinateSystems','stateToken'])assert.deepEqual(model[key],before.model[key],key);
  assert.deepEqual((await f.cad('property.list')).propertyRecords,before.raw);assert.deepEqual((await f.cad('property.instance.list')).instances,before.typed);
}
function bridge(f){return new CadMcpProcessClient({serverPath:path.join(product,'gateway/cad-mcp-server.mjs'),apiRoot:f.api,documentId:'default',cwd:root});}
const argumentsFor=before=>({baseRevision:before.model.revision,baseStateToken:before.model.stateToken,parameters:{width:3,depth:4,height:5,x:40}});
const value=result=>JSON.parse(result.content.find(part=>part.type==='text').text);
async function finish(f,client,data,verified){if(f){f.tell('release-geometry');f.tell('release-geometry-exit');}await client?.stop();if(f)assert.equal(await f.stop(),0);if(verified)clean(data);else console.error('MCP task diagnostics retained:',data);}

test('real MCP stdio cancellation waits for exact native exit and restores geometry, both property systems and history',async()=>{
  const data=scratch();let f,client,verified=false;
  try {
    f=await gatedGeometryGateway(data);const before=await seed(f);client=bridge(f);
    f.tell('arm-geometry');await f.event('geometry-armed');f.tell('arm-geometry-exit');await f.event('geometry-exit-armed');
    const abort=new AbortController(),pending=client.request('tools/call',{name:'primitive__box',arguments:argumentsFor(before)},{signal:abort.signal});let done=false;pending.finally(()=>done=true).catch(()=>{});
    assert.equal((await f.event('geometry-held')).bodyCount,2);abort.abort();await f.event('geometry-exit-held');
    const tasks=(await f.get('/documents/default/modeling-tasks')).tasks;assert.equal(tasks.length,1);assert.equal(tasks[0].phase,'stopping');assert.equal(done,false);assert.equal(client.status().exited,false);
    f.tell('release-geometry-exit');const result=await pending,detail=value(result);assert.equal(result.isError,true,JSON.stringify(result));assert.equal(detail.outcome,'restored');assert.equal(detail.modelingTask.phase,'cancelled');assert.equal(detail.modelingTask.restored,true);assert.equal(detail.retryableByModel,false);
    await restored(f,before);assert.equal((await f.get('/documents/default/modeling-tasks')).tasks.length,1);verified=true;
  } finally {await finish(f,client,data,verified);}
});
test('real MCP stop during protected native checkpoint keeps the original successful commit and sends no cancel POST',async()=>{
  const data=scratch();let f,client,verified=false;
  try {
    f=await gatedGeometryGateway(data);const before=await seed(f);client=bridge(f);f.tell('arm-task-commit');await f.event('task-commit-armed');
    const abort=new AbortController(),pending=client.request('tools/call',{name:'primitive__box',arguments:argumentsFor(before)},{signal:abort.signal});await f.event('task-commit-held');abort.abort();
    await f.until(()=>f.events.some(item=>item.type==='fixture.request-admitted'&&/modeling-tasks\/[a-f0-9-]+$/.test(item.path)),'Stop did not read its original task');
    assert.equal((await f.get('/documents/default/modeling-tasks')).tasks[0].phase,'committing');assert.equal(f.events.some(item=>item.type==='fixture.request-admitted'&&item.path.endsWith('/cancel')),false);
    f.tell('release-geometry');const result=await pending,detail=value(result);assert.equal(result.isError,false,JSON.stringify(result));assert.equal(detail.modelingTask.phase,'succeeded');assert.equal(detail.bodyCount,2);assert.equal((await f.cad('document.summary')).bodyCount,2);verified=true;
  } finally {await finish(f,client,data,verified);}
});
test('an unconfirmed native exit remains unknown in the MCP result and never triggers a second geometry submission',async()=>{
  const data=scratch();let f,client,verified=false;
  try {
    f=await gatedGeometryGateway(data,{GEOMETRY_WORKER_STOP_TIMEOUT_MS:'40'});const before=await seed(f);client=bridge(f);f.tell('arm-geometry');await f.event('geometry-armed');f.tell('arm-geometry-exit');await f.event('geometry-exit-armed');
    const abort=new AbortController(),pending=client.request('tools/call',{name:'primitive__box',arguments:argumentsFor(before)},{signal:abort.signal});await f.event('geometry-held');abort.abort();await f.event('geometry-exit-held');
    const result=await pending,detail=value(result);assert.equal(result.isError,true);assert.equal(detail.outcome,'unknown');assert.equal(detail.modelingTask.phase,'unknown');assert.notEqual(detail.modelingTask.restored,true);assert.equal(detail.retryableByModel,false);assert.equal((await f.get('/health')).runtime.workerChannel.state,'blocked');
    assert.equal(f.events.filter(item=>item.type==='fixture.native-request'&&item.operation==='primitive.box').length,2,'One seed and one attempted mutation only');assert.ok(fs.readdirSync(path.join(data,'document-transactions')).some(name=>name.endsWith('.pending.json')),'Unknown native exit must retain recovery evidence');f.tell('release-geometry-exit');verified=true;
  } finally {await finish(f,client,data,verified);}
});
test('actual Pi RPC abort propagates through its native tool signal and MCP notification into the real CAD task rollback',async()=>{
  const data=scratch();let f,verified=false,baseline;const requests=[],errors=[];
  const provider=createServer(async(request,response)=>{
    try {
      let text='';for await(const chunk of request)text+=chunk;
      const body=JSON.parse(text);requests.push(body);assert.equal(requests.length,1,'Abort must not request another model turn');
      const delta={role:'assistant',tool_calls:[{index:0,id:'abort-native-box',type:'function',function:{name:'primitive__box',arguments:JSON.stringify(argumentsFor(baseline))}}]};
      const frame=(delta,finish)=>({id:'local-abort',object:'chat.completion.chunk',created:1,model:'abort-fixture',choices:[{index:0,delta,finish_reason:finish}]});
      response.writeHead(200,{'content-type':'text/event-stream'});response.write('data: '+JSON.stringify(frame(delta,null))+'\n\n');response.write('data: '+JSON.stringify(frame({},'tool_calls'))+'\n\n');response.end('data: [DONE]\n\n');
    } catch(error) {errors.push(error.message);response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'Local test failed'}}));}
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  try {
    const cwd=path.join(data,'pi-workspaces/default');fs.mkdirSync(cwd,{recursive:true});
    f=await gatedGeometryGateway(data,{PI_CLI_PATH:'',PI_CLI_CWD:cwd,TSX_TSCONFIG_PATH:path.resolve(root,'../pi/tsconfig.json'),PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',AGENT_ALLOW_PRIVATE_URL:'true'});baseline=await seed(f);
    const saved=await f.post('/agent/providers',{id:'abort-fixture',name:'Local abort test',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,protocol:'chat-completions',model:'abort-fixture',apiKey:'local-test-not-a-real-secret'});assert.equal(saved.status,200,JSON.stringify(saved));
    const created=await f.post('/pi/sessions',{sessionId:'native-abort',documentId:'default',providerId:'abort-fixture'});assert.equal(created.status,200,JSON.stringify(created));
    const rpc=command=>f.post('/pi/sessions/native-abort/commands',{documentId:'default',streamId:created.value.streamId,command});
    assert.equal((await rpc({type:'set_model',provider:'abort-fixture',modelId:'abort-fixture'})).status,200);await rpc({type:'set_auto_retry',enabled:false});
    f.tell('arm-geometry');await f.event('geometry-armed');f.tell('arm-geometry-exit');await f.event('geometry-exit-armed');
    const prompt=rpc({type:'prompt',message:'Create the test box.'});await f.event('geometry-held',0);const stopping=rpc({type:'abort'});await f.event('geometry-exit-held');
    const task=(await f.get('/documents/default/modeling-tasks')).tasks[0];assert.equal(task.phase,'stopping');f.tell('release-geometry-exit');assert.equal((await stopping).status,200);assert.equal((await prompt).status,200);
    await f.until(async()=>['cancelled','unknown','failed'].includes((await f.get('/documents/default/modeling-tasks/'+task.taskId)).modelingTask.phase),'Native Pi task has no terminal result');
    const terminal=(await f.get('/documents/default/modeling-tasks/'+task.taskId)).modelingTask;assert.equal(terminal.phase,'cancelled',JSON.stringify(terminal));assert.equal(terminal.restored,true);await restored(f,baseline);assert.equal(requests.length,1);assert.deepEqual(errors,[]);verified=true;
  } finally {provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await finish(f,null,data,verified);}
});
