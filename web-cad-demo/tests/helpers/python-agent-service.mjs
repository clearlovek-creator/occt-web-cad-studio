import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'../..');
export function pythonTestRuntime(){
  const python=process.env.CAD_TEST_PYTHON||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),dependencies=path.resolve(root,process.env.CAD_TEST_PYTHON_DEPENDENCIES||'.artifacts/python-workspace-deps'),packageRoot=path.resolve(root,process.env.CAD_TEST_PYTHON_PACKAGE_ROOT||'modeling-agent/src');
  for(const file of [python,path.join(dependencies,'fastapi'),path.join(packageRoot,'modeling_agent/api/app.py')])assert.ok(fs.existsSync(file),'Python test runtime missing: '+file+'; prepare the documented isolated Python test dependencies.');
  return {python,dependencies,packageRoot};
}
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
export async function pythonAgentService(data,{gateway='',mode='local'}={}){
  const runtime=pythonTestRuntime(),port=await freePort(),token=randomUUID();fs.mkdirSync(data,{recursive:true});
  const child=spawn(runtime.python,['-B',path.join(root,'tests/fixtures/python-workspace-http.py'),'--dependencies',runtime.dependencies,'--package-root',runtime.packageRoot,'--data',data,'--port',String(port),'--gateway',gateway,'--mode',mode],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CAD_TEST_PYTHON_STOP_TOKEN:token,LANGCHAIN_TRACING_V2:'false',LANGSMITH_TRACING:'false'}});
  let diagnostics='',buffer='';const ready=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error('Python fixture exited before readiness: '+code+' '+diagnostics)));child.stdout.on('data',part=>{buffer+=part;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line.includes('python-test-ready')){try{const value=JSON.parse(line);assert.equal(value.port,port);assert.equal(fs.realpathSync(value.packageOrigin),fs.realpathSync(path.join(runtime.packageRoot,'modeling_agent/api/app.py')));resolve();}catch(error){reject(error);}}}});});child.stderr.on('data',part=>diagnostics=(diagnostics+part).slice(-32768));
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal}))),api=`http://127.0.0.1:${port}/api/v1/agent`;
  const fixture={child,api,runtime,async stop(){if(child.exitCode!==null||child.signalCode!==null){const value=await closed;assert.equal(value.code,0,diagnostics);return value.code;}child.stdin.write(JSON.stringify({stop:token})+'\n');let timer;try{const value=await Promise.race([closed,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Python fixture exit unconfirmed; preserve '+data+' and inspect the same child')),15000))]);assert.equal(value.code,0,diagnostics);return value.code;}finally{clearTimeout(timer);}}};
  let timer;try{await Promise.race([ready,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Python readiness observation expired; preserve same child and data: '+data)),15000))]);}catch(error){Object.defineProperty(error,'fixture',{value:fixture});try{await fixture.stop();}catch{/* Preserve the exact still-owned handle; never replace an unconfirmed child. */}throw error;}finally{clearTimeout(timer);}return fixture;
}
