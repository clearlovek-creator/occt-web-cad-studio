/* Reproducible, isolated Windows research target; not a product release. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
assert.equal(process.platform,'win32','This research build is qualified only on Windows.');
const cmake='C:/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe';
const compiler='C:/msys64/ucrt64/bin/g++.exe',ninja='C:/msys64/ucrt64/bin/ninja.exe';
const dependencies=path.join(root,'.artifacts/discrete-dependencies'),build=path.join(root,'.artifacts/discrete-surface-build');
const evidence=path.resolve(root,process.argv[2]||`.artifacts/discrete-surface-build-proof-${Date.now()}`);
assert.ok(evidence.startsWith(path.join(root,'.artifacts')+path.sep)&&!fs.existsSync(evidence));
for(const directory of [dependencies,build]){
  let current=directory;
  while(current!==root){if(fs.existsSync(current))assert.ok(fs.lstatSync(current).isDirectory()&&!fs.lstatSync(current).isSymbolicLink());current=path.dirname(current);}
}
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const archives=[['CGAL-6.1.2-library.tar.xz','a4d7d36ee49f813609f195638bf9ab2d1d55157e8d1256fb2408459a09a87b59'],['boost_1_88_0.tar.gz','3621533e820dcab1e8012afd583c0c73cf0f77694952b81352bf38c1488f9cb4']];
for(const [name,hash] of archives)assert.equal(sha(path.join(dependencies,name)),hash,'Research archive changed');
const sources=['experiments/discrete-surface/main.cxx','experiments/discrete-surface/CMakeLists.txt','discrete-surface-worker/src/SurfaceRefinement.cxx','discrete-surface-worker/src/SurfaceRefinement.hxx','discrete-surface-worker/cmake/boost-headers/BoostConfig.cmake','discrete-surface-worker/cmake/boost-headers/BoostConfigVersion.cmake','discrete-surface-worker/cmake/boost-headers/ReadHeaderVersion.cmake','geometry-worker/src/protocol/Json.cxx','geometry-worker/src/protocol/Json.hxx','geometry-worker/src/runtime/NativeResourceGuard.cxx','geometry-worker/src/runtime/NativeResourceGuard.hxx','scripts/build-discrete-surface-research.mjs'];
const sourceProof=sources.map(file=>({file,sha256:sha(path.join(root,file))}));
fs.mkdirSync(evidence,{recursive:true});
const environment={...process.env,PATH:`C:/msys64/ucrt64/bin;C:/msys64/usr/bin;${process.env.PATH}`};
async function run(binary,args,name){
  const child=spawn(binary,args,{cwd:root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const log=fs.createWriteStream(path.join(evidence,name+'.log'),{flags:'wx'});let output='',overflow=false;
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log.write(bytes);if(Buffer.byteLength(output)+bytes.length>4*1024*1024){overflow=true;child.kill();}else output+=bytes;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  await new Promise(resolve=>log.end(resolve));assert.equal(overflow,false,`${name} diagnostic limit`);assert.equal(code,0,`${name} failed; see retained log\n${output.slice(-1500)}`);return output;
}
const configure=['-S','experiments/discrete-surface','-B',build,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_CXX_FLAGS_RELEASE=-O1 -DNDEBUG',`-DCMAKE_CXX_COMPILER=${compiler}`,`-DCMAKE_MAKE_PROGRAM=${ninja}`,`-DCGAL_DIR=${path.join(dependencies,'CGAL-6.1.2')}`,`-DBOOST_ROOT=${path.join(dependencies,'boost_1_88_0')}`,'-DGMP_INCLUDE_DIR=C:/msys64/ucrt64/include','-DGMP_LIBRARIES=C:/msys64/ucrt64/lib/libgmp.dll.a','-DMPFR_INCLUDE_DIR=C:/msys64/ucrt64/include','-DMPFR_LIBRARIES=C:/msys64/ucrt64/lib/libmpfr.dll.a'];
await run(cmake,configure,'configure');await run(cmake,['--build',build,'--parallel','1'],'compile');
for(const item of sourceProof)assert.equal(sha(path.join(root,item.file)),item.sha256,'Project source changed during build');
const binary=path.join(evidence,'cad_discrete_surface_research.exe');fs.copyFileSync(path.join(build,path.basename(binary)),binary,fs.constants.COPYFILE_EXCL);
const imports=await run('C:/msys64/ucrt64/bin/objdump.exe',['-p',binary],'pe-imports');
const importedDlls=[...imports.matchAll(/DLL Name:\s*(\S+)/g)].map(x=>x[1]).sort();
assert.ok(importedDlls.length>0,'No PE imports were observed; do not certify a truncated inspection.');
const runtime=importedDlls.filter(name=>fs.existsSync(path.join('C:/msys64/ucrt64/bin',name))).map(name=>({name,sha256:sha(path.join('C:/msys64/ucrt64/bin',name))}));
const receipt={format:'discrete-surface-research-build',version:1,scope:'algorithm-regression-harness-not-a-product-release',createdAt:new Date().toISOString(),node:process.version,compilerVersion:(await run(compiler,['--version'],'compiler-version')).split(/\r?\n/)[0],tools:[cmake,compiler,ninja].map(file=>({file,sha256:sha(file)})),configureArguments:configure,archives:archives.map(([name,sha256])=>({name,sha256})),sources:sourceProof,executable:{file:path.relative(root,binary).replaceAll('\\','/'),sha256:sha(binary)},importedDlls,runtime,limits:['Archive hashes and actual tool/runtime bytes recorded; not a full compiler/system/dependency source closure.','GPL-3.0-or-later route selected; product runtime and corresponding-source qualification remain separate gates.','Regression executable is never selected by the daily workers or release system.']};
fs.writeFileSync(path.join(evidence,'build.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
console.log(JSON.stringify({ok:true,evidence,executable:receipt.executable,runtime:runtime.map(r=>r.name)}));
