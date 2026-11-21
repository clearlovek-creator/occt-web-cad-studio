import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {collectDiagnostics} from '../gateway/diagnostic-report.mjs';

async function within(action){
  let timer;try{return await Promise.race([action,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Diagnostic observation exceeded its cleanup/deadline bound')),500);})]);}finally{clearTimeout(timer);}
}
test('a response cancellation promise that never settles cannot hold the diagnostic report open',async()=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'cad-diagnostic-deadline-'));let cancelled=0;
  try{
    const report=await within(collectDiagnostics({workspace,timeoutMs:100,maxResponseBytes:1024,fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2048));},cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}})}));
    assert.equal(report.observations.gateway.state,'response-limit');assert.equal(cancelled,3);
  }finally{assert.equal(path.dirname(workspace),path.resolve(os.tmpdir()));assert.match(path.basename(workspace),/^cad-diagnostic-deadline-/);fs.rmSync(workspace,{recursive:true,force:true});}
});
test('a transport that ignores AbortSignal still cannot exceed the observation deadline',async()=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'cad-diagnostic-deadline-'));
  try{
    const report=await within(collectDiagnostics({workspace,timeoutMs:100,fetchImpl:()=>new Promise(()=>{})}));
    assert.equal(report.observations.gateway.state,'timeout');assert.equal(report.observations.frontend.state,'timeout');
  }finally{assert.equal(path.dirname(workspace),path.resolve(os.tmpdir()));assert.match(path.basename(workspace),/^cad-diagnostic-deadline-/);fs.rmSync(workspace,{recursive:true,force:true});}
});
