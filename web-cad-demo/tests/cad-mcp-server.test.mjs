import assert from "node:assert/strict";
import test from "node:test";
import { createCadMcpHandler as createHandler, listCadMcpTools } from "../gateway/cad-mcp-server.mjs";
import {withMcpTaskReservations} from './helpers/mcp-task-fetch.mjs';
const createCadMcpHandler=options=>createHandler({...options,fetchImpl:withMcpTaskReservations(options.fetchImpl)});

test('mesh strategy tools expose exact definition proofs and typed options without demanding a fake native revision',()=>{const tools=listCadMcpTools(),create=tools.find(tool=>tool.name==='mesh__strategy__create'),update=tools.find(tool=>tool.name==='mesh__strategy__update'),remove=tools.find(tool=>tool.name==='mesh__strategy__delete'),list=tools.find(tool=>tool.name==='mesh__strategy__list');assert.ok(create&&update&&remove&&list);assert.ok(create.inputSchema.required.includes('baseStateToken'));assert.equal(create.inputSchema.required.includes('baseRevision'),false);assert.deepEqual(create.inputSchema.properties.parameters.required,['name','options']);const options=create.inputSchema.properties.parameters.properties.options;assert.equal(options.additionalProperties,false);assert.deepEqual(options.required,['repairMode','qualityThreshold']);assert.equal(options.properties.qualityThreshold.minimum,0);assert.equal(options.properties.sizing.properties.rules.maxItems,16);for(const tool of [update,remove]){assert.ok(tool.inputSchema.properties.parameters.required.includes('definitionHash'));assert.equal(tool.inputSchema.properties.parameters.properties.revision.minimum,1);assert.deepEqual(tool.inputSchema.properties.inputs.required,['strategyId']);}assert.equal(list.inputSchema.required?.includes('baseStateToken')||false,false);});

test("MCP server advertises the live CAD command catalog and a read-only model query", () => {
  const tools = listCadMcpTools();
  assert.ok(tools.length > 70);
  assert.ok(tools.some((tool) => tool.name === "primitive__box"));
  assert.ok(tools.some((tool) => tool.name === "property__instance__create"));
  assert.ok(tools.some((tool) => tool.name === "query_model"));
  assert.ok(tools.every((tool) => tool.inputSchema.type === "object"));
  const loft=tools.find(tool=>tool.name==="detail__loft");assert.ok(loft.inputSchema.required.includes('baseStateToken'));assert.deepEqual(loft.inputSchema.properties.inputs.required,['sections']);assert.equal(loft.inputSchema.properties.inputs.properties.sections.minItems,2);assert.deepEqual(loft.inputSchema.properties.inputs.properties.sections.items.required,['bodyId','faceId']);
  assert.match(loft.description,/ordered sections.*bodyId,faceId/);assert.match(loft.description,/holes and curved Faces are rejected/);assert.match(loft.description,/Actual spatial placement is the default/);
  const genericOperation = tools.find((tool) => tool.name === "primitive__wedge");
  assert.equal(genericOperation.inputSchema.properties.inputs.type, "object");
  assert.equal(genericOperation.inputSchema.properties.parameters.type, "object");
  assert.equal(genericOperation.inputSchema.properties.parameters.additionalProperties, true);
  const requiredOperation = tools.find((tool) => tool.name === "primitive__box");
  assert.deepEqual(requiredOperation.inputSchema.properties.parameters.required, ["width", "depth", "height"]);
  const measure = tools.find((tool) => tool.name === "geometry__measure");
  assert.deepEqual(measure.inputSchema.properties.inputs.properties.selectionType.enum, ["body", "face", "edge"]);
  assert.ok(measure.inputSchema.properties.inputs.properties.selectionId);
  const propertyList = tools.find((tool) => tool.name === "property__list");
  assert.ok(propertyList.inputSchema.properties.inputs.properties.topologyId);
  const coordinate=tools.find(tool=>tool.name==='coordinate__set').inputSchema.properties.parameters;
  assert.deepEqual(coordinate.required,['id','name']);assert.equal(coordinate.properties.origin.type,'array');
  assert.deepEqual(coordinate.properties.associationMode.enum,['associative','snapshot']);assert.equal(coordinate.properties.preserveReference.type,'boolean');
  assert.ok(tools.find(tool=>tool.name==='detail__fillet').inputSchema.required.includes('baseStateToken'));
  assert.ok(tools.find(tool=>tool.name==='coordinate__set').inputSchema.required.includes('baseStateToken'));
});

