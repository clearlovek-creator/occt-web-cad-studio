import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const inside=(root,file)=>{const relative=path.relative(root,file);return Boolean(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const fail=message=>Error(`TEST_NATIVE_RUNTIME: ${message}`);
function readProof(file,max=64*1024*1024){
  const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>max)throw fail('Native test input must be a bounded regular file, not a link.');
  const bytes=fs.readFileSync(file),after=fs.lstatSync(file);
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||bytes.length!==after.size)throw fail('Native test input changed while hashing.');
  return {buffer:bytes,proof:{bytes:bytes.length,sha256:hash(bytes)}};
}
const proof=(file,max)=>readProof(file,max).proof;
export function nativeTestSources(workspace){
  const result=[];let total=0;
  function add(file){const item=proof(file,4*1024*1024);total+=item.bytes;if(result.length>=4096||total>64*1024*1024)throw fail('Native project source budget exceeded.');result.push({file:path.relative(workspace,file).replaceAll('\\','/'),...item});}
  function walk(directory){const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('Native source directories cannot be links.');for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){const file=path.join(directory,entry.name);if(entry.isDirectory())walk(file);else add(file);}}
  for(const name of ['geometry-worker','mesh-worker']){add(path.join(workspace,name,'CMakeLists.txt'));walk(path.join(workspace,name,'src'));walk(path.join(workspace,name,'tests'));}
  return result;
}
export function validateTestBuildDirectory(workspace,directory){
  workspace=path.resolve(workspace);directory=path.resolve(directory);
  if(!inside(workspace,directory))throw fail('Test build directories must stay inside the workspace.');
  const relative=path.relative(workspace,directory).replaceAll('\\','/').toLowerCase();
  if(['geometry-worker','mesh-worker'].includes(relative)||['app','gateway','scripts','tests','shared','docs','node_modules'].includes(relative.split('/')[0])||relative.split('/').some(part=>['.data','.git','.codex','.agents','.aws','.releases','.backend-releases','runtime-logs'].includes(part))||['geometry-worker/build','mesh-worker/build-gmsh'].some(name=>relative===name||relative.startsWith(name+'/'))||['geometry-worker/src','geometry-worker/tests','mesh-worker/src','mesh-worker/tests'].some(name=>relative===name||relative.startsWith(name+'/')))throw fail('Do not build tests in live data, release, source or retained default-build directories.');
  // Reject directory junctions as well as file links. No path component may
  // redirect a supposedly private build outside its checked workspace.
  let current=directory;while(current!==workspace){if(fs.existsSync(current)){const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('Test build paths cannot contain links.');}current=path.dirname(current);}
  return directory;
}
function buildInventory(workspace,directory,kind){
  directory=validateTestBuildDirectory(workspace,directory);
  const cacheInput=readProof(path.join(directory,'CMakeCache.txt')),cache=cacheInput.buffer.toString('utf8');
  const setting=name=>cache.match(new RegExp('^'+name+':[^=\\r\\n]*=(.*)$','m'))?.[1].trim();
  if(path.resolve(setting('CMAKE_HOME_DIRECTORY')||'')!==path.join(workspace,kind==='geometry'?'geometry-worker':'mesh-worker'))throw fail('CMake cache belongs to another source project.');
  if(setting('CMAKE_BUILD_TYPE')!=='Release'||setting(kind==='geometry'?'BUILD_TESTING':'MESH_NATIVE_TESTS')!=='ON')throw fail('Release builds with native test targets enabled are required.');
  const required=kind==='geometry'?['occt_geometry_worker.exe','cad_snapshot_source_inspector.exe','cad_data_directory_lock.exe','cad_source_file_swap.exe','mesh_industrial_corpus_tests.exe']:['gmsh_mesh_worker.exe','mesh_quality_statistics_test.exe'];
  const names=fs.readdirSync(directory).filter(name=>name.endsWith('.exe')).sort();if(names.length>128||required.some(name=>!names.includes(name)))throw fail('Required native worker/helper/test executables are missing.');
  return {directory,files:['CMakeCache.txt','CTestTestfile.cmake',...names].map(file=>({file,...(file==='CMakeCache.txt'?cacheInput.proof:proof(path.join(directory,file)))}))};
}
export function captureNativeTestRuntime({workspace,geometryBuild,meshBuild,sourcesBefore}){
  workspace=path.resolve(workspace);const sources=nativeTestSources(workspace);
  assert.deepEqual(sources,sourcesBefore,'Native sources changed during the successful build; do not register a mixed test runtime');
  return {format:'web-cad-native-test-runtime',version:1,workspace,platform:process.platform,arch:process.arch,nodeVersion:process.versions.node,createdAt:new Date().toISOString(),scope:'Successful project-native builds and exact source/output consistency; external compiler, SDK and runtime DLL dependencies are not sealed',sources,builds:{geometry:buildInventory(workspace,geometryBuild,'geometry'),mesh:buildInventory(workspace,meshBuild,'mesh')}};
}
export function validateNativeTestRuntime(manifest,workspace,{environment=process.env}={}){
  workspace=path.resolve(workspace);
  if(manifest?.format!=='web-cad-native-test-runtime'||manifest.version!==1||manifest.workspace!==workspace||manifest.platform!==process.platform||manifest.arch!==process.arch||manifest.nodeVersion!==process.versions.node)throw fail('Missing or incompatible test runtime. Run npm run test:prepare.');
  assert.deepEqual(nativeTestSources(workspace),manifest.sources,'Native sources changed: run npm run test:prepare before testing');
  for(const kind of ['geometry','mesh']){const expected=manifest.builds?.[kind];if(!expected)throw fail('A paired geometry/mesh runtime is required.');assert.deepEqual(buildInventory(workspace,expected.directory,kind),expected,'Native build outputs/configuration changed: run npm run test:prepare');}
  const geometry=path.join(manifest.builds.geometry.directory,'occt_geometry_worker.exe'),mesh=path.join(manifest.builds.mesh.directory,'gmsh_mesh_worker.exe');
  for(const [key,expected] of [['GEOMETRY_WORKER_PATH',geometry],['MESH_WORKER_PATH',mesh]])if(environment[key]&&path.resolve(environment[key])!==expected)throw fail(`${key} conflicts with the registered test pair; do not silently mix runtimes.`);
  return {geometry,mesh,environment:{...environment,GEOMETRY_WORKER_PATH:geometry,MESH_WORKER_PATH:mesh,GEOMETRY_SOURCE_INSPECTOR_PATH:path.join(manifest.builds.geometry.directory,'cad_snapshot_source_inspector.exe'),CAD_NATIVE_LOCK_PATH:path.join(manifest.builds.geometry.directory,'cad_data_directory_lock.exe'),CAD_NATIVE_SWAP_PATH:path.join(manifest.builds.geometry.directory,'cad_source_file_swap.exe')}};
}
export function selectNativeTestRuntime(workspace,selectionFile,options={}){
  selectionFile??=(options.environment??process.env).CAD_TEST_NATIVE_SELECTION||path.join(workspace,'.artifacts/native-test-runtime/selected.json');
  let selection,bytes;
  try{const file=path.resolve(selectionFile);selection=JSON.parse(fs.readFileSync(file,'utf8'));if(selection?.format!=='web-cad-native-test-selection'||selection.version!==1||typeof selection.file!=='string'||!/^runtime-[a-f0-9-]+\.json$/.test(selection.file))throw fail('Invalid native test selection.');bytes=fs.readFileSync(path.join(path.dirname(file),selection.file));if(hash(bytes)!==selection.sha256)throw fail('Native test manifest digest changed.');}
  catch(error){throw fail(`Test runtime selection is unavailable or invalid. Run npm run test:prepare. (${error.code||'invalid selection'})`);}
  const manifest=JSON.parse(bytes.toString('utf8')),runtime=validateNativeTestRuntime(manifest,workspace,options);
  return {...runtime,manifest,manifestSha256:hash(bytes),selectionFile:path.resolve(selectionFile)};
}

export function assertNativeTestRoles(manifest,roles){
  const names={geometry:['geometry','occt_geometry_worker.exe'],mesh:['mesh','gmsh_mesh_worker.exe'],inspector:['geometry','cad_snapshot_source_inspector.exe'],lock:['geometry','cad_data_directory_lock.exe'],swap:['geometry','cad_source_file_swap.exe']};
  for(const [role,[kind,name]] of Object.entries(names)){
    const expected=manifest.builds[kind].files.find(item=>item.file===name);if(!expected||typeof roles?.[role]!=='string')throw fail('Frozen backend is missing a required native role.');
    const actual=proof(roles[role]);assert.deepEqual(actual,{bytes:expected.bytes,sha256:expected.sha256},`Frozen backend ${role} does not match the registered test pair`);
  }
}
