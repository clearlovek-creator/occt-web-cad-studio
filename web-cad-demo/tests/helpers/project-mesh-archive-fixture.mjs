import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {MeshJobStore} from '../../gateway/mesh-job-store.mjs';
import {cadDiscreteTetraFixture} from './cad-discrete-tetra-fixture.mjs';
import {assembleCadDiscreteTetraResult} from '../../gateway/cad-discrete-tetra.mjs';
import {tetraTaskResult,validateTetraTaskResult} from '../../gateway/discrete-tetra-task-result.mjs';
import {writeDiscreteMeshFiles} from '../../gateway/discrete-mesh-files.mjs';
import {captureProjectMeshArchive} from '../../gateway/project-mesh-archive.mjs';
export function archiveFixture(t,{derived=false,materials=['Copper'],state='complete'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-mesh-archive-')),store=new MeshJobStore(root),f=cadDiscreteTetraFixture({materials});
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-mesh-archive-/);fs.rmSync(root,{recursive:true,force:true});});
  const job={version:1,jobId:'mesh-'+crypto.randomUUID(),documentId:'doc',kind:'discrete-tetra',state:'running',discreteStage:'partition',source:f.source,materialSourceSha256:f.snapshot.materials.sha256,options:{discreteTetra:f.snapshot.settings,nativeSurfaceMemoryLimitBytes:2*1024**3,nativeMemoryLimitBytes:2*1024**3},createdAt:'2026-11-18T00:00:00Z',processResources:{partition:f.domain.processResources},artifact:{}};
  store.save(job);Object.assign(job.artifact,store.writeTetraArtifact(job,'discreteSource',f.snapshot).artifact);Object.assign(job.artifact,store.writeTetraArtifact(job,'partition',f.domain).artifact);
  let value;
  if(state==='complete'){
    job.processResources.tetra=f.output.processResources;value=assembleCadDiscreteTetraResult(f.snapshot,f.domain,f.output);const result=tetraTaskResult(job,value);Object.assign(job.artifact,store.writeResult(job,result));job.discreteTetraSummary=validateTetraTaskResult(result,job,f.snapshot,f.domain);job.state='complete';job.discreteStage='complete';job.finishedAt='2026-11-18T00:00:02Z';store.commitCompletion(job);
    if(derived){const directory=store.derivedDirectory(job);fs.mkdirSync(directory);writeDiscreteMeshFiles({directory,snapshot:f.snapshot,result:value,jobId:job.jobId});}
  }else{job.state=state;store.save(job);}
  const capture=()=>captureProjectMeshArchive({store,documentId:'doc',source:f.source,jobs:[job]});
  return {root,store,f,job,value,capture};
}
export function copyArchive(archive){return {...structuredClone({version:archive.version,source:archive.source,assets:archive.assets}),blobs:archive.blobs.map(blob=>({...blob,data:Buffer.from(blob.data)}))};}
export function replaceArchiveRole(archive,role,change){
  const asset=archive.assets[0],old=asset.files[role],blob=archive.blobs.find(blob=>blob.sha256===old),data=Buffer.from(JSON.stringify(change(JSON.parse(blob.data))));
  const sha256=crypto.createHash('sha256').update(data).digest('hex');asset.files[role]=sha256;archive.blobs=archive.blobs.filter(row=>row.sha256!==old||archive.assets.some(asset=>Object.values(asset.files).includes(old)));archive.blobs.push({sha256,bytes:data.length,data});return {sha256,bytes:data.length};
}
