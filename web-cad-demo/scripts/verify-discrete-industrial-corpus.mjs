import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../gateway/native-runtime-release.mjs';
import {assertRegularDirectory,hashFile} from '../gateway/frontend-release.mjs';
import {discreteIndustrialCases} from '../tests/helpers/discrete-industrial-corpus.mjs';

const root=path.resolve(import.meta.dirname,'..');
const releaseRoot=path.resolve(process.env.DISCRETE_CORPUS_BACKEND_ROOT||'.artifacts/mesh-project-transaction-backend-releases');
const output=path.resolve(process.env.DISCRETE_CORPUS_ARTIFACTS||'.artifacts/discrete-industrial-baseline');
for(const target of [releaseRoot,output])assert.ok(target.startsWith(path.join(root,'.artifacts')+path.sep));
assert.ok(!fs.existsSync(output));
for(let parent=path.dirname(output);parent!==root;parent=path.dirname(parent))if(fs.existsSync(parent))assertRegularDirectory(parent);
const backend=selectBackendRelease(releaseRoot),native=validateNativeRuntime(path.join(backend.directory,'native'),backend.native);
const modulePath=name=>pathToFileURL(path.join(backend.directory,'runtime/gateway',name)).href;
const {DiscreteSurfaceClient}=await import(modulePath('discrete-surface-client.mjs'));
const {DiscreteTetraClient}=await import(modulePath('discrete-tetra-client.mjs'));
const {assertVolumePartitionResult}=await import(modulePath('volume-partition-protocol.mjs'));
const {assertDiscreteTetraResult}=await import(modulePath('discrete-tetra-protocol.mjs'));
const sourceProof=['scripts/verify-discrete-industrial-corpus.mjs','tests/helpers/discrete-industrial-corpus.mjs'].map(file=>({file,sha256:hashFile(path.join(root,file))}));
fs.mkdirSync(output);const children=new Set(),records=[];
const save=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2),{flag:'wx'});
const spawnImpl=(...args)=>{const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));return child;};
const diagnostic={version:1,mode:'diagnostic',threshold:.2,maxBadFraction:0};
for(const item of discreteIndustrialCases()){
  const start=performance.now(),domainClient=new DiscreteSurfaceClient({workerPath:native.roles.discrete,runtimePath:native.discreteBin,spawnImpl});
  const tetraClient=new DiscreteTetraClient({workerPath:native.roles.mesh,runtimePath:native.meshBin,spawnImpl});
  let stage='partition';save(item.name+'.input.json',item.input);
  try{
    if(item.reject){
      await assert.rejects(domainClient.partition(item.input),error=>item.reject.includes(error.code));
      records.push({name:item.name,ok:true,expectedRejection:true});
    }else{
      const domain=await domainClient.partition(item.input);assertVolumePartitionResult(domain,item.input,domain.requestId);
      assert.ok(Math.abs(domain.report.unionVolume-item.volume)<=1e-6*item.volume);
      assert.equal(domain.execution.exitCode,0);assert.equal(domain.processResources.enforced,true);save(item.name+'.domain.json',domain);
      stage='tetra';const input={domain,meshSize:item.meshSize,quality:diagnostic,...item.optimization&&{optimization:item.optimization}};
      const result=await tetraClient.tetrahedralize(input,{sourceInput:item.input});assertDiscreteTetraResult(result,input,result.requestId);
      assert.equal(result.execution.exitCode,0);assert.equal(result.processResources.enforced,true);save(item.name+'.tetra.json',result);
      stage='strict';let strict;
      try{
        const accepted=await tetraClient.tetrahedralize({...input,quality:{...diagnostic,mode:'strict'}},{sourceInput:item.input});
        assert.equal(accepted.quality.meetsRequestedQuality,true);save(item.name+'.strict.json',accepted);strict={accepted:true};
      }catch(error){
        assert.equal(error.code,'MESH_QUALITY_REJECTED');assert.equal(error.details.quality.meetsRequestedQuality,false);assert.equal(error.execution.exitCode,2);
        strict={accepted:false,code:error.code,minimumSICN:error.details.quality.minimumSICN};save(item.name+'.strict-rejection.json',strict);
      }
      records.push({name:item.name,ok:true,cells:domain.cells.length,volume:domain.report.unionVolume,tetrahedra:result.report.tetraCount,minimumSICN:result.quality.minimumSICN,optimization:result.optimization.disposition||'not-requested',strict});
    }
  }catch(error){records.push({name:item.name,ok:false,stage,code:error.code,error:error.stack});}
  finally{await domainClient.closeAndWait();await tetraClient.closeAndWait();assert.equal(domainClient.children.size,0);assert.equal(tetraClient.children.size,0);}
  records.at(-1).elapsedMs=Math.round(performance.now()-start);console.log(JSON.stringify(records.at(-1)));
}
assert.equal(children.size,0);
for(const item of sourceProof)assert.equal(hashFile(path.join(root,item.file)),item.sha256);
assert.equal(selectBackendRelease(releaseRoot,backend.releaseId).manifestSha256,backend.manifestSha256);
validateNativeRuntime(path.join(backend.directory,'native'),backend.native);
const result={format:'web-cad-discrete-industrial-corpus-verification',version:1,ok:records.every(row=>row.ok),createdAt:new Date().toISOString(),scope:'Synthetic analytic geometry stress corpus; not production CAD qualification. Diagnostic results are not admitted normal meshes.',backend:{releaseId:backend.releaseId,manifestSha256:backend.manifestSha256,sourceSha256:backend.sourceSha256,nativeSha256:backend.native.sha256},sourceProof,records,counts:{total:records.length,passed:records.filter(row=>row.ok).length,failed:records.filter(row=>!row.ok).length},childrenExited:true,dailyServicesChanged:false,publicDistributionQualified:false,paidProviderCalls:0};
save('result.json',result);console.log(JSON.stringify({ok:result.ok,counts:result.counts,output}));if(!result.ok)process.exitCode=1;
