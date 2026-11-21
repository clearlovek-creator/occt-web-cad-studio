import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DiscreteSurfaceClient} from '../gateway/discrete-surface-client.mjs';
import {DISCRETE_SURFACE_PROTOCOL as P,assertDiscreteHandshake} from '../gateway/discrete-surface-protocol.mjs';
import {discreteMemoryPolicy,assertNativeMemoryGuard} from '../gateway/native-resource-policy.mjs';
import {fileInventory,hashFile,readSmallJson,assertRegularDirectory} from '../gateway/frontend-release.mjs';

const root=path.resolve(import.meta.dirname,'..'),output=path.resolve(process.argv[2]||'.artifacts/discrete-worker-protocol-check'),build=path.resolve(process.argv[3]||'.artifacts/discrete-worker-native-second');
for(const directory of [output,build])assert.ok(directory.startsWith(path.join(root,'.artifacts')+path.sep));
assert.ok(!fs.existsSync(output),'Choose a new evidence directory.');for(let p=path.dirname(output);p!==root;p=path.dirname(p))if(fs.existsSync(p))assertRegularDirectory(p);
const receipt=readSmallJson(path.join(build,'build.json')),receiptSha=hashFile(path.join(build,'build.json'));
assert.equal(receipt.format,'web-cad-discrete-surface-worker-build');assert.equal(receipt.version,1);
const runtime=path.join(build,'runtime'),worker=path.join(build,receipt.worker.file);
const scriptNames=['scripts/verify-discrete-surface-worker.mjs','gateway/discrete-surface-client.mjs','gateway/single-job-native-client.mjs','gateway/discrete-surface-protocol.mjs','gateway/volume-partition-protocol.mjs','gateway/native-request-channel.mjs','gateway/bounded-json-lines.mjs','gateway/child-exit.mjs','gateway/native-resource-policy.mjs'];
const scriptSources=scriptNames.map(file=>({file,sha256:hashFile(path.join(root,file))}));
function verifyInputs(){
  assert.equal(hashFile(path.join(build,'build.json')),receiptSha);
  for(const item of [...receipt.sources,...scriptSources])assert.equal(hashFile(path.join(root,item.file)),item.sha256,item.file+' changed.');
  assert.equal(hashFile(path.join(build,receipt.headerInputs.file)),receipt.headerInputs.sha256);
  assert.deepEqual(fileInventory(runtime),receipt.runtime.files,'Actual runtime differs from the captured transitive PE closure.');
  assert.equal(hashFile(worker),receipt.worker.sha256);
}
verifyInputs();fs.mkdirSync(output);let passed=0;const results=[];
const horizontal=[[-2,-2,0],[2,-2,0],[0,2,0]],vertical=[[0,-1,-1],[0,-1,1],[0,1,0]];
const soup=triangles=>({units:'mm',points:triangles.flat(),triangles:triangles.map((_,i)=>[3*i,3*i+1,3*i+2]),sources:triangles.map((_,i)=>({faceId:'face-'+i,bodyId:'body-'+i,solidId:'solid-'+i}))});
async function check(name,action){const start=performance.now();await action();passed++;results.push({name,ok:true,elapsedMs:Math.round(performance.now()-start)});console.log('PASS '+name);}
async function refine(name,input,expected){
  const client=new DiscreteSurfaceClient({workerPath:worker,runtimePath:runtime,timeoutMs:30000});
  fs.writeFileSync(path.join(output,name+'.input.json'),JSON.stringify(input),{flag:'wx'});
  try{const value=await client.refine(input);assert.equal(client.children.size,0);expected(value);fs.writeFileSync(path.join(output,name+'.result.json'),JSON.stringify(value),{flag:'wx'});}
  finally{await client.closeAndWait();}
}
async function raw(name,lines,{environment={},code=2,expectedCode,health=false}={}){
  const env={...process.env,...environment,DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:environment.DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES??String(2*1024**3)};delete env.Path;delete env.PATH;env.Path=runtime;
  const child=spawn(worker,[],{cwd:runtime,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',failure;const timer=setTimeout(()=>{failure=Error('Native check timeout');child.kill();},30000);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>P.maxResponseBytes){failure=Error('Output over budget');child.kill();}});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-65536);});child.stdin.on('error',()=>{});
  child.stdin.end(Buffer.isBuffer(lines)?lines:lines.join('\n')+'\n');
  const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
  fs.writeFileSync(path.join(output,name+'.stdout.txt'),stdout,{flag:'wx'});fs.writeFileSync(path.join(output,name+'.stderr.txt'),stderr,{flag:'wx'});if(failure)throw failure;
  assert.equal(exitCode,code);const frames=stdout.trim()?stdout.trim().split('\n').map(line=>JSON.parse(line)):[];
  if(expectedCode)assert.equal(frames.at(-1)?.code,expectedCode);
  if(health){assertDiscreteHandshake(frames[0]);assertNativeMemoryGuard(frames[0],discreteMemoryPolicy({},'win32'),P.service);}
  return frames;
}
const envelope=(operation,extra={})=>JSON.stringify({protocolVersion:1,requestId:'check-'+operation,operation,...extra});
const ping=envelope('health.ping');
try{
  await check('clean-surface-through-formal-client',()=>refine('clean',soup([horizontal]),r=>{assert.equal(r.triangles.length,1);assert.equal(r.report.inputHadCrossings,false);assert.equal(r.execution.exitCode,0);}));
  await check('crossing-surface-through-formal-client',()=>refine('crossing',soup([horizontal,vertical]),r=>{assert.equal(r.triangles.length,7);assert.equal(r.report.inputHadCrossings,true);assert.equal(r.report.outputHasCrossings,false);assert.equal(r.report.tetrahedralReady,false);assert.equal(r.report.sourceIdentityAuthority,'caller-supplied-discrete-labels-not-cad-certificates');}));
  await check('coplanar-multi-owner-through-formal-client',()=>refine('coplanar',soup([horizontal,[...horizontal].reverse()]),r=>{assert.equal(r.triangles.length,1);assert.deepEqual(r.sourceTriangleIds,[[0,1]]);}));
  await check('native-domain-rejection-is-not-success',async()=>{const client=new DiscreteSurfaceClient({workerPath:worker,runtimePath:runtime});try{await assert.rejects(client.refine({...soup([horizontal]),options:{iterations:11}}),{code:'INVALID_INPUT'});assert.equal(client.children.size,0);}finally{await client.closeAndWait();}});
  await check('actual-native-resource-handshake',()=>raw('handshake',[ping],{code:0,health:true}));
  await check('refine-before-handshake-rejected',()=>raw('no-handshake',[envelope('surface.refine',{input:soup([horizontal])})],{expectedCode:'SURFACE_HANDSHAKE_REQUIRED'}));
  await check('repeat-handshake-rejected',()=>raw('repeat-handshake',[ping,JSON.stringify({protocolVersion:1,requestId:'different-health',operation:'health.ping'})],{expectedCode:'SURFACE_PROTOCOL_SEQUENCE',health:true}));
  await check('request-identifier-reuse-rejected',()=>raw('duplicate-id',[ping,JSON.stringify({protocolVersion:1,requestId:'check-health.ping',operation:'surface.refine',input:soup([horizontal])})],{expectedCode:'SURFACE_DUPLICATE_REQUEST',health:true}));
  await check('unsupported-protocol-rejected',()=>raw('wrong-protocol',[JSON.stringify({protocolVersion:2,requestId:'r',operation:'health.ping'})],{expectedCode:'SURFACE_PROTOCOL_UNSUPPORTED'}));
  await check('fractional-protocol-rejected',()=>raw('fractional-protocol',[JSON.stringify({protocolVersion:1.5,requestId:'r',operation:'health.ping'})],{expectedCode:'SURFACE_REQUEST_INVALID'}));
  await check('unbounded-request-id-rejected',()=>raw('long-id',[JSON.stringify({protocolVersion:1,requestId:'r'.repeat(129),operation:'health.ping'})],{expectedCode:'SURFACE_REQUEST_INVALID'}));
  await check('unknown-envelope-field-rejected',()=>raw('unknown-field',[envelope('health.ping',{arbitraryPath:'x'})],{expectedCode:'SURFACE_REQUEST_INVALID'}));
  await check('unknown-operation-rejected',()=>raw('unknown-operation',[envelope('tetrahedralize')],{expectedCode:'SURFACE_OPERATION_UNSUPPORTED'}));
  await check('invalid-json-rejected',()=>raw('invalid-json',['{broken}'],{expectedCode:'SURFACE_REQUEST_INVALID'}));
  await check('unknown-surface-input-field-rejected',()=>raw('unknown-input-field',[ping,envelope('surface.refine',{input:{...soup([horizontal]),callerCertificate:'not-trusted'}})],{expectedCode:'INVALID_INPUT',health:true}));
  await check('escaped-control-source-identity-rejected',()=>raw('bad-source-id',[ping,envelope('surface.refine',{input:{...soup([horizontal]),sources:[{bodyId:'body-1\u0000',faceId:'face-1'}]}})],{expectedCode:'SOURCE_MAP_INVALID',health:true}));
  await check('native-request-byte-budget-enforced',()=>raw('request-limit',[JSON.stringify({padding:'x'.repeat(P.maxRequestBytes)})],{expectedCode:'SURFACE_INPUT_LIMIT'}));
  await check('memory-guard-cannot-be-disabled',()=>raw('memory-disabled',[],{environment:{DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:'0'},code:89}));
  await check('one-job-exit-does-not-execute-second-input',async()=>{const frames=await raw('one-job',[ping,envelope('surface.refine',{input:soup([horizontal])}),envelope('surface.refine',{input:soup([horizontal,vertical])})],{code:0,health:true});assert.equal(frames.length,2);assert.equal(frames[1].triangles.length,1);});
  verifyInputs();
  const result={ok:true,format:'web-cad-discrete-surface-worker-verification',version:1,scope:'formal-worker-and-client-not-project-task-or-volume-integration',build:{file:path.relative(root,path.join(build,'build.json')).replaceAll('\\','/'),sha256:receiptSha,worker:receipt.worker.sha256,runtimeFiles:receipt.runtime.files.length},scriptSources,counts:{total:results.length,passed},results,dailyServicesChanged:false,publicDistributionQualified:false,tetrahedralReady:false};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,total:passed,output}));
}catch(error){fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({ok:false,passed,error:{code:error.code,message:error.message},results},null,2),{flag:'wx'});throw error;}
