import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {discreteValidationPacket,discreteValidationBinary,decodeDiscreteValidationBinary} from '../gateway/discrete-validation-envelope.mjs';
import {validateDiscreteNativePacket} from '../gateway/discrete-native-validation.mjs';
import {DiscreteTetraClient} from '../gateway/discrete-tetra-client.mjs';
import {tetraExecutionInput} from '../gateway/discrete-tetra-task-result.mjs';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../gateway/native-runtime-release.mjs';
import {fileInventory,hashFile,readSmallJson,assertRegularDirectory} from '../gateway/frontend-release.mjs';
const root=path.resolve(import.meta.dirname,'..'),insideArtifacts=target=>target.startsWith(path.join(root,'.artifacts')+path.sep);
if(process.argv[2]==='--child'){
  const [mode,inputPath,outputPath]=process.argv.slice(3);assert.ok(['json-reference','binary'].includes(mode));for(const target of [inputPath,outputPath])assert.ok(insideArtifacts(path.resolve(target)));
  const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));global.gc();const before=process.memoryUsage(),start=performance.now(),encoded=mode==='binary'?discreteValidationBinary(input):discreteValidationPacket(input),elapsedMs=performance.now()-start,after=process.memoryUsage(),packagingStageMaxRssKiB=process.resourceUsage().maxRSS;
  let encodedBytes,header;
  if(mode==='binary'){encodedBytes=encoded.packet.bytes;const {data,...rest}=encoded.packet;header=rest;fs.writeFileSync(outputPath,Buffer.from(data),{flag:'wx'});}
  else{const wire=JSON.stringify(encoded.packet);encodedBytes=Buffer.byteLength(wire);fs.writeFileSync(outputPath,wire,{flag:'wx'});}
  const report={mode,elapsedMs,encodedBytes,sha256:encoded.sha256,packagingStageMaxRssKiB,wholeChildAfterSnapshotWriteMaxRssKiB:process.resourceUsage().maxRSS,before,after,...header&&{header}};
  console.log(JSON.stringify(report));
}else{
  const output=path.resolve(process.argv[2]||'.artifacts/binary-validation-benchmark'),sourceRoot=path.resolve('.artifacts/threaded-tetra-native-qualified/data/mesh-jobs/default'),backend=selectBackendRelease(path.resolve('.artifacts/threaded-tetra-final-backend-releases'));
  assert.ok(insideArtifacts(output)&&!fs.existsSync(output));for(let p=path.dirname(output);p!==root;p=path.dirname(p))if(fs.existsSync(p))assertRegularDirectory(p);fs.mkdirSync(output);
  const original=fs.readdirSync(sourceRoot).map(name=>path.join(sourceRoot,name)).find(directory=>fs.existsSync(path.join(directory,'result.json'))&&JSON.parse(fs.readFileSync(path.join(directory,'metadata.json'))).state==='complete');assert.ok(original);
  const sourceFile=path.join(original,'discrete-source.json'),partitionFile=path.join(original,'partition.json'),snapshot=readSmallJson(sourceFile,22*1024**2),domain=readSmallJson(partitionFile,64*1024**2),sourceInput=tetraExecutionInput(snapshot),native=validateNativeRuntime(path.join(backend.directory,'native'),backend.native);
  assert.equal(snapshot.cad.source.bodies.length,1);assert.equal(domain.sourceSolids.length,1);
  const sourceProof=['scripts/benchmark-discrete-validation.mjs','gateway/discrete-validation-envelope.mjs','gateway/discrete-native-validation.mjs','gateway/discrete-tetra-protocol.mjs','gateway/discrete-tetra-client.mjs','gateway/single-job-native-client.mjs','gateway/native-request-channel.mjs','gateway/discrete-tetra-task-result.mjs'].map(file=>({file,sha256:hashFile(path.join(root,file))})),inputs=[sourceFile,partitionFile].map(file=>({file:path.relative(root,file).replaceAll('\\','/'),sha256:hashFile(file)})),children=new Set(),cases=[];
  const spawnOwned=(...args)=>{const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));return child;};
  async function measured(mode,inputPath,outputPath){
    const child=spawnOwned(process.execPath,['--expose-gc','--max-old-space-size=1024',path.join(root,'scripts/benchmark-discrete-validation.mjs'),'--child',mode,inputPath,outputPath],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',failure;
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>65536){failure=Error('Benchmark child output limit');child.kill();}});child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-65536));
    const timer=setTimeout(()=>{failure=Error('Benchmark child deadline');child.kill();},60000);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));if(failure)throw failure;assert.equal(code,0,stderr);return JSON.parse(stdout);
  }
  const quality={version:1,mode:'diagnostic',threshold:.2,maxBadFraction:0},median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  try{
    for(const meshSize of [1,.2,.08]){
      const name='size-'+String(meshSize).replace('.','_'),client=new DiscreteTetraClient({workerPath:native.roles.mesh,runtimePath:native.meshBin,spawnImpl:spawnOwned});let result;
      try{result=await client.tetrahedralize({domain,meshSize,quality},{sourceInput});}finally{await client.closeAndWait();assert.equal(client.children.size,0);}
      assert.equal(result.execution.exitCode,0);const nativeFile=path.join(output,name+'.native.json');fs.writeFileSync(nativeFile,JSON.stringify(result),{flag:'wx'});
      const {processResources,algorithm,execution,...candidate}=result;assert.equal(processResources.enforced,true);assert.equal(algorithm.gmshVersion,'4.15.2');assert.equal(execution.automaticReplay,false);
      const fields={phase:'result',operation:'mesh.discrete-tetra',requestId:result.requestId,input:{domain,meshSize,quality},context:{sourceInput},candidate},inputPath=path.join(output,name+'.fields.json');fs.writeFileSync(inputPath,JSON.stringify(fields),{flag:'wx'});const runs=[];
      for(const [index,mode]of ['json-reference','binary','binary','json-reference','json-reference','binary'].entries()){
        const snapshotPath=path.join(output,name+'.run-'+index+(mode==='binary'?'.bin':'.json')),run=await measured(mode,inputPath,snapshotPath);runs.push({...run,file:path.relative(root,snapshotPath).replaceAll('\\','/')});
      }
      const reference=runs.find(run=>run.mode==='json-reference'),binary=runs.find(run=>run.mode==='binary'),raw=fs.readFileSync(path.join(root,binary.file)),data=new ArrayBuffer(raw.length);new Uint8Array(data).set(raw);const envelope={...binary.header,data},decoded=decodeDiscreteValidationBinary(envelope);
      assert.equal(decoded.sha256,binary.sha256);assert.equal(JSON.stringify(decoded.packet),fs.readFileSync(path.join(root,reference.file),'utf8'));assert.equal(crypto.createHash('sha256').update(JSON.stringify(decoded.packet)).digest('hex'),reference.sha256);assert.equal(validateDiscreteNativePacket(envelope).sha256,binary.sha256);
      const summary={name,meshSize,tetrahedra:result.report.tetraCount,nodes:result.points.length,nativeOutputBytes:fs.statSync(nativeFile).size,semanticEqualityAndNativeGeometryRevalidated:true,runs,medians:Object.fromEntries(['json-reference','binary'].map(mode=>{const rows=runs.filter(run=>run.mode===mode);return [mode,{elapsedMs:median(rows.map(run=>run.elapsedMs)),packagingStageMaxRssKiB:median(rows.map(run=>run.packagingStageMaxRssKiB)),encodedBytes:median(rows.map(run=>run.encodedBytes))}];}))};cases.push(summary);console.log(JSON.stringify({name,tetrahedra:summary.tetrahedra,medians:summary.medians}));
    }
    for(const item of [...sourceProof,...inputs])assert.equal(hashFile(path.join(root,item.file)),item.sha256);assert.equal(validateNativeRuntime(path.join(backend.directory,'native'),backend.native).sha256,native.sha256);assert.equal(children.size,0);
    const files=fileInventory(output),report={format:'web-cad-discrete-validation-packaging-benchmark',version:1,ok:true,createdAt:new Date().toISOString(),sourceProof,inputs,files,cases,environment:{node:process.version,platform:process.platform,architecture:process.arch,cpuExclusive:false,warmFilesystemCache:true,isolatedChildPerRun:true,childOldGenerationMiB:1024,explicitGCBeforePackaging:true},scope:'Packaging-stage parent-process measurements on actual independently revalidated one-CAD-box Gmsh tetrahedral results. Includes preloaded DTO and snapshot creation; excludes native generation, worker deep validation and snapshot-file writes from timed interval. maxRSS is sampled immediately after packaging and includes prior loading; separate whole-child-after-write maxRSS retained. Not full Gateway, whole-machine, dirty-geometry throughput, GPU or industrial peak-memory certification.',backendNative:{releaseId:backend.releaseId,nativeSha256:backend.native.sha256,workerSha256:hashFile(native.roles.mesh)},normalMeshAdmitted:false,childrenExited:true,dailyServicesChanged:false,paidProviderCalls:0};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,output,cases:cases.length}));
  }finally{for(const child of children){child.kill();await new Promise(resolve=>child.once('close',resolve));}}
}
