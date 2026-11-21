import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "node:http";
import {randomUUID} from 'node:crypto';
import cadMcpExtension from "../gateway/pi-cad-mcp-extension.mjs";

test('a read-only mesh query reconnects an exited bridge without replaying writes or unlocking CAD reconciliation',async()=>{
  const handlers=new Map(),registered=[],clients=[];
  const tool=(name,readOnly)=>({name,inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:readOnly}});
  const pi={on:(event,handler)=>handlers.set(event,handler),registerTool:value=>registered.push(value)};
  cadMcpExtension(pi,{clientFactory:()=>{
    const client={state:'open',confirmed:0,calls:[],async stop(){this.state='closed';},status(){return {state:this.state};},notify(){},confirmReconciled(){this.confirmed++;},requireReconciliation(){},async request(method,params){
      this.calls.push({method,params});if(method==='initialize')return {capabilities:{tools:{}}};if(method==='tools/list')return {tools:[tool('query_model',true),tool('mesh_jobs__get',true),tool('mesh_jobs__cancel',false)]};return {content:[{type:'text',text:JSON.stringify({stateToken:'a'.repeat(64),revision:1})}],isError:false};
    }};clients.push(client);return client;
  }});
  try{
    await handlers.get('session_start')();clients[0].state='failed';
    const reply=await registered.find(tool=>tool.name==='mesh_jobs__get').execute('lookup',{jobId:'one'});assert.equal(reply.isError,false);assert.equal(clients.length,2);assert.equal(clients[0].state,'closed');assert.equal(clients[1].confirmed,0);assert.deepEqual(clients[1].calls.filter(call=>call.method==='tools/call').map(call=>call.params.name),['mesh_jobs__get']);
    await registered.find(tool=>tool.name==='query_model').execute('model',{});assert.equal(clients[1].confirmed,1);
  }finally{await handlers.get('session_shutdown')();}
});

test("Pi extension starts a per-session MCP server and registers the CAD tool catalog", async () => {
  const keys = ["CAD_MCP_SERVER_PATH", "CAD_GEOMETRY_API_URL", "CAD_DOCUMENT_ID", "CAD_AGENT_MODE"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const gatewayDirectory = path.dirname(fileURLToPath(new URL("../gateway/cad-mcp-server.mjs", import.meta.url)));
  const received = [];let reservation;
  const server = createServer(async (request, response) => {
    if(request.method==='GET'&&request.url==='/api/health'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({ok:true,gateway:true,worker:true}));return;}
    let body = "";
    for await (const chunk of request) body += chunk;
    const input=JSON.parse(body);received.push({ url: request.url, ...input });
    if(request.url.endsWith('/modeling-tasks')){
      const now=new Date().toISOString();reservation={version:1,taskId:randomUUID(),documentId:input.command.documentId,operation:input.command.operation,requestKey:input.command.requestId,phase:'reserved',sequence:1,createdAt:now,updatedAt:now,cancelRequested:false,cancellable:true,reportDurable:true};
      response.writeHead(201,{'Content-Type':'application/json'});response.end(JSON.stringify({ok:true,modelingTask:reservation}));return;
    }
    const mutation=input.operation==='primitive.box';if(mutation){assert.equal(request.headers['x-cad-task-id'],reservation.taskId);assert.equal(input.requestId,reservation.requestKey);}
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, documentId:'pi-extension-test',bodyId: "isolated-test-body", revision: 1, stateToken:'a'.repeat(64),...(mutation?{modelingTask:{...reservation,phase:'succeeded',sequence:2,cancellable:false,revision:1,stateToken:'a'.repeat(64)}}:{}) }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.CAD_MCP_SERVER_PATH = path.join(gatewayDirectory, "cad-mcp-server.mjs");
  process.env.CAD_GEOMETRY_API_URL = `http://127.0.0.1:${server.address().port}/api`;
  process.env.CAD_DOCUMENT_ID = "pi-extension-test";
  process.env.CAD_AGENT_MODE = "plan";

  const handlers = new Map();
  const tools = [];
  const pi = { on: (event, handler) => handlers.set(event, handler), registerTool: (tool) => tools.push(tool), logger: { debug() {}, info() {} } };
  try {
    cadMcpExtension(pi);
    await handlers.get("session_start")();
    assert.ok(tools.length > 70, `Expected the full CAD tool catalog, received ${tools.length}`);
    assert.ok(tools.some((tool) => tool.label === "query_model"));
    const box = tools.find((tool) => tool.label === "primitive__box");
    assert.ok(box);
    const result = await box.execute("test-call", { parameters: { width: 20, depth: 20, height: 20 } });
    assert.equal(result.isError, false, `Single-mode Pi tool execution failed: ${JSON.stringify(result.content)}`);
    assert.equal(JSON.parse(result.content[0].text).bodyId, "isolated-test-body");
    assert.equal(received.length, 3);
    assert.equal(received[0].operation,'document.summary');
    assert.equal(received[1].url,'/api/documents/pi-extension-test/modeling-tasks');
    assert.equal(received[2].url, "/api/commands");
    assert.equal(received[2].documentId, "pi-extension-test");
    assert.equal(received[2].operation, "primitive.box");
    assert.equal(received[2].baseStateToken,'a'.repeat(64));
  } finally {
    await handlers.get("session_shutdown")?.();
    await new Promise(resolve => server.close(resolve));
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
