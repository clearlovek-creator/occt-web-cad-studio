// Explicit diagnostic runs against one retained input. Never a product retry policy.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../gateway/native-runtime-release.mjs';
import {hashFile,assertRegularDirectory} from '../gateway/frontend-release.mjs';
const root=path.resolve(import.meta.dirname,'..'),releaseRoot=path.resolve(process.env.NETGEN_BACKEND_ROOT||'.artifacts/discrete-local-frame-backend-releases'),inputRoot=path.resolve(process.env.NETGEN_INPUT_ROOT||'.artifacts/sheet-constraints-service-final/data/mesh-jobs/default/mesh-1f098c74-1a64-4719-a1a0-d4cdfadc3e0d'),output=path.resolve(process.env.NETGEN_ARTIFACTS||'.artifacts/sheet-constraints-netgen-baseline');
for(const target of [releaseRoot,inputRoot,output])assert.ok(target.startsWith(path.join(root,'.artifacts')+path.sep));assert.equal(fs.existsSync(output),false);for(let p=path.dirname(output);p!==root;p=path.dirname(p))if(fs.existsSync(p))assertRegularDirectory(p);fs.mkdirSync(output);
const backend=selectBackendRelease(releaseRoot),native=validateNativeRuntime(path.join(backend.directory,'native'),backend.native),{DiscreteTetraClient}=await import(pathToFileURL(path.join(backend.directory,'runtime/gateway/discrete-tetra-client.mjs')).href),read=name=>JSON.parse(fs.readFileSync(path.join(inputRoot,name)));
const snapshot=read('discrete-source.json'),metadata=read('metadata.json'),domain=read('partition.json'),settings=metadata.options.discreteTetra,input={domain,meshSize:settings.meshSize,quality:settings.quality,optimization:settings.optimization},sourceInput={...snapshot.cad.bundle.input,options:snapshot.settings.repair};
const inputs=['discrete-source.json','metadata.json','partition.json'].map(name=>({file:path.relative(root,path.join(inputRoot,name)).replaceAll('\\','/'),sha256:hashFile(path.join(inputRoot,name))})),records=[],children=new Set();
const sourceProof=['scripts/verify-netgen-reproduction.mjs'].map(file=>({file,sha256:hashFile(path.join(root,file))}));
for(let run=1;run<=5;run++){
  const stderr=[],client=new DiscreteTetraClient({workerPath:native.roles.mesh,runtimePath:native.meshBin,spawnImpl:(...args)=>{const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));child.stderr.on('data',bytes=>{if(stderr.join('').length<32768)stderr.push(bytes.toString());});return child;}}),start=performance.now();
  try{const result=await client.tetrahedralize(input,{sourceInput});fs.writeFileSync(path.join(output,`run-${run}.json`),JSON.stringify(result),{flag:'wx'});const meshSha256=crypto.createHash('sha256').update(JSON.stringify({points:result.points,cells:result.cells,boundaries:result.boundaries})).digest('hex');records.push({run,ok:true,tetrahedra:result.report.tetraCount,minimumSICN:result.quality.minimumSICN,optimization:result.optimization.disposition,meshSha256});}
  catch(error){records.push({run,ok:false,code:error.code,message:error.message,stderr:stderr.join('')});}
  finally{await client.closeAndWait();assert.equal(client.children.size,0);}
  records.at(-1).elapsedMs=Math.round(performance.now()-start);console.log(JSON.stringify(records.at(-1)));
}
assert.equal(children.size,0);for(const item of [...inputs,...sourceProof])assert.equal(hashFile(path.join(root,item.file)),item.sha256);assert.equal(selectBackendRelease(releaseRoot,backend.releaseId).manifestSha256,backend.manifestSha256);validateNativeRuntime(path.join(backend.directory,'native'),backend.native);
const report={format:'web-cad-netgen-independent-reproduction',version:1,ok:true,createdAt:new Date().toISOString(),scope:'Five explicitly scheduled independent diagnostic processes, not automatic replay or product acceptance.',backend:{releaseId:backend.releaseId,manifestSha256:backend.manifestSha256,sourceSha256:backend.sourceSha256,nativeSha256:backend.native.sha256},inputs,sourceProof,records,counts:{total:5,passed:records.filter(row=>row.ok).length,failed:records.filter(row=>!row.ok).length},childrenExited:true,dailyServicesChanged:false,paidProviderCalls:0};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2),{flag:'wx'});
