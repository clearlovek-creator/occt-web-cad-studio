import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),quote=value=>"'"+value.replaceAll("'","''")+"'";
async function run(t,args,{copyNode=false,nodeOptions=''}={}){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cad-node-command-')),script=path.join(scratch,'test.ps1'),inputs=path.join(scratch,'arguments.json'),executable=copyNode?path.join(scratch,'中文 程序','node.exe'):process.execPath;
  if(copyNode){fs.mkdirSync(path.dirname(executable));fs.copyFileSync(process.execPath,executable);}
  t.after(()=>{assert.equal(path.dirname(scratch),path.resolve(os.tmpdir()));fs.rmSync(scratch,{recursive:true,force:true});});
  fs.writeFileSync(inputs,JSON.stringify(args));
  fs.writeFileSync(script,`\ufeff$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$root=${quote(root)};$NodeExecutable=${quote(executable)};$StartupTimeoutSeconds=15;$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(root,'scripts/start-web-cad-demo.ps1'))},[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Controller syntax invalid'};foreach($name in @('Resolve-NodeExecutable','Quote-CadNodeArgument','Invoke-CadNodeCommand')){$node=$ast.FindAll({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name},$true)[0];Invoke-Expression $node.Extent.Text};$arguments=[string[]](Get-Content -LiteralPath ${quote(inputs)} -Raw -Encoding UTF8 | ConvertFrom-Json);try{$reply=Invoke-CadNodeCommand $arguments;Write-Output ('RESULT '+$reply)}catch{Write-Output ('FAIL '+$_.Exception.Message)}`,{encoding:'utf8'});
  const env={...process.env,NODE_OPTIONS:nodeOptions};for(const key of Object.keys(env))if(key.toUpperCase()==='PATHEXT')delete env[key];
  const child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{cwd:root,windowsHide:true,env,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>errors+=bytes);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,errors);return output.trim();
}
test('managed Node commands preserve Chinese paths, spaces, quotes, shell-looking data and trailing backslashes',async t=>{
  const values=['中文 value','C:\\directory with spaces\\','quoted "value"','&;$(not a command)',''];const output=await run(t,['-e','console.log(JSON.stringify(process.argv.slice(1)))',...values],{copyNode:true});assert.ok(output.startsWith('RESULT '),output);assert.deepEqual(JSON.parse(output.slice(7)),values);
});
test('managed Node observes the real nonzero exit code and bounded stderr rather than an ambient LASTEXITCODE',async t=>{
  const output=await run(t,['-e','console.error("expected unit failure");process.exitCode=7;']);assert.match(output,/^FAIL Node command failed with exit code 7\./);assert.match(output,/expected unit failure/);
});
test('managed Node preflight strips inherited code hooks before running certified control code',async t=>{
  const output=await run(t,['-e','console.log(JSON.stringify({nodeOptions:process.env.NODE_OPTIONS??null,ok:true}))'],{nodeOptions:'--import Z:/must-not-execute.mjs'});assert.ok(output.startsWith('RESULT '),output);assert.deepEqual(JSON.parse(output.slice(7)),{nodeOptions:null,ok:true});
});
