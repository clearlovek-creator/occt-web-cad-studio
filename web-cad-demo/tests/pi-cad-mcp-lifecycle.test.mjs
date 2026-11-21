import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../gateway/pi-cad-mcp-extension.mjs';
import {McpProcessError} from '../gateway/cad-mcp-process-client.mjs';
const tools=[{name:'query_model',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'primitive__box',inputSchema:{type:'object'},annotations:{readOnlyHint:false}}];
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
class Client{
  constructor(){this.phase='open';this.calls=[];this.stops=0;this.reconcile=false;}
  status(){return {state:this.phase};}
  async request(method,params,options){this.calls.push({method,params,options});if(method==='initialize')return this.init?this.init.promise:{capabilities:{tools:{}}};if(method==='tools/list')return {tools:this.tools||tools};if(this.error)throw this.error;return {content:[{type:'text',text:JSON.stringify({stateToken:'a'.repeat(64),revision:1})}]};}
  notify(){}
  async stop(){this.stops++;if(this.stopError)throw this.stopError;this.phase='closed';this.init?.reject(new McpProcessError('MCP_PROCESS_EXIT','test close'));}
  requireReconciliation(){this.reconcile=true;}
  confirmReconciled(){this.reconcile=false;}
}
function fixture(factory){const handlers=new Map(),registered=[];extension({on:(event,handler)=>handlers.set(event,handler),registerTool:tool=>registered.push(tool),logger:{debug(){},info(){}}},{clientFactory:factory});return {handlers,registered};}
test('invalid catalogs are atomic and failed startup waits for its owned process to stop',async()=>{
  const client=new Client();client.tools=[tools[0],tools[0]];const f=fixture(()=>client);await assert.rejects(f.handlers.get('session_start')(),error=>error.code==='MCP_CATALOG_INVALID');assert.equal(f.registered.length,0);assert.equal(client.phase,'closed');assert.equal(client.stops,1);await f.handlers.get('session_shutdown')();
});
test('a failed bridge never automatically replays a mutation; an explicit query restores transport without replacing Pi history or registering duplicate tools',async()=>{
  const clients=[],f=fixture(()=>{const client=new Client();clients.push(client);return client;});await f.handlers.get('session_start')();const box=f.registered.find(tool=>tool.name==='primitive__box'),query=f.registered.find(tool=>tool.name==='query_model');clients[0].phase='failed';clients[0].error=new McpProcessError('MCP_CALL_TIMEOUT','unknown',{outcome:'unknown'});
  const failed=await box.execute('one',{});assert.equal(failed.isError,true);assert.equal(failed.details.outcome,'unknown');assert.equal(clients.length,1);const recovered=await query.execute('observe',{});assert.equal(recovered.isError,false);assert.equal(clients.length,2);assert.equal(f.registered.length,2);assert.equal(clients[0].calls.filter(call=>call.method==='tools/call').length,1);assert.equal(clients[1].calls.filter(call=>call.method==='tools/call').length,1);assert.equal(clients[1].calls.at(-1).options.readOnly,true);await f.handlers.get('session_shutdown')();
});
test('an unconfirmed old process stop forbids replacement even during an explicit query recovery',async()=>{
  const first=new Client();let created=0;const f=fixture(()=>{created++;return first;});await f.handlers.get('session_start')();first.phase='failed';first.stopError=new McpProcessError('MCP_STOP_UNCONFIRMED','still alive');const result=await f.registered[0].execute('observe',{});assert.equal(result.isError,true);assert.equal(created,1);assert.match(result.content[0].text,/MCP_STOP_UNCONFIRMED/);first.stopError=null;await f.handlers.get('session_shutdown')();
});
test('shutdown fences late startup and stale tool closures cannot resurrect another subprocess',async()=>{
  const first=new Client();first.init=deferred();let count=0;const f=fixture(()=>{count++;return count===1?first:new Client();}),starting=f.handlers.get('session_start')();const rejected=assert.rejects(starting);await f.handlers.get('session_shutdown')();await rejected;assert.equal(f.registered.length,0);assert.equal(count,1);await f.handlers.get('session_start')();const old=f.registered[0];await f.handlers.get('session_shutdown')();const result=await old.execute('late',{});assert.equal(result.isError,true);assert.match(result.content[0].text,/MCP_SESSION_CHANGED/);assert.equal(count,2);
});
test('native abort signals and progress callbacks are forwarded, and a successful observed query is the only write-unlock path',async()=>{
  const client=new Client(),f=fixture(()=>client);await f.handlers.get('session_start')();const abort=new AbortController(),box=f.registered[1];await box.execute('one',{width:3},abort.signal,()=>{});assert.equal(client.calls.at(-1).options.signal,abort.signal);client.reconcile=true;await f.registered[0].execute('query',{});assert.equal(client.reconcile,false);await f.handlers.get('session_shutdown')();
});
test('native Pi result hooks propagate CAD errors without trusting model-authored details or changing successful tools',async()=>{
  const client=new Client(),f=fixture(()=>client);await f.handlers.get('session_start')();
  const hook=f.handlers.get('tool_result'),tool=f.registered[1];
  const success=await tool.execute('success',{});
  assert.equal(hook({toolName:tool.name,...success}),undefined);
  client.error=new McpProcessError('MCP_CALL_TIMEOUT','Result unknown',{outcome:'unknown'});
  const failure=await tool.execute('failure',{}),event={toolName:tool.name,...failure,isError:false};
  const patched=hook(event);assert.equal(patched.isError,true);assert.equal(patched.content,failure.content);assert.equal(patched.details,failure.details);
  assert.equal(hook({...event,details:{...failure.details}}),undefined,'Untrusted copies must not mark unrelated tools as failed');
  await f.handlers.get('session_shutdown')();
});
