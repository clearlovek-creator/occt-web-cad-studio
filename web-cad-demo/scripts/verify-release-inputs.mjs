/* Read-only release/source proof. Does not select, start or deploy a release. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {selectRelease,fileInventory,hashFile,frontendBuildInputs} from '../gateway/frontend-release.mjs';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
const workspace=path.resolve(import.meta.dirname,'..');
const argument=name=>{const index=process.argv.indexOf(name);if(index<0||!process.argv[index+1])throw Error('Required argument: '+name);return path.resolve(process.argv[index+1]);};
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const frontend=selectRelease(argument('--frontend-root'),workspace),backend=selectBackendRelease(argument('--backend-root'));
const inputs=frontendBuildInputs(frontend.version);
const frontendFiles=inputs.flatMap(name=>{const file=path.join(workspace,name);if(!fs.existsSync(file))return [];const stat=fs.lstatSync(file);assert.ok(!stat.isSymbolicLink());return stat.isDirectory()?fileInventory(file).map(item=>({...item,file:name+'/'+item.file})):[{file:name,bytes:stat.size,sha256:hashFile(file)}];});
assert.equal(digest(frontendFiles),frontend.sourceSha256,'Frontend source is not the verified release input');
const backendFiles=['gateway','shared'].flatMap(folder=>fileInventory(path.join(workspace,folder)).filter(item=>item.file.endsWith('.mjs')).map(item=>({...item,file:'runtime/'+folder+'/'+item.file})));
const entry='scripts/backend-server.mjs';backendFiles.push({file:'runtime/'+entry,bytes:fs.statSync(path.join(workspace,entry)).size,sha256:hashFile(path.join(workspace,entry))});backendFiles.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
assert.deepEqual(backendFiles,backend.files.filter(item=>item.file.endsWith('.mjs')),'Backend source differs from the frozen runtime');
const testFiles=['tests','scripts'].flatMap(folder=>fileInventory(path.join(workspace,folder)).map(item=>({...item,file:folder+'/'+item.file})));
const report={ok:true,frontend:frontend.releaseId,frontendSourceSha256:frontend.sourceSha256,frontendFiles:frontendFiles.length,backend:backend.releaseId,sourceSha256:backend.sourceSha256,checkedSourceFiles:backendFiles.length,native:backend.native?.sha256,sdk:backend.sdk?.manifest.sha256,verificationFiles:testFiles.length,verificationFilesSha256:digest(testFiles)};
if(process.argv.includes('--transport-root')){const transport=selectBackendRelease(argument('--transport-root'));assert.ok(!transport.sdk);assert.equal(transport.sourceSha256,backend.sourceSha256);assert.equal(transport.native?.sha256,backend.native?.sha256);report.transport=transport.releaseId;}
if(process.argv.includes('--baseline'))assert.deepEqual(report,JSON.parse(fs.readFileSync(argument('--baseline'),'utf8')),'Release or verification inputs changed during acceptance');
if(process.argv.includes('--output')){const output=argument('--output');assert.ok(output.startsWith(path.join(workspace,'.artifacts')+path.sep)&&output.endsWith('.json'));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
