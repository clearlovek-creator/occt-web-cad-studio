import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PythonAgentClient} from '../app/modeling/python-agent-client.ts';
import {pythonAgentService,pythonTestRuntime} from './helpers/python-agent-service.mjs';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';
import {spawn} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..'),scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cad-python-workspace-'));
function clean(data){assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-python-workspace-/);fs.rmSync(data,{recursive:true,force:true});}

test('the real Python API recovers a dropped creation reply and restores the same scoped Run after a full service restart without reposting',async()=>{
  const data=scratch();let service,verified=false;try{service=await pythonAgentService(data);let posts=0,pendingSeen=false,client;
    const request=async(url,init)=>{if(init.method==='POST'){posts++;pendingSeen=Boolean(client.getRecoveryState().pending);const reply=await fetch(url,init);assert.equal(reply.status,200);await reply.arrayBuffer();throw Error('Drop real committed response');}return fetch(url,init);};
    client=new PythonAgentClient(service.api,request);client.setDocumentId('alpha');const result=await client.run('create an antenna');assert.equal(result.responseAction,'observed');assert.equal(result.status.status,'waiting_user');assert.equal(pendingSeen,true);assert.equal(posts,1);const saved=client.getRecoveryState(),before=fs.readFileSync(path.join(data,'agent.json'));
    assert.equal(await service.stop(),0);service=null;service=await pythonAgentService(data);const readCalls=[],restored=new PythonAgentClient(service.api,async(url,init)=>{readCalls.push(init.method);return fetch(url,init);});restored.setDocumentId('alpha');restored.restoreRecoveryState(saved);const current=await restored.refreshActiveRun();assert.equal(current.run_id,result.status.run_id);assert.equal(current.run_version,result.status.run_version);assert.deepEqual(readCalls,['GET']);assert.deepEqual(fs.readFileSync(path.join(data,'agent.json')),before);
    assert.equal((await fetch(service.api+'/runs/'+current.run_id+'?document_id=beta')).status,409);assert.equal((await fetch(service.api+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(current.client_creation)})).status,409);assert.deepEqual(fs.readFileSync(path.join(data,'agent.json')),before);verified=true;
  }finally{if(service)assert.equal(await service.stop(),0);if(verified)clean(data);else console.error('Python HTTP recovery data retained:',data);}
});

test('the final Python client survives a lost approval reply while real OCCT creates only the original document, and Python live regressions pass on a private Gateway',async()=>{
  const data=scratch();let service,gateway,verified=false;try{gateway=await gatedGeometryGateway(path.join(data,'geometry'));service=await pythonAgentService(path.join(data,'agent'),{gateway:gateway.api.replace(/\/api$/,''),mode:'local'});let approvalPosts=0,creationPosts=0;
    const client=new PythonAgentClient(service.api,async(url,init)=>{const reply=await fetch(url,init);if(init.method==='POST'&&url.endsWith('/runs'))creationPosts++;if(init.method==='POST'&&url.includes('/approvals/')){approvalPosts++;assert.equal(reply.status,200);await reply.arrayBuffer();throw Error('Drop real native approval response');}return reply;});client.setDocumentId('alpha');
    const first=await client.run('create a 2.45 GHz rectangular patch antenna on FR-4');assert.equal(first.status.status,'waiting_approval');const result=await client.run('execute original',true);assert.equal(result.responseAction,'observed');assert.equal(result.status.status,'completed');assert.equal(creationPosts,1);assert.equal(approvalPosts,1);const alpha=await gateway.cad('document.summary',{}, {},'alpha');assert.equal(alpha.bodyCount,1);assert.equal((await gateway.cad('document.summary',{}, {},'beta')).bodyCount,0);
    client.setDocumentId('beta');assert.equal(client.getActiveStatus(),null);const beta=await client.run('create an antenna');assert.equal(beta.status.document_id,'beta');assert.notEqual(beta.status.run_id,first.status.run_id);assert.equal((await gateway.cad('document.summary',{}, {},'alpha')).stateToken,alpha.stateToken);assert.equal(creationPosts,2);
    // Also exercise the project's entire Python suite against this private native
    // Gateway. Disable pytest's source-path override when a frozen wheel is used.
    const runtime=pythonTestRuntime(),code="import sys; sys.path[:0]=sys.argv[1:3]; import pytest; raise SystemExit(pytest.main(['modeling-agent/tests','-q','-rs','-o','pythonpath=','-p','no:cacheprovider']))";
    const child=spawn(runtime.python,['-B','-c',code,runtime.packageRoot,runtime.dependencies],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MODEL_AGENT_LIVE_GATEWAY:'1',MODEL_AGENT_GATEWAY_URL:gateway.api.replace(/\/api$/,''),HYPOTHESIS_STORAGE_DIRECTORY:path.join(data,'hypothesis'),LANGCHAIN_TRACING_V2:'false',LANGSMITH_TRACING:'false'}});let output='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(exit,0,output);assert.doesNotMatch(output,/\bskipped\b/);assert.match(output,/\b94 passed\b/);console.log('Private native Python regression: 94 passed; no skips.');verified=true;
  }finally{if(service)assert.equal(await service.stop(),0);if(gateway)assert.equal(await gateway.stop(),0);if(verified)clean(data);else console.error('Python/native diagnostics retained:',data);}
});
