import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MeshWorkerClient} from '../gateway/mesh-worker-client.mjs';
import {spawnSync} from 'node:child_process';

test('native preparation partitions multiple overlapping Solids even when they belong to one imported Body',()=>{
  const worker=process.env.GEOMETRY_WORKER_PATH||path.resolve('geometry-worker/build/occt_geometry_worker.exe');
  const env={...process.env},inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;env.PATH=[path.resolve('../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  const result=spawnSync(path.join(path.dirname(worker),'mesh_preparation_tests.exe'),[],{env,windowsHide:true,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,`${result.error?.message||''}\n${result.stderr}\n${result.stdout}`);assert.match(result.stdout,/single Body multi-Solid partition/);
});

function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-face-中文-'));
  const geometry=new MeshWorkerClient({workerPath:process.env.GEOMETRY_WORKER_PATH||path.resolve('geometry-worker/build/occt_geometry_worker.exe'),runtimePath:[path.resolve('../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin'].join(path.delimiter)});
  const mesh=new MeshWorkerClient({workerPath:process.env.MESH_WORKER_PATH||path.resolve('mesh-worker/build-gmsh/gmsh_mesh_worker.exe'),runtimePath:'C:/msys64/ucrt64/bin'});
  let revision=0,sequence=0;
  const cad=async(operation,parameters={},inputs={})=>{const result=await geometry.request({protocolVersion:1,operation,requestId:'cad-'+(++sequence),documentId:'test',baseRevision:revision,parameters,inputs});if(Number.isInteger(result.revision))revision=result.revision;return result;};
  const prepare=async(mode='conservative',options={})=>{
    const brep=path.join(directory,'prepared-'+(++sequence)+'.brep'),manifestPath=brep+'.json';
    const response=await cad('mesh.prepare',{path:brep,manifestPath,repairMode:mode,...options});return {brep,manifest:JSON.parse(fs.readFileSync(manifestPath)),response};
  };
  const create=prepared=>mesh.request({protocolVersion:1,operation:'mesh.create',requestId:'mesh-'+(++sequence),parameters:{inputPath:prepared.brep,outputPath:path.join(directory,'mesh-'+sequence+'.msh'),dimension:3,repairMode:prepared.manifest.preprocessing.repairMode,resolveIntersections:true,bodyIds:prepared.manifest.bodies.filter(b=>b.kind==='solid').map(b=>b.bodyId),bodyManifest:prepared.manifest}});
  const close=async()=>{await Promise.all([geometry.closeAndWait(),mesh.closeAndWait()]);fs.rmSync(directory,{recursive:true,force:true});};
  return {directory,cad,prepare,create,close};
}

test('OCCT mesh snapshot keeps exact Face history through a touching interface without mutating the CAD document',async()=>{
  const f=fixture();try{
    await f.cad('primitive.box',{width:10,depth:10,height:10});await f.cad('primitive.box',{width:10,depth:10,height:10,x:10});
    const before=await f.cad('document.summary'),rawBefore=path.join(f.directory,'before.brep');await f.cad('brep.export',{path:rawBefore});
    const prepared=await f.prepare();assert.equal(prepared.manifest.preprocessing.faceMappingComplete,true);
    assert.equal(prepared.manifest.solids.length,2);assert.equal(prepared.manifest.faces.length,11);assert.equal(prepared.manifest.sourceFaces.length,12);
    const shared=prepared.manifest.faces.filter(face=>face.adjacentSolidIndices.length===2);assert.equal(shared.length,1);assert.equal(shared[0].sources.length,2);
    const result=await f.create(prepared),boundary=result.mesh.boundaryMapping;
    assert.equal(boundary.complete,true);assert.equal(boundary.sourceFaces.length,12);assert.equal(boundary.surfaces.length,11);
    const interfaceFace=boundary.surfaces.find(face=>face.adjacentSolidIds.length===2);assert.equal(interfaceFace.sources.length,2);assert.ok(interfaceFace.elementCount>0);
    for(const source of interfaceFace.sources){const entry=boundary.sourceFaces.find(face=>face.source.bodyId===source.bodyId&&face.source.cadFaceId===source.cadFaceId);assert.deepEqual(entry.surfaceTags,[interfaceFace.surfaceTag]);}
    assert.equal(result.mesh.conformity.nonConformalCount,0);assert.ok(result.mesh.conformity.interfaces.some(face=>face.nodeCount>0));
    const msh=fs.readFileSync(result.mesh.outputPath,'utf8');for(const source of interfaceFace.sources)assert.ok(msh.includes(`CADFace/${source.bodyId}/${source.cadFaceId}`));
    for(const group of result.mesh.render.groups)for(const face of group.faces){assert.match(face.meshFaceId,/^mesh-face-/);assert.ok(face.cadSources.length>0);}
    const after=await f.cad('document.summary');assert.deepEqual(after,{...before,requestId:after.requestId});
    const rawAfter=path.join(f.directory,'after.brep');await f.cad('brep.export',{path:rawAfter});assert.equal(fs.readFileSync(rawBefore,'utf8'),fs.readFileSync(rawAfter,'utf8'),'Preparing a mesh must not heal or tessellate live CAD shapes');
  }finally{await f.close();}
});

test('prepared mesh rejects a mismatched face certificate, adjacency or identity instead of guessing ownership',async()=>{
  const f=fixture();try{
    await f.cad('primitive.box',{width:10,depth:12,height:14});const prepared=await f.prepare('strict');
    for(const change of [manifest=>{manifest.faces[0].area+=5;},manifest=>{manifest.faces[0].adjacentSolidIndices=[];},manifest=>{manifest.faces[0].sources[0].topologyIdentity='0'.repeat(32);},manifest=>{manifest.sourceFaces[0].faceIndices=[];manifest.sourceFaces[0].state='removed';}]){
      const invalid={...prepared,manifest:structuredClone(prepared.manifest)};change(invalid.manifest);await assert.rejects(f.create(invalid),/certificate|adjacency|identity|provenance/);
    }
    assert.equal((await f.create(prepared)).mesh.boundaryMapping.complete,true,'A rejected input must not poison the next worker request');
  }finally{await f.close();}
});

test('analytic mesh snapshot bounds are distinct from strict index certificates, with legacy certificate compatibility and unknown versions rejected',async()=>{
  const f=fixture();try{
    await f.cad('primitive.torus',{majorRadius:8,minorRadius:2});const prepared=await f.prepare();
    assert.equal(prepared.manifest.preprocessing.indexCertificateVersion,1);assert.ok(prepared.manifest.solids.every(solid=>solid.indexCertificate.boundsPolicy==='occt-brep-conservative'));
    assert.equal((await f.create(prepared)).mesh.boundaryMapping.complete,true);
    for(const change of [manifest=>manifest.preprocessing.indexCertificateVersion=99,manifest=>delete manifest.faces[0].indexCertificate,manifest=>manifest.solids[0].indexCertificate.bounds.min[0]-=5,manifest=>manifest.faces[0].indexCertificate.triangulationUsed=true,manifest=>manifest.faces[0].bounds.max[0]+=1000]){
      const invalid={...prepared,manifest:structuredClone(prepared.manifest)};change(invalid.manifest);await assert.rejects(f.create(invalid),/certificate|bounds|policy/);
    }
    const legacy={...prepared,manifest:structuredClone(prepared.manifest)};delete legacy.manifest.preprocessing.indexCertificateVersion;for(const record of [...legacy.manifest.solids,...legacy.manifest.faces]){record.bounds=record.indexCertificate.bounds;delete record.indexCertificate;}
    assert.equal((await f.create(legacy)).mesh.boundaryMapping.complete,true,'Already saved v2 snapshots retain their original conservative certificate contract');
  }finally{await f.close();}
});

test('all nine solid constructors retain CAD face sources through strict BREP import and tetrahedral meshing',async()=>{
  const f=fixture();try{
    const primitives={box:{width:10,depth:12,height:14},cylinder:{radius:5,height:14},cone:{radius1:6,radius2:2,height:14},sphere:{radius:6},torus:{majorRadius:8,minorRadius:2},wedge:{width:10,depth:12,height:14,topLength:4},prism:{radius:6,sides:6,height:14},pyramid:{baseWidth:10,baseDepth:12,topWidth:4,topDepth:5,height:14},tube:{outerRadius:6,innerRadius:3,height:14}};
    for(const [kind,parameters] of Object.entries(primitives)){
      await f.cad('document.create');await f.cad('primitive.'+kind,parameters);
      const prepared=await f.prepare('conservative',{deepCheck:true,includePreview:true}),result=await f.create(prepared);assert.equal(result.mesh.boundaryMapping.complete,true,kind);assert.equal(prepared.response.diagnostics.status,'ready',kind);assert.ok(prepared.response.preview.positions.length>0,kind);
      assert.ok(result.mesh.boundaryMapping.sourceFaces.every(face=>face.state==='mapped'&&face.surfaceTags.length>0),kind);
      assert.ok(result.mesh.quality.tetraCount>0,kind);
    }
  }finally{await f.close();}
});

test('all five Sheet constructors keep surface mesh ownership alongside a Solid, including an embedded planar interface',async()=>{
  const f=fixture();try{
    for(const [kind,parameters] of Object.entries({rectangle:{width:40,height:40,z:0},disk:{radius:6,x:40},cylinder:{radius:6,height:10,x:40},cone:{radius1:6,radius2:2,height:10,x:40},sphere:{radius:6,x:40}})){
      await f.cad('document.create');await f.cad('primitive.box',{width:20,depth:20,height:20,x:-10,y:-10,z:-10});const sheet=await f.cad('surface.'+kind,parameters);
      const prepared=await f.prepare(),result=await f.create(prepared);assert.equal(result.mesh.boundaryMapping.complete,true,kind);
      const groups=result.mesh.render.groups.filter(group=>group.bodyId===sheet.bodyId);assert.ok(groups.length>0,kind);assert.ok(groups.every(group=>group.sourceBodySurface&&group.wirePositions.length>0),kind);
      if(kind==='rectangle'){
        const interfaceFace=result.mesh.boundaryMapping.surfaces.find(face=>face.sources.some(source=>source.bodyId===sheet.bodyId)&&face.adjacentSolidIds.length===2);assert.ok(interfaceFace,'An internal Sheet must split and share the volume interface');assert.equal(result.mesh.conformity.nonConformalCount,0);
      }
    }
  }finally{await f.close();}
});

test('open internal and partially intersecting Sheets constrain tetrahedra through actual shared mesh nodes',async()=>{
  const f=fixture();try{
    for(const parameters of [{width:8,height:8},{width:40,height:40,x:-20,y:-20}]){
      await f.cad('document.create');await f.cad('primitive.box',{width:20,depth:20,height:20,x:-10,y:-10,z:-10});const sheet=await f.cad('surface.rectangle',parameters);
      const prepared=await f.prepare(),result=await f.create(prepared);
      const embedded=result.mesh.boundaryMapping.surfaces.filter(face=>face.sources.some(source=>source.bodyId===sheet.bodyId)&&face.embeddedSolidIds.length>0);
      assert.ok(embedded.length>0,'The internal Sheet must be certified as an embedded constraint, not a volume boundary');
      assert.ok(result.mesh.conformity.embeddedSurfaceCount>0);assert.equal(result.mesh.conformity.nonConformalCount,0);
      for(const face of embedded){const proof=result.mesh.conformity.interfaces.find(item=>item.surfaceTag===face.surfaceTag);assert.equal(proof.role,'embedded');assert.ok(proof.nodeCount>0);assert.equal(proof.missingNodeReferences,0);}
    }
  }finally{await f.close();}
});
