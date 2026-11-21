import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {selectNativeTestRuntime,validateNativeTestRuntime,assertNativeTestRoles} from './test-native-runtime.mjs';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../gateway/native-runtime-release.mjs';
const workspace=path.resolve(import.meta.dirname,'..'),args=process.argv.slice(2);
const runtime=selectNativeTestRuntime(workspace,process.env.CAD_TEST_NATIVE_SELECTION);
function verifyExplicitBackends(){
  for(const prefix of ['CAD_TEST_BACKEND_RELEASE','CAD_TEST_PI_FIXTURE_BACKEND_RELEASE']){
    if(!process.env[prefix+'_ROOT'])continue;
    const release=selectBackendRelease(path.resolve(workspace,process.env[prefix+'_ROOT']),process.env[prefix+'_ID']);
    if(release.native)assertNativeTestRoles(runtime.manifest,validateNativeRuntime(path.join(release.directory,'native'),release.native).roles);
  }
}
if(args.length===1&&args[0]==='--inspect'){
  console.log(JSON.stringify({ok:true,manifestSha256:runtime.manifestSha256,geometry:runtime.geometry,mesh:runtime.mesh,sourceFiles:runtime.manifest.sources.length,scope:runtime.manifest.scope}));
}else{
  let commands,files=[];
  if(args.length===1&&args[0]==='--native')commands=['geometry','mesh'].map(kind=>({binary:'powershell.exe',args:['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(workspace,'scripts/test-native.ps1'),'-BuildDirectory',runtime.manifest.builds[kind].directory,'-RuntimeProfile',kind]}));
  else if(args.length===2&&args[0]==='--script'&&/^scripts\/verify-[a-z0-9-]+\.(?:mjs|cjs)$/.test(args[1])&&fs.existsSync(path.join(workspace,args[1])))commands=[{binary:process.execPath,args:[args[1]]}];
  else{
    if(args.some(name=>!/^tests\/[A-Za-z0-9_.-]+\.test\.mjs$/.test(name)||!fs.existsSync(path.join(workspace,name))))throw Error('Pass top-level tests/*.test.mjs files, --native, or --script scripts/verify-*.mjs/cjs.');
    files=args.length?args:fs.readdirSync(path.join(workspace,'tests')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name);
    commands=[{binary:process.execPath,args:['--test','--test-concurrency=4',...files]}];
  }
  console.log(JSON.stringify({type:'test.native-runtime',manifestSha256:runtime.manifestSha256,files:files.length,sourceFiles:runtime.manifest.sources.length}));
  if(args[0]==='--script')verifyExplicitBackends();
  for(const command of commands){
    const child=spawn(command.binary,command.args,{cwd:workspace,windowsHide:true,stdio:'inherit',env:runtime.environment});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(signal?1:code??1));});
    // A passing test result cannot certify inputs changed while the test ran.
    validateNativeTestRuntime(runtime.manifest,workspace);
    if(args[0]==='--script')verifyExplicitBackends();
    if(code!==0){process.exitCode=code;break;}
  }
}
