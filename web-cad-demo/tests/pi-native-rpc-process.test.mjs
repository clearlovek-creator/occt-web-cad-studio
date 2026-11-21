import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {PiRpcSession} from '../gateway/pi-rpc-runtime.mjs';

test('the actual configured Pi source CLI and CAD extension complete RPC handshake and verified process/stdio shutdown without a provider call',async()=>{
  const root=path.resolve(import.meta.dirname,'..'),pi=path.resolve(root,'../pi'),scratch=await mkdtemp(path.join(os.tmpdir(),'cad-native-pi-rpc-')),requests=[];
  const server=createServer((request,response)=>{requests.push({method:request.method,path:request.url});response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({ok:true,gateway:true,worker:true}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const allowed=new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','USERPROFILE','HOME','TEMP','TMP','APPDATA','LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE']);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toUpperCase())));Object.assign(env,{CAD_GEOMETRY_API_URL:`http://127.0.0.1:${server.address().port}/api`,NODE_ENV:'test'});
  const session=new PiRpcSession({sessionId:'native-rpc-budget',documentId:'isolated_native',cliPath:path.join(pi,'node_modules/tsx/dist/cli.mjs'),cliArgs:[path.join(pi,'packages/coding-agent/src/cli.ts')],extensionPath:path.join(root,'gateway/pi-cad-mcp-extension.mjs'),cwd:pi,sessionRoot:path.join(scratch,'sessions'),agentConfigDir:path.join(scratch,'agent-config'),env});
  try{
    await session.start();const owned=session.child,state=await session.request({type:'get_state'});assert.equal(state.success,true);assert.equal(typeof state.transport.streamId,'string');const history=await session.request({type:'get_messages'});assert.equal(history.success,true);assert.deepEqual(history.data.messages,[]);
    await session.stop();assert.ok(owned.exitCode!==null||owned.signalCode!==null);assert.equal(session.stoppingChild,null);assert.equal(session.pendingBytes,0);assert.equal(session.pending.size,0);assert.ok(requests.some(request=>request.path==='/api/health'));assert.ok(requests.every(request=>request.method==='GET'&&request.path==='/api/health'),'No CAD writes, model prompts or external provider test calls');
  }finally{await session.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(scratch,{recursive:true,force:true});}
});
