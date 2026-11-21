import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../gateway/native-runtime-release.mjs';
import {fileInventory,hashFile,assertRegularDirectory} from '../gateway/frontend-release.mjs';
import {sheetConstraintCases} from '../tests/helpers/sheet-constraint-corpus.mjs';
const root=path.resolve(import.meta.dirname,'..'),releaseRoot=path.resolve(process.env.SHEET_CONSTRAINT_BACKEND_ROOT||'.artifacts/sheet-constraints-backend-releases'),output=path.resolve(process.env.SHEET_CONSTRAINT_ARTIFACTS||'.artifacts/sheet-constraints-native-checks');
for(const target of [releaseRoot,output])assert.ok(target.startsWith(path.join(root,'.artifacts')+path.sep));assert.equal(fs.existsSync(output),false);for(let p=path.dirname(output);p!==root;p=path.dirname(p))if(fs.existsSync(p))assertRegularDirectory(p);
const backend=selectBackendRelease(releaseRoot),native=validateNativeRuntime(path.join(backend.directory,'native'),backend.native),load=name=>import(pathToFileURL(path.join(backend.directory,'runtime/gateway',name)).href);
const {DiscreteSurfaceClient}=await load('discrete-surface-client.mjs'),{assertConstrainedVolumeResult}=await load('volume-partition-protocol.mjs');
const sources=['scripts/verify-sheet-constraint-worker.mjs','tests/helpers/sheet-constraint-corpus.mjs','tests/helpers/discrete-industrial-corpus.mjs'].map(file=>({file,sha256:hashFile(path.join(root,file))}));
fs.mkdirSync(output);const children=new Set(),records=[],save=(name,value)=>fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(value,null,2),{flag:'wx'});
const spawnImpl=(...args)=>{const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));return child;};
for(const item of sheetConstraintCases()){
  const start=performance.now(),client=new DiscreteSurfaceClient({workerPath:native.roles.discrete,runtimePath:native.discreteBin,spawnImpl});save(item.name+'.input',item.input);
  try{
    if(item.reject){let failure;try{await client.partitionConstrained(item.input);}catch(error){failure=error;}assert.ok(item.reject.includes(failure?.code),failure?.message);save(item.name+'.rejection',{code:failure.code,message:failure.message,execution:failure.execution});records.push({name:item.name,ok:true,rejection:failure.code});}
    else{
      const result=await client.partitionConstrained(item.input);assertConstrainedVolumeResult(result,item.input,result.requestId);assert.equal(result.execution.exitCode,0);assert.equal(result.processResources.enforced,true);
      assert.ok(Math.abs(result.report.unionVolume-item.volume)<1e-8*item.volume);assert.equal(result.report.normalMeshAdmitted,false);assert.equal(result.report.tetrahedralReady,false);
      for(const [key,value]of [['embeddedTriangles',item.embedded],['exteriorTriangles',item.exterior],['boundarySheetTriangles',item.boundarySheet]])assert.equal(result.constraints.report[key]>0,value);
      const embeddedCells=new Set(result.constraints.triangles.flatMap(row=>row.cellIndexes));if(item.embeddedCells)assert.equal(embeddedCells.size,item.embeddedCells);if(item.shared)assert.ok(result.report.sharedInterfaceTriangles>0);
      if(item.cells)assert.equal(result.cells.length,item.cells);
      assert.ok(result.sourceSolids.every(source=>!source.bodyId.startsWith('sheet-')));save(item.name+'.result',result);records.push({name:item.name,ok:true,volume:result.report.unionVolume,cells:result.cells.length,triangles:result.triangles.length,...result.constraints.report});
    }
  }catch(error){records.push({name:item.name,ok:false,code:error.code,error:error.stack});}
  finally{await client.closeAndWait();assert.equal(client.children.size,0);}
  records.at(-1).elapsedMs=Math.round(performance.now()-start);console.log(JSON.stringify(records.at(-1)));
}
assert.equal(children.size,0);for(const source of sources)assert.equal(hashFile(path.join(root,source.file)),source.sha256);assert.equal(selectBackendRelease(releaseRoot,backend.releaseId).manifestSha256,backend.manifestSha256);validateNativeRuntime(path.join(backend.directory,'native'),backend.native);
const result={format:'web-cad-sheet-constraint-worker-verification',version:1,ok:records.every(row=>row.ok),createdAt:new Date().toISOString(),scope:'Exact constrained domain classification in the existing guarded CGAL core and client. Tetra embedding, CAD task integration and normal mesh admission are not yet enabled.',backend:{releaseId:backend.releaseId,manifestSha256:backend.manifestSha256,sourceSha256:backend.sourceSha256,nativeSha256:backend.native.sha256},sourceProof:sources,counts:{total:records.length,passed:records.filter(row=>row.ok).length,failed:records.filter(row=>!row.ok).length},records,files:fileInventory(output),childrenExited:true,dailyServicesChanged:false,paidProviderCalls:0,normalMeshAdmitted:false,productTaskIntegration:false,publicDistributionQualified:false};save('result',result);console.log(JSON.stringify({ok:result.ok,counts:result.counts}));if(!result.ok)process.exitCode=1;
