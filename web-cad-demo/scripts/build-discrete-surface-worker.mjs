/* GPL product-worker build and exact PE runtime capture; never selects daily services. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {collectNativeRuntimeProfile} from '../gateway/native-runtime-release.mjs';
import {fileInventory,hashFile,copyCertifiedFiles,assertRegularDirectory} from '../gateway/frontend-release.mjs';
import {dependencyHeaderInventory} from './discrete-build-inputs.mjs';
const root=path.resolve(import.meta.dirname,'..'),output=path.resolve(process.argv[2]||'.artifacts/discrete-worker-native');
assert.equal(process.platform,'win32');assert.ok(output.startsWith(path.join(root,'.artifacts')+path.sep));assert.ok(!fs.existsSync(output),'Use a new build directory to retain earlier evidence.');
for(let current=path.dirname(output);current!==root;current=path.dirname(current))if(fs.existsSync(current))assertRegularDirectory(current);
const cmake='C:/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe',compiler='C:/msys64/ucrt64/bin/g++.exe',ninja='C:/msys64/ucrt64/bin/ninja.exe',mingw='C:/msys64/ucrt64/bin';
const dependencies=path.join(root,'.artifacts/discrete-dependencies'),cgal=path.join(dependencies,'CGAL-6.1.2'),boost=path.join(dependencies,'boost_1_88_0'),build=path.join(output,'build'),runtime=path.join(output,'runtime');
const archives=[['CGAL-6.1.2-library.tar.xz','a4d7d36ee49f813609f195638bf9ab2d1d55157e8d1256fb2408459a09a87b59'],['boost_1_88_0.tar.gz','3621533e820dcab1e8012afd583c0c73cf0f77694952b81352bf38c1488f9cb4']];
for(const [name,sha]of archives)assert.equal(hashFile(path.join(dependencies,name)),sha,'Verified dependency archive changed.');
assert.equal(hashFile(path.join(root,'discrete-surface-worker/LICENSE')),hashFile(path.join(cgal,'LICENSE.GPL')));
assert.match(fs.readFileSync(path.join(cgal,'include/CGAL/Polygon_mesh_processing/autorefinement.h'),'utf8'),/SPDX-License-Identifier: GPL-3\.0-or-later OR LicenseRef-Commercial/);
const sourceNames=[...fileInventory(path.join(root,'discrete-surface-worker')).map(item=>'discrete-surface-worker/'+item.file),'experiments/discrete-surface/main.cxx','geometry-worker/src/protocol/Json.hxx','geometry-worker/src/protocol/Json.cxx','geometry-worker/src/runtime/NativeResourceGuard.hxx','geometry-worker/src/runtime/NativeResourceGuard.cxx','scripts/build-discrete-surface-worker.mjs','gateway/native-runtime-release.mjs','gateway/frontend-release.mjs'];
sourceNames.push('scripts/discrete-build-inputs.mjs');
sourceNames.push('experiments/volume-domain/main.cxx');
const sources=sourceNames.map(file=>({file,sha256:hashFile(path.join(root,file))}));
// Capture the actual header trees used by this build, not only their archives.
const headers=()=>[...dependencyHeaderInventory(path.join(cgal,'include')).map(item=>({...item,file:'CGAL-6.1.2/include/'+item.file})),...dependencyHeaderInventory(path.join(boost,'boost')).map(item=>({...item,file:'boost_1_88_0/boost/'+item.file})),...['gmp.h','mpfr.h'].map(name=>({file:'ucrt64/include/'+name,bytes:fs.statSync(path.join(mingw,'../include',name)).size,sha256:hashFile(path.join(mingw,'../include',name))}))];
const headerInputs=headers(),headerSha=crypto.createHash('sha256').update(JSON.stringify(headerInputs)).digest('hex');fs.mkdirSync(output,{recursive:true});
const environment={...process.env,PATH:mingw+';C:/msys64/usr/bin;'+process.env.PATH};
async function run(binary,args,name){
  const fd=fs.openSync(path.join(output,name+'.log'),'wx'),child=spawn(binary,args,{cwd:root,env:environment,windowsHide:true,stdio:['ignore',fd,fd]});
  try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,name+' failed; inspect the retained build log.');}finally{fs.closeSync(fd);}
}
const configure=['-S',path.join(root,'discrete-surface-worker'),'-B',build,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_CXX_FLAGS_RELEASE=-O1 -DNDEBUG',`-DCMAKE_CXX_COMPILER=${compiler}`,`-DCMAKE_MAKE_PROGRAM=${ninja}`,`-DCGAL_DIR=${cgal}`,`-DBOOST_ROOT=${boost}`,'-DGMP_INCLUDE_DIR=C:/msys64/ucrt64/include','-DGMP_LIBRARIES=C:/msys64/ucrt64/lib/libgmp.dll.a','-DMPFR_INCLUDE_DIR=C:/msys64/ucrt64/include','-DMPFR_LIBRARIES=C:/msys64/ucrt64/lib/libmpfr.dll.a','-DDISCRETE_BUILD_COMPATIBILITY_HARNESS=ON'];
await run(cmake,configure,'configure');await run(cmake,['--build',build,'--parallel','1'],'compile');
assert.deepEqual(headers(),headerInputs,'Dependency headers changed during compilation.');for(const item of sources)assert.equal(hashFile(path.join(root,item.file)),item.sha256,'Project source changed during compilation.');
const executable=path.join(build,'cad_discrete_surface_worker.exe'),profile=collectNativeRuntimeProfile({roles:{discrete:executable},search:[build,mingw]});
fs.mkdirSync(runtime);for(const entry of profile.entries)copyCertifiedFiles(path.dirname(entry.source),runtime,[entry.proof]);
for(const entry of profile.entries)assert.equal(hashFile(entry.source),entry.proof.sha256,'Runtime source changed during capture.');
fs.writeFileSync(path.join(output,'header-inputs.json'),JSON.stringify(headerInputs,null,2),{flag:'wx'});
const receipt={format:'web-cad-discrete-surface-worker-build',version:1,createdAt:new Date().toISOString(),scope:'formal-worker-core-and-protocol-not-yet-project-task-integration-or-public-distribution',platform:process.platform,arch:process.arch,node:process.version,license:{spdx:'GPL-3.0-or-later',route:'user-selected-open-source',commercialLicenseUsed:false,correspondingSourceQualification:'incomplete-runtime-source-closure',notice:'No separate-process licensing exemption is claimed; project/API/release integration and complete distribution source materials remain gates.'},tools:[cmake,compiler,ninja].map(file=>({file,sha256:hashFile(file)})),archives:archives.map(([file,sha256])=>({file,sha256})),sources,headerInputs:{file:'header-inputs.json',sha256:hashFile(path.join(output,'header-inputs.json')),treeSha256:headerSha,files:headerInputs.length},configureArguments:configure,worker:{file:'runtime/cad_discrete_surface_worker.exe',sha256:hashFile(path.join(runtime,'cad_discrete_surface_worker.exe'))},compatibilityHarness:{file:'build/cad_discrete_surface_research.exe',sha256:hashFile(path.join(build,'cad_discrete_surface_research.exe'))},runtime:{roles:profile.roles,systemImports:profile.systemImports,files:profile.entries.map(entry=>entry.proof)},limits:{inputTriangles:20000,outputTriangles:200000,points:600000,sourceReferences:1000000,requestBytes:8*1024*1024,responseBytes:64*1024*1024},remaining:['Current-project CAD source binding and durable repair-task integration.','Cancellation/timeouts/actual-exit ownership and full runtime/release qualification.','Closed-region reconstruction and actual conformal tetrahedra; surface splitting alone stays tetrahedralReady=false.','Corresponding source and license closure for the actual GMP/MPFR/winpthreads runtime before public distribution.']};
fs.writeFileSync(path.join(output,'build.json'),JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,output,worker:receipt.worker,headers:headerInputs.length,runtimeFiles:profile.entries.length,license:receipt.license.spdx,publicDistributionQualified:false,dailyServicesChanged:false}));
