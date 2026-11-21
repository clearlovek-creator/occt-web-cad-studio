import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createNodeRuntime,validateNodeRuntime,nodeSourceUrls,readNodeSourceMaterial,verifyNodeRuntimeInputs} from '../gateway/node-runtime-release.mjs';
import {peImports} from '../gateway/native-runtime-release.mjs';
import {hashFile,atomicJson} from '../gateway/frontend-release.mjs';

function image(importName='KERNEL32.dll'){
  const bytes=Buffer.alloc(4096),pe=0x80,opt=pe+24;bytes.writeUInt16LE(0x5a4d);bytes.writeUInt32LE(pe,0x3c);bytes.writeUInt32LE(0x4550,pe);bytes.writeUInt16LE(0x8664,pe+4);bytes.writeUInt16LE(1,pe+6);bytes.writeUInt16LE(240,pe+20);bytes.writeUInt16LE(0x20b,opt);bytes.writeUInt32LE(0x200,opt+60);bytes.writeUInt32LE(16,opt+108);const section=opt+240;bytes.writeUInt32LE(0x1000,section+12);bytes.writeUInt32LE(0xe00,section+16);bytes.writeUInt32LE(0x200,section+20);bytes.writeUInt32LE(0x1000,opt+120);bytes.writeUInt32LE(40,opt+124);bytes.writeUInt32LE(0x1400,0x20c);bytes.write(importName+'\0',0x600,'ascii');return bytes;
}
function fixture(t,imports){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-node-runtime-')),source=path.join(root,'source'),executable=path.join(root,'source-node.exe'),output=path.join(root,'封存 Node');fs.mkdirSync(source);fs.writeFileSync(executable,image(imports));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const checksums=Buffer.from(hashFile(executable)+'  win-x64/node.exe\n'),license=Buffer.from('Node.js is licensed for use as follows:\nTest fixture, not a redistributable license.');fs.writeFileSync(path.join(source,'SHASUMS256.txt'),checksums);fs.writeFileSync(path.join(source,'LICENSE'),license);
  const descriptor={format:'web-cad-node-source-material',version:1,nodeVersion:process.versions.node,platform:'win32',arch:'x64',urls:nodeSourceUrls(process.versions.node),executableSha256:hashFile(executable),checksumsSha256:crypto.createHash('sha256').update(checksums).digest('hex'),licenseSha256:crypto.createHash('sha256').update(license).digest('hex')};atomicJson(path.join(source,'source.json'),descriptor);return {root,source,executable,output,descriptor};
}
test('Node material URLs bind to the exact version and reject escaping or non-version identities',()=>{assert.match(nodeSourceUrls('24.14.0').checksums,/\/v24\.14\.0\/SHASUMS256\.txt$/);for(const version of['../latest','v24.14.0','24.14','24.14.0?x','24.14.0\n'])assert.throws(()=>nodeSourceUrls(version));});
test('Node runtime seals parsed exact bytes, full license and source material without source paths',t=>{
  const f=fixture(t),binding=createNodeRuntime(f.output,{executable:f.executable,sourceMaterial:f.source}),runtime=validateNodeRuntime(f.output,binding);assert.equal(runtime.executable,path.join(f.output,'node.exe'));assert.deepEqual(runtime.systemImports,['kernel32.dll']);assert.equal(fs.readFileSync(runtime.executable).equals(image()),true);assert.equal(JSON.stringify(binding).includes(f.root),false);assert.equal(fs.existsSync(path.join(f.output,'provenance/LICENSE')),true);
  fs.writeFileSync(f.executable,'source later changes');assert.equal(validateNodeRuntime(f.output,binding).nodeVersion,process.versions.node);assert.throws(()=>createNodeRuntime(f.output,{sourceMaterial:f.source}),/already exists/);
});
test('Node source refuses mismatch, unexpected files, wrong version and modified license before output creation',t=>{
  const f=fixture(t);fs.appendFileSync(path.join(f.source,'LICENSE'),'changed');assert.throws(()=>createNodeRuntime(f.output,{executable:f.executable,sourceMaterial:f.source}),/license material/);assert.equal(fs.existsSync(f.output),false);
  fs.writeFileSync(path.join(f.source,'LICENSE'),'Node.js is licensed for use as follows:\nTest fixture, not a redistributable license.');fs.writeFileSync(path.join(f.source,'extra'),'unexpected');assert.throws(()=>readNodeSourceMaterial(f.source,process.versions.node),/unexpected/);fs.rmSync(path.join(f.source,'extra'));assert.throws(()=>readNodeSourceMaterial(f.source,'0.0.0'),/identity/);
  fs.appendFileSync(f.executable,'modified');assert.throws(()=>createNodeRuntime(f.output,{executable:f.executable,sourceMaterial:f.source}),/published checksum/);assert.equal(fs.existsSync(f.output),false);
});
test('Node source rejects duplicate published executable rows and unaudited license identity',t=>{
  const f=fixture(t),checksums=path.join(f.source,'SHASUMS256.txt');fs.appendFileSync(checksums,fs.readFileSync(checksums));atomicJson(path.join(f.source,'source.json'),{...f.descriptor,checksumsSha256:hashFile(checksums)});assert.throws(()=>readNodeSourceMaterial(f.source,process.versions.node),/duplicate/);
  fs.writeFileSync(checksums,f.descriptor.executableSha256+'  win-x64/node.exe\n');fs.writeFileSync(path.join(f.source,'LICENSE'),'wrong license');atomicJson(path.join(f.source,'source.json'),{...f.descriptor,licenseSha256:hashFile(path.join(f.source,'LICENSE'))});assert.throws(()=>readNodeSourceMaterial(f.source,process.versions.node),/license material/);
});
test('Node static dependency audit rejects unknown non-system DLLs instead of inheriting development PATH',t=>{const f=fixture(t,'custom-runtime.dll');assert.throws(()=>createNodeRuntime(f.output,{executable:f.executable,sourceMaterial:f.source}),/non-system DLL/);assert.equal(fs.existsSync(f.output),false);});
test('Node source rejects shared hardlinks and directory links',t=>{
  const f=fixture(t),hard=path.join(f.root,'shared.exe');fs.linkSync(f.executable,hard);assert.throws(()=>createNodeRuntime(f.output,{executable:f.executable,sourceMaterial:f.source}),/single-link/);fs.rmSync(hard);
  const alias=path.join(f.root,'alias');fs.symlinkSync(f.source,alias,process.platform==='win32'?'junction':'dir');assert.throws(()=>readNodeSourceMaterial(alias,process.versions.node),/目录类型无效/);
});
test('Node validation refuses extra/missing/changed files, provenance or manifest and exact-version mismatch',t=>{
  const f=fixture(t),binding=createNodeRuntime(f.output,{executable:f.executable,sourceMaterial:f.source}),entry=path.join(f.output,'node.exe'),before=fs.readFileSync(entry);fs.appendFileSync(entry,'x');assert.throws(()=>validateNodeRuntime(f.output,binding),/files are/);fs.writeFileSync(entry,before);
  fs.writeFileSync(path.join(f.output,'extra'),'x');assert.throws(()=>validateNodeRuntime(f.output,binding),/files are/);fs.rmSync(path.join(f.output,'extra'));fs.rmSync(entry);assert.throws(()=>validateNodeRuntime(f.output,binding),/files are/);fs.writeFileSync(entry,before);
  assert.throws(()=>validateNodeRuntime(f.output,{...binding,nodeVersion:'0.0.0'}),/version differs/);fs.appendFileSync(path.join(f.output,'node-runtime.json'),' ');assert.throws(()=>validateNodeRuntime(f.output,binding),/manifest changed/);
});
test('larger Node PE allowance is explicit and does not relax the existing 64 MiB native image budget',()=>{
  const large=Buffer.alloc(64*1024*1024+1);image().copy(large);assert.throws(()=>peImports(large),/大小无效/);assert.deepEqual(peImports(large,{imageBytes:128*1024*1024}),['kernel32.dll']);for(const imageBytes of[0,NaN,128*1024*1024+1])assert.throws(()=>peImports(large,{imageBytes}));
});
test('Node input preflight uses the same byte/dependency proof without creating output material',t=>{
  const f=fixture(t),before=fs.readdirSync(f.root).sort(),verified=verifyNodeRuntimeInputs({executable:f.executable,sourceMaterial:f.source});assert.equal(verified.executableSha256,f.descriptor.executableSha256);assert.deepEqual(verified.systemImports,['kernel32.dll']);assert.deepEqual(fs.readdirSync(f.root).sort(),before);assert.equal(fs.existsSync(f.output),false);
  fs.appendFileSync(f.executable,'changed');assert.throws(()=>verifyNodeRuntimeInputs({executable:f.executable,sourceMaterial:f.source}),/published checksum/);assert.deepEqual(fs.readdirSync(f.root).sort(),before);
});
