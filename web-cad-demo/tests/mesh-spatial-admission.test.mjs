import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMeshAdmission} from '../gateway/mesh-admission.mjs';
import {admissionFixture} from './helpers/mesh-admission-fixture.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {withStreamedQualityIndex} from '../gateway/mesh-quality-stream.mjs';

function pair(first, second) {
  const f=admissionFixture();
  f.index.positions=[...first.flat(),...second.flat()];
  f.index.cells=[0,1].map(i=>({...f.index.cells[0],elementId:String(i+1),corners:[0,1,2,3].map(n=>n+4*i)}));
  f.mesh.nodeCount=8;f.mesh.elementCount=2;
  Object.assign(f.mesh.quality,{tetraCount:2,finiteCount:2});
  f.mesh.boundaryMapping.surfaces[0].elementCount=8;
  return f;
}
const unit=[[0,0,0],[1,0,0],[0,1,0],[0,0,1]];
const assess=f=>assessMeshAdmission(f.mesh,f.index,f.source);

test('positive quality and valid independent connectivity cannot admit a tetrahedron entirely inside another',()=>{
  const f=pair(unit,unit.map(p=>p.map(v=>v*.2+.1))),report=assess(f);
  assert.equal(report.counts.badCount,0);
  assert.equal(report.topology.duplicateTetraCount,0);
  assert.equal(report.usable,false);
  assert.ok(report.reasons.some(row=>row.code==='OVERLAPPING_TETRAHEDRA'));
});

test('crossing tetrahedra without any contained vertex are rejected as spatial overlap',()=>{
  const f=pair([[1,1,1],[-1,-1,1],[-1,1,-1],[1,-1,-1]],[[-1,-1,-1],[1,-1,1],[1,1,-1],[-1,1,1]]),report=assess(f);
  assert.equal(report.counts.badCount,0);
  assert.equal(report.usable,false);
  assert.ok(report.reasons.some(row=>row.code==='OVERLAPPING_TETRAHEDRA'));
});

test('streamed and in-memory spatial admission agree only after full digest verification',()=>{
  const f=pair(unit,unit.map(p=>p.map(v=>v*.2+.1))),directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-spatial-proof-')),file=path.join(directory,'index.json');
  try{
    fs.writeFileSync(file,JSON.stringify(f.index));
    const bytes=fs.readFileSync(file),job={jobId:f.index.requestId,source:f.source,artifact:{quality:{bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}}};
    const actual=withStreamedQualityIndex(file,job,index=>assessMeshAdmission(f.mesh,index,f.source),{chunkBytes:11});
    assert.deepEqual(actual.value,assess(f));assert.equal(actual.metrics.retainedCellObjects,0);
    fs.appendFileSync(file,' ');
    assert.throws(()=>withStreamedQualityIndex(file,job,index=>assessMeshAdmission(f.mesh,index,f.source)),{code:'MESH_ARTIFACT_INVALID'});
  }finally{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^cad-spatial-proof-/);fs.rmSync(directory,{recursive:true,force:true});}
});
test('curved elements remain available only with explicit untested spatial coverage, not a fictitious corner-based no-intersection proof',()=>{
  const f=admissionFixture();f.index.cells[0].elementType=11;f.index.cells[0].order=2;
  const report=assess(f);assert.equal(report.status,'warning');assert.equal(report.spatial.status,'partial');assert.equal(report.spatial.checkedTetraCount,0);
  assert.ok(report.reasons.some(row=>row.code==='CURVED_TETRA_SPATIAL_UNCHECKED'));
});
test('resource exhaustion never returns a partially checked usable mesh',()=>{
  const f=pair(unit,unit.map(p=>p.map(v=>v*.2+.1)));
  assert.throws(()=>assessMeshAdmission(f.mesh,f.index,f.source,{spatialLimits:{bytes:1}}),{code:'MESH_ARTIFACT_LIMIT'});
});
