import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {localGateway,proxyGeometry} from '../gateway/frontend-proxy.mjs';
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('only credential-free loopback /api targets are valid gateway destinations',()=>{
  assert.equal(localGateway('http://127.0.0.1:8916/api').pathname,'/api');
  for(const value of ['https://example.com/api','http://user:secret@localhost/api','http://localhost/api?key=secret','file:///api','http://127.0.0.1/other'])assert.throws(()=>localGateway(value));
});
test('bridge streams the exact upload once, retains status and strips hop-by-hop or spoofed forwarded headers',async()=>{
  let count=0;const upstream=http.createServer((request,response)=>{count++;const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{assert.equal(request.url,'/api/import?request=once');assert.equal(request.headers['x-forwarded-for'],undefined);assert.equal(request.headers['x-drop'],undefined);response.writeHead(409,{'Content-Type':'application/json','x-proof':'preserved'});response.end(JSON.stringify({bytes:Buffer.concat(chunks).toString('base64')}));});});
  const target=localGateway(await listen(upstream)+'/api'),bridge=http.createServer((request,response)=>proxyGeometry(request,response,target)),url=await listen(bridge),body=Buffer.from('binary\0STEP 中文');
  try{const result=await new Promise((resolve,reject)=>{const request=http.request(url+'/api/import?request=once',{method:'POST',headers:{'x-forwarded-for':'spoofed','Connection':'x-drop','x-drop':'not-forwarded'}},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,value:JSON.parse(text)}));});request.once('error',reject);request.end(body);});assert.equal(result.status,409);assert.equal(result.headers['x-proof'],'preserved');assert.equal(result.value.bytes,body.toString('base64'));assert.equal(count,1);}
  finally{await close(bridge);await close(upstream);}
});
test('SSE is delivered before upstream completion and client disconnect closes only that subscription',async()=>{
  let ended=false,disconnected;const exit=new Promise(resolve=>{disconnected=resolve;});const upstream=http.createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('event: pi\ndata: {"phase":"first"}\n\n');request.on('close',()=>{ended=true;disconnected();});});
  const target=localGateway(await listen(upstream)+'/api'),bridge=http.createServer((request,response)=>proxyGeometry(request,response,target)),url=await listen(bridge),abort=new AbortController();
  try{const reply=await fetch(url+'/api/events',{signal:abort.signal}),reader=reply.body.getReader(),chunk=await reader.read();assert.match(Buffer.from(chunk.value).toString(),/phase/);assert.equal(ended,false,'The first event cannot be buffered until stream completion');abort.abort();await exit;assert.equal(ended,true);}
  finally{abort.abort();await close(bridge);await close(upstream);}
});
test('connection failure produces one actionable non-retry response, without exposing internal errors',async()=>{
  const temporary=http.createServer(),closed=await listen(temporary);await close(temporary);const bridge=http.createServer((request,response)=>proxyGeometry(request,response,localGateway(closed+'/api'))),url=await listen(bridge);
  try{const reply=await fetch(url+'/api/commands',{method:'POST',body:'one attempt'}),result=await reply.json();assert.equal(reply.status,503);assert.equal(result.code,'FRONTEND_GATEWAY_UNAVAILABLE');assert.equal(result.recoverable,false);assert.ok(!JSON.stringify(result).includes('ECONNREFUSED'));}
  finally{await close(bridge);}
});
