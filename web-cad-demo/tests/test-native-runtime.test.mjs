import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {nativeTestSources,validateTestBuildDirectory,captureNativeTestRuntime,validateNativeTestRuntime,selectNativeTestRuntime,assertNativeTestRoles} from '../scripts/test-native-runtime.mjs';
function fixture(t){
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'cad-test-runtime-中文-'));t.after(()=>{assert.equal(path.dirname(workspace),path.resolve(os.tmpdir()));assert.ok(path.basename(workspace).startsWith('cad-test-runtime-'));fs.rmSync(workspace,{recursive:true,force:true});});
  for(const name of ['geometry-worker','mesh-worker']){const root=path.join(workspace,name);fs.mkdirSync(path.join(root,'src'),{recursive:true});fs.mkdirSync(path.join(root,'tests'));fs.writeFileSync(path.join(root,'CMakeLists.txt'),'project(test)');fs.writeFileSync(path.join(root,'src/main.cxx'),'int main() {}');fs.writeFileSync(path.join(root,'tests/example.cxx'),'test');}
  const geometryBuild=path.join(workspace,'.artifacts/build geometry'),meshBuild=path.join(workspace,'.artifacts/build mesh');
  for(const [kind,directory,names] of [['geometry',geometryBuild,['occt_geometry_worker.exe','cad_snapshot_source_inspector.exe','cad_data_directory_lock.exe','cad_source_file_swap.exe','mesh_industrial_corpus_tests.exe']],['mesh',meshBuild,['gmsh_mesh_worker.exe','mesh_quality_statistics_test.exe']]]){
    fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'CMakeCache.txt'),`CMAKE_HOME_DIRECTORY:INTERNAL=${path.join(workspace,kind==='geometry'?'geometry-worker':'mesh-worker')}\nCMAKE_BUILD_TYPE:STRING=Release\n${kind==='geometry'?'BUILD_TESTING':'MESH_NATIVE_TESTS'}:BOOL=ON\n`);fs.writeFileSync(path.join(directory,'CTestTestfile.cmake'),'test');for(const name of names)fs.writeFileSync(path.join(directory,name),'synthetic consistency fixture '+name);
  }
  const options={workspace,geometryBuild,meshBuild,sourcesBefore:nativeTestSources(workspace)},manifest=captureNativeTestRuntime(options);
  return {workspace,geometryBuild,meshBuild,manifest,options};
}
test('a test runtime records the exact paired workers, helpers, test executables and native source inputs',t=>{
  const f=fixture(t),runtime=validateNativeTestRuntime(f.manifest,f.workspace,{environment:{TEST_ONLY:'retained'}});
  assert.equal(runtime.geometry,path.join(f.geometryBuild,'occt_geometry_worker.exe'));assert.equal(runtime.mesh,path.join(f.meshBuild,'gmsh_mesh_worker.exe'));
  assert.equal(runtime.environment.TEST_ONLY,'retained');assert.equal(runtime.environment.GEOMETRY_SOURCE_INSPECTOR_PATH,path.join(f.geometryBuild,'cad_snapshot_source_inspector.exe'));
  assert.equal(f.manifest.sources.length,6);assert.ok(f.manifest.scope.includes('not sealed'));
});
test('changed or newly added native source invalidates the selected pair before tests run',t=>{
  const f=fixture(t),source=path.join(f.workspace,'geometry-worker/src/main.cxx');fs.writeFileSync(source,'changed');
  assert.throws(()=>validateNativeTestRuntime(f.manifest,f.workspace,{environment:{}}),/Native sources changed/);
  assert.throws(()=>captureNativeTestRuntime(f.options),/Native sources changed during/);
  fs.writeFileSync(source,'int main() {}');fs.writeFileSync(path.join(f.workspace,'mesh-worker/src/new.hxx'),'new input');assert.throws(()=>validateNativeTestRuntime(f.manifest,f.workspace,{environment:{}}),/Native sources changed/);
});
test('changed executable and missing helper invalidate test preparation',t=>{
  const f=fixture(t),exe=path.join(f.meshBuild,'gmsh_mesh_worker.exe'),bytes=fs.readFileSync(exe);fs.writeFileSync(exe,'changed binary');assert.throws(()=>validateNativeTestRuntime(f.manifest,f.workspace,{environment:{}}),/outputs\/configuration changed/);fs.writeFileSync(exe,bytes);
  fs.unlinkSync(path.join(f.geometryBuild,'cad_source_file_swap.exe'));assert.throws(()=>validateNativeTestRuntime(f.manifest,f.workspace,{environment:{}}),/executables are missing/);
});
test('unrelated CMake projects and disabled test targets cannot be registered as a matching runtime',t=>{
  const f=fixture(t),cache=path.join(f.geometryBuild,'CMakeCache.txt'),original=fs.readFileSync(cache,'utf8');
  fs.writeFileSync(cache,original.replace('BUILD_TESTING:BOOL=ON','BUILD_TESTING:BOOL=OFF'));assert.throws(()=>captureNativeTestRuntime(f.options),/native test targets/);
  fs.writeFileSync(cache,original.replace(f.workspace,path.join(f.workspace,'unrelated')));assert.throws(()=>captureNativeTestRuntime(f.options),/another source project/);
});
test('explicit worker overrides must match the registered test pair, rather than silently mixing old and new kernels',t=>{
  const f=fixture(t);assert.throws(()=>validateNativeTestRuntime(f.manifest,f.workspace,{environment:{GEOMETRY_WORKER_PATH:path.join(f.workspace,'old.exe')}}),/conflicts with the registered test pair/);
  assert.throws(()=>validateNativeTestRuntime(f.manifest,f.workspace,{environment:{MESH_WORKER_PATH:path.join(f.workspace,'old-mesh.exe')}}),/conflicts with the registered test pair/);
  assert.doesNotThrow(()=>validateNativeTestRuntime(f.manifest,f.workspace,{environment:{GEOMETRY_WORKER_PATH:path.join(f.geometryBuild,'occt_geometry_worker.exe'),MESH_WORKER_PATH:path.join(f.meshBuild,'gmsh_mesh_worker.exe')}}));
});
test('native test preparation cannot overwrite live data, production releases, sources or retained default builds',t=>{
  const f=fixture(t);for(const name of ['.data/build','.releases/new','.backend-releases/new','runtime-logs/test','geometry-worker/build','mesh-worker/build-gmsh','geometry-worker/src/build','geometry-worker','mesh-worker','node_modules/build','.codex/build','scripts/build'])assert.throws(()=>validateTestBuildDirectory(f.workspace,path.join(f.workspace,name)),/Do not build tests/);
  assert.throws(()=>validateTestBuildDirectory(f.workspace,path.join(f.workspace,'../outside')),/inside the workspace/);
});
test('native test preparation rejects linked sources and junction build directories',t=>{
  const f=fixture(t),source=path.join(f.workspace,'mesh-worker/src/main.cxx');fs.linkSync(source,path.join(f.workspace,'mesh-worker/src/hardlink.cxx'));assert.throws(()=>nativeTestSources(f.workspace),/not a link/);fs.unlinkSync(path.join(f.workspace,'mesh-worker/src/hardlink.cxx'));
  const linked=path.join(f.workspace,'junction');fs.symlinkSync(f.geometryBuild,linked,process.platform==='win32'?'junction':'dir');assert.throws(()=>validateTestBuildDirectory(f.workspace,linked),/cannot contain links/);
});
test('test runtime selection requires a valid digest and cannot be transplanted to another workspace or Node version',t=>{
  const f=fixture(t),area=path.join(f.workspace,'.artifacts/native-test-runtime');fs.mkdirSync(area,{recursive:true});const bytes=Buffer.from(JSON.stringify(f.manifest)),file='runtime-abc-123.json';fs.writeFileSync(path.join(area,file),bytes);const pointer=path.join(area,'selected.json'),selection={format:'web-cad-native-test-selection',version:1,file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};fs.writeFileSync(pointer,JSON.stringify(selection));
  assert.equal(selectNativeTestRuntime(f.workspace,pointer,{environment:{}}).manifestSha256,selection.sha256);
  fs.appendFileSync(path.join(area,file),' ');assert.throws(()=>selectNativeTestRuntime(f.workspace,pointer,{environment:{}}),/selection is unavailable or invalid/);
  assert.throws(()=>validateNativeTestRuntime({...f.manifest,nodeVersion:'0.0.0'},f.workspace),/incompatible/);
  assert.throws(()=>validateNativeTestRuntime(f.manifest,path.join(f.workspace,'other')),/incompatible/);
});

