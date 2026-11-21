/* Real STEP transfer + exact BRep evidence; isolated processes, no live service. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {selectNativeTestRuntime} from './test-native-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..'),runtime=selectNativeTestRuntime(root);
const label=process.env.CAD_FINGERPRINT_LABEL||'baseline';assert.match(label,/^[a-z][a-z0-9-]{0,31}$/);
const area=path.join(root,'.artifacts/performance'),fixtures=path.join(area,'fingerprint-fixtures');fs.mkdirSync(fixtures,{recursive:true});
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exe=path.join(path.dirname(runtime.geometry),'fingerprint_tests.exe');
const sizes=(process.env.CAD_FINGERPRINT_CASES||'16x24,64x48,128x64').split(',').map(value=>{assert.match(value,/^\d+x\d+$/);const [patches,poles]=value.split('x').map(Number);assert.ok(patches>=1&&patches<=256&&poles>=4&&poles<=128&&patches*poles*poles<=1048576);return {name:value,patches,poles};});assert.ok(sizes.length<=6);
const env={...runtime.environment};const inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;
env.PATH=[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
async function run(input){
  const child=spawn(exe,[],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',error='',timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill();},180000);
  child.stdout.on('data',chunk=>{output=(output+chunk).slice(-1024*1024);});child.stderr.on('data',chunk=>error=(error+chunk).slice(-8192));
  child.stdin.end(JSON.stringify(input)+'\n');let code;
  try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);}
  assert.equal(timedOut,false,'Benchmark deadline exceeded; child close was observed');assert.equal(code,0,error+'\n'+output);
  const record=output.split(/\r?\n/).find(line=>line.startsWith('FINGERPRINT_BENCH '));assert.ok(record,'Native benchmark receipt missing');return JSON.parse(record.slice(18));
}
const cases=[];
for(const size of sizes){
  const directory=path.join(fixtures,size.name),file=path.join(directory,'surfaces.step'),manifest=path.join(directory,'fixture.json');
  if(!fs.existsSync(file)){
    const prepare=await run({mode:'prepare',directory,...size});
    fs.writeFileSync(manifest,JSON.stringify({...size,...prepare,stepSha256:hash(file)},null,2),{flag:'wx'});
  }
  const fixture=JSON.parse(fs.readFileSync(manifest,'utf8'));assert.equal(hash(file),fixture.stepSha256,'Retained STEP fixture changed');assert.equal(fs.statSync(file).size,fixture.stepBytes);
  const samples=[];
  // Independent processes avoid one variant inheriting another's process peak.
  // Alternating ABBA order reduces, but does not remove, warm cache/CPU bias.
  for(const mode of ['legacy','current','current','legacy']){
    const sample=await run({mode,directory});assert.ok(sample.faces>=size.patches);assert.ok(sample.edges>=4*size.patches);assert.ok(sample.serializedBytes>0);
    if(samples.length){assert.deepEqual(sample.hashes,samples[0].hashes,'Legacy/current exact evidence differs');assert.equal(sample.serializedBytes,samples[0].serializedBytes);assert.equal(sample.sourceFingerprint,samples[0].sourceFingerprint);}
    samples.push(sample);console.log(JSON.stringify({case:size.name,...sample}));
  }
  assert.equal(hash(file),fixture.stepSha256);cases.push({fixture,samples});
}
// Re-check the same registered pair after every child has exited.
assert.equal(selectNativeTestRuntime(root).manifestSha256,runtime.manifestSha256);
const sources=['geometry-worker/src/document/ShapeFingerprint.cxx','geometry-worker/src/document/ShapeFingerprint.hxx','geometry-worker/src/exchange/StepImport.cxx','geometry-worker/tests/fingerprint.cxx','geometry-worker/CMakeLists.txt','scripts/benchmark-fingerprint.mjs'];
const result={ok:true,label,recordedAt:new Date().toISOString(),environment:{platform:process.platform,node:process.version,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length},
  testManifestSha256:runtime.manifestSha256,executableSha256:hash(exe),sources:Object.fromEntries(sources.map(file=>[file,hash(path.join(root,file))])),cases,
  scope:'Synthetic independent cubic B-spline Sheet compounds transferred to real STEP and read with production v2 importer; exact production/legacy BRep SHA parity and serialized bytes. Windows 1ms sampled process PrivateUsage/WorkingSet during hash, plus whole-process peak; import memory is separate. ABBA independent processes, warm OS cache, non-exclusive CPU. Not industrial assembly, healing, meshing or all STEP qualification.'};
const output=path.join(area,`fingerprint-${label}.json`);fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,output,cases:cases.length,label}));
