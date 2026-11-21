import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {MeshCheckpointClient} from '../gateway/mesh-checkpoint-client.mjs';
import {assertCheckpointHandshake,assertCheckpointInput,assertCheckpointResult,assertOptimizationCheckpointInput,assertCheckpointOptimizationResult} from '../gateway/mesh-checkpoint-protocol.mjs';
import {checkpointInput,checkpointHealth,checkpointResult,optimizedCheckpointResult,volumeInput} from './helpers/mesh-checkpoint-fixture.mjs';
const optimizeInput=()=>({generationInput:checkpointInput(),checkpointResult:checkpointResult()});
test('an unoptimized checkpoint retains explicit node/element identities, topology and diagnostic-only status',()=>{
  assertCheckpointInput(checkpointInput(),{sourceInput:volumeInput()});assert.equal(assertCheckpointHandshake(checkpointHealth()).basis,checkpointResult().basis);
  const result=assertCheckpointResult(checkpointResult(),checkpointInput(),'checkpoint');assert.equal(result.baseline.quality.mode,'diagnostic');assert.equal(result.baseline.optimization.requested,false);assert.equal(result.normalMeshAdmitted,false);
  assert.equal(assertOptimizationCheckpointInput(optimizeInput(),{sourceInput:volumeInput()}).checkpointResult.execution.exitCode,0);
});
const mutations={
  'false admission':r=>r.normalMeshAdmitted=true,
  'wrong basis':r=>r.basis='guessed',
  'wrong process operation':r=>r.operation='mesh.discrete-tetra',
  'changed generation size':r=>r.generationInput.meshSize=2,
  'changed requested optimization':r=>r.generationInput.optimization.method='netgen',
  'false strict baseline':r=>r.baseline.quality.mode='strict',
  'hidden baseline optimization':r=>r.baseline.optimization.requested=true,
  'missing explicit tag map':r=>delete r.checkpoint.pointNodeTags,
  'coordinate-equal renamed point':r=>r.checkpoint.pointNodeTags[0]=999999,
  'wrong world frame':r=>r.checkpoint.worldOrigin[0]=1,
  'unknown checkpoint path':r=>r.checkpoint.path='private',
  'unknown entity field':r=>r.checkpoint.entities[0].path='private',
  'negative point identity':r=>r.checkpoint.entities[0].tag=-1,
  'oversized sparse node tag':r=>r.checkpoint.entities[0].nodes[0]=1000001,
  'repeated node classification':r=>r.checkpoint.entities[1].nodes=[1],
  'moved node with unchanged baseline':r=>r.checkpoint.entities[0].coordinates[0]=.01,
  'repeated element identity':r=>r.checkpoint.entities[1].elements[0][0]=1,
  'missing entity boundary':r=>r.checkpoint.entities.find(e=>e.dimension===2).boundary.pop(),
  'fake signed discrete curve use':r=>r.checkpoint.entities.find(e=>e.dimension===2).boundary[0]*=-1,
  'missing curve endpoint':r=>r.checkpoint.entities.find(e=>e.dimension===1).boundary.pop(),
  'reversed stored boundary triangle':r=>{const t=r.checkpoint.entities.find(e=>e.dimension===2).vertices[0];[t[0],t[1]]=[t[1],t[0]];},
  'wrong volume surface orientation':r=>r.checkpoint.entities.at(-1).boundary[0]*=-1,
  'invented volume tetrahedron':r=>r.checkpoint.entities.at(-1).vertices[0][0]=8,
  'non-finite parameter':r=>r.checkpoint.entities[0].parameters=[NaN],
};
for(const [name,mutate]of Object.entries(mutations))test('checkpoint rejects '+name,()=>{const result=checkpointResult();mutate(result);assert.throws(()=>assertCheckpointResult(result,checkpointInput(),'checkpoint'),{code:'MESH_CHECKPOINT_INVALID'});});
test('separate optimization requires the first process exit and pinned algorithm/resource proof',()=>{
  for(const mutate of [r=>delete r.execution,r=>r.execution.exitCode=1,r=>r.execution.automaticReplay=true,r=>r.algorithm.basis='other',r=>r.processResources.enforced=false]){const input=optimizeInput();mutate(input.checkpointResult);assert.throws(()=>assertOptimizationCheckpointInput(input,{sourceInput:volumeInput()}));}
  const health=checkpointHealth();delete health.capabilities.meshCheckpoint;assert.throws(()=>assertCheckpointHandshake(health),{code:'MESH_CHECKPOINT_INVALID'});
});
test('optimized output independently rechecks quality, exact boundary identities and original coordinates',()=>{
  const input=optimizeInput();assert.equal(assertCheckpointOptimizationResult(optimizedCheckpointResult(),input,'optimized').restoredExactly,true);
  for(const mutate of [r=>r.restoredExactly=false,r=>r.pointNodeTags[0]=99999,r=>r.mesh.optimization.before.minimumSICN=.9,r=>r.mesh.points[0][0]=.001]){const result=optimizedCheckpointResult();mutate(result);assert.throws(()=>assertCheckpointOptimizationResult(result,input,'optimized'),{code:'MESH_CHECKPOINT_INVALID'});}
});
function processFixture(t){
  const writes=[],children=[],options=[];let crash=false,legacy=false;
  const spawnImpl=(_binary,args,config)=>{
    const child=new EventEmitter();Object.assign(child,{pid:900000+children.length,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new EventEmitter(),exitCode:null,signalCode:null});
    const exit=code=>{if(child.exitCode!==null)return;child.exitCode=code;child.emit('exit',code);child.stdout.end();child.stderr.end();child.emit('close',code);};child.kill=()=>{exit(0);return true;};child.stdin.writable=true;
    child.stdin.write=(wire,callback)=>{const request=JSON.parse(wire);writes.push(request);queueMicrotask(()=>{if(request.operation==='health.ping'){const health=checkpointHealth(request.requestId);if(legacy)delete health.capabilities.meshCheckpoint;child.stdout.write(JSON.stringify(health)+'\n');}else if(crash)exit(3221225477);else{const result=request.operation==='mesh.discrete-checkpoint'?checkpointResult(request.requestId):optimizedCheckpointResult(request.requestId);child.stdout.write(JSON.stringify(result)+'\n');exit(0);}});callback?.();return true;};children.push(child);options.push({args,config});return child;
  };
  const client=new MeshCheckpointClient({workerPath:'C:/private/gmsh_mesh_worker.exe',spawnImpl,timeoutMs:1000,stopTimeoutMs:50});t.after(async()=>{for(const child of children)child.kill();await client.closeAndWait();});return {client,writes,children,options,setCrash:value=>crash=value,setLegacy:value=>legacy=value};
}
test('optimizer crash never regenerates, rewrites or silently admits the surviving checkpoint',async t=>{
  const f=processFixture(t),checkpoint=await f.client.createCheckpoint(checkpointInput(),{sourceInput:volumeInput()}),before=JSON.stringify(checkpoint);assert.deepEqual(f.options[0].args,['--discrete-checkpoint-single-job']);f.setCrash(true);
  await assert.rejects(f.client.optimizeCheckpoint({generationInput:checkpointInput(),checkpointResult:checkpoint},{sourceInput:volumeInput()}),{code:'MESH_WORKER_EXITED'});assert.equal(f.children.length,2);assert.equal(f.client.children.size,0);assert.equal(JSON.stringify(checkpoint),before);assert.equal(checkpoint.normalMeshAdmitted,false);
  f.setCrash(false);await f.client.optimizeCheckpoint({generationInput:checkpointInput(),checkpointResult:checkpoint},{sourceInput:volumeInput()});assert.equal(f.children.length,3);assert.equal(f.writes.filter(row=>row.operation==='mesh.discrete-checkpoint').length,1);assert.equal(JSON.stringify(checkpoint),before);
});
test('malformed checkpoints and pre-cancellation never start a process; legacy capabilities receive no mesh',async t=>{
  const f=processFixture(t),controller=new AbortController();controller.abort();await assert.rejects(f.client.createCheckpoint(checkpointInput(),{sourceInput:volumeInput(),signal:controller.signal}),{code:'MESH_CANCELLED'});assert.equal(f.children.length,0);
  const input=optimizeInput();delete input.checkpointResult.execution;await assert.rejects(f.client.optimizeCheckpoint(input,{sourceInput:volumeInput()}));assert.equal(f.children.length,0);
  f.setLegacy(true);await assert.rejects(f.client.createCheckpoint(checkpointInput(),{sourceInput:volumeInput()}),{code:'MESH_CHECKPOINT_INVALID'});assert.equal(f.writes.length,1);assert.equal(f.writes[0].operation,'health.ping');
});
