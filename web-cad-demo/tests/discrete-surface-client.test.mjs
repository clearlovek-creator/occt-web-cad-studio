import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {DiscreteSurfaceClient} from '../gateway/discrete-surface-client.mjs';
import {DISCRETE_SURFACE_PROTOCOL as P,assertDiscreteHandshake,assertDiscreteResult} from '../gateway/discrete-surface-protocol.mjs';
import {discreteMemoryPolicy,discreteResourceExitError,assertNativeMemoryGuard} from '../gateway/native-resource-policy.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const input=()=>({units:'mm',points:[[0,0,0],[1,0,0],[0,1,0]],triangles:[[0,1,2]],sources:[{faceId:'face-1',bodyId:'body-1'}]});
function health(id){return {ok:true,protocolVersion:1,requestId:id,service:P.service,capabilities:{version:1,processResources:{version:1,basis:'windows-job-commit-v1',processLimitBytes:2*1024**3,jobLimitBytes:2*1024**3,enforced:true,failurePolicy:'retire-on-memory-event-or-allocator-failure-v1'},surfaceRefinement:{...P,version:1,volumeDomainReconstruction:false,oneJobPerProcess:true}}};}
function result(command){return {ok:true,protocolVersion:1,requestId:command.requestId,service:P.service,operation:'surface.refine',basis:P.basis,cgalVersion:P.cgalVersion,units:'mm',points:command.input.points.map(point=>[...point]),triangles:[[0,1,2]],sources:[{bodyId:'body-1',faceId:'face-1'}],sourceTriangleIds:[[0]],report:{inputTriangles:1,distinctInputTriangles:1,outputTriangles:1,inputHadCrossings:false,outputHasCrossings:false,sourceReferences:1,maxSourceDeviation:0,maxRelativeSourceAreaError:0,tolerance:1e-7,snapGridSize:40,iterationLimit:5,removedDegenerateInputTriangles:[],volumeDomainReconstruction:'not-performed',tetrahedralReady:false,sourceIdentityAuthority:'caller-supplied-discrete-labels-not-cad-certificates'}};}
function fixture(t,options={}){
  const children=[],writes=[],spawns=[];
  function spawnImpl(binary,args,config){
    const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new EventEmitter(),pid:900000+children.length,exitCode:null,signalCode:null,killed:false});
    child.stdin.writable=true;child.stdin.write=(wire,callback)=>{const command=JSON.parse(wire);writes.push(command);queueMicrotask(()=>options.onWrite?.(child,command,fixtureValue));callback?.();return true;};
    child.kill=()=>{child.killed=true;options.onKill?.(child,fixtureValue);return true;};children.push(child);spawns.push({binary,args,config});
    if(options.failSpawn){child.pid=undefined;child.stdin.writable=false;queueMicrotask(()=>{child.emit('error',Object.assign(Error('spawn ENOENT'),{code:'ENOENT'}));child.stdout.end();child.stderr.end();child.emit('close',-4058);});}
    return child;
  }
  const client=new DiscreteSurfaceClient({workerPath:'C:/candidate/cad_discrete_surface_worker.exe',spawnImpl,timeoutMs:1000,stopTimeoutMs:50,...options});
  const send=(child,value)=>child.stdout.write(JSON.stringify(value)+'\n');
  const exit=(child,code=0)=>{if(child.exitCode!=null||child.signalCode!=null)return;child.exitCode=code;child.emit('exit',code);child.stdout.end();child.stderr.end();child.emit('close',code);};
  const fixtureValue={client,children,writes,spawns,send,exit};
  t.after(async()=>{children.forEach(child=>exit(child));await tick();await client.closeAndWait();});return fixtureValue;
}
const autoHandshake=(child,command,f)=>{if(command.operation==='health.ping')f.send(child,health(command.requestId));};
const complete=(child,command,f)=>{if(command.operation==='health.ping')autoHandshake(child,command,f);else{f.send(child,result(command));f.exit(child);}};

