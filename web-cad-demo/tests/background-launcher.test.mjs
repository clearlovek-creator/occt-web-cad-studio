import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const workspace=path.resolve(import.meta.dirname,'..'),wrapper=path.join(workspace,'tests/fixtures/background-wrapper.ps1');
const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const pathKey=Object.keys(process.env).find(key=>key.toLowerCase()==='path');
const pwsh=(process.env[pathKey]||'').split(path.delimiter).map(directory=>path.join(directory,'pwsh.exe')).find(file=>fs.existsSync(file));
const quote=value=>"'"+value.replaceAll("'","''")+"'";
for(const mode of ['node-direct','powershell-file','powershell-nested-powershell',...(pwsh?['pwsh-file','pwsh-nested-powershell']:[])])test(`background startup exits and closes caller pipes while its service remains alive: ${mode}`,async t=>{
  assert.equal(process.platform,'win32','This launcher contract targets Windows');assert.ok(fs.existsSync(powershell));
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cad-launch-lifecycle-中文-')),nonce=crypto.randomUUID(),ready=path.join(scratch,'ready.json');
  const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',wrapper,'-Node',process.execPath,'-Launcher',path.join(workspace,'scripts/launch-background-service.mjs'),'-Workspace',workspace,'-Target',path.join(workspace,'tests/fixtures/background-idle.mjs'),'-StdoutFile',path.join(scratch,'stdout.log'),'-StderrFile',path.join(scratch,'stderr.log'),'-ReadyFile',ready,'-Nonce',nonce];
  const extra=['','space value','literal"quote','trailing\\','汉字 / 🙂','slashes\\\\"quote'];
  const binary=mode==='node-direct'?process.execPath:mode.startsWith('powershell-')?powershell:pwsh;
  const command=mode==='node-direct'?[path.join(workspace,'scripts/launch-background-service.mjs'),'--cwd',workspace,'--target',path.join(workspace,'tests/fixtures/background-idle.mjs'),'--stdout',path.join(scratch,'stdout.log'),'--stderr',path.join(scratch,'stderr.log'),'--',ready,nonce,'6000',...extra]:mode.includes('nested')?['-NoProfile','-Command','& '+[powershell,...args].map(quote).join(' ')]:args;
  const started=performance.now(),child=spawn(binary,command,{cwd:workspace,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',exitAt=null,closeAt=null,code=null;
  child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);child.once('exit',value=>{exitAt=performance.now()-started;code=value;});
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',()=>{closeAt=performance.now()-started;resolve();});});
  let observationTimer;
  try{
    await Promise.race([closed,new Promise((_,reject)=>{observationTimer=setTimeout(()=>reject(Error('Test-owned launch observation timed out; preserve '+scratch)),13000);})]);
    assert.equal(code,0,stderr);assert.ok(exitAt<4000,`wrapper exit took ${exitAt}ms; ${mode}`);assert.ok(closeAt<4000,`caller pipes closed only after ${closeAt}ms; ${mode}`);
    const readyDeadline=performance.now()+1000;while(!fs.existsSync(ready)&&performance.now()<readyDeadline)await new Promise(resolve=>setTimeout(resolve,20));
    const result=JSON.parse(stdout),receipt=JSON.parse(fs.readFileSync(ready,'utf8'));assert.equal(result.pid,receipt.pid);assert.equal(receipt.nonce,nonce);assert.deepEqual(receipt.arguments,mode==='node-direct'?extra:[]);
    assert.equal(process.kill(result.pid,0),true,'Detached service must remain alive after the launch command has fully closed');
    t.diagnostic(JSON.stringify({mode,wrapperExitMs:Math.round(exitAt),pipesCloseMs:Math.round(closeAt),serviceAliveAfterClose:true}));
  }finally{
    clearTimeout(observationTimer);
    // The finite fixture exits on its own; never terminate a PID inferred from
    // a stale file, and never touch registered production processes.
    const deadline=performance.now()+10000;
    while(performance.now()<deadline){let running=false;if(fs.existsSync(ready)){const receipt=JSON.parse(fs.readFileSync(ready,'utf8'));try{running=process.kill(receipt.pid,0);}catch(error){if(error.code!=='ESRCH')throw error;}}if(!running&&exitAt!==null)break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(exitAt!==null&&closeAt!==null,'Fixture wrapper is still live; preserve '+scratch);
    if(fs.existsSync(ready)){const receipt=JSON.parse(fs.readFileSync(ready,'utf8'));let running=false;try{running=process.kill(receipt.pid,0);}catch(error){if(error.code!=='ESRCH')throw error;}assert.equal(running,false,'Finite fixture did not exit; preserve '+scratch);}
    assert.equal(path.dirname(scratch),path.resolve(os.tmpdir()));assert.ok(path.basename(scratch).startsWith('cad-launch-lifecycle-'));fs.rmSync(scratch,{recursive:true,force:true});
  }
});
