import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {DiscreteSurfaceClient} from '../gateway/discrete-surface-client.mjs';
import {assertVolumePartitionInput,assertVolumePartitionHandshake,assertVolumePartitionResult} from '../gateway/volume-partition-protocol.mjs';
import {volumeInput,volumeHealth,volumeResult} from './helpers/volume-partition-fixture.mjs';

test('formal volume input matches native point, Solid, repair and identity limits',()=>{
  assert.equal(assertVolumePartitionInput(volumeInput()).units,'mm');
  for(const mutate of [i=>i.points[0][0]=Infinity,i=>i.sources[0].faceId='bad/path',i=>i.sources[0].solidId='x'.repeat(81),i=>i.options={snapGridSize:52},i=>i.options={snapGridSize:29},i=>i.options={tolerance:1e-13},i=>i.options={tolerance:.01},i=>i.options={iterations:11},i=>i.path='arbitrary',i=>i.triangles[0][0]=100]){
    const input=volumeInput();mutate(input);assert.throws(()=>assertVolumePartitionInput(input),{code:'VOLUME_REQUEST_INVALID'});
  }
  const input=volumeInput();delete input.sources[0].solidId;assert.throws(()=>assertVolumePartitionInput(input),{code:'VOLUME_FREE_SHEET_UNSUPPORTED'});
});
test('volume capability cannot be inferred from the legacy surface handshake',()=>{
  assert.equal(assertVolumePartitionHandshake(volumeHealth()).cgalVersion,'6.1.2');
  for(const mutate of [h=>delete h.capabilities.volumePartition,h=>h.capabilities.volumePartition.maxCells=129,h=>h.capabilities.volumePartition.normalMeshAdmitted=true,h=>h.capabilities.volumePartition.license='commercial',h=>h.capabilities.volumePartition.sourceIdentityAuthority='cad-certificates']){
    const health=volumeHealth();mutate(health);assert.throws(()=>assertVolumePartitionHandshake(health),{code:'VOLUME_PROTOCOL_INVALID'});
  }
});
test('single closed volume and translated coordinates pass independent local-origin integration',()=>{
  const input=volumeInput(),result=volumeResult();assert.equal(assertVolumePartitionResult(result,input,'partition').cells.length,1);
  for(const p of input.points)for(let j=0;j<3;j++)p[j]+=1e8;
  result.points=structuredClone(input.points);assert.equal(assertVolumePartitionResult(result,input,'partition').report.unionVolume,8);
});
test('removed degenerate input remains explicit rather than silently losing a source',()=>{
  const input=volumeInput(),result=volumeResult();input.triangles.push([0,0,0]);input.sources.push({...input.sources[0]});result.sources=structuredClone(input.sources);result.surfaceReport.inputTriangles=13;result.surfaceReport.removedDegenerateInputTriangles=[12];
  assert.equal(assertVolumePartitionResult(result,input,'partition').surfaceReport.removedDegenerateInputTriangles[0],12);
});
test('native object field order is immaterial but unknown use fields are rejected',()=>{
  const result=volumeResult();result.triangleRegionUses=result.triangleRegionUses.map(row=>row.map(use=>({orientation:use.orientation,regionIndex:use.regionIndex})));result.triangleCellUses=result.triangleCellUses.map(row=>row.map(use=>({orientation:use.orientation,cellIndex:use.cellIndex})));
  assert.equal(assertVolumePartitionResult(result,volumeInput(),'partition').ok,true);
  result.triangleCellUses[0][0].untrusted=true;assert.throws(()=>assertVolumePartitionResult(result,volumeInput(),'partition'),{code:'VOLUME_PROTOCOL_INVALID'});
});
const mutations={
  'wrong service':r=>r.service='other',
  'wrong request':r=>r.requestId='foreign',
  'wrong operation':r=>r.operation='surface.refine',
  'foreign body':r=>r.sourceSolids[0].bodyId='foreign',
  'forged membership':r=>r.cells[0].sourceSolidIndexes=[1],
  'duplicate region':r=>r.regions.push(structuredClone(r.regions[0])),
  'missing cell face':r=>r.cells[0].shells[0].triangleIndexes.pop(),
  'repeated cell face':r=>r.cells[0].shells[0].triangleIndexes.push(0),
  'wrong shell volume':r=>r.cells[0].shells[0].signedVolume=9,
  'wrong cell volume':r=>r.cells[0].volume=9,
  'wrong region volume':r=>r.regions[0].volume=9,
  'wrong source volume':r=>r.sourceSolids[0].volume=9,
  'wrong union volume':r=>r.report.unionVolume=9,
  'wrong boundary direction':r=>{r.triangleCellUses[0][0].orientation=-1;r.triangleRegionUses[0][0].orientation=-1;},
  'fake cavity':r=>r.cells[0].shells[0].outer=false,
  'missing source':r=>r.sourceTriangleIds[0]=[],
  'coplanar triangles swapped':r=>{r.sourceTriangleIds[0]=[1];r.sourceTriangleIds[1]=[0];},
  'duplicated boundary':r=>r.triangles[1]=r.triangles[0],
  'false mesh admission':r=>r.report.normalMeshAdmitted=true,
  'false source authority':r=>r.report.sourceIdentityAuthority='cad-certificates',
  'missing repair report':r=>delete r.surfaceReport,
};
for(const [name,mutate]of Object.entries(mutations))test('volume reply rejects '+name,()=>{const result=volumeResult();mutate(result);assert.throws(()=>assertVolumePartitionResult(result,volumeInput(),'partition'),{code:'VOLUME_PROTOCOL_INVALID'});});