test('discrete worker has an independent strict memory policy and authoritative resource exits',()=>{
  const policy=discreteMemoryPolicy({},'win32');assert.equal(policy.limitBytes,2*1024**3);
  for(const value of ['0','-1','1e9','','134217727','8589934593'])assert.throws(()=>discreteMemoryPolicy({DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES:value},'win32'),{code:'SURFACE_RESOURCE_CONFIG_INVALID'});
  assert.throws(()=>discreteMemoryPolicy({},'linux'),{code:'SURFACE_RESOURCE_PLATFORM_UNSUPPORTED'});
  assert.equal(assertNativeMemoryGuard(health('h'),policy,P.service).enforced,true);
  for(const [code,expected]of [[86,'SURFACE_MEMORY_LIMIT'],[87,'SURFACE_MEMORY_EXHAUSTED'],[88,'SURFACE_RESOURCE_GUARD_UNAVAILABLE'],[89,'SURFACE_RESOURCE_CONFIG_INVALID']])assert.equal(discreteResourceExitError(code,policy).code,expected);
});
test('handshake pins license, algorithm, version, limits and absence of volume reconstruction',()=>{
  assert.equal(assertDiscreteHandshake(health('h')).license,'GPL-3.0-or-later');
  for(const patch of [{cgalVersion:'6.2.1'},{license:'commercial'},{basis:'approximate'},{maxInputTriangles:1},{maxResponseBytes:1},{oneJobPerProcess:false},{volumeDomainReconstruction:true}]){const h=health('h');Object.assign(h.capabilities.surfaceRefinement,patch);assert.throws(()=>assertDiscreteHandshake(h),{code:'SURFACE_PROTOCOL_INVALID'});}
});
test('single-use process is guarded before geometry, excludes inherited DLL paths, and accepts only exited success',async t=>{
  const f=fixture(t,{onWrite:complete,environment:{PRIVATE_API_KEY:'must-not-reach-native',CGAL_DISABLE_ROUNDING_MATH_CHECK:'1',Path:'C:/unrelated-dlls'}}),out=await f.client.refine(input());assert.equal(out.execution.exitCode,0);assert.equal(out.report.tetrahedralReady,false);assert.equal(out.processResources.enforced,true);assert.equal(f.spawns[0].config.env.PRIVATE_API_KEY,undefined);assert.equal(f.spawns[0].config.env.CGAL_DISABLE_ROUNDING_MATH_CHECK,undefined);
  assert.deepEqual(f.writes.map(x=>x.operation),['health.ping','surface.refine']);assert.equal(f.spawns[0].config.windowsHide,true);assert.equal(f.spawns[0].config.env.Path,'C:\\candidate');assert.equal(f.spawns[0].config.env.PATH,undefined);assert.equal(f.client.status().state,'idle');
  await f.client.refine(input());assert.equal(f.children.length,2,'No reuse of a single-job process.');
});
test('input snapshot cannot change while health is pending',async t=>{
  const f=fixture(t),source=input(),work=f.client.refine(source);source.points[0][0]=900;source.sources[0].faceId='changed';const child=f.children[0];f.send(child,health(f.writes[0].requestId));await tick();assert.equal(f.writes[1].input.points[0][0],0);assert.equal(f.writes[1].input.sources[0].faceId,'face-1');f.send(child,result(f.writes[1]));f.exit(child);await work;
});
test('oversize, malformed, cyclic and pre-cancelled inputs never start a process',async t=>{
  const f=fixture(t),controller=new AbortController();controller.abort();await assert.rejects(f.client.refine(input(),{signal:controller.signal}),{code:'SURFACE_CANCELLED'});
  for(const value of [null,[],{}, {...input(),sources:[]}])await assert.rejects(f.client.refine(value),{code:'SURFACE_REQUEST_INVALID'});
  const cycle=input();cycle.loop=cycle;await assert.rejects(f.client.refine(cycle),{code:'SURFACE_REQUEST_INVALID'});
  await assert.rejects(f.client.refine({...input(),junk:'x'.repeat(P.maxRequestBytes)}),{code:'SURFACE_INPUT_LIMIT'});assert.equal(f.children.length,0);
});
test('untrusted handshake is retired before any geometry is sent',async t=>{
  for(const mutation of [h=>h.capabilities.surfaceRefinement.license='other',h=>h.capabilities.processResources.enforced=false]){
    const f=fixture(t,{onWrite:(child,command,f)=>{const h=health(command.requestId);mutation(h);f.send(child,h);},onKill:(child,f)=>f.exit(child)});
    await assert.rejects(f.client.refine(input()),error=>['SURFACE_PROTOCOL_INVALID','SURFACE_RESOURCE_GUARD_UNAVAILABLE'].includes(error.code));assert.equal(f.writes.length,1);assert.equal(f.children[0].killed,true);
  }
});
test('receiving a valid result is not completion until its exact process exits',async t=>{
  const f=fixture(t,{onWrite:(child,command,f)=>{if(command.operation==='health.ping')autoHandshake(child,command,f);else f.send(child,result(command));}});let settled=false;
  const work=f.client.refine(input()).then(value=>{settled=true;return value;});await tick();await tick();assert.equal(f.client.status().state,'awaiting-exit');assert.equal(settled,false);await assert.rejects(f.client.refine(input()),{code:'SURFACE_BUSY'});f.exit(f.children[0]);await work;assert.equal(settled,true);
});
test('late process failure discards an otherwise valid reply, including authoritative memory failure',async t=>{
  for(const code of [3,86,87]){const f=fixture(t,{onWrite:(child,command,f)=>{if(command.operation==='health.ping')autoHandshake(child,command,f);else{f.send(child,result(command));f.exit(child,code);}}});await assert.rejects(f.client.refine(input()),{code:code===86?'SURFACE_MEMORY_LIMIT':code===87?'SURFACE_MEMORY_EXHAUSTED':'SURFACE_PROCESS_FAILED'});assert.equal(f.children.length,1);}
});
test('domain failure is returned only after exit and is never retried automatically',async t=>{
  const f=fixture(t,{onWrite:(child,command,f)=>{if(command.operation==='health.ping')autoHandshake(child,command,f);else{f.send(child,{ok:false,protocolVersion:1,requestId:command.requestId,service:P.service,code:'GEOMETRY_DRIFT',error:'Explicit tolerance exceeded.'});f.exit(child,2);}}});await assert.rejects(f.client.refine(input()),{code:'GEOMETRY_DRIFT'});assert.equal(f.children.length,1);assert.equal(f.writes.length,2);
});

