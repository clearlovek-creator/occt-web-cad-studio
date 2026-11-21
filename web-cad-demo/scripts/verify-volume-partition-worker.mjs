import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DiscreteSurfaceClient} from '../gateway/discrete-surface-client.mjs';
import {assertVolumePartitionHandshake,assertVolumePartitionResult} from '../gateway/volume-partition-protocol.mjs';
import {fileInventory,hashFile,readSmallJson,assertRegularDirectory} from '../gateway/frontend-release.mjs';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../gateway/native-runtime-release.mjs';

const root=path.resolve(import.meta.dirname,'..');
const build=path.resolve(process.argv[2]||'.artifacts/volume-partition-worker-native-first');
const inputDirectory=path.resolve(process.argv[3]||'.artifacts/volume-partition-domain-checks');
const output=path.resolve(process.argv[4]||'.artifacts/volume-partition-worker-checks');
for(const directory of [build,inputDirectory,output])assert.ok(directory.startsWith(path.join(root,'.artifacts')+path.sep));
assert.ok(!fs.existsSync(output));for(let p=path.dirname(output);p!==root;p=path.dirname(p))if(fs.existsSync(p))assertRegularDirectory(p);
const receipt=readSmallJson(path.join(build,'build.json')),buildSha=hashFile(path.join(build,'build.json'));
let worker=path.join(build,receipt.worker.file),runtime=path.join(build,'runtime'),Client=DiscreteSurfaceClient,backend;
if(process.env.VOLUME_PARTITION_BACKEND_ROOT){
  const releaseRoot=path.resolve(process.env.VOLUME_PARTITION_BACKEND_ROOT);assert.ok(releaseRoot.startsWith(path.join(root,'.artifacts')+path.sep));
  backend=selectBackendRelease(releaseRoot);const native=validateNativeRuntime(path.join(backend.directory,'native'),backend.native);
  worker=native.roles.discrete;runtime=native.discreteBin;assert.equal(hashFile(worker),receipt.worker.sha256);
  Client=(await import(pathToFileURL(path.join(backend.directory,'runtime/gateway/discrete-surface-client.mjs')).href)).DiscreteSurfaceClient;
}
const sources=[...receipt.sources,...['scripts/verify-volume-partition-worker.mjs','gateway/volume-partition-protocol.mjs','gateway/discrete-surface-client.mjs','gateway/single-job-native-client.mjs','gateway/discrete-surface-protocol.mjs','gateway/native-request-channel.mjs','gateway/child-exit.mjs','gateway/native-resource-policy.mjs'].map(file=>({file,sha256:hashFile(path.join(root,file))}))];
function verify(){assert.equal(hashFile(path.join(build,'build.json')),buildSha);for(const item of sources)assert.equal(hashFile(path.join(root,item.file)),item.sha256);assert.deepEqual(fileInventory(runtime),receipt.runtime.files);if(backend){const selected=selectBackendRelease(path.dirname(backend.directory),backend.releaseId);assert.equal(selected.manifestSha256,backend.manifestSha256);validateNativeRuntime(path.join(backend.directory,'native'),backend.native);}}
verify();fs.mkdirSync(output);const records=[],children=new Set(),inputs=[];
const names=['single-closed-box','disjoint-boxes','overlapping-boxes','face-touching-boxes','edge-touching-boxes','vertex-touching-boxes','identical-boxes','contained-cavity-region','nested-cavity-shells','three-overlapping-boxes','disconnected-membership-is-not-one-connected-cell','rational-rotated-intersection','one-body-with-two-source-solids','same-local-solid-label-in-different-bodies','actual-cad-captured-overlap'];
const source=name=>{const target=path.join(inputDirectory,name+'.input.json');inputs.push({file:path.relative(root,target).replaceAll('\\','/'),sha256:hashFile(target)});return readSmallJson(target,8*1024**2);};
async function check(name,action){const start=performance.now();try{const value=await action();records.push({name,ok:true,elapsedMs:Math.round(performance.now()-start),...value});console.log('PASS '+name);}catch(error){records.push({name,ok:false,error:error.stack,code:error.code});console.error('FAIL '+name+': '+error.message);}}
function trackSpawn(binary,args,options){const child=spawn(binary,args,options);children.add(child);child.once('close',()=>children.delete(child));return child;}
for(const name of names)await check(name,async()=>{
  const input=source(name),client=new Client({workerPath:worker,runtimePath:runtime,spawnImpl:trackSpawn});
  try{const result=await client.partition(input);assertVolumePartitionResult(result,input,result.requestId);assert.equal(result.execution.exitCode,0);assert.equal(result.processResources.enforced,true);assert.equal(client.children.size,0);fs.writeFileSync(path.join(output,name+'.result.json'),JSON.stringify(result),{flag:'wx'});return {cells:result.cells.length,regions:result.regions.length,volume:result.report.unionVolume,sharedTriangles:result.report.sharedInterfaceTriangles};}finally{await client.closeAndWait();}
});
for(const [name,expected]of [['open-solid-refused',['VOLUME_OPEN_BOUNDARY','VOLUME_NON_MANIFOLD']],['inverted-solid-refused',['VOLUME_ORIENTATION_INVALID']],['opposite-coincident-use-refused',['VOLUME_ORIENTATION_CONFLICT']]])await check(name,async()=>{
  const client=new Client({workerPath:worker,runtimePath:runtime,spawnImpl:trackSpawn});try{await assert.rejects(client.partition(source(name)),error=>expected.includes(error.code));assert.equal(client.children.size,0);return {rejected:true};}finally{await client.closeAndWait();}
});
await check('real-cancellation-observes-the-exact-process-exit',async()=>{
  const controller=new AbortController();let native,submitted=false;
  const client=new Client({workerPath:worker,runtimePath:runtime,spawnImpl:(...args)=>{
    native=trackSpawn(...args);const write=native.stdin.write.bind(native.stdin);
    native.stdin.write=(wire,...rest)=>{const sent=write(wire,...rest);if(JSON.parse(wire).operation==='volume.partition'){submitted=true;setImmediate(()=>controller.abort());}return sent;};return native;
  }});
  try{await assert.rejects(client.partition(source('three-overlapping-boxes'),{signal:controller.signal}),{code:'SURFACE_CANCELLED'});assert.equal(submitted,true);assert.equal(native.killed,true);assert.equal(client.children.size,0);assert.ok(native.exitCode!==null||native.signalCode!==null);return {submitted,exitObserved:true};}finally{await client.closeAndWait();}
});
await check('real-timeout-does-not-start-replacement-or-publish-late-results',async()=>{
  let spawned=0;const client=new Client({workerPath:worker,runtimePath:runtime,timeoutMs:1,spawnImpl:(...args)=>{spawned++;return trackSpawn(...args);}});
  try{await assert.rejects(client.partition(source('three-overlapping-boxes')),{code:'SURFACE_TIMEOUT'});assert.equal(spawned,1);assert.equal(client.children.size,0);return {spawned,exitObserved:true};}finally{await client.closeAndWait();}
});
async function raw(name,commands,expectedCode){
  const env={};for(const [key,value]of Object.entries(process.env))if(['SYSTEMROOT','WINDIR','TEMP','TMP','SYSTEMDRIVE'].includes(key.toUpperCase()))env[key]=value;
  const child=trackSpawn(worker,[],{cwd:runtime,env:{...env,Path:runtime,DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:String(2*1024**3)},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',failure;const timer=setTimeout(()=>{failure=Error('Native volume protocol deadline exceeded');child.kill();},30000);
  child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>64*1024**2){failure=Error('Native volume output exceeded its budget');child.kill();}});child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-65536));child.stdin.end(commands.map(command=>JSON.stringify(command)).join('\n')+'\n');
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
  fs.writeFileSync(path.join(output,name+'.stdout.txt'),stdout,{flag:'wx'});fs.writeFileSync(path.join(output,name+'.stderr.txt'),stderr,{flag:'wx'});if(failure)throw failure;
  const frames=stdout.trim().split('\n').map(line=>JSON.parse(line));if(expectedCode){assert.equal(code,2);assert.equal(frames.at(-1).code,expectedCode);}else assert.equal(code,0);return frames;
}
const health={protocolVersion:1,requestId:'volume-health',operation:'health.ping'},command={protocolVersion:1,requestId:'volume-job',operation:'volume.partition',input:source('single-closed-box')};
await check('volume-before-handshake-is-rejected',async()=>{await raw('no-handshake',[command],'SURFACE_HANDSHAKE_REQUIRED');return {};});
await check('volume-envelope-rejects-unknown-fields',async()=>{await raw('unknown-field',[health,{...command,path:'private'}],'SURFACE_REQUEST_INVALID');return {};});
await check('one-volume-job-exits-before-second-job',async()=>{const frames=await raw('one-job',[health,command,{...command,requestId:'second-volume'}]);assert.equal(frames.length,2);assertVolumePartitionHandshake(frames[0]);assertVolumePartitionResult(frames[1],command.input,command.requestId);return {frames:frames.length};});
verify();for(const item of inputs)assert.equal(hashFile(path.join(root,item.file)),item.sha256);assert.equal(children.size,0);
const result={format:'web-cad-volume-partition-worker-verification',version:1,ok:records.every(row=>row.ok),createdAt:new Date().toISOString(),scope:'formal shared core, guarded volume protocol and client; no product mesh-task admission or daily update',build:{file:path.relative(root,path.join(build,'build.json')).replaceAll('\\','/'),sha256:buildSha,workerSha256:receipt.worker.sha256},...backend&&{backend:{releaseId:backend.releaseId,manifestSha256:backend.manifestSha256,sourceSha256:backend.sourceSha256,nativeSha256:backend.native.sha256}},sourceProof:sources,inputs:[...new Map(inputs.map(item=>[item.file,item])).values()],counts:{total:records.length,passed:records.filter(row=>row.ok).length,failed:records.filter(row=>!row.ok).length},records,childrenExited:true,normalMeshAdmitted:false,productTaskIntegration:false,dailyServicesChanged:false,paidProviderCalls:0};
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({ok:result.ok,counts:result.counts,output}));if(!result.ok)process.exitCode=1;
