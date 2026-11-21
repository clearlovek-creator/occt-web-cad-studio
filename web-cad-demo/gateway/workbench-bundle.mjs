import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertRegularDirectory,copyCertifiedFiles,fileInventory,hashFile,readSmallJson,atomicJson,selectRelease,validateRelease} from './frontend-release.mjs';
import {selectBackendRelease,validateBackendRelease} from './backend-release.mjs';
import {createNodeRuntime,validateNodeRuntime,verifyNodeRuntimeInputs} from './node-runtime-release.mjs';
import {prepareWorkbenchBuildPaths} from './workbench-build-paths.mjs';

const ID=/^workbench-[0-9]{13}-[a-f0-9-]{36}$/,HASH=/^[a-f0-9]{64}$/;
const CONTROL=['start-web-cad-demo.ps1','launch-background-service.mjs','launch-background-windows.ps1','frontend-release-info.mjs','backend-release-info.mjs','workbench-bundle-info.mjs'];
const SCOPE={qualification:'local-portable-candidate',owned:['frontend-v2','backend-v3','bundled-node','managed-service-control'],external:['windows-system-runtime','user-data-and-configuration','user-agent-resources','dynamic-native-plugins'],thirdPartyLicenseAudit:'incomplete'};
const fail=message=>Object.assign(Error(message),{code:'WORKBENCH_BUNDLE_INVALID'});
const proof=(root,file)=>{const stat=fs.lstatSync(path.join(root,file));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024*1024)throw fail('Workbench control input is invalid.');return {file,bytes:stat.size,sha256:hashFile(path.join(root,file))};};

