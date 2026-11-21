import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {DiscreteTetraClient} from '../gateway/discrete-tetra-client.mjs';
import {normalizeDiscreteTetraInput,assertDiscreteTetraInput,assertDiscreteTetraHandshake,assertDiscreteTetraResult,discreteTetraFailure} from '../gateway/discrete-tetra-protocol.mjs';
import {volumeInput,verifiedDomain,tetraHealth,tetraResult} from './helpers/discrete-tetra-fixture.mjs';
const input=()=>normalizeDiscreteTetraInput({domain:verifiedDomain()});

test('formal tetra defaults to explicit strict quality, with original verified source required',()=>{
  const command=input();assert.deepEqual(command.quality,{version:1,mode:'strict',threshold:.2,maxBadFraction:0});assert.equal(command.meshSize,1);
  assert.equal(assertDiscreteTetraInput(command,{sourceInput:volumeInput()}).domain.cells.length,1);
  for(const mutate of [r=>delete r.domain.execution,r=>r.domain.algorithm.basis='guessed',r=>r.domain.processResources.enforced=false,r=>r.domain.sources[0].faceId='foreign']){const value=input();mutate(value);assert.throws(()=>assertDiscreteTetraInput(value,{sourceInput:volumeInput()}),{code:'MESH_DOMAIN_UNQUALIFIED'});}
  for(const [mutate,code]of [[r=>r.meshSize=0,'MESH_SIZE_INVALID'],[r=>r.quality.threshold=1.1,'MESH_POLICY_INVALID'],[r=>r.optimization={version:1,method:'netgen',iterations:6},'MESH_POLICY_INVALID'],[r=>r.path='arbitrary','MESH_INPUT_INVALID']]){const value=input();mutate(value);assert.throws(()=>assertDiscreteTetraInput(value,{sourceInput:volumeInput()}),{code});}
  assert.throws(()=>assertDiscreteTetraInput(input(),{}),{code:'MESH_DOMAIN_UNQUALIFIED'});
});
test('formal tetra handshake pins actual runtime, API, mode, budgets and user-config isolation',()=>{
  assert.equal(assertDiscreteTetraHandshake(tetraHealth()).gmshVersion,'4.15.2');
  for(const mutate of [h=>delete h.capabilities.discreteTetra,h=>h.capabilities.discreteTetra.gmshVersion='4.16.0',h=>h.capabilities.discreteTetra.apiVersion='4.14.0',h=>h.capabilities.discreteTetra.maxTetrahedra++,h=>h.capabilities.discreteTetra.userConfigLoaded=true,h=>h.capabilities.discreteTetra.oneJobPerProcess=false,h=>h.capabilities.discreteTetra.normalMeshAdmitted=true]){const h=tetraHealth();mutate(h);assert.throws(()=>assertDiscreteTetraHandshake(h),{code:'MESH_PROTOCOL_INVALID'});}
});
test('six positive cube tetrahedra pass coordinate quality, outward boundary and coverage checks',()=>{
  assert.equal(assertDiscreteTetraResult(tetraResult(),input(),'tetra').cells[0].tetrahedra.length,6);
});
const mutations={
  'wrong operation':r=>r.operation='mesh.create',
  'wrong request':r=>r.requestId='foreign',
  'foreign source body':r=>r.sourceSolids[0].bodyId='foreign',
  'foreign source face':r=>r.sources[0].faceId='foreign',
  'wrong cell membership':r=>r.cells[0].sourceSolidIndexes=[1],
  'inverted tet':r=>{const t=r.cells[0].tetrahedra[0];[t[0],t[1]]=[t[1],t[0]];},
  'missing tet':r=>{r.cells[0].tetrahedra.pop();r.cells[0].qualities.pop();},
  'duplicate tet':r=>{r.cells[0].tetrahedra[1]=[...r.cells[0].tetrahedra[0]];},
  'coordinate-equal cracked node':r=>{r.points.push([...r.points[0]]);r.cells[0].tetrahedra[0][0]=8;r.report.nodeCount++;},
  'forged per-tet quality':r=>{r.cells[0].qualities.fill(1);r.report.minimumSICN=1;},
  'missing boundary triangle':r=>r.boundaries[0].triangles=[],
  'wrong boundary use':r=>r.boundaries[0].cellUses[0].orientation=-1,
  'source triangle swap':r=>{r.boundaries[0].sourceTriangleIds=[1];r.boundaries[1].sourceTriangleIds=[0];},
  'wrong boundary accounting':r=>r.report.boundaryTriangleCount++,
  'wrong volume':r=>r.cells[0].volume=9,
  'false quality acceptance':r=>r.quality.meetsRequestedQuality=false,
  'non-finite quality discrepancy':r=>r.quality.maxEngineMetricDifference=null,
  'false normal mesh admission':r=>r.report.normalMeshAdmitted=true,
  'silent material priority':r=>r.report.materialPriorityAssigned=true,
  'fabricated optimization':r=>r.optimization.requested=true,
};
for(const [name,mutate]of Object.entries(mutations))test('formal tetra rejects '+name,()=>{const r=tetraResult();mutate(r);assert.throws(()=>assertDiscreteTetraResult(r,input(),'tetra'),{code:'MESH_PROTOCOL_INVALID'});});
test('strict rejection exposes bounded quality diagnostics but never a mesh',()=>{
  const request=input();request.quality.threshold=.9;const generated=tetraResult('tetra',request.quality);
  const response={ok:false,operation:'mesh.discrete-tetra',code:'MESH_QUALITY_REJECTED',error:'Requested quality not met.',quality:generated.quality,optimization:generated.optimization};
  const error=discreteTetraFailure(response,request);assert.equal(error.code,'MESH_QUALITY_REJECTED');assert.equal(error.details.quality.lowQualityCount,6);assert.equal(error.retryable,false);
  assert.throws(()=>discreteTetraFailure({...response,points:generated.points},request),{code:'MESH_PROTOCOL_INVALID'});
  assert.throws(()=>discreteTetraFailure({...response,quality:{...generated.quality,meetsRequestedQuality:true}},request),{code:'MESH_PROTOCOL_INVALID'});
});

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{auto=true,wait=false,legacy=false}={}){
  const writes=[],children=[],configs=[];
  const exit=(child,code=0)=>{if(child.exitCode!=null)return;child.exitCode=code;child.emit('exit',code);child.stdout.end();child.stderr.end();child.emit('close',code);};
  const send=(child,value)=>child.stdout.write(JSON.stringify(value)+'\n');
  const spawnImpl=(binary,args,config)=>{
    const child=new EventEmitter();Object.assign(child,{pid:777771,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new EventEmitter(),exitCode:null,signalCode:null,killed:false});
    child.stdin.writable=true;child.stdin.write=(wire,callback)=>{const command=JSON.parse(wire);writes.push(command);if(auto)queueMicrotask(()=>{if(command.operation==='health.ping'){const h=tetraHealth(command.requestId);if(legacy)delete h.capabilities.discreteTetra;send(child,h);}else{send(child,tetraResult(command.requestId,command.input.quality));if(!wait)exit(child);}});callback?.();return true;};child.kill=()=>{child.killed=true;exit(child);return true;};children.push(child);configs.push({binary,args,config});return child;
  };
  const client=new DiscreteTetraClient({workerPath:'C:/private/gmsh_mesh_worker.exe',spawnImpl,timeoutMs:1000,stopTimeoutMs:50,environment:{PRIVATE_API_KEY:'not-inherited',GMSH_HOME:'not-inherited',Path:'C:/wrong-libraries'}});
  t.after(async()=>{children.forEach(child=>exit(child));await client.closeAndWait();});return {client,writes,children,configs,exit,send};
}
test('single-job tetra uses the fixed existing-program mode and waits for its exact process',async t=>{
  const f=fixture(t,{wait:true});let settled=false;const work=f.client.tetrahedralize({domain:verifiedDomain()},{sourceInput:volumeInput()}).then(r=>{settled=true;return r;});await tick();assert.equal(settled,false);assert.equal(f.client.status().state,'awaiting-exit');
  assert.deepEqual(f.configs[0].args,['--discrete-single-job']);assert.equal(f.configs[0].config.env.Path,'C:\\private');assert.equal(f.configs[0].config.env.PRIVATE_API_KEY,undefined);assert.equal(f.configs[0].config.env.GMSH_HOME,undefined);assert.equal(f.configs[0].config.env.MESH_WORKER_MEMORY_LIMIT_BYTES,String(2*1024**3));
  await assert.rejects(f.client.tetrahedralize({domain:verifiedDomain()},{sourceInput:volumeInput()}),{code:'MESH_BUSY'});f.exit(f.children[0]);const result=await work;assert.equal(result.execution.exitCode,0);assert.equal(result.report.normalMeshAdmitted,false);
});
test('original source and domain are fixed before health, while legacy capability is refused',async t=>{
  const f=fixture(t,{auto:false}),d=verifiedDomain(),source=volumeInput(),work=f.client.tetrahedralize({domain:d},{sourceInput:source});d.sources[0].faceId='changed';source.sources[0].faceId='changed';f.send(f.children[0],tetraHealth(f.writes[0].requestId));await tick();assert.equal(f.writes[1].input.domain.sources[0].faceId,'face-0');f.send(f.children[0],tetraResult(f.writes[1].requestId));f.exit(f.children[0]);await work;
  const g=fixture(t,{legacy:true});await assert.rejects(g.client.tetrahedralize({domain:verifiedDomain()},{sourceInput:volumeInput()}),{code:'MESH_PROTOCOL_INVALID'});assert.equal(g.writes.length,1);
});
test('tetra pre-cancellation and missing source never start a process; active cancellation confirms exit',async t=>{
  const f=fixture(t),controller=new AbortController();controller.abort();await assert.rejects(f.client.tetrahedralize({domain:verifiedDomain()},{sourceInput:volumeInput(),signal:controller.signal}),{code:'MESH_CANCELLED'});await assert.rejects(f.client.tetrahedralize({domain:verifiedDomain()}),{code:'MESH_DOMAIN_UNQUALIFIED'});assert.equal(f.children.length,0);
  const g=fixture(t,{auto:false}),active=new AbortController(),work=g.client.tetrahedralize({domain:verifiedDomain()},{sourceInput:volumeInput(),signal:active.signal}),checked=assert.rejects(work,{code:'MESH_CANCELLED'});g.send(g.children[0],tetraHealth(g.writes[0].requestId));await tick();active.abort();await checked;assert.equal(g.children[0].killed,true);assert.equal(g.client.children.size,0);
});
test('stdout EOF before an observed zero exit is reconciled without publishing early',async t=>{
  const f=fixture(t,{auto:false});let settled=false;const work=f.client.tetrahedralize({domain:verifiedDomain()},{sourceInput:volumeInput()}).then(r=>{settled=true;return r;});f.send(f.children[0],tetraHealth(f.writes[0].requestId));await tick();f.send(f.children[0],tetraResult(f.writes[1].requestId));f.children[0].stdout.end();await tick();assert.equal(settled,false);f.exit(f.children[0]);assert.equal((await work).execution.exitCode,0);
});
test('valid tetra replies are discarded on late process failure or memory exit',async t=>{
  for(const [code,expected]of [[3,'MESH_PROCESS_FAILED'],[86,'MESH_WORKER_MEMORY_LIMIT']]){const f=fixture(t,{auto:false}),work=f.client.tetrahedralize({domain:verifiedDomain()},{sourceInput:volumeInput()}),checked=assert.rejects(work,{code:expected});f.send(f.children[0],tetraHealth(f.writes[0].requestId));await tick();f.send(f.children[0],tetraResult(f.writes[1].requestId));f.exit(f.children[0],code);await checked;}
});

