import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
const workspace=path.resolve(import.meta.dirname,'..');
const cmakeString=value=>'"'+value.replaceAll('\\','/').replaceAll('"','\\"')+'"';
for(const profile of ['geometry','mesh'])test(`native CTest runner chooses the ${profile} DLL profile, not a shared geometry-first path`,async()=>{
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cad-ctest-profile-中文-'));
  try{
    const geometry=path.join(scratch,'geometry DLL'),mesh=path.join(scratch,'mesh DLL'),mingw=path.join(scratch,'tool DLL');for(const directory of [geometry,mesh,mingw])fs.mkdirSync(directory);
    const expected=profile==='geometry'?geometry:mesh;
    fs.writeFileSync(path.join(scratch,'CTestTestfile.cmake'),'add_test(profile '+[process.execPath,path.join(workspace,'tests/fixtures/native-profile.mjs'),expected].map(cmakeString).join(' ')+')\n');
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(workspace,'scripts/test-native.ps1'),'-BuildDirectory',scratch,'-RuntimeProfile',profile],{cwd:workspace,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,OCCT_BIN:geometry,GMSH_BIN:mesh,MINGW_BIN:mingw}});let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,output);assert.match(output,/100% tests passed/);
  }finally{assert.equal(path.dirname(scratch),path.resolve(os.tmpdir()));assert.ok(path.basename(scratch).startsWith('cad-ctest-profile-'));fs.rmSync(scratch,{recursive:true,force:true});}
});