test('isolated test selection propagates to child fixtures without changing the global pointer',t=>{
  const f=fixture(t),area=path.join(f.workspace,'.artifacts/private-pair');fs.mkdirSync(area,{recursive:true});
  const bytes=Buffer.from(JSON.stringify(f.manifest)),file='runtime-deadbeef-123.json',pointer=path.join(area,'selected.json');
  fs.writeFileSync(path.join(area,file),bytes);
  fs.writeFileSync(pointer,JSON.stringify({format:'web-cad-native-test-selection',version:1,file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));
  const environment={CAD_TEST_NATIVE_SELECTION:pointer};
  assert.equal(selectNativeTestRuntime(f.workspace,undefined,{environment}).selectionFile,pointer);
  assert.equal(fs.existsSync(path.join(f.workspace,'.artifacts/native-test-runtime/selected.json')),false);
  assert.throws(()=>selectNativeTestRuntime(f.workspace,path.join(area,'missing.json'),{environment}),/selection is unavailable or invalid/);
  const moduleUrl=new URL('../scripts/test-native-runtime.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {selectNativeTestRuntime} from ${JSON.stringify(moduleUrl)};process.stdout.write(selectNativeTestRuntime(${JSON.stringify(f.workspace)}).selectionFile);`],{env:{...process.env,...environment,GEOMETRY_WORKER_PATH:path.join(f.geometryBuild,'occt_geometry_worker.exe'),MESH_WORKER_PATH:path.join(f.meshBuild,'gmsh_mesh_worker.exe')},windowsHide:true,encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,pointer);
});

test('CMake parsing and hashing use the same observed bytes and reject a concurrent configuration replacement',t=>{
  const f=fixture(t),cache=path.join(f.geometryBuild,'CMakeCache.txt'),read=fs.readFileSync;
  let changed=false;
  t.mock.method(fs,'readFileSync',(file,...args)=>{const value=read(file,...args);if(file===cache&&!changed){changed=true;fs.writeFileSync(cache,Buffer.from(value).toString('utf8').replace('BUILD_TESTING:BOOL=ON','BUILD_TESTING:BOOL=OFF'));}return value;});
  assert.throws(()=>captureNativeTestRuntime(f.options),/changed while hashing/);assert.equal(changed,true);
});

function rolesFor(f){return {geometry:path.join(f.geometryBuild,'occt_geometry_worker.exe'),mesh:path.join(f.meshBuild,'gmsh_mesh_worker.exe'),inspector:path.join(f.geometryBuild,'cad_snapshot_source_inspector.exe'),lock:path.join(f.geometryBuild,'cad_data_directory_lock.exe'),swap:path.join(f.geometryBuild,'cad_source_file_swap.exe')};}
test('explicit frozen browser backends must use byte-identical programs for all five native roles',t=>{
  const f=fixture(t),roles=rolesFor(f),copy=path.join(f.workspace,'.artifacts/frozen');fs.mkdirSync(copy);
  for(const [role,file] of Object.entries(roles)){const target=path.join(copy,path.basename(file));fs.copyFileSync(file,target);roles[role]=target;}
  assert.doesNotThrow(()=>assertNativeTestRoles(f.manifest,roles));
  for(const role of Object.keys(roles)){const file=roles[role],bytes=fs.readFileSync(file);fs.appendFileSync(file,'old runtime');assert.throws(()=>assertNativeTestRoles(f.manifest,roles),/does not match the registered test pair/);fs.writeFileSync(file,bytes);}
});
test('a frozen backend cannot omit helper roles while only matching the two worker programs',t=>{
  const f=fixture(t),roles=rolesFor(f);delete roles.inspector;assert.throws(()=>assertNativeTestRoles(f.manifest,roles),/missing a required native role/);
});