test('strict quality rejection retains bounded diagnostics and exact failure-exit proof',async t=>{
  const f=fixture(t,{auto:false}),quality={version:1,mode:'strict',threshold:.9,maxBadFraction:0};
  const checked=f.client.tetrahedralize({domain:verifiedDomain(),quality},{sourceInput:volumeInput()}).catch(error=>error);f.send(f.children[0],tetraHealth(f.writes[0].requestId));await tick();
  const generated=tetraResult(f.writes[1].requestId,quality);f.send(f.children[0],{ok:false,protocolVersion:1,requestId:generated.requestId,service:'gmsh-mesh-worker',operation:'mesh.discrete-tetra',code:'MESH_QUALITY_REJECTED',error:'Requested quality not met.',quality:generated.quality,optimization:generated.optimization});
  await tick();assert.equal(f.children[0].killed,false);assert.equal(f.client.status().state,'awaiting-exit');f.exit(f.children[0],2);const error=await checked;assert.equal(error.code,'MESH_QUALITY_REJECTED');assert.equal(error.details.quality.lowQualityCount,6);assert.equal(error.execution.exitCode,2);assert.equal(error.processResources.enforced,true);assert.equal(error.algorithm.gmshVersion,'4.15.2');assert.equal(f.children.length,1);
});
