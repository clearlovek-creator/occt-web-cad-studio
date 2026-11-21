import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {stopTestChild} from './helpers/stop-test-child.mjs';
const root=path.resolve(import.meta.dirname,'..'),tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;}
async function launch(data,extra={},ready=true){
  const api=`http://127.0.0.1:${await freePort()}/api`,port=new URL(api).port,child=spawn(process.execPath,['tests/fixtures/gateway-shutdown.mjs'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:port,GEOMETRY_WORKER_TIMEOUT_MS:'30000',GEOMETRY_WORKER_MEMORY_LIMIT_BYTES:String(128*1024*1024),...extra}});let output='',diagnostics='',lines='';const events=[];child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;lines+=chunk;let at;while((at=lines.indexOf('\n'))>=0){try{events.push(JSON.parse(lines.slice(0,at)));}catch{}lines=lines.slice(at+1);}});child.stderr.on('data',chunk=>diagnostics=(diagnostics+chunk).slice(-16384));
  const deadline=Date.now()+15000;while(!output.includes(ready?'Geometry gateway ready':'Geometry gateway listening')){assert.equal(child.exitCode,null,diagnostics);assert.ok(Date.now()<deadline,'Native-memory fixture startup unconfirmed: '+diagnostics);await tick();}
  const get=route=>fetch(api+route,{signal:AbortSignal.timeout(15000)}).then(response=>response.json());
  const cad=async(operation,parameters={},inputs={})=>{const state=await get('/documents/default'),response=await fetch(api+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId:'default',operation,parameters,inputs,baseRevision:state.revision,baseStateToken:state.stateToken})}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.ok,true);return value;};
  const stop=async()=>{
    if(child.exitCode==null&&child.signalCode==null){const file=path.join(data,'.gateway-control.json');if(fs.existsSync(file)){const control=JSON.parse(fs.readFileSync(file));const ended=new Promise(resolve=>child.once('close',resolve));await fetch(api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':control.token}}).catch(()=>{});let timer;try{await Promise.race([ended,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Memory fixture shutdown unconfirmed')),15000))]);}finally{clearTimeout(timer);}}}
    await stopTestChild(child);
  };
  return {api,child,events,get,cad,stop};
}
function remove(directory){assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^cad-native-memory-/);fs.rmSync(directory,{recursive:true,force:true});}
function largeStep(directory){
  const environment={...process.env};const inherited=environment.Path||environment.PATH||'';delete environment.Path;delete environment.PATH;environment.PATH=[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  const generated=spawnSync(path.join(path.dirname(process.env.GEOMETRY_WORKER_PATH),'fingerprint_tests.exe'),[],{env:environment,input:JSON.stringify({mode:'prepare',directory,patches:128,poles:64})+'\n',windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.equal(generated.status,0,generated.error?.message+'\n'+generated.stderr+'\n'+generated.stdout);return fs.readFileSync(path.join(directory,'surfaces.step'));
}
test('real complex STEP exceeding an OS commit budget retires the native process and restores geometry, identity, both property systems and history',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-native-memory-')),data=path.join(directory,'data');let f,verified=false;
  try{const bytes=largeStep(path.join(directory,'source'));f=await launch(data);const health=await f.get('/health');assert.equal(health.capabilities.nativeGeometry.resourceGuard.processLimitBytes,128*1024*1024);assert.equal(health.runtime.geometryMemory.state,'enforced');const instance=health.capabilities.nativeGeometry.workerInstance;
    const box=await f.cad('primitive.box',{width:10,depth:20,height:30}),type=await f.cad('property.type.create',{key:'MemoryBoundary',targetScope:'body',association:'required',fields:[{key:'marker',type:'int'}]});await f.cad('property.instance.create',{typeId:type.type.typeId,value:{marker:41},target:{kind:'body',bodyId:box.bodyId}});await f.cad('property.set',{key:'memoryMarker',type:'int',value:41},{kind:'body',bodyId:box.bodyId});
    const before=await f.cad('document.summary'),raw=(await f.cad('property.list')).propertyRecords,typed=(await f.cad('property.instance.list')).instances;
    const response=await fetch(f.api+'/documents/default/imports/step',{method:'POST',headers:{'content-type':'application/step','x-request-id':'memory-budget-import'},body:bytes,signal:AbortSignal.timeout(60000)}),result=await response.json();assert.equal(response.status,503,JSON.stringify(result));assert.equal(result.documentId,'default');assert.ok(['WORKER_MEMORY_LIMIT','WORKER_MEMORY_EXHAUSTED'].includes(result.code),JSON.stringify(result));assert.deepEqual(result.projectRollback,{documentId:'default',confirmed:true});assert.equal(result.retryableByModel,false);
    const after=await f.cad('document.summary');for(const key of ['revision','stateToken','features','bodyMetadata','entityIdentities','coordinateSystems','history'])assert.deepEqual(after[key],before[key],key);assert.deepEqual((await f.cad('property.list')).propertyRecords,raw);assert.deepEqual((await f.cad('property.instance.list')).instances,typed);assert.equal((await f.cad('geometry.measure',{}, {bodyId:box.bodyId})).volume,6000);
    const recovered=await f.get('/health');assert.notEqual(recovered.capabilities.nativeGeometry.workerInstance,instance);assert.equal(recovered.capabilities.nativeGeometry.resourceGuard.jobLimitBytes,128*1024*1024);assert.equal((await f.get('/documents/default/imports/step/status?requestId=memory-budget-import')).stepImportStatus.phase,'failed');assert.equal(fs.readdirSync(path.join(data,'document-transactions')).some(file=>file.endsWith('.pending.json')),false);assert.equal((await f.cad('primitive.box',{width:2,depth:3,height:4,x:50})).bodyCount,2);
    // The exact same STEP bytes must succeed under an adequate, still enforced
    // budget. A malformed-file failure is not evidence of memory qualification.
    await f.stop();f=null;f=await launch(path.join(directory,'control-data'),{GEOMETRY_WORKER_MEMORY_LIMIT_BYTES:String(1024**3)});const accepted=await fetch(f.api+'/documents/default/imports/step',{method:'POST',headers:{'content-type':'application/step','x-request-id':'adequate-memory-import'},body:bytes,signal:AbortSignal.timeout(60000)}),control=await accepted.json();assert.equal(accepted.status,200,JSON.stringify(control).slice(0,2000));assert.equal(control.ok,true);const imported=await f.cad('document.summary');assert.equal(imported.features[0].type,'import.step');assert.equal(imported.bodyMetadata.reduce((sum,body)=>sum+body.topologyNaming.namedFaceCount,0),128);assert.equal((await f.get('/health')).capabilities.nativeGeometry.resourceGuard.jobLimitBytes,1024**3);verified=true;
  }finally{await f?.stop();if(verified)remove(directory);else console.error('Preserved native memory recovery diagnostics: '+directory);}
});
test('missing or mismatched native protection declaration blocks all engineering RPC and does not restart unguarded',async()=>{
  for(const mode of ['missing','mismatch']){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-native-memory-'));let f,verified=false;
    try{f=await launch(path.join(directory,'data'),{CAD_TEST_RESOURCE_DECLARATION:mode},false);const health=await f.get('/health');assert.equal(health.worker,false);assert.equal(health.runtime.geometryMemory.state,'blocked');assert.equal(health.runtime.geometryMemory.blockedCode,'WORKER_RESOURCE_GUARD_UNAVAILABLE');const response=await fetch(f.api+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId:'default',operation:'primitive.box',parameters:{width:1,depth:1,height:1}})}),value=await response.json();assert.equal(response.status,503,JSON.stringify(value));assert.equal(value.code,'WORKER_RESOURCE_GUARD_UNAVAILABLE');assert.equal(value.recoverable,false);await new Promise(resolve=>setTimeout(resolve,350));assert.equal(f.events.filter(item=>item.type==='fixture.geometry-start').length,1);assert.ok(f.events.filter(item=>item.type==='fixture.native-request').every(item=>item.operation==='health.ping'));verified=true;
    }finally{await f?.stop();if(verified)remove(directory);else console.error('Preserved native guard declaration diagnostics: '+directory);}
  }
});
test('invalid Gateway resource policy fails before creating any persistent store or native child',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-native-memory-')),data=path.join(directory,'must-not-exist');
  try{const result=spawnSync(process.execPath,['gateway/server.mjs'],{cwd:root,windowsHide:true,env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_WORKER_MEMORY_LIMIT_BYTES:'0'},encoding:'utf8',timeout:10000});assert.notEqual(result.status,0);assert.match(result.stderr,/WORKER_RESOURCE_CONFIG_INVALID|几何内存限制/);assert.equal(fs.existsSync(data),false);}
  finally{remove(directory);}
});