// Composition has its own aggregate budget. Each component still goes through
// the unchanged 512 MiB / 10000-file inventory and its original validator.
export function workbenchFileInventory(directory,{excludeManifest=false}={}){
  assertRegularDirectory(directory);
  const folders=['app','backend','frontend','node'],rootFiles=['Start-WebCAD.ps1','workbench.json'];
  const entries=fs.readdirSync(directory),files=[];let bytes=0,count=0;
  for(const name of [...folders,'Start-WebCAD.ps1'])if(!entries.includes(name))throw fail('Workbench composition is missing a required root entry.');
  for(const name of entries){
    const stat=fs.lstatSync(path.join(directory,name));
    if(folders.includes(name)){
      if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('Workbench component roots must be ordinary directories.');
    }else if(!rootFiles.includes(name)||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>2*1024*1024){
      throw fail('Workbench root contains an unexpected or invalid entry.');
    }
  }
  const add=(row,include=true)=>{
    bytes+=row.bytes;
    count++;
    if(bytes>1024*1024*1024||count>10000)throw fail('Workbench composition exceeds 1 GiB or 10000 files.');
    if(include)files.push(row);
  };
  for(const row of fileInventory(directory,{exclude:folders}))add(row,!(excludeManifest&&row.file==='workbench.json'));
  for(const folder of folders)for(const row of fileInventory(path.join(directory,folder)))add({...row,file:folder+'/'+row.file});
  return files.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
}
export function createWorkbenchBundle({workspace,frontendRoot,backendRoot,nodeSourceMaterial,outputRoot}){
  const admission=prepareWorkbenchBuildPaths({workspace,frontendRoot,backendRoot,nodeSourceMaterial,outputRoot});
  ({workspace,frontendRoot,backendRoot,nodeSourceMaterial,outputRoot}=admission.paths);
  const frontend=selectRelease(frontendRoot,workspace),backend=selectBackendRelease(backendRoot);
  if(frontend.version!==2||backend.version!==3)throw fail('Portable candidates require standalone frontend V2 and complete backend V3.');
  for(const directory of[frontend.directory,backend.directory,path.join(workspace,'gateway'),path.join(workspace,'scripts'),path.dirname(process.execPath)])admission.observeInputDirectory(directory);
  for(const file of['gateway/workbench-bundle.mjs','gateway/workbench-build-paths.mjs','gateway/node-runtime-release.mjs','gateway/native-runtime-release.mjs'])if(proof(workspace,file).sha256!==hashFile(path.join(backend.directory,'runtime',file)))throw fail('Selected backend does not contain the current bundle runtime.');
  const inputFiles=[...CONTROL.map(file=>'scripts/'+file),'scripts/workbench-bundle-start.ps1'].map(file=>proof(workspace,file));
  const nodeInputs=verifyNodeRuntimeInputs({sourceMaterial:nodeSourceMaterial});
  admission.createOutputRoot();
  const releaseId='workbench-'+Date.now()+'-'+randomUUID(),staging=path.join(outputRoot,'.pending-'+randomUUID()),directory=path.join(outputRoot,releaseId);
  let published=false,stagingCreated=false;
  try{
    admission.recheck();fs.mkdirSync(staging);stagingCreated=true;admission.recheck();
    copyCertifiedFiles(frontend.directory,path.join(staging,'frontend',frontend.releaseId),fileInventory(frontend.directory));
    copyCertifiedFiles(backend.directory,path.join(staging,'backend',backend.releaseId),fileInventory(backend.directory));
    copyCertifiedFiles(path.join(backend.directory,'runtime'),path.join(staging,'app'),backend.files.map(file=>({...file,file:file.file.slice('runtime/'.length)})));
    copyCertifiedFiles(workspace,path.join(staging,'app'),inputFiles.filter(file=>file.file!=='scripts/workbench-bundle-start.ps1'));
    const bootstrap=inputFiles.find(file=>file.file==='scripts/workbench-bundle-start.ps1');
    fs.copyFileSync(path.join(workspace,bootstrap.file),path.join(staging,'Start-WebCAD.ps1'),fs.constants.COPYFILE_EXCL);if(hashFile(path.join(staging,'Start-WebCAD.ps1'))!==bootstrap.sha256)throw fail('Workbench bootstrap changed while copying.');
    const node=createNodeRuntime(path.join(staging,'node'),{sourceMaterial:path.resolve(nodeSourceMaterial)});
    if(node.executable.sha256!==nodeInputs.executableSha256||JSON.stringify(verifyNodeRuntimeInputs({sourceMaterial:nodeSourceMaterial}))!==JSON.stringify(nodeInputs))throw fail('Node inputs differ from their pre-write admission.');
    if(JSON.stringify(inputFiles)!==JSON.stringify(inputFiles.map(file=>proof(workspace,file.file))))throw fail('Workbench control source changed while copying.');
    validateRelease(frontend.directory,workspace);validateBackendRelease(backend.directory);
    const files=workbenchFileInventory(staging),controlFiles=files.filter(file=>file.file==='Start-WebCAD.ps1'||file.file.startsWith('app/'));
    const manifest={format:'web-cad-workbench-bundle',version:1,releaseId,nodeVersion:process.versions.node,platform:'win32',arch:'x64',createdAt:new Date().toISOString(),scope:SCOPE,node,frontend:{releaseId:frontend.releaseId,manifestSha256:hashFile(path.join(frontend.directory,'release.json')),sourceSha256:frontend.sourceSha256},backend:{releaseId:backend.releaseId,manifestSha256:backend.manifestSha256,sourceSha256:backend.sourceSha256},controlFiles,files};
    atomicJson(path.join(staging,'workbench.json'),manifest);
    // Metadata is omitted from the self-inventory, not from resource accounting.
    // Check the complete tree before publishing, including its final manifest.
    workbenchFileInventory(staging,{excludeManifest:true});admission.recheck();fs.renameSync(staging,directory);published=true;return validateWorkbenchBundle(directory);
  }finally{
    if(!published&&stagingCreated&&fs.existsSync(staging))console.error('Retained incomplete bundle candidate: '+staging);
  }
}
export function validateWorkbenchBundle(directory,{onProgress=()=>{}}={}){
  directory=path.resolve(directory);assertRegularDirectory(directory);const manifest=readSmallJson(path.join(directory,'workbench.json'));
  onProgress('manifest-read');
  if(manifest.format!=='web-cad-workbench-bundle'||manifest.version!==1||!ID.test(manifest.releaseId)||path.basename(directory)!==manifest.releaseId||manifest.nodeVersion!==process.versions.node||manifest.platform!=='win32'||manifest.arch!=='x64'||process.platform!=='win32'||process.arch!=='x64'||JSON.stringify(manifest.scope)!==JSON.stringify(SCOPE)||!Array.isArray(manifest.files)||!Array.isArray(manifest.controlFiles))throw fail('Workbench bundle identity or scope is invalid.');
  const files=workbenchFileInventory(directory,{excludeManifest:true});if(JSON.stringify(files)!==JSON.stringify(manifest.files))throw fail('Workbench bundle files are missing, extra or changed.');
  onProgress('inventory-verified');
  const control=files.filter(file=>file.file==='Start-WebCAD.ps1'||file.file.startsWith('app/'));if(control.length<10||control.length>300||JSON.stringify(control)!==JSON.stringify(manifest.controlFiles))throw fail('Workbench control closure differs.');
  const node=validateNodeRuntime(path.join(directory,'node'),manifest.node);
  onProgress('node-verified');
  for(const[kind,pattern]of[['frontend',/^frontend-[0-9]{13}-[a-f0-9-]{36}$/],['backend',/^backend-[0-9]{13}-[a-f0-9-]{36}$/]])if(!pattern.test(manifest[kind]?.releaseId)||!HASH.test(manifest[kind]?.manifestSha256)||!HASH.test(manifest[kind]?.sourceSha256))throw fail('Workbench release pair binding is invalid.');
  const frontDir=path.join(directory,'frontend',manifest.frontend.releaseId),backDir=path.join(directory,'backend',manifest.backend.releaseId);
  if(hashFile(path.join(frontDir,'release.json'))!==manifest.frontend.manifestSha256||hashFile(path.join(backDir,'release.json'))!==manifest.backend.manifestSha256)throw fail('Workbench release pair manifest differs.');
  const frontend=validateRelease(frontDir);onProgress('frontend-verified');
  const backend=validateBackendRelease(backDir);onProgress('backend-verified');
  if(frontend.version!==2||backend.version!==3||frontend.sourceSha256!==manifest.frontend.sourceSha256||backend.sourceSha256!==manifest.backend.sourceSha256)throw fail('Workbench release pair source differs.');
  return {...manifest,directory,manifestSha256:hashFile(path.join(directory,'workbench.json')),nodeExecutable:node.executable,frontendDirectory:frontDir,backendDirectory:backDir};
}