test("Plan mode allows model query but denies mutation before it reaches the geometry gateway", async () => {
  const calls = [];
  const handle = createCadMcpHandler({ documentId: "doc-readonly", mode: "plan", fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, revision: 8, bodyCount: 1 }), { status: 200 });
  } });
  const query = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_model", arguments: {} } });
  assert.equal(query.result.isError, false);
  assert.equal(calls[0].url, "http://127.0.0.1:8788/api/agent/model/query");
  assert.equal(calls[0].body.documentId, "doc-readonly");
  const mutation = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "primitive__box", arguments: { parameters: { width: 10, depth: 10, height: 10 } } } });
  assert.equal(mutation.result.isError, true);
  assert.match(mutation.result.content[0].text, /Plan 模式为只读/);
  assert.equal(calls.length, 1);
});

test("Edit-mode MCP commands stay bound to the active document and keep expressions intact", async () => {
  let request;
  const handle = createCadMcpHandler({ documentId: "doc-active", mode: "edit", apiRoot: "http://cad.local/api/", fetchImpl: async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ ok: true, revision: 9, bodyId: "body-2" }), { status: 200 });
  } });
  const response = await handle({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name: "primitive__box", arguments: { baseRevision: 8, baseStateToken:"a".repeat(64), parameters: { width: "boardWidth", depth: "40 mm", height: "20 mm" } } } });
  assert.equal(response.result.isError, false);
  assert.equal(request.url, "http://cad.local/api/commands");
  assert.equal(request.body.documentId, "doc-active");
  assert.equal(request.body.baseRevision, 8);
  assert.equal(request.body.baseStateToken,"a".repeat(64));
  assert.equal(request.body.parameters.width, "boardWidth");
});

test("MCP JSON-RPC reports unknown tools and methods with protocol errors", async () => {
  const handle = createCadMcpHandler({ fetchImpl: async () => new Response("{}") });
  const method = await handle({ jsonrpc: "2.0", id: 1, method: "unsupported/method" });
  const tool = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "not_a_cad_tool" } });
  assert.equal(method.error.code, -32601);
  assert.equal(tool.result.isError, true);
  assert.match(tool.result.content[0].text, /Unknown CAD MCP tool/);
});

test('MCP never refreshes a selection token implicitly; missing and stale state reach the model as structured query/reselect guidance',async()=>{
  const calls=[],token='a'.repeat(64),old='b'.repeat(64);
  const handle=createCadMcpHandler({documentId:'observed',fetchImpl:async(url,init)=>{
    const body=JSON.parse(init.body);calls.push({url,body});
    if(url.endsWith('/agent/model/query'))return new Response(JSON.stringify({ok:true,query:{revision:8,stateToken:token,bodies:[]}}));
    if(body.baseStateToken!==token)return new Response(JSON.stringify({ok:false,code:'PROJECT_STATE_CONFLICT',error:'工程已变化'}),{status:409});
    return new Response(JSON.stringify({ok:true,bodyId:'body-1'}));
  }});
  const args={inputs:{bodyId:'body-1',edgeId:'edge-1-1'},parameters:{radius:1}},call=arguments_=>handle({id:1,method:'tools/call',params:{name:'detail__fillet',arguments:arguments_}});
  let result=await call(args);assert.equal(JSON.parse(result.result.content[0].text).code,'SELECTION_STATE_REQUIRED');assert.equal(calls.length,0);
  const queried=await handle({id:2,method:'tools/call',params:{name:'query_model',arguments:{}}});assert.equal(JSON.parse(queried.result.content[0].text).stateToken,token);
  result=await call(args);assert.equal(JSON.parse(result.result.content[0].text).code,'SELECTION_STATE_REQUIRED');assert.equal(calls.length,1,'Querying is not permission to stamp later stale IDs with a fresh token');
  result=await call({...args,baseStateToken:old});const conflict=JSON.parse(result.result.content[0].text);assert.equal(conflict.code,'PROJECT_STATE_CONFLICT');assert.match(conflict.recovery,/重新确认选择/);assert.equal(conflict.retryableByModel,false);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/agent/model/query'),'An unknown stale receipt may be checked, never silently refreshed and forwarded');
  result=await call({...args,baseStateToken:token});assert.equal(result.result.isError,false);assert.equal(calls.length,3);
});
