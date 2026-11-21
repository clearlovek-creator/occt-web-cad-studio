import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {assertVolumePartitionInput,assertVolumePartitionResult,assertConstrainedVolumeInput,assertConstrainedVolumeHandshake,assertConstrainedVolumeResult} from '../gateway/volume-partition-protocol.mjs';
import {assertDiscreteTetraInput,normalizeDiscreteTetraInput} from '../gateway/discrete-tetra-protocol.mjs';
import {DiscreteSurfaceClient} from '../gateway/discrete-surface-client.mjs';
import {constrainedInput,constrainedHealth,constrainedResult} from './helpers/constrained-volume-fixture.mjs';
import {volumeHealth} from './helpers/volume-partition-fixture.mjs';

test('open Sheet constraints are explicit and do not weaken the legacy closed-volume input',()=>{
  const input=constrainedInput();assert.equal(assertConstrainedVolumeInput(input),input);
  assert.throws(()=>assertVolumePartitionInput(input),{code:'VOLUME_FREE_SHEET_UNSUPPORTED'});
  const sheetOnly=structuredClone(input);for(const source of sheetOnly.sources)delete source.solidId;
  assert.throws(()=>assertConstrainedVolumeInput(sheetOnly),{code:'VOLUME_SOLID_REQUIRED'});
  input.sources[12].solidId='';assert.throws(()=>assertConstrainedVolumeInput(input),{code:'VOLUME_REQUEST_INVALID'});
});
test('constrained partition requires its own pinned capability, not a guessed legacy capability',()=>{
  assert.equal(assertConstrainedVolumeHandshake(constrainedHealth()).basis,constrainedResult().basis);
  assert.throws(()=>assertConstrainedVolumeHandshake(volumeHealth()),{code:'VOLUME_PROTOCOL_INVALID'});
  const health=constrainedHealth();health.capabilities.constrainedVolumePartition.constraintBasis='guessed';assert.throws(()=>assertConstrainedVolumeHandshake(health),{code:'VOLUME_PROTOCOL_INVALID'});
});
test('an internal Sheet is retained without becoming a closed-cell shell or changing volume',()=>{
  const result=assertConstrainedVolumeResult(constrainedResult(),constrainedInput(),'partition');
  assert.equal(result.report.unionVolume,8);assert.equal(result.cells[0].shells[0].triangleIndexes.length,12);assert.equal(result.sourceSolids.length,1);assert.equal(result.triangles.length,14);
  assert.throws(()=>assertVolumePartitionResult(result,constrainedInput(),'partition'),{code:'VOLUME_PROTOCOL_INVALID'});
  // Tetra embedding and final mesh admission are separate gates, not enabled by
  // a new classification report or by changing an operation string.
  assert.throws(()=>assertDiscreteTetraInput(normalizeDiscreteTetraInput({domain:result}),{sourceInput:constrainedInput()}),{code:'MESH_DOMAIN_UNQUALIFIED'});
});
const mutations={
  'missing constraints':r=>delete r.constraints,
  'unknown constraint field':r=>r.constraints.path='private',
  'wrong classification basis':r=>r.constraints.basis='guessed',
  'missing triangle classification':r=>r.constraints.triangles.pop(),
  'invented cell':r=>r.constraints.triangles[12].cellIndexes=[1],
  'multiple embedded cells':r=>r.constraints.triangles[12].cellIndexes=[0,0],
  'boundary mislabeled as interior':r=>r.constraints.triangles[0]={kind:'embedded',cellIndexes:[0]},
  'Sheet mislabeled as shell':r=>r.constraints.triangles[12]={kind:'boundary',cellIndexes:[]},
  'exterior with volume owner':r=>r.constraints.triangles[12].kind='exterior',
  'unknown classification field':r=>r.constraints.triangles[12].orientation=1,
  'false embedded count':r=>r.constraints.report.embeddedTriangles=0,
  'false exterior count':r=>r.constraints.report.exteriorTriangles=1,
  'false Sheet face count':r=>r.constraints.report.sheetSourceFaces=2,
  'altered source coverage':r=>r.sourceTriangleIds[12]=[13],
  'Sheet added to source Solids':r=>r.sourceSolids.push({bodyId:'sheet-1',solidId:'solid-2',volume:1,partitionVolume:1}),
  'Sheet inserted into shell':r=>r.cells[0].shells[0].triangleIndexes.push(12),
};
for(const [name,mutate]of Object.entries(mutations))test('constrained volume rejects '+name,()=>{const result=constrainedResult();mutate(result);assert.throws(()=>assertConstrainedVolumeResult(result,constrainedInput(),'partition'),{code:'VOLUME_PROTOCOL_INVALID'});});

test('constrained volume uses the existing single-job transport and exact process-exit ownership',async t=>{
  const writes=[],children=[];let legacy=false;
  const spawnImpl=()=>{
    const child=new EventEmitter();Object.assign(child,{pid:777700,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new EventEmitter(),exitCode:null,signalCode:null});
    const exit=()=>{if(child.exitCode!==null)return;child.exitCode=0;child.emit('exit',0);child.stdout.end();child.stderr.end();child.emit('close',0);};
    child.kill=()=>{exit();return true;};child.stdin.writable=true;child.stdin.write=(wire,callback)=>{const request=JSON.parse(wire);writes.push(request);queueMicrotask(()=>{const result=request.operation==='health.ping'?(legacy?volumeHealth:constrainedHealth)(request.requestId):constrainedResult(request.requestId);child.stdout.write(JSON.stringify(result)+'\n');if(request.operation!=='health.ping')exit();});callback?.();return true;};children.push(child);return child;
  };
  const client=new DiscreteSurfaceClient({workerPath:'C:/private/surface.exe',spawnImpl,timeoutMs:1000,stopTimeoutMs:50});t.after(async()=>{for(const child of children)child.kill();await client.closeAndWait();});
  const result=await client.partitionConstrained(constrainedInput());assert.equal(result.execution.exitCode,0);assert.equal(result.algorithm.basis,result.basis);assert.equal(client.children.size,0);assert.deepEqual(writes.map(row=>row.operation),['health.ping','volume.partition-constrained']);
  legacy=true;const previous=writes.length;await assert.rejects(client.partitionConstrained(constrainedInput()),{code:'VOLUME_PROTOCOL_INVALID'});assert.equal(writes.length,previous+1);assert.equal(client.children.size,0);
});
