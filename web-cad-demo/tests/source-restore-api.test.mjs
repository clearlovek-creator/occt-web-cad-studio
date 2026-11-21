import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {stopTestChild} from './helpers/stop-test-child.mjs';

test('source recovery API admits only audited targets, retains results across restart, reconciles interrupted swaps and blocks unsafe modeling',{timeout:90000,skip:process.platform!=='win32'},async()=>{
  const root=path.resolve(import.meta.dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cad-source-restore-api-中文-'));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));const api=`http://127.0.0.1:${port}/api`;
  let gateway;
  const start=async()=>{
    let diagnostics='';gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:String(port),GEOMETRY_DATA_DIR:dataDir,GEOMETRY_STEP_LIMIT_BYTES:String(1024*1024)},windowsHide:true,stdio:['ignore','pipe','pipe']});gateway.stderr.on('data',chunk=>diagnostics+=chunk);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Source restore API startup '+diagnostics)),15000);gateway.once('error',error=>{clearTimeout(timer);reject(error);});gateway.stdout.on('data',chunk=>{if(String(chunk).includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
  };
  const stop=async()=>{await stopTestChild(gateway);gateway=null;};
  const json=async(route,method='GET',body,headers={})=>{
    const response=await fetch(api+route,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    return {status:response.status,payload:await response.json()};
  };
  const command=async(operation,parameters={},inputs={})=>{const result=await json('/commands','POST',{documentId:'A',operation,parameters,inputs});assert.equal(result.payload.ok,true,JSON.stringify(result.payload));return result.payload;};
  const wait=async read=>{for(let count=0;count<500;count++){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Source recovery condition did not settle');};
  const audit=async()=>{
    const started=await json('/documents/A/source-audit','POST');assert.equal(started.status,202,JSON.stringify(started.payload));
    return wait(async()=>{const result=(await json('/documents/A/source-audit')).payload.audit;assert.notEqual(result?.state,'failed',JSON.stringify(result));return result?.state==='complete'?result:null;});
  };
  const prepareUrl=(id,report)=>`/source-restores/${id}/prepare?${new URLSearchParams({scope:'current-undo-redo',documentId:'A',auditJobId:report.jobId,assetId:report.assets[0].assetId,fileName:'原始模型.step'})}`;
  const upload=async(id,report,bytes,headers={})=>{
    const response=await fetch(api+prepareUrl(id,report),{method:'POST',headers:{'content-type':'application/step',...headers},body:bytes,signal:AbortSignal.timeout(20000)});return {status:response.status,payload:await response.json()};
  };
  const settled=async id=>wait(async()=>{const result=await json('/source-restores/'+id);assert.equal(result.payload.ok,true,JSON.stringify(result.payload));return !result.payload.restoration.serviceBusy?result.payload.restoration:null;});
  const act=async(id,action)=>{const result=await json(`/source-restores/${id}/${action}`,'POST',{});assert.equal(result.status,202,JSON.stringify(result.payload));return settled(id);};
  const disk=()=>{
    const result={},walk=directory=>{if(!fs.existsSync(directory))return;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())walk(file);else result[path.relative(dataDir,file)]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');}};
    for(const name of ['history','property-schemas'])walk(path.join(dataDir,name));return result;
  };
  try{
    await start();const empty=await json('/source-restores');assert.equal(empty.status,200);assert.equal(empty.payload.total,0);assert.equal(fs.existsSync(path.join(dataDir,'source-restores')),false,'Reading history cannot create recovery materials');
    const created=await command('primitive.box',{width:12,depth:15,height:8}),exported=await json('/documents/A/exports/step','POST',{});assert.equal(exported.payload.ok,true);
    const bytes=Buffer.from(await fetch(`http://127.0.0.1:${port}`+exported.payload.downloadUrl).then(response=>response.arrayBuffer()));
    const imported=await fetch(api+'/documents/A/imports/step',{method:'POST',headers:{'content-type':'application/step'},body:bytes}).then(response=>response.json());assert.equal(imported.ok,true,JSON.stringify(imported));assert.ok(created.bodyCount);
    const type=await command('property.type.create',{key:'RestoreCheck',name:'来源恢复验证',targetScope:'project',association:'none',fields:[{key:'frequency',label:'频率',type:'double',default:3},{key:'enabled',label:'启用',type:'bool',default:true}]});
    await command('property.instance.create',{typeId:type.type.typeId,name:'Setup1',value:{frequency:3,enabled:true},target:null});
    const baseline=await command('document.summary'),before=disk(),target=baseline.features.find(feature=>feature.type==='import.step').stringParameters.sourcePath,original=fs.readFileSync(target);fs.appendFileSync(target,'\n/* changed source */');
    let report=await audit();assert.equal(report.assets[0].status,'changed');const id='restore-'+randomUUID();
    assert.equal((await upload(id,report,original,{origin:'https://untrusted.example'})).status,403);
    const untrustedHost=await new Promise((resolve,reject)=>{const request=http.get(api+'/source-restores',{headers:{Host:'untrusted.example:'+port}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});request.once('error',reject);});assert.equal(untrustedHost,403);
    const arbitrary=await fetch(api+prepareUrl(id,report)+'&target=C%3A%5Cprivate.step',{method:'POST',headers:{'content-type':'application/step'},body:original});assert.equal(arbitrary.status,400);
    assert.equal(fs.existsSync(path.join(dataDir,'source-restores')),false,'Rejected admission cannot create operation directories');
    const accepted=await upload(id,report,original,{origin:'http://localhost:3000'});assert.equal(accepted.status,202,JSON.stringify(accepted.payload));let operation=await settled(id);assert.equal(operation.state,'prepared');assert.equal(operation.canCommit,true);assert.equal(operation.referenceCount>=1,true);assert.equal(JSON.stringify(operation).includes(dataDir),false);assert.deepEqual(disk(),before);
    assert.equal((await json(`/source-restores/${id}/commit`,'POST',{target:'C:\\private.step'})).status,400);
    const malformed=await fetch(api+`/source-restores/${id}/commit`,{method:'POST',headers:{'content-type':'application/json'},body:'{invalid'});assert.equal(malformed.status,400);
    const largeAction=await fetch(api+`/source-restores/${id}/commit`,{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(1025)});assert.equal(largeAction.status,413);assert.equal(fs.readFileSync(target,'utf8').endsWith('/* changed source */'),true);
    const duplicate=await upload(id,report,original);assert.equal(duplicate.status,409);assert.equal(duplicate.payload.code,'SOURCE_RESTORE_EXISTS');
    for(const role of ['candidate','before']){
      const response=await fetch(api+`/source-restores/${id}/files/${role}`);assert.equal(response.status,200);const result=Buffer.from(await response.arrayBuffer());assert.equal(createHash('sha256').update(result).digest('hex'),response.headers.get('x-content-sha256'));assert.equal(result.equals(original),role==='candidate');
    }
    operation=await act(id,'commit');assert.equal(operation.state,'committed');assert.deepEqual(fs.readFileSync(target),original);assert.equal((await command('document.summary')).stateToken,baseline.stateToken);assert.deepEqual(disk(),before);
    const recordPath=path.join(dataDir,'source-restores',id,'record.json'),attempts=JSON.parse(fs.readFileSync(recordPath)).attempts.length;await act(id,'commit');assert.equal(JSON.parse(fs.readFileSync(recordPath)).attempts.length,attempts,'Repeated commit must only acknowledge the original completed result');
    operation=await act(id,'rollback');assert.equal(operation.state,'rolled-back');assert.equal(fs.readFileSync(target,'utf8').endsWith('/* changed source */'),true);assert.deepEqual(disk(),before);
    const stale=await upload('restore-'+randomUUID(),report,original);assert.equal(stale.status,409);assert.equal(stale.payload.code,'SOURCE_RESTORE_ASSET_NOT_READY');
    report=await audit();const invalid='restore-'+randomUUID();assert.equal((await upload(invalid,report,Buffer.concat([original,Buffer.from('not original')]))).status,202);const rejected=await settled(invalid);assert.equal(rejected.state,'failed');assert.equal(rejected.requestErrorCode,'SOURCE_RESTORE_CONFLICT');assert.equal(rejected.canCommit,false);assert.equal(rejected.canRevalidate,true);assert.deepEqual(disk(),before);
    const oversized=await upload('restore-'+randomUUID(),report,Buffer.alloc(1024*1024+1));assert.equal(oversized.status,413);
    const partial='restore-'+randomUUID();report=await audit();
    const aborted=http.request(api+prepareUrl(partial,report),{method:'POST',headers:{'content-type':'application/step'}});aborted.on('error',()=>{});aborted.write(original.subarray(0,256));
    await wait(async()=>{const result=await json('/source-restores/'+partial);return result.status===200&&result.payload.restoration.phase==='upload';});aborted.destroy();
    const incomplete=await settled(partial);assert.equal(incomplete.uploadComplete,false);assert.equal(incomplete.canRevalidate,false);assert.equal(incomplete.canCommit,false);assert.equal(incomplete.canAbandon,true);
    await act(partial,'abandon');assert.equal((await settled(partial)).state,'abandoned');assert.equal(fs.existsSync(path.join(dataDir,'source-restores',partial,'candidate.step')),true,'Partial material is retained, not silently cleaned');
    report=await audit();const interrupted='restore-'+randomUUID();assert.equal((await upload(interrupted,report,original)).status,202);assert.equal((await settled(interrupted)).state,'prepared');await stop();
    const crash=spawn(process.execPath,[path.join(root,'tests/fixtures/source-restore-crash-fixture.mjs'),dataDir,interrupted,'commit'],{windowsHide:true,stdio:['ignore','pipe','pipe']});crash.stdout.resume();let diagnostic='';crash.stderr.on('data',chunk=>diagnostic+=chunk);
    // This test-only fixture reuses the already inspected real plan signature
    // so that termination occurs at the file/journal boundary, not in planning.
    try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Crash fixture timeout '+diagnostic)),10000);crash.once('exit',code=>{clearTimeout(timer);try{assert.equal(code,88,diagnostic);resolve();}catch(error){reject(error);}});crash.once('error',error=>{clearTimeout(timer);reject(error);});});}finally{await stopTestChild(crash);}
    assert.deepEqual(fs.readFileSync(target),original);await start();operation=await settled(interrupted);assert.equal(operation.state,'prepared');assert.match(operation.recovery,/未自动继续/);assert.equal(fs.readFileSync(target,'utf8').endsWith('/* changed source */'),true);assert.deepEqual(disk(),before);
    assert.equal((await json('/source-restores/'+invalid)).payload.restoration.requestErrorCode,'SOURCE_RESTORE_CONFLICT','Failed candidate stays queryable without an automatic retry');
    await act(interrupted,'commit');await stop();fs.writeFileSync(target,'external unknown version');await start();
    let health=(await json('/health')).payload;assert.equal(health.storage.sourceRestoration.blocked,true);const blocked=await json('/commands','POST',{documentId:'A',operation:'document.summary'});assert.equal(blocked.status,503);assert.equal(blocked.payload.code,'SOURCE_RESTORE_RECOVERY_REQUIRED');
    operation=(await json('/source-restores/'+interrupted)).payload.restoration;assert.equal(operation.state,'attention');assert.equal(operation.canReview,true);assert.equal(JSON.stringify(operation).includes(dataDir),false);
    await audit();assert.deepEqual(disk(),before,'Read-only diagnostics must remain available while modeling is blocked');
    assert.equal((await act(interrupted,'review')).state,'attention');assert.equal(fs.readFileSync(target,'utf8'),'external unknown version','Review must not guess an unknown external file');
    fs.writeFileSync(target,original);assert.equal((await act(interrupted,'review')).state,'committed');health=(await json('/health')).payload;assert.equal(health.storage.sourceRestoration.blocked,false);assert.equal((await command('document.summary')).stateToken,baseline.stateToken);assert.deepEqual(disk(),before);
    const listed=(await json('/source-restores?documentId=A&limit=2')).payload;assert.equal(listed.items.length,2);assert.ok(listed.total>=4);assert.equal(JSON.stringify(listed).includes(dataDir),false);assert.equal((await json('/source-restores?limit=51')).status,400);
  }finally{await stop();fs.rmSync(dataDir,{recursive:true,force:true});}
});
