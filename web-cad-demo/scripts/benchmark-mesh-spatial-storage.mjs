/** Offline spatial-index accounting only. Not native mesher or process peak RSS. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {LinearTetraSpatial,MESH_SPATIAL_LIMITS} from '../gateway/mesh-spatial.mjs';
const root=path.resolve(import.meta.dirname,'..'),inputs=['gateway/mesh-spatial.mjs','scripts/benchmark-mesh-spatial-storage.mjs'];
const snapshot=()=>Object.fromEntries(inputs.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
const sources=snapshot(),cases=[],patterns=[[0,1,3,7],[0,5,1,7],[0,3,2,7],[0,2,6,7],[0,4,5,7],[0,6,4,7]];
for(const count of [100000,1000000]){
  const cubes=Math.ceil(count/6),positions=new Float64Array((cubes+1)*12);
  for(let x=0;x<=cubes;x++)positions.set([x,0,0,x,1,0,x,0,1,x,1,1],x*12);
  const spatial=new LinearTetraSpatial(count,n=>positions[n]),start=performance.now();let row=0;
  for(let x=0;row<count;x++){
    const nodes=[4*x,4*(x+1),4*x+1,4*(x+1)+1,4*x+2,4*(x+1)+2,4*x+3,4*(x+1)+3];
    for(const pattern of patterns){if(row===count)break;spatial.add({elementId:String(1000000000000n+BigInt(row)),elementType:4,order:1,volumeTag:1,corners:pattern.map(i=>nodes[i])},true);row++;}
  }
  const report=spatial.finish();assert.equal(report.checkedTetraCount,count);assert.equal(report.overlapPairCount,0);assert.ok(report.resources.peakAccountedBytes<=MESH_SPATIAL_LIMITS.bytes);
  cases.push({kind:'conforming-linear-strip',cells:count,elementIdDigits:13,elapsedMs:performance.now()-start,blocks:spatial.blocks.length,coordinateBytes:positions.byteLength,resources:report.resources});
  console.log(JSON.stringify(cases.at(-1)));
}
const curved=new LinearTetraSpatial(MESH_SPATIAL_LIMITS.cells,()=>0),started=performance.now();
for(let n=0;n<MESH_SPATIAL_LIMITS.cells;n++)curved.add({order:2,elementType:11});
const report=curved.finish();assert.equal(report.resources.accountedBytes,0);assert.equal(report.resources.peakAccountedBytes,0);
cases.push({kind:'curved-spatial-skip-only',cells:MESH_SPATIAL_LIMITS.cells,elapsedMs:performance.now()-started,resources:report.resources});
assert.deepEqual(snapshot(),sources,'Storage benchmark source changed; mixed-source proof refused');
const output=path.join(root,'.artifacts/performance/mesh-spatial-block-storage.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({node:process.version,sources,scope:'offline spatial-index accounting for a synthetic conforming strip with 13-digit element IDs and curved skip path; not a CAD/Gmsh mesh, online responsiveness, complete high-order admission or process peak RSS; caches not cleared, CPU nonexclusive',cases},null,2));console.log(output);