const domainFailure=command=>({ok:false,protocolVersion:1,requestId:command.requestId,service:P.service,code:'GEOMETRY_DRIFT',error:'Explicit tolerance exceeded.'});

test('domain refusal waits for self-exit and retains verified execution proof without killing',async t=>{
  const f=fixture(t,{onWrite:(child,command,f)=>{if(command.operation==='health.ping')autoHandshake(child,command,f);else f.send(child,domainFailure(command));}});
  let settled=false;const checked=f.client.refine(input()).catch(error=>{settled=true;return error;});await tick();assert.equal(settled,false);assert.equal(f.children[0].killed,false);assert.equal(f.client.status().state,'awaiting-exit');
  f.exit(f.children[0],2);const error=await checked;assert.equal(error.code,'GEOMETRY_DRIFT');assert.deepEqual(error.execution,{basis:'single-process-exit-confirmed-v1',exitCode:2,automaticReplay:false});assert.equal(error.algorithm.license,P.license);assert.equal(error.processResources.enforced,true);assert.equal(f.children[0].killed,false);assert.equal(f.children.length,1);
});

test('domain refusal arriving after its exact exit retains complete verified diagnosis',async t=>{
  const f=fixture(t,{onWrite:autoHandshake}),checked=f.client.refine(input()).catch(error=>error);await tick();const child=f.children[0],wire=JSON.stringify(domainFailure(f.writes[1]))+'\n';child.stdout.write(wire.slice(0,21));child.exitCode=2;child.emit('exit',2);await tick();child.stdout.write(wire.slice(21));child.stdout.end();const error=await checked;assert.equal(error.code,'GEOMETRY_DRIFT');assert.equal(error.execution.exitCode,2);assert.equal(child.killed,false);
});

test('domain refusal with EOF before exit reconciles the actual failure exit',async t=>{
  const f=fixture(t,{onWrite:autoHandshake}),checked=f.client.refine(input()).catch(error=>error);await tick();const child=f.children[0];f.send(child,domainFailure(f.writes[1]));child.stdout.end();await tick();assert.equal(child.killed,false);f.exit(child,2);assert.equal((await checked).execution.exitCode,2);
});

test('domain refusal cannot conceal a contradictory process exit or memory failure',async t=>{
  for(const [exitCode,code]of [[0,'SURFACE_PROCESS_FAILED'],[3,'SURFACE_PROCESS_FAILED'],[86,'SURFACE_MEMORY_LIMIT']]){
    const f=fixture(t,{onWrite:(child,command,f)=>{if(command.operation==='health.ping')autoHandshake(child,command,f);else{f.send(child,domainFailure(command));f.exit(child,exitCode);}}});
    await assert.rejects(f.client.refine(input()),error=>{assert.equal(error.code,code);assert.equal(error.execution,undefined);return true;});
  }
});

test('late extra frame and unterminated error tail cannot become trusted domain diagnostics',async t=>{
  for(const tail of ['{broken',JSON.stringify({ok:false,protocolVersion:1,requestId:'foreign'})+'\n']){
    const f=fixture(t,{onWrite:autoHandshake}),checked=f.client.refine(input()).catch(error=>error);await tick();const child=f.children[0];f.send(child,domainFailure(f.writes[1]));child.exitCode=2;child.emit('exit',2);child.stdout.write(tail);child.stdout.end();const error=await checked;assert.equal(error.code,'SURFACE_PROTOCOL_INVALID');assert.equal(error.execution,undefined);
  }
});