function processFixture(t,{legacy=false,waitForExit=false}={}){
  const writes=[],children=[];
  const exit=child=>{if(child.exitCode!=null)return;child.exitCode=0;child.emit('exit',0);child.stdout.end();child.stderr.end();child.emit('close',0);};
  const spawnImpl=()=>{
    const child=new EventEmitter();Object.assign(child,{pid:999991,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new EventEmitter(),exitCode:null,signalCode:null});
    child.stdin.writable=true;child.stdin.write=(wire,callback)=>{const command=JSON.parse(wire);writes.push(command);queueMicrotask(()=>{if(command.operation==='health.ping'){const h=volumeHealth(command.requestId);if(legacy)delete h.capabilities.volumePartition;child.stdout.write(JSON.stringify(h)+'\n');}else{child.stdout.write(JSON.stringify(volumeResult(command.requestId,command.input))+'\n');if(!waitForExit)exit(child);}});callback?.();return true;};
    child.kill=()=>{exit(child);return true;};children.push(child);return child;
  };
  const client=new DiscreteSurfaceClient({workerPath:'C:/private/cad_discrete_surface_worker.exe',spawnImpl,timeoutMs:1000,stopTimeoutMs:50});
  t.after(async()=>{children.forEach(exit);await client.closeAndWait();});return {client,writes,children,exit};
}
test('formal volume uses the existing single-job transport and verifies actual process exit',async t=>{
  const f=processFixture(t,{waitForExit:true});let settled=false;const pending=f.client.partition(volumeInput()).then(result=>{settled=true;return result;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(f.client.status().state,'awaiting-exit');assert.deepEqual(f.writes.map(row=>row.operation),['health.ping','volume.partition']);
  await assert.rejects(f.client.refine({}),{code:'SURFACE_BUSY'});f.exit(f.children[0]);const result=await pending;assert.equal(result.execution.exitCode,0);assert.equal(result.algorithm.basis,volumeResult().basis);assert.equal(result.report.normalMeshAdmitted,false);
});
test('legacy worker cannot receive volume data, while malformed inputs never spawn',async t=>{
  const f=processFixture(t,{legacy:true});await assert.rejects(f.client.partition(volumeInput()),{code:'VOLUME_PROTOCOL_INVALID'});assert.equal(f.writes.length,1);
  const g=processFixture(t),input=volumeInput();delete input.sources[0].solidId;await assert.rejects(g.client.partition(input),{code:'VOLUME_FREE_SHEET_UNSUPPORTED'});assert.equal(g.children.length,0);
});
