import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {frontendEnvironment} from '../gateway/frontend-release.mjs';
import {backendEnvironment} from '../gateway/backend-release.mjs';

// Windows needs an explicit STARTUPINFOEX handle whitelist: libuv 1.51
// CreateProcess inherits eligible non-stdio handles too. Redirecting fd 1/2
// alone did not stop caller pipes remaining open for the service's lifetime.
const argv=process.argv.slice(2), options={}; let commandArgs=[];
for(let index=0;index<argv.length;index++) {
  if(argv[index]==="--") {commandArgs=argv.slice(index+1);break;}
  if(argv[index]==="--visible") {options.visible=true;continue;}
  const key=argv[index]; if(!["--cwd","--target","--stdout","--stderr","--profile"].includes(key) || !argv[index+1]) throw new Error(`Invalid launch option: ${key}`);
  options[key.slice(2)]=argv[++index];
}
for(const key of ["cwd","target","stdout","stderr"]) if(!options[key] || !path.isAbsolute(options[key])) throw new Error(`An absolute ${key} path is required.`);
if(options.profile&&!['frontend','gateway'].includes(options.profile))throw Error('Unsupported environment profile.');
const environment=options.profile==='frontend'?frontendEnvironment(process.env):options.profile==='gateway'?backendEnvironment(process.env):process.env;
if(process.platform==='win32'){
  const helper=path.join(import.meta.dirname,'launch-background-windows.ps1'),powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const child=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{cwd:options.cwd,env:environment,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.length>8192)child.stdout.destroy(Error('Launch reply exceeds budget'));});child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-8192);});
  const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('error',reject);child.stdin.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Windows background launch failed; no service readiness was reported. '+(stderr.match(/WINDOWS_BACKGROUND_LAUNCH_FAILED stage=[a-z]+ kind=[A-Za-z0-9]+ code=[A-Za-z0-9,._-]+/)?.[0]||'No launch receipt'))));});
  child.stdin.end(JSON.stringify({executable:process.execPath,cwd:options.cwd,stdout:options.stdout,stderr:options.stderr,args:[options.target,...commandArgs],visible:Boolean(options.visible)}));
  await completion;const result=JSON.parse(stdout);if(!Number.isSafeInteger(result.pid)||result.pid<1||result.executable!==process.execPath)throw Error('Invalid background launch receipt.');process.stdout.write(JSON.stringify(result));
}else{
  const output=fs.openSync(options.stdout,'a'),errors=fs.openSync(options.stderr,'a');
  try{const child=spawn(process.execPath,[options.target,...commandArgs],{cwd:options.cwd,env:environment,detached:true,stdio:['ignore',output,errors]});await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve);});child.unref();process.stdout.write(JSON.stringify({pid:child.pid,executable:process.execPath}));}
  finally{fs.closeSync(output);fs.closeSync(errors);}
}
