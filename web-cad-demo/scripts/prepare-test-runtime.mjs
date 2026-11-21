import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {nativeTestSources,validateTestBuildDirectory,captureNativeTestRuntime,validateNativeTestRuntime} from './test-native-runtime.mjs';
const workspace=path.resolve(import.meta.dirname,'..'),args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++){const name=args[i];if(!['--geometry-build','--mesh-build'].includes(name)||!args[i+1]||Object.hasOwn(options,name))throw Error('Usage: prepare-test-runtime.mjs [--geometry-build directory] [--mesh-build directory]');options[name]=args[++i];}
if(process.platform!=='win32')throw Error('The current native build preparation supports the documented Windows toolchain only.');
const geometryBuild=validateTestBuildDirectory(workspace,path.resolve(workspace,options['--geometry-build']||'.artifacts/native-test-build/geometry')),meshBuild=validateTestBuildDirectory(workspace,path.resolve(workspace,options['--mesh-build']||'.artifacts/native-test-build/mesh'));
assert.notEqual(geometryBuild,meshBuild,'Geometry and mesh must have separate build directories');
const area=path.join(workspace,'.artifacts/native-test-runtime');fs.mkdirSync(area,{recursive:true});
const id=crypto.randomUUID(),log=fs.openSync(path.join(area,`prepare-${id}.log`),'wx'),sourcesBefore=nativeTestSources(workspace);
try{
  for(const [script,extra] of [['build-worker.ps1',['-NativeTests']],['build-mesh-worker.ps1',['-NativeTests']]]){
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(workspace,'scripts',script),...extra],{cwd:workspace,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,GEOMETRY_WORKER_BUILD_DIR:geometryBuild,MESH_WORKER_BUILD_DIR:meshBuild}});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,`Native build failed; inspect .artifacts/native-test-runtime/prepare-${id}.log. Existing test selection is unchanged.`);
  }
  const manifest=captureNativeTestRuntime({workspace,geometryBuild,meshBuild,sourcesBefore});validateNativeTestRuntime(manifest,workspace,{environment:{}});
  const file=`runtime-${id}.json`,bytes=Buffer.from(JSON.stringify(manifest,null,2));fs.writeFileSync(path.join(area,file),bytes,{flag:'wx'});
  const pointer={format:'web-cad-native-test-selection',version:1,file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')},temporary=path.join(area,`selected-${id}.tmp`);
  fs.writeFileSync(temporary,JSON.stringify(pointer,null,2),{flag:'wx'});fs.renameSync(temporary,path.join(area,'selected.json'));
  console.log(JSON.stringify({ok:true,manifest:file,manifestSha256:pointer.sha256,sourceFiles:manifest.sources.length,geometryBuild,meshBuild,scope:manifest.scope}));
}finally{fs.closeSync(log);}
