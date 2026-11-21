/* Real sealed components, invalid late inputs, no build-output writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWorkbenchBundle} from '../gateway/workbench-bundle.mjs';
import {selectRelease,validateRelease,fileInventory,copyCertifiedFiles,hashFile,atomicJson} from '../gateway/frontend-release.mjs';
import {selectBackendRelease,validateBackendRelease} from '../gateway/backend-release.mjs';
const workspace=path.resolve(import.meta.dirname,'..'),frontendRoot=path.resolve(process.env.LOFT_UI_RELEASE_ROOT||'.artifacts/frontend-standalone-releases'),backendRoot=path.resolve(process.env.CAD_TEST_BACKEND_RELEASE_ROOT||'.artifacts/bundle-path-guards-backend-releases'),nodeSourceMaterial=path.resolve(process.env.CAD_TEST_NODE_SOURCE_MATERIAL||'.artifacts/workbench-bundle-node-source');
const frontend=selectRelease(frontendRoot,workspace),backend=selectBackendRelease(backendRoot),sourceBefore=fileInventory(nodeSourceMaterial),frontManifest=hashFile(path.join(frontend.directory,'release.json')),backManifest=backend.manifestSha256;
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cad-bundle-build-guards-')),artifacts=path.resolve(process.env.BUNDLE_BUILD_GUARD_ARTIFACTS||'.artifacts/bundle-path-guards-api');fs.mkdirSync(artifacts,{recursive:true});
const checks=[],base={workspace,frontendRoot,backendRoot,nodeSourceMaterial};let verified=false;
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
function noWrites(options,pattern){
  const mkdir=fs.mkdirSync,attempts=[];
  fs.mkdirSync=(directory)=>{attempts.push(directory);throw Error('Unexpected mkdir before input admission.');};
  try{assert.throws(()=>createWorkbenchBundle(options),pattern);}finally{fs.mkdirSync=mkdir;}
  assert.deepEqual(attempts,[]);assert.equal(fs.existsSync(options.outputRoot),false);
}
function material(name){const directory=path.join(scratch,name);copyCertifiedFiles(nodeSourceMaterial,directory,sourceBefore);return directory;}
async function cli(args){
  const child=spawn(process.execPath,[path.join(workspace,'scripts/build-workbench-bundle.mjs'),...args],{cwd:workspace,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',diagnostic='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>diagnostic=(diagnostic+bytes).slice(-16384));const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});return {code,output,diagnostic};
}
try{
  const badHash=material('bad-node-hash'),descriptorFile=path.join(badHash,'source.json'),descriptor=JSON.parse(fs.readFileSync(descriptorFile,'utf8')),checksums=Buffer.from('0'.repeat(64)+'  win-x64/node.exe\n');fs.writeFileSync(path.join(badHash,'SHASUMS256.txt'),checksums);atomicJson(descriptorFile,{...descriptor,executableSha256:'0'.repeat(64),checksumsSha256:createHash('sha256').update(checksums).digest('hex')});
  await check('a self-consistent but wrong published Node checksum is refused before any output mkdir or component copy',()=>{const before=fileInventory(badHash);noWrites({...base,nodeSourceMaterial:badHash,outputRoot:path.join(scratch,'outputs','bad-node')},/Node executable does not match/);assert.deepEqual(fileInventory(badHash),before);assert.equal(fs.existsSync(path.join(scratch,'outputs')),false);});
  const badJson=material('bad-node-json');fs.writeFileSync(path.join(badJson,'source.json'),'not JSON');
  await check('malformed Node material is rejected without repairing inputs or creating output parents',()=>{const before=fileInventory(badJson);noWrites({...base,nodeSourceMaterial:badJson,outputRoot:path.join(scratch,'outputs','bad-json')},/发布清单损坏/);assert.deepEqual(fileInventory(badJson),before);});
  const clone=path.join(scratch,'source-control-copy');
  const gatewayFiles=['workbench-bundle.mjs','workbench-build-paths.mjs','node-runtime-release.mjs','native-runtime-release.mjs'];
  for(const name of gatewayFiles){const file='gateway/'+name;copyCertifiedFiles(workspace,clone,[{file,bytes:fs.statSync(path.join(workspace,file)).size,sha256:hashFile(path.join(workspace,file))}]);}
  const controls=['start-web-cad-demo.ps1','launch-background-service.mjs','launch-background-windows.ps1','frontend-release-info.mjs','backend-release-info.mjs','workbench-bundle-info.mjs','workbench-bundle-start.ps1'];
  for(const name of controls){const file='scripts/'+name;copyCertifiedFiles(workspace,clone,[{file,bytes:fs.statSync(path.join(workspace,file)).size,sha256:hashFile(path.join(workspace,file))}]);}
  await check('a missing late control script is refused before output admission',()=>{const file=path.join(clone,'scripts/workbench-bundle-start.ps1'),bytes=fs.readFileSync(file);fs.unlinkSync(file);try{noWrites({...base,workspace:clone,outputRoot:path.join(scratch,'outputs','missing-control')},/ENOENT/);}finally{fs.writeFileSync(file,bytes);}});
  await check('a hard-linked control script is not certified and no output material is created',()=>{const target=path.join(clone,'scripts/backend-release-info.mjs'),alias=path.join(scratch,'shared-control.mjs');fs.linkSync(target,alias);try{noWrites({...base,workspace:clone,outputRoot:path.join(scratch,'outputs','linked-control')},/control input is invalid/);}finally{fs.unlinkSync(alias);}});
  await check('a linked control-script parent is refused before copying or output creation',()=>{
    const parent=path.join(clone,'scripts'),aside=path.join(clone,'scripts-original');assert.equal(path.dirname(parent),clone);assert.equal(path.dirname(aside),clone);fs.renameSync(parent,aside);fs.symlinkSync(aside,parent,'junction');try{noWrites({...base,workspace:clone,outputRoot:path.join(scratch,'outputs','linked-parent')},/links, junctions/);}finally{fs.unlinkSync(parent);fs.renameSync(aside,parent);}
  });
  await check('the real CLI rejects unknown options before it can create a requested output',async()=>{const outputRoot=path.join(scratch,'cli-output','unknown'),result=await cli(['--frontend-root',frontendRoot,'--backend-root',backendRoot,'--node-material',nodeSourceMaterial,'--output-root',outputRoot,'--unexpected','value']);assert.equal(result.code,1);assert.match(result.diagnostic,/Exactly one value/);assert.equal(fs.existsSync(path.join(scratch,'cli-output')),false);});
  await check('the real CLI preserves the same no-output guarantee for a late Node checksum failure',async()=>{const outputRoot=path.join(scratch,'cli-output','bad-node'),result=await cli(['--frontend-root',frontendRoot,'--backend-root',backendRoot,'--node-material',badHash,'--output-root',outputRoot]);assert.equal(result.code,1);assert.match(result.diagnostic,/Node executable does not match/);assert.equal(fs.existsSync(path.join(scratch,'cli-output')),false);});
  validateRelease(frontend.directory,workspace);validateBackendRelease(backend.directory);assert.equal(hashFile(path.join(frontend.directory,'release.json')),frontManifest);assert.equal(hashFile(path.join(backend.directory,'release.json')),backManifest);assert.deepEqual(fileInventory(nodeSourceMaterial),sourceBefore);verified=true;
  const result={ok:true,passed:checks.length,checks,frontend:frontend.releaseId,backend:backend.releaseId,sourceManifestsUnchanged:true,nodeSourceFilesUnchanged:true,paidProviderCalls:0,scope:'Actual V2/V3 components and current builder; all invalid-input cases run before output mkdir. Temporary fixtures only; no complete bundle built in this verifier.'};fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
}finally{
  if(verified){assert.equal(path.dirname(scratch),path.resolve(os.tmpdir()));assert.match(path.basename(scratch),/^cad-bundle-build-guards-/);fs.rmSync(scratch,{recursive:true,force:true});}else console.error('Retained builder input diagnostics: '+scratch);
}
