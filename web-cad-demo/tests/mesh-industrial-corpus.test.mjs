import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {MeshWorkerClient} from '../gateway/mesh-worker-client.mjs';
import {assessMeshAdmission,captureMeshInventory} from '../gateway/mesh-admission.mjs';
import {validateQualityIndex} from '../gateway/mesh-quality-query.mjs';
import {validateMeshBoundary} from '../gateway/mesh-boundary-query.mjs';

test('representative industrial preprocessing corpus preserves source BREP, source volumes, conformal constraints and usable tetrahedral coverage',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-industrial-corpus-中文-')),geometry=process.env.GEOMETRY_WORKER_PATH||path.resolve('geometry-worker/build/occt_geometry_worker.exe');
  const env={...process.env},inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;env.PATH=[path.resolve('../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  const worker=new MeshWorkerClient({workerPath:process.env.MESH_WORKER_PATH||path.resolve('mesh-worker/build-gmsh/gmsh_mesh_worker.exe'),runtimePath:'C:/msys64/ucrt64/bin',timeoutMs:120000});
  try{
    const generated=spawnSync(path.join(path.dirname(geometry),'mesh_industrial_corpus_tests.exe'),[],{env,windowsHide:true,encoding:'utf8',input:JSON.stringify({directory})+'\n',timeout:120000});assert.equal(generated.status,0,`${generated.error?.message||''}\n${generated.stderr}\n${generated.stdout}`);
    const samples=JSON.parse(fs.readFileSync(path.join(directory,'industrial-corpus.json')));assert.equal(samples.length,13);
    for(const sample of samples)await t.test(sample.id,async()=>{
      for(let body=0;body<sample.sourceCount;body++)assert.deepEqual(fs.readFileSync(path.join(directory,`${sample.id}-source-${body}-before.brep`)),fs.readFileSync(path.join(directory,`${sample.id}-source-${body}-after.brep`)),'Preparation must not mutate the original topology or caches');
      if(sample.expectedBlocked){assert.equal(sample.prepared,false);assert.equal(sample.diagnostics.status,'blocked');assert.ok(sample.errorCode);return;}
      assert.equal(sample.diagnostics.status,'ready');const manifest=JSON.parse(fs.readFileSync(path.join(directory,sample.id+'-manifest.json'))),source={version:1,documentId:'industrial-corpus',revision:1,bodies:manifest.bodies};
      const volumes=new Map();for(const solid of manifest.solids)for(const bodyId of new Set(solid.sources.map(row=>row.bodyId)))volumes.set(bodyId,(volumes.get(bodyId)||0)+solid.volume);
      for(const [bodyId,expected] of Object.entries(sample.expectedBodyVolumes))assert.ok(Math.abs(volumes.get(bodyId)-expected)<=1e-8*Math.max(1,expected),`${sample.id}/${bodyId} volume mismatch ${volumes.get(bodyId)} != ${expected}`);
      const indexPath=path.join(directory,sample.id+'-quality.json'),requestId='industrial-'+sample.id,result=await worker.request({protocolVersion:1,requestId,operation:'mesh.create',parameters:{inputPath:path.join(directory,sample.id+'-prepared.brep'),outputPath:path.join(directory,sample.id+'.msh'),qualityOutputPath:indexPath,bodyManifest:manifest,bodyIds:manifest.bodies.filter(body=>body.kind==='solid').map(body=>body.bodyId),dimension:3,repairMode:sample.mode,qualityThreshold:.2}});
      assert.equal(result.ok,true,JSON.stringify(result));result.mesh.sourceInventory=captureMeshInventory(manifest);validateMeshBoundary(result.mesh.boundaryMapping,source);const index=validateQualityIndex(JSON.parse(fs.readFileSync(indexPath)),{jobId:requestId,source}),admission=assessMeshAdmission(result.mesh,index,source);assert.equal(admission.usable,true,JSON.stringify({sample:sample.id,admission}));assert.equal(admission.counts.volumeCount,manifest.solids.length);assert.equal(admission.counts.meshedVolumeCount,manifest.solids.length);assert.equal(result.mesh.boundaryMapping.complete,true);
      assert.equal(admission.spatial.status,'complete');assert.equal(admission.spatial.checkedTetraCount,index.cells.length);assert.equal(admission.spatial.overlapPairCount,0,'The real linear mesh must not contain positive-volume cell overlap');
      if(sample.id==='crossed-internal-sheets')assert.ok(result.mesh.conformity.embeddedSurfaceCount>=4,'Both crossing Sheet sources must be split and embedded');
      if(sample.id==='near-coincident-gap')assert.equal(result.mesh.conformity.interfaceCount,0,'A real gap must not be silently joined');
    });
  }finally{await worker.closeAndWait();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});}
});
