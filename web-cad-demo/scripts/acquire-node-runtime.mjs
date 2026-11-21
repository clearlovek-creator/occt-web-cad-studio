/* Explicit build-input acquisition only. Never downloads or executes Node. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {nodeSourceUrls,readNodeSourceMaterial} from '../gateway/node-runtime-release.mjs';
import {hashFile,atomicJson} from '../gateway/frontend-release.mjs';
const index=process.argv.indexOf('--output');if(index<0||!process.argv[index+1])throw Error('An explicit --output directory is required.');
const output=path.resolve(process.argv[index+1]);if(fs.existsSync(output))throw Error('Source material directory already exists; nothing overwritten.');
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Only Windows x64 is currently qualified.');
const version=process.versions.node,urls=nodeSourceUrls(version),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function acquire(url){
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Official material request failed: '+response.status);
  let count=0;const chunks=[];for await(const bytes of response.body){count+=bytes.length;if(count>1024*1024)throw Error('Official material exceeds its budget.');chunks.push(bytes);}return Buffer.concat(chunks);
}
const [checksums,license]=await Promise.all([acquire(urls.checksums),acquire(urls.license)]),published=checksums.toString('ascii').split(/\r?\n/).map(line=>/^([a-f0-9]{64})\s+win-x64\/node\.exe$/.exec(line)).filter(Boolean);
if(published.length!==1||hashFile(process.execPath)!==published[0][1])throw Error('Installed Node does not match the published exact Windows x64 executable checksum.');
fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'SHASUMS256.txt'),checksums,{flag:'wx'});fs.writeFileSync(path.join(output,'LICENSE'),license,{flag:'wx'});
atomicJson(path.join(output,'source.json'),{format:'web-cad-node-source-material',version:1,nodeVersion:version,platform:'win32',arch:'x64',acquiredAt:new Date().toISOString(),urls,executableSha256:published[0][1],checksumsSha256:sha(checksums),licenseSha256:sha(license)});
readNodeSourceMaterial(output,version);console.log(JSON.stringify({ok:true,nodeVersion:version,executableSha256:published[0][1],sourceMaterial:output,scope:'HTTPS-acquired published checksum and version-tagged license; not a PGP signature verification.'}));
