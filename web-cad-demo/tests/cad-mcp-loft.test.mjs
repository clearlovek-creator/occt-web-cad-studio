import test from 'node:test';
import assert from 'node:assert/strict';
import {listCadMcpTools,createCadMcpHandler as createHandler} from '../gateway/cad-mcp-server.mjs';
import {withMcpTaskReservations} from './helpers/mcp-task-fetch.mjs';
const createCadMcpHandler=options=>createHandler({...options,fetchImpl:withMcpTaskReservations(options.fetchImpl)});
import {validateLoftSections,validateLoftDefinition,readMcpNativeCapabilities} from '../gateway/cad-mcp-loft.mjs';
const token='a'.repeat(64),capability='loft-through-holes-v1',snapshot={version:1,source:'native-handshake',ready:true,workerInstance:'11111111-1111-4111-8111-111111111111',features:{[capability]:{maxSections:32,maxHolesPerSection:16,boundaryLoopsVersion:1}}};
const sections=[{bodyId:'body-1',faceId:'face-1-1',holeEdgeIds:['edge-1-2']},{bodyId:'body-2',faceId:'face-2-1',holeEdgeIds:['edge-2-2']}],health={ok:true,protocolVersion:1,gateway:true,worker:true,capabilities:{nativeGeometry:snapshot}};
const response=value=>new Response(JSON.stringify(value));
const call=(handle,name,args)=>handle({id:1,method:'tools/call',params:{name,arguments:args}});
test('the same tool names gain strict hole/retained-section schemas only with actual runtime proof',()=>{
  const old=listCadMcpTools(),current=listCadMcpTools({nativeCapabilities:snapshot});assert.deepEqual(old.map(tool=>tool.name),current.map(tool=>tool.name));
  const loft=tools=>tools.find(tool=>tool.name==='detail__loft');assert.equal(loft(old).inputSchema.properties.inputs.properties.sections.items.properties.holeEdgeIds,undefined);assert.equal(loft(current).inputSchema.properties.inputs.properties.sections.items.properties.holeEdgeIds.maxItems,16);assert.match(loft(current).description,/ALL inner loops/);assert.doesNotMatch(loft(current).description,/holes and curved Faces are rejected/);
  const definition=current.find(tool=>tool.name==='feature__update').inputSchema.properties.parameters.properties.loftDefinition;assert.equal(definition.additionalProperties,false);assert.deepEqual(definition.properties.sections.items.anyOf[1].required,['sectionId']);
});
test('Loft structural validation preserves exact inputs and rejects missing, duplicate, mixed or invented hole mappings',()=>{
  const before=JSON.stringify(sections);assert.equal(validateLoftSections(sections),true);assert.equal(JSON.stringify(sections),before);assert.equal(validateLoftDefinition({sections:[{sectionId:'s1'},{sectionId:'s2'}],sectionSpacing:'pitch * 2'}),false);
  for(const value of [[],[sections[0]], [{...sections[0],holeEdgeIds:[]},sections[1]], [{...sections[0],holeEdgeIds:['edge-1-2','edge-1-2']},sections[1]], [sections[0],{bodyId:'body-2',faceId:'face-2-1'}], [{...sections[0],holeSelectors:['opaque']},sections[1]]])assert.throws(()=>validateLoftSections(value),error=>error.code==='MCP_LOFT_DEFINITION_INVALID'&&error.retryableByModel===true);
  for(const value of [[],{ruled:1},{placement:'guess'},{sectionSpacing:Infinity},{sourcePath:'secret'}])assert.throws(()=>validateLoftDefinition(value));
});
test('capability reads reject redirects, oversized/unknown health and stale unready claims without forwarding raw errors',async()=>{
  assert.deepEqual(await readMcpNativeCapabilities('http://unit/api',async()=>response(health)),snapshot);
  for(const value of [{...health,protocolVersion:2},{...health,worker:false},{...health,capabilities:{}},{...health,capabilities:{nativeGeometry:{...snapshot,ready:false}}}])assert.equal(await readMcpNativeCapabilities('http://unit/api',async()=>response(value)),null);
  let cancelled=false;const oversized=new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}}));assert.equal(await readMcpNativeCapabilities('http://unit/api',async()=>oversized),null);assert.equal(cancelled,true);
  assert.equal(await readMcpNativeCapabilities('http://unit/api',async(_url,options)=>{assert.equal(options.redirect,'error');throw Error('secret provider key');}),null);
});
test('fresh runtime proof is attached to a hole mutation, never a caller-supplied worker credential',async()=>{
  const requests=[],handle=createCadMcpHandler({fetchImpl:async(url,init)=>{requests.push({url,init});return url.endsWith('/health')?response(health):response({ok:true,bodyId:'body-3'});}});
  const result=await call(handle,'detail__loft',{baseRevision:3,baseStateToken:token,inputs:{sections},workerCapabilityPrecondition:{forged:true}});assert.equal(result.result.isError,false);const sent=JSON.parse(requests.at(-1).init.body);assert.deepEqual(sent.inputs.sections,sections);assert.deepEqual(sent.workerCapabilityPrecondition,{version:1,workerInstance:snapshot.workerInstance,capability});assert.equal(sent.baseStateToken,token);
});
test('unsupported or offline runtime rejects holes without forwarding a mutation or deleting hole parameters',async()=>{
  const requests=[],handle=createCadMcpHandler({fetchImpl:async(url)=>{requests.push(url);return response({ok:true,gateway:true,worker:true});}});const result=await call(handle,'detail__loft',{baseStateToken:token,inputs:{sections}});assert.equal(JSON.parse(result.result.content[0].text).code,'WORKER_CAPABILITY_UNAVAILABLE');assert.deepEqual(requests,['http://127.0.0.1:8788/api/health']);
});
test('feature edits inspect the exact current feature; v3 retained references still require capability proof',async()=>{
  const requests=[],handle=createCadMcpHandler({documentId:'d',fetchImpl:async(url,init)=>{requests.push({url,init});if(url.endsWith('/agent/model/query')){assert.deepEqual(JSON.parse(init.body),{documentId:'d',kind:'feature',bodyId:'',featureId:'feature-1'});return response({ok:true,query:{revision:8,stateToken:token,feature:{id:'feature-1',type:'detail.loft',stringParameters:{loftVersion:'3'}}}});}return url.endsWith('/health')?response(health):response({ok:true});}});
  const args={baseStateToken:token,inputs:{featureId:'feature-1'},parameters:{loftDefinition:{sections:[{sectionId:'s1'},{sectionId:'s2'}],sectionSpacing:'gap'}}},result=await call(handle,'feature__update',args);assert.equal(result.result.isError,false);assert.equal(JSON.parse(requests.at(-1).init.body).parameters.loftDefinition.sectionSpacing,'gap');assert.ok(JSON.parse(requests.at(-1).init.body).workerCapabilityPrecondition);
  requests.length=0;const stale=await call(handle,'feature__update',{...args,baseStateToken:'b'.repeat(64)});assert.equal(JSON.parse(stale.result.content[0].text).code,'PROJECT_STATE_CONFLICT');assert.equal(requests.length,1,'A new query must never refresh old selection tokens or send a mutation');
});
test('existing scoped query_model forwards feature and project-data scopes without adding new tools',async()=>{
  let sent;const handle=createCadMcpHandler({fetchImpl:async(_url,init)=>{sent=JSON.parse(init.body);return response({ok:true,query:{feature:{id:'feature-7'}}});}});await call(handle,'query_model',{kind:'feature',featureId:'feature-7'});assert.equal(sent.featureId,'feature-7');assert.equal(sent.kind,'feature');
  assert.ok(listCadMcpTools().find(tool=>tool.name==='query_model').inputSchema.properties.kind.enum.includes('materials'));
});
test('native revisions come only from the exact observed state, including cached stale receipts which the Gateway still checks',async()=>{
  const commands=[],handle=createCadMcpHandler({fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);if(url.endsWith('/agent/model/query'))return response({ok:true,query:{revision:9,stateToken:token}});commands.push(body);return response({ok:true});}});
  await call(handle,'query_model',{});const done=await call(handle,'boolean__cut',{baseStateToken:token,inputs:{targetBody:'body-1',toolBody:'body-2'}});assert.equal(done.result.isError,false);assert.equal(commands[0].baseRevision,9);assert.equal(commands[0].baseStateToken,token);
  const stale=await call(handle,'boolean__cut',{baseStateToken:'b'.repeat(64),inputs:{targetBody:'body-1',toolBody:'body-2'}});assert.equal(JSON.parse(stale.result.content[0].text).code,'PROJECT_STATE_CONFLICT');assert.equal(commands.length,1);
  const missing=await call(handle,'body__delete',{inputs:{bodyId:'body-1'}});assert.equal(JSON.parse(missing.result.content[0].text).code,'SELECTION_STATE_REQUIRED');assert.equal(commands.length,1);assert.ok(listCadMcpTools().find(tool=>tool.name==='body__delete').inputSchema.required.includes('baseStateToken'));
});