test('cancellation during domain-failure output drain wins over its late diagnosis',async t=>{
  const controller=new AbortController(),f=fixture(t,{onWrite:autoHandshake}),checked=f.client.refine(input(),{signal:controller.signal}).catch(error=>error);await tick();const child=f.children[0];f.send(child,domainFailure(f.writes[1]));child.exitCode=2;child.emit('exit',2);await tick();controller.abort();child.stdout.end();const error=await checked;assert.equal(error.code,'SURFACE_CANCELLED');assert.equal(error.execution,undefined);assert.equal(child.killed,false);
});
test('cancellation waits for actual exit, not merely a kill request',async t=>{
  const f=fixture(t,{onWrite:autoHandshake}),controller=new AbortController();let settled=false;
  const work=f.client.refine(input(),{signal:controller.signal}),checked=assert.rejects(work,{code:'SURFACE_CANCELLED'}).then(()=>{settled=true;});await tick();controller.abort();await tick();assert.equal(f.children[0].killed,true);assert.equal(settled,false);await assert.rejects(f.client.refine(input()),{code:'SURFACE_BUSY'});f.exit(f.children[0]);await checked;
});
test('stop deadline leaves client blocked until late exit; no overlapping replacement is started',async t=>{
  const f=fixture(t,{onWrite:autoHandshake,timeoutMs:5,stopTimeoutMs:10});await assert.rejects(f.client.refine(input()),{code:'SURFACE_STOP_UNCONFIRMED'});assert.equal(f.client.status().state,'blocked');await assert.rejects(f.client.refine(input()),{code:'SURFACE_BUSY'});assert.equal(f.children.length,1);f.exit(f.children[0]);await tick();assert.equal(f.client.status().state,'idle');
});
test('job timeout retires the exact process and cannot publish a late valid result',async t=>{
  const f=fixture(t,{onWrite:autoHandshake,timeoutMs:5,onKill:(child,f)=>{const command=f.writes.find(x=>x.operation==='surface.refine');if(command)f.send(child,result(command));f.exit(child);}});await assert.rejects(f.client.refine(input()),{code:'SURFACE_TIMEOUT'});assert.equal(f.children.length,1);
});
test('abort after reply but before process exit discards the reply',async t=>{
  const controller=new AbortController(),f=fixture(t,{onWrite:(child,command,f)=>{if(command.operation==='health.ping')autoHandshake(child,command,f);else{f.send(child,result(command));controller.abort();f.exit(child);}}});await assert.rejects(f.client.refine(input(),{signal:controller.signal}),{code:'SURFACE_CANCELLED'});
});
test('ownership, point, triangle, source coverage and volume claims are validated',()=>{
  const command={requestId:'r',input:input()};assert.equal(assertDiscreteResult(result(command),command.input,'r').ok,true);
  for(const mutate of [r=>r.sources[0].bodyId='wrong',r=>r.sourceTriangleIds[0]=[1],r=>r.sourceTriangleIds[0]=[0,0],r=>r.points[0][0]=Infinity,r=>r.triangles[0]=[0,0,1],r=>r.report.sourceReferences=2,r=>r.report.tetrahedralReady=true,r=>r.report.maxSourceDeviation=1,r=>r.report.removedDegenerateInputTriangles=[0]]){const r=result(command);mutate(r);assert.throws(()=>assertDiscreteResult(r,input(),'r'),{code:'SURFACE_PROTOCOL_INVALID'});}
});
test('malformed or extra protocol frames and unbounded diagnostics cannot publish',async t=>{
  for(const emit of [(child)=>child.stdout.write('{broken}\n'),(child)=>child.stdout.write('unframed native log\n'),(child)=>child.stderr.write(Buffer.alloc(65537,120)),(child,command,f)=>f.send(child,{...health(command.requestId),requestId:'not-owned'})]){
    const f=fixture(t,{onWrite:emit,onKill:(child,f)=>f.exit(child)});await assert.rejects(f.client.refine(input()),error=>['SURFACE_PROTOCOL_INVALID','SURFACE_DIAGNOSTIC_LIMIT'].includes(error.code));assert.equal(f.writes.length,1);
  }
});
test('shutdown confirms exit and permanently closes admission',async t=>{
  const f=fixture(t,{onWrite:autoHandshake,onKill:(child,f)=>f.exit(child)}),work=f.client.refine(input()),checked=assert.rejects(work,{code:'SURFACE_SERVICE_CLOSED'});await tick();await f.client.closeAndWait();await checked;await assert.rejects(f.client.refine(input()),{code:'SURFACE_SERVICE_CLOSED'});assert.equal(f.client.children.size,0);
});
test('failed spawn with observed close is unavailable, not an unconfirmed live process',async t=>{
  const f=fixture(t,{failSpawn:true});await assert.rejects(f.client.refine(input()),{code:'SURFACE_PROCESS_UNAVAILABLE'});assert.equal(f.client.status().state,'idle');assert.equal(f.client.children.size,0);
});
