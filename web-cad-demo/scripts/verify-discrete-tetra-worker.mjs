import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DiscreteSurfaceClient} from '../gateway/discrete-surface-client.mjs';
import {DiscreteTetraClient} from '../gateway/discrete-tetra-client.mjs';
import {assertDiscreteTetraHandshake,assertDiscreteTetraResult} from '../gateway/discrete-tetra-protocol.mjs';
import {fileInventory,hashFile,readSmallJson,assertRegularDirectory} from '../gateway/frontend-release.mjs';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../gateway/native-runtime-release.mjs';
const root=path.resolve(import.meta.dirname,'..'),meshBuild=path.resolve(process.argv[2]||'.artifacts/discrete-tetra-native-first'),domainBuild=path.resolve(process.argv[3]||'.artifacts/volume-partition-worker-native-first'),output=path.resolve(process.argv[4]||'.artifacts/discrete-tetra-worker-checks');
for(const directory of [meshBuild,domainBuild,output])assert.ok(directory.startsWith(path.join(root,'.artifacts')+path.sep));assert.ok(!fs.existsSync(output));for(let p=path.dirname(output);p!==root;p=path.dirname(p))if(fs.existsSync(p))assertRegularDirectory(p);
const meshReceipt=readSmallJson(path.join(meshBuild,'build.json')),domainReceipt=readSmallJson(path.join(domainBuild,'build.json'));
let meshWorker=path.join(meshBuild,meshReceipt.worker.file),meshRuntime=path.join(meshBuild,'runtime'),domainWorker=path.join(domainBuild,domainReceipt.worker.file),domainRuntime=path.join(domainBuild,'runtime'),Tetra=DiscreteTetraClient,Domain=DiscreteSurfaceClient,backend;
if(process.env.DISCRETE_TETRA_BACKEND_ROOT){
  const releaseRoot=path.resolve(process.env.DISCRETE_TETRA_BACKEND_ROOT);assert.ok(releaseRoot.startsWith(path.join(root,'.artifacts')+path.sep));backend=selectBackendRelease(releaseRoot);const native=validateNativeRuntime(path.join(backend.directory,'native'),backend.native);
  meshWorker=native.roles.mesh;meshRuntime=native.meshBin;domainWorker=native.roles.discrete;domainRuntime=native.discreteBin;
  Tetra=(await import(pathToFileURL(path.join(backend.directory,'runtime/gateway/discrete-tetra-client.mjs')).href)).DiscreteTetraClient;
  Domain=(await import(pathToFileURL(path.join(backend.directory,'runtime/gateway/discrete-surface-client.mjs')).href)).DiscreteSurfaceClient;
}
const sourceNames=['scripts/verify-discrete-tetra-worker.mjs','gateway/single-job-native-client.mjs','gateway/discrete-tetra-client.mjs','gateway/discrete-tetra-protocol.mjs','gateway/discrete-surface-client.mjs','gateway/volume-partition-protocol.mjs','gateway/discrete-surface-protocol.mjs','gateway/native-request-channel.mjs','gateway/native-resource-policy.mjs','gateway/child-exit.mjs'];
const sourceProof=[...meshReceipt.sources,...domainReceipt.sources,...sourceNames.map(file=>({file,sha256:hashFile(path.join(root,file))}))],buildProofs=[meshBuild,domainBuild].map(dir=>({file:path.relative(root,path.join(dir,'build.json')).replaceAll('\\','/'),sha256:hashFile(path.join(dir,'build.json'))}));
function verify(){for(const item of [...sourceProof,...buildProofs])assert.equal(hashFile(path.join(root,item.file)),item.sha256);assert.equal(hashFile(meshWorker),meshReceipt.worker.sha256);assert.equal(hashFile(domainWorker),domainReceipt.worker.sha256);assert.deepEqual(fileInventory(meshRuntime),meshReceipt.runtime.files);assert.deepEqual(fileInventory(domainRuntime),domainReceipt.runtime.files);if(backend){assert.equal(selectBackendRelease(path.dirname(backend.directory),backend.releaseId).manifestSha256,backend.manifestSha256);validateNativeRuntime(path.join(backend.directory,'native'),backend.native);}}
verify();fs.mkdirSync(output);const children=new Set(),records=[],inputs=[],cache=new Map();
function trackedSpawn(...args){const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));return child;}
async function check(name,action){const start=performance.now();try{const result=await action();records.push({name,ok:true,elapsedMs:Math.round(performance.now()-start),...result});console.log('PASS '+name);}catch(error){records.push({name,ok:false,code:error.code,error:error.stack});console.error('FAIL '+name+': '+error.message);}}
const names=['single-closed-box','disjoint-boxes','overlapping-boxes','face-touching-boxes','edge-touching-boxes','vertex-touching-boxes','identical-boxes','contained-cavity-region','nested-cavity-shells','three-overlapping-boxes','disconnected-membership-is-not-one-connected-cell','rational-rotated-intersection','one-body-with-two-source-solids','same-local-solid-label-in-different-bodies','actual-cad-captured-overlap'];
const diagnostic={version:1,mode:'diagnostic',threshold:.2,maxBadFraction:0};
async function source(name){
  if(cache.has(name))return cache.get(name);
  const target=path.join(root,'.artifacts/volume-partition-domain-final',name+'.input.json'),sourceInput=readSmallJson(target,8*1024**2);inputs.push({file:path.relative(root,target).replaceAll('\\','/'),sha256:hashFile(target)});
  const client=new Domain({workerPath:domainWorker,runtimePath:domainRuntime,spawnImpl:trackedSpawn});
  try{const domain=await client.partition(sourceInput);assert.equal(client.children.size,0);const value={sourceInput,domain};cache.set(name,value);fs.writeFileSync(path.join(output,name+'.domain.json'),JSON.stringify(domain),{flag:'wx'});return value;}finally{await client.closeAndWait();}
}
async function tetra(name,sourceName,{optimization,quality=diagnostic,reject}={}){
  const {sourceInput,domain}=await source(sourceName),client=new Tetra({workerPath:meshWorker,runtimePath:meshRuntime,spawnImpl:trackedSpawn});
  const input={domain,meshSize:.8,...quality!==null&&{quality},...optimization&&{optimization}};
  fs.writeFileSync(path.join(output,name+'.input.json'),JSON.stringify(input),{flag:'wx'});
  try{
    if(reject){let error;try{await client.tetrahedralize(input,{sourceInput});}catch(cause){error=cause;}assert.equal(error?.code,reject);assert.equal(error.details?.quality?.meetsRequestedQuality,false);assert.deepEqual(error.execution,{basis:'single-process-exit-confirmed-v1',exitCode:2,automaticReplay:false});assert.equal(error.processResources.enforced,true);assert.equal(error.algorithm.gmshVersion,'4.15.2');assert.equal(client.children.size,0);fs.writeFileSync(path.join(output,name+'.rejection.json'),JSON.stringify({code:error.code,message:error.message,details:error.details,execution:error.execution,processResources:error.processResources,algorithm:error.algorithm}),{flag:'wx'});return {rejection:error.code,lowQualityCount:error.details.quality.lowQualityCount,minimumSICN:error.details.quality.minimumSICN,failureExitConfirmed:true};}
    const result=await client.tetrahedralize(input,{sourceInput});assertDiscreteTetraResult(result,{...input,quality:quality||{version:1,mode:'strict',threshold:.2,maxBadFraction:0}},result.requestId);assert.equal(result.execution.exitCode,0);assert.equal(result.processResources.enforced,true);assert.equal(client.children.size,0);fs.writeFileSync(path.join(output,name+'.result.json'),JSON.stringify(result),{flag:'wx'});
    return {cells:result.cells.length,tetrahedra:result.report.tetraCount,nodes:result.points.length,minimumSICN:result.quality.minimumSICN,lowQualityCount:result.quality.lowQualityCount,meetsRequestedQuality:result.quality.meetsRequestedQuality,optimization:result.optimization.disposition||'not-requested'};
  }finally{await client.closeAndWait();}
}
for(const name of names)await check(name,()=>tetra(name,name));
for(const name of ['overlapping-boxes','nested-cavity-shells','three-overlapping-boxes','rational-rotated-intersection'])await check('netgen-'+name,()=>tetra('netgen-'+name,name,{optimization:{version:1,method:'netgen',iterations:3}}));
await check('default-strict-single-box',()=>tetra('default-strict-single-box','single-closed-box',{quality:null}));
await check('default-strict-overlap-rejected',()=>tetra('default-strict-overlap-rejected','overlapping-boxes',{quality:null,reject:'MESH_QUALITY_REJECTED'}));
await check('strict-optimized-three-way',()=>tetra('strict-optimized-three-way','three-overlapping-boxes',{quality:null,optimization:{version:1,method:'netgen',iterations:3}}));
await check('strict-optimized-rotated-rejected',()=>tetra('strict-optimized-rotated-rejected','rational-rotated-intersection',{quality:null,optimization:{version:1,method:'netgen',iterations:3},reject:'MESH_QUALITY_REJECTED'}));
await check('real-cancellation-after-domain-send-confirms-exit',async()=>{
  const {sourceInput,domain}=await source('three-overlapping-boxes'),controller=new AbortController();let native,sent=false;
  const client=new Tetra({workerPath:meshWorker,runtimePath:meshRuntime,spawnImpl:(...args)=>{native=trackedSpawn(...args);const write=native.stdin.write.bind(native.stdin);native.stdin.write=(wire,...rest)=>{const accepted=write(wire,...rest);if(JSON.parse(wire).operation==='mesh.discrete-tetra'){sent=true;setImmediate(()=>controller.abort());}return accepted;};return native;}});
  try{await assert.rejects(client.tetrahedralize({domain,quality:diagnostic},{sourceInput,signal:controller.signal}),{code:'MESH_CANCELLED'});assert.equal(sent,true);assert.equal(native.killed,true);assert.equal(client.children.size,0);return {sent,exitObserved:true};}finally{await client.closeAndWait();}
});
await check('real-timeout-has-no-replacement-process',async()=>{
  const {sourceInput,domain}=await source('three-overlapping-boxes');let count=0;const client=new Tetra({workerPath:meshWorker,runtimePath:meshRuntime,timeoutMs:1,spawnImpl:(...args)=>{count++;return trackedSpawn(...args);}});
  try{await assert.rejects(client.tetrahedralize({domain,quality:diagnostic},{sourceInput}),{code:'MESH_TIMEOUT'});assert.equal(count,1);assert.equal(client.children.size,0);return {processes:count,exitObserved:true};}finally{await client.closeAndWait();}
});
const single=await source('single-closed-box');
async function raw(name,commands,{expectedCode,exitCode=2,environment={}}={}){
  const env={};for(const [key,value]of Object.entries(process.env))if(['SYSTEMROOT','WINDIR','TEMP','TMP','SYSTEMDRIVE'].includes(key.toUpperCase()))env[key]=value;
  const child=trackedSpawn(meshWorker,['--discrete-single-job'],{cwd:meshRuntime,env:{...env,Path:meshRuntime,MESH_WORKER_MEMORY_LIMIT_BYTES:String(2*1024**3),...environment},windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',failure;
  const timer=setTimeout(()=>{failure=Error('Raw tetra protocol deadline exceeded');child.kill();},30000);child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>64*1024**2){failure=Error('Raw tetra output exceeded budget');child.kill();}});child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-65536));child.stdin.end(commands.map(command=>typeof command==='string'?command:JSON.stringify(command)).join('\n')+'\n');
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));fs.writeFileSync(path.join(output,name+'.stdout.txt'),stdout,{flag:'wx'});fs.writeFileSync(path.join(output,name+'.stderr.txt'),stderr,{flag:'wx'});if(failure)throw failure;assert.equal(code,exitCode);const frames=stdout.trim()?stdout.trim().split('\n').map(JSON.parse):[];if(expectedCode)assert.equal(frames.at(-1)?.code,expectedCode);return frames;
}
const health={protocolVersion:1,requestId:'tetra-health',operation:'health.ping'},job={protocolVersion:1,requestId:'tetra-job',operation:'mesh.discrete-tetra',input:{domain:single.domain,meshSize:.8,quality:diagnostic}};
for(const [name,commands,expectedCode]of [
  ['no-handshake',[job],'MESH_HANDSHAKE_REQUIRED'],
  ['duplicate-id',[health,{...job,requestId:health.requestId}],'MESH_DUPLICATE_REQUEST'],
  ['repeat-health',[health,{...health,requestId:'second-health'}],'MESH_PROTOCOL_SEQUENCE'],
  ['unknown-envelope',[health,{...job,path:'private'}],'MESH_REQUEST_INVALID'],
  ['unknown-operation',[health,{protocolVersion:1,requestId:'other-operation',operation:'mesh.create'}],'MESH_OPERATION_UNSUPPORTED'],
  ['quality-policy-required',[health,{...job,input:{domain:single.domain,meshSize:.8}}],'MESH_POLICY_REQUIRED'],
  ['unknown-input-field',[health,{...job,input:{...job.input,path:'private'}}],'MESH_INPUT_INVALID'],
  ['invalid-json',['{broken}'],'MESH_REQUEST_INVALID'],
  ['request-byte-limit',[JSON.stringify({padding:'x'.repeat(8*1024**2)})],'MESH_INPUT_LIMIT'],
])await check(name,async()=>{await raw(name,commands,{expectedCode});return {rejection:expectedCode};});
await check('actual-resource-and-runtime-handshake',async()=>{const frames=await raw('health',[health],{exitCode:0});assertDiscreteTetraHandshake(frames[0]);assert.equal(frames[0].capabilities.processResources.enforced,true);return {gmshVersion:frames[0].capabilities.discreteTetra.gmshVersion};});
await check('one-job-exits-before-a-second-input',async()=>{const frames=await raw('one-job',[health,job,{...job,requestId:'second-job'}],{exitCode:0});assert.equal(frames.length,2);assertDiscreteTetraResult(frames[1],job.input,job.requestId);return {frames:frames.length};});
await check('memory-guard-cannot-be-disabled',async()=>{await raw('memory-disabled',[],{exitCode:89,environment:{MESH_WORKER_MEMORY_LIMIT_BYTES:'0'}});return {exitCode:89};});
verify();for(const item of inputs)assert.equal(hashFile(path.join(root,item.file)),item.sha256);assert.equal(children.size,0);
const result={format:'web-cad-discrete-tetra-worker-verification',version:1,ok:records.every(row=>row.ok),createdAt:new Date().toISOString(),scope:'formal CGAL partition to formal single-job Gmsh tetra client pipeline; not CAD-bound durable mesh tasks or material admission',builds:buildProofs,...backend&&{backend:{releaseId:backend.releaseId,manifestSha256:backend.manifestSha256,sourceSha256:backend.sourceSha256,nativeSha256:backend.native.sha256}},sourceProof,inputs,counts:{total:records.length,passed:records.filter(row=>row.ok).length,failed:records.filter(row=>!row.ok).length},records,childrenExited:true,normalMeshAdmitted:false,productTaskIntegration:false,dailyServicesChanged:false,publicDistributionQualified:false,paidProviderCalls:0};
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({ok:result.ok,counts:result.counts,output}));if(!result.ok)process.exitCode=1;
