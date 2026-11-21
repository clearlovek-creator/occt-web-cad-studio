import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {assertRegularDirectory,copyCertifiedFiles,fileInventory,hashFile,readSmallJson,atomicJson} from './frontend-release.mjs';
import {peImports,isSystemImport} from './native-runtime-release.mjs';

const HASH=/^[a-f0-9]{64}$/,VERSION=/^[0-9]+\.[0-9]+\.[0-9]+$/,MAX_IMAGE=128*1024*1024;
const fail=message=>Object.assign(Error(message),{code:'NODE_RUNTIME_INVALID'});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function nodeSourceUrls(version){
  if(!VERSION.test(version))throw fail('Node version is invalid.');
  return {checksums:`https://nodejs.org/dist/v${version}/SHASUMS256.txt`,license:`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`};
}
function ordinaryBytes(file,limit){
  const before=fs.lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>BigInt(limit))throw fail('Node runtime material must be a bounded ordinary single-link file.');
  const bytes=fs.readFileSync(file),after=fs.lstatSync(file,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key])||BigInt(bytes.length)!==before.size)throw fail('Node runtime material changed while reading.');return bytes;
}
export function readNodeSourceMaterial(directory,version){
  directory=path.resolve(directory);assertRegularDirectory(directory);const descriptor=readSmallJson(path.join(directory,'source.json'),16384),urls=nodeSourceUrls(version);
  if(descriptor.format!=='web-cad-node-source-material'||descriptor.version!==1||descriptor.nodeVersion!==version||descriptor.platform!=='win32'||descriptor.arch!=='x64'||JSON.stringify(descriptor.urls)!==JSON.stringify(urls)||!HASH.test(descriptor.executableSha256))throw fail('Node source material identity is invalid.');
  const checksums=ordinaryBytes(path.join(directory,'SHASUMS256.txt'),1024*1024),license=ordinaryBytes(path.join(directory,'LICENSE'),1024*1024);
  if(sha(checksums)!==descriptor.checksumsSha256||sha(license)!==descriptor.licenseSha256||!license.toString('utf8').startsWith('Node.js is licensed for use as follows:'))throw fail('Node source checksum or license material is inconsistent.');
  const matches=checksums.toString('ascii').split(/\r?\n/).map(line=>/^([a-f0-9]{64})\s+win-x64\/node\.exe$/.exec(line)).filter(Boolean);
  if(matches.length!==1||matches[0][1]!==descriptor.executableSha256)throw fail('Node published executable checksum is missing, duplicate or inconsistent.');
  const files=fileInventory(directory);if(files.length!==3||files.some(file=>!['source.json','SHASUMS256.txt','LICENSE'].includes(file.file)))throw fail('Node source material contains unexpected files.');
  return {descriptor,files};
}
function certifiedNodeInputs({executable=process.execPath,sourceMaterial}={}){
  if(process.platform!=='win32'||process.arch!=='x64'||!sourceMaterial)throw fail('Bundled Node requires explicit Windows x64 source material.');
  const source=readNodeSourceMaterial(sourceMaterial,process.versions.node),bytes=ordinaryBytes(executable,MAX_IMAGE),executableSha256=sha(bytes);
  if(executableSha256!==source.descriptor.executableSha256)throw fail('Node executable does not match its acquired published checksum.');
  const imports=peImports(bytes,{imageBytes:MAX_IMAGE});if(imports.some(name=>!isSystemImport(name)))throw fail('Node has an unbundled non-system DLL import.');
  return {source,bytes,executableSha256,imports};
}
export function createNodeRuntime(directory,{executable=process.execPath,sourceMaterial}={}){
  directory=path.resolve(directory);if(fs.existsSync(directory))throw fail('Node runtime output already exists; it was not overwritten.');
  const {source,bytes,executableSha256,imports}=certifiedNodeInputs({executable,sourceMaterial});
  fs.mkdirSync(directory,{recursive:true});
  try{
    // Write the exact bytes that were hashed and parsed, never reopen the source
    // for a second potentially different copy.
    fs.writeFileSync(path.join(directory,'node.exe'),bytes,{flag:'wx'});copyCertifiedFiles(path.resolve(sourceMaterial),path.join(directory,'provenance'),source.files);
    if(JSON.stringify(readNodeSourceMaterial(sourceMaterial,process.versions.node))!==JSON.stringify(source)||hashFile(executable)!==executableSha256)throw fail('Node source inputs changed while sealing.');
    const descriptor={format:'web-cad-node-runtime',version:1,nodeVersion:process.versions.node,platform:'win32',arch:'x64',entry:'node.exe',source:source.descriptor,systemImports:imports,files:fileInventory(directory)};
    atomicJson(path.join(directory,'node-runtime.json'),descriptor);
    return {format:'web-cad-node-binding',version:1,nodeVersion:descriptor.nodeVersion,executable:{bytes:bytes.length,sha256:executableSha256},manifest:{bytes:fs.statSync(path.join(directory,'node-runtime.json')).size,sha256:hashFile(path.join(directory,'node-runtime.json'))}};
  }catch(error){throw Object.assign(error,{retainedNodeOutput:directory});}
}
export function verifyNodeRuntimeInputs({executable=process.execPath,sourceMaterial}={}){
  const {source,executableSha256,imports}=certifiedNodeInputs({executable,sourceMaterial});
  return {nodeVersion:process.versions.node,executableSha256,systemImports:imports,sourceFiles:source.files};
}
export function validateNodeRuntime(directory,binding){
  directory=path.resolve(directory);assertRegularDirectory(directory);
  if(binding?.format!=='web-cad-node-binding'||binding.version!==1||binding.nodeVersion!==process.versions.node||!Number.isSafeInteger(binding.executable?.bytes)||binding.executable.bytes<256||binding.executable.bytes>MAX_IMAGE||!HASH.test(binding.executable.sha256)||!Number.isSafeInteger(binding.manifest?.bytes)||binding.manifest.bytes<1||binding.manifest.bytes>16384||!HASH.test(binding.manifest.sha256))throw fail('Bundled Node binding is invalid or runtime version differs.');
  const manifestBytes=ordinaryBytes(path.join(directory,'node-runtime.json'),16384);if(manifestBytes.length!==binding.manifest.bytes||sha(manifestBytes)!==binding.manifest.sha256)throw fail('Bundled Node manifest changed.');
  const descriptor=JSON.parse(manifestBytes);
  if(descriptor.format!=='web-cad-node-runtime'||descriptor.version!==1||descriptor.nodeVersion!==binding.nodeVersion||descriptor.platform!=='win32'||descriptor.arch!=='x64'||descriptor.entry!=='node.exe'||!Array.isArray(descriptor.files))throw fail('Bundled Node descriptor is invalid.');
  if(JSON.stringify(fileInventory(directory,{exclude:['node-runtime.json']}))!==JSON.stringify(descriptor.files))throw fail('Bundled Node files are missing, additional or changed.');
  const source=readNodeSourceMaterial(path.join(directory,'provenance'),binding.nodeVersion);if(JSON.stringify(source.descriptor)!==JSON.stringify(descriptor.source)||source.descriptor.executableSha256!==binding.executable.sha256)throw fail('Bundled Node provenance differs.');
  const executable=path.join(directory,'node.exe'),bytes=ordinaryBytes(executable,MAX_IMAGE);
  if(bytes.length!==binding.executable.bytes||sha(bytes)!==binding.executable.sha256)throw fail('Bundled Node executable differs.');
  const imports=peImports(bytes,{imageBytes:MAX_IMAGE});if(imports.some(name=>!isSystemImport(name))||JSON.stringify(imports)!==JSON.stringify(descriptor.systemImports))throw fail('Bundled Node system dependency declaration differs.');
  return {executable,nodeVersion:binding.nodeVersion,systemImports:imports,manifestSha256:binding.manifest.sha256};
}
