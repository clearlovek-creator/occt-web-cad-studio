import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {collectDiagnostics,diagnosticEndpoint,writeDiagnosticReport} from '../gateway/diagnostic-report.mjs';
import {diagnosticArguments} from '../scripts/export-diagnostics.mjs';

const secret='sk-private-sentinel-do-not-export',identity='11111111-1111-4111-8111-111111111111';
const fileNames=['package-lock.json','geometry-worker/build/occt_geometry_worker.exe','geometry-worker/build/cad_snapshot_source_inspector.exe','geometry-worker/build/cad_source_file_swap.exe','mesh-worker/build-gmsh/gmsh_mesh_worker.exe'];
function fixture(t){
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'cad-diagnostics-中文-')),id='frontend-1794718333067-'+randomUUID();
  const put=(relative,value)=>{const file=path.join(workspace,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));return file;};
  for(const file of fileNames)put(file,'fixture binary '+file);
  const lock=createHash('sha256').update(fs.readFileSync(path.join(workspace,fileNames[0]))).digest('hex');
  put('.releases/selected.json',{format:'web-cad-frontend-selection',version:1,releaseId:id});
  const manifest={format:'web-cad-frontend-release',version:1,releaseId:id,sourceSha256:'a'.repeat(64),dependencyLockSha256:lock,productionServerSha256:'b'.repeat(64),files:[]};put(`.releases/${id}/release.json`,manifest);
  put('.env','API_KEY='+secret);put('.data/project-secret.xbf',secret);put('runtime-logs/private.log',secret);
  t.after(()=>{assert.ok(workspace.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(workspace,{recursive:true,force:true});});
  const gateway={ok:true,gateway:true,worker:true,protocolVersion:1,loadedDocuments:4,storage:{writer:{mechanism:'windows-kernel-file-sharing',ownerPid:87654321,instanceId:identity,directoryIdentity:secret},sourceRestoration:{blocked:false,active:null}},documentLoading:{known:4,unloaded:2,loading:0,ready:2,failed:0},lifecycle:{state:'running',activeDocuments:0,queuedDocumentActions:0},runtime:{uptimeSeconds:3.2,workerPending:0,gatewayMemory:{rss:32,heapUsed:16}}};
  const frontend={ok:true,format:'web-cad-frontend',version:1,mode:'Production',releaseId:id,clientAssetsValid:true,apiMode:'same-origin',gatewayApi:'http://127.0.0.1:8788/api',ownerPid:98765432};
  const calls=[],fetchImpl=async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify(new URL(url).pathname==='/__cad/health'?frontend:gateway),{headers:{'content-type':'application/json'}});};
  return {workspace,id,put,manifest,gateway,frontend,calls,fetchImpl,collect:options=>collectDiagnostics({workspace,fetchImpl,...options})};
}
async function server(t,handler){const instance=http.createServer(handler);await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));t.after(async()=>{instance.closeAllConnections();await new Promise(resolve=>instance.close(resolve));});const origin='http://127.0.0.1:'+instance.address().port;return {frontend:origin+'/',gateway:origin+'/api'};}

test('diagnostic endpoints allow only exact credential-free local HTTP origins and fixed paths',()=>{
  assert.equal(diagnosticEndpoint('http://127.0.0.1:3000/','frontend').port,'3000');assert.equal(diagnosticEndpoint('http://[::1]:8788/api','gateway').pathname,'/api');
  for(const value of ['https://example.com/api','http://example.com:8788/api','http://127.0.0.1/api','file:///api','http://user:pass@127.0.0.1:8788/api','http://127.0.0.1:8788/api?key='+secret,'http://127.0.0.1:8788/api#secret','http://127.0.0.1:8788/api/','http://127.0.0.1:8788/api/commands'])assert.throws(()=>diagnosticEndpoint(value,'gateway'),error=>error.code==='DIAGNOSTIC_ENDPOINT_INVALID');
});

test('offline reports hash fixed installed files without network requests or running-binary claims',async t=>{
  const f=fixture(t),report=await f.collect({offline:true});assert.equal(f.calls.length,0);assert.ok(report.localInstalledFiles.every(file=>file.state==='hashed'));assert.equal(report.comparisons.selectedDependencyLockMatchesLocal,true);assert.equal(report.observations.gateway.state,'not-observed');assert.equal(report.policy.localFilesAreRunningBinaryAttestation,false);assert.equal(report.selectedRelease.integrity,'metadata-only-not-file-certification');assert.equal(report.localInstalledFiles[0].sha256,f.manifest.dependencyLockSha256);
});

test('collector opens only seven fixed evidence files, never environment, data, control records or raw logs',async t=>{
  const f=fixture(t),opened=[],original=fs.openSync;
  fs.openSync=(file,...args)=>{const relative=path.relative(f.workspace,String(file)).replaceAll('\\','/');opened.push(relative);assert.ok(!relative.startsWith('.data/')&&!relative.startsWith('runtime-logs/')&&relative!=='.env');return original(file,...args);};
  try{await f.collect({offline:true});}finally{fs.openSync=original;}
  assert.deepEqual(new Set(opened),new Set([...fileNames,'.releases/selected.json',`.releases/${f.id}/release.json`]));
});

test('only three fixed GETs run; successful native health is projected through a strict field whitelist',async t=>{
  const f=fixture(t);f.gateway.error=secret;f.gateway.runtime.gatewayMemory.secret=secret;f.gateway.storage.sourceRestoration.diagnostic={code:secret,error:'C:\\Customer\\'+secret};f.frontend.privateConfig={key:secret};
  const report=await f.collect(),serialized=JSON.stringify(report);assert.equal(report.observations.frontend.state,'ready');assert.equal(report.observations.gateway.state,'ready');assert.equal(report.comparisons.runningMatchesSelected,true);assert.equal(report.comparisons.bridgeReachesSameGateway,true);assert.equal(f.calls.length,3);
  for(const call of f.calls){assert.equal(call.options.method,'GET');assert.equal(call.options.redirect,'error');assert.equal(call.options.credentials,'omit');assert.equal(call.options.body,undefined);assert.deepEqual(call.options.headers,{Accept:'application/json'});assert.ok(['/api/health','/__cad/health'].includes(new URL(call.url).pathname));}
  for(const value of [secret,f.workspace,'87654321','98765432',identity,'gatewayApi','ownerPid'])assert.equal(serialized.includes(value),false,value);assert.deepEqual(report.findings,[]);
});

test('release and Gateway mismatches are observable but never restart or replay anything',async t=>{
  const f=fixture(t);f.frontend.releaseId='frontend-1794718333067-'+randomUUID();f.frontend.gatewayApi='http://127.0.0.1:8789/api';
  const report=await f.collect({fetchImpl:async(url,options)=>{f.calls.push({url:String(url),options});const address=new URL(url),body=address.pathname==='/__cad/health'?f.frontend:structuredClone(f.gateway);if(address.port==='3000'&&address.pathname==='/api/health')body.storage.writer.instanceId=randomUUID();return Response.json(body);}});
  assert.equal(report.comparisons.runningMatchesSelected,false);assert.equal(report.comparisons.advertisedGatewayMatchesConfigured,false);assert.equal(report.comparisons.bridgeReachesSameGateway,false);assert.ok(report.findings.some(item=>item.code==='RUNNING_RELEASE_DIFFERS_FROM_SELECTION'));assert.ok(report.findings.some(item=>item.code==='GATEWAY_TARGET_MISMATCH'));assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>call.options.method==='GET'));
});

test('an old Gateway without restoration health is unsupported, not falsely clear; typed blocks stay visible',async t=>{
  const f=fixture(t);delete f.gateway.storage.sourceRestoration;assert.deepEqual((await f.collect()).observations.gateway.sourceRestoration,{supported:false});
  f.gateway.storage.sourceRestoration={blocked:true,active:{action:'review',operationId:secret},diagnostic:{error:secret}};const report=await f.collect();assert.equal(report.observations.gateway.sourceRestoration.blocked,true);assert.equal(report.observations.gateway.sourceRestoration.activeAction,'review');assert.ok(report.findings.some(item=>item.code==='SOURCE_RECOVERY_BLOCKED'));assert.equal(JSON.stringify(report).includes(secret),false);
});

test('malformed source recovery fields remain unverified, never coerced into a cleared block',async t=>{
  const f=fixture(t);
  for(const value of [null,{}, {blocked:'false',active:null},{blocked:false,active:{action:secret}}]){f.gateway.storage.sourceRestoration=value;const report=await f.collect();assert.equal(report.observations.gateway.sourceRestoration.blocked,null);assert.equal(report.observations.gateway.sourceRestoration.state,'invalid-response');assert.ok(report.findings.some(item=>item.code==='SOURCE_RECOVERY_STATE_UNVERIFIED'));assert.equal(JSON.stringify(report).includes(secret),false);}
});

test('connection exceptions, arbitrary HTTP errors and malformed JSON never enter report prose',async t=>{
  const f=fixture(t);const failed=await f.collect({fetchImpl:async()=>{throw Error(secret+' '+f.workspace);}});assert.equal(failed.observations.frontend.state,'unreachable');assert.equal(JSON.stringify(failed).includes(secret),false);
  for(const response of [()=>new Response(secret,{headers:{'content-type':'text/html'},status:502}),()=>new Response(secret,{headers:{'content-type':'application/json'},status:503}),()=>Response.json({ok:true,error:secret})]){const result=await f.collect({fetchImpl:async()=>response()});assert.notEqual(result.observations.gateway.state,'ready');assert.equal(JSON.stringify(result).includes(secret),false);}
});

test('real HTTP redirects are rejected without contacting their destination',async t=>{
  const f=fixture(t);let redirected=0;const urls=await server(t,(request,response)=>{if(request.url==='/do-not-read'){redirected++;response.end(secret);}else{response.writeHead(302,{Location:'/do-not-read'});response.end();}});
  const report=await f.collect({...urls,fetchImpl:fetch});assert.equal(redirected,0);assert.equal(report.observations.frontend.state,'unreachable');assert.equal(JSON.stringify(report).includes(secret),false);
});

test('response limits cover both declared and streaming bodies, cancel the response, and do not retry',async t=>{
  const f=fixture(t);let calls=0,cancelled=0;
  for(const declared of [true,false]){const report=await f.collect({maxResponseBytes:1024,fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(2048,65));},cancel(){cancelled++;}}),{headers:{'content-type':'application/json',...(declared?{'content-length':'2048'}:{})}});}});assert.equal(report.observations.gateway.state,'response-limit');}
  assert.equal(calls,6);assert.equal(cancelled,6);
});

test('real unresponsive endpoints time out within the configured observation budget without retries',{timeout:5000},async t=>{
  const f=fixture(t);let calls=0;
  for(const sendHeaders of [false,true]){const urls=await server(t,(_request,response)=>{calls++;if(sendHeaders){response.writeHead(200,{'content-type':'application/json'});response.write('{');}}),started=performance.now(),report=await f.collect({...urls,fetchImpl:fetch,timeoutMs:100});assert.equal(report.observations.frontend.state,'timeout');assert.equal(report.observations.gateway.state,'timeout');assert.ok(performance.now()-started<1500);}
  assert.equal(calls,6);
});

test('link components and corrupt/oversized release metadata are rejected instead of copied',async t=>{
  const f=fixture(t),native=path.join(f.workspace,fileNames[1]);fs.unlinkSync(native);fs.linkSync(path.join(f.workspace,'.env'),native);let report=await f.collect({offline:true});assert.equal(report.localInstalledFiles[1].state,'DIAGNOSTIC_FILE_UNSAFE');assert.equal(JSON.stringify(report).includes(secret),false);
  f.put('.releases/selected.json',secret);report=await f.collect({offline:true});assert.equal(report.selectedRelease.state,'DIAGNOSTIC_METADATA_INVALID');assert.equal(JSON.stringify(report).includes(secret),false);
  f.put('.releases/selected.json',' '.repeat(4097));report=await f.collect({offline:true});assert.equal(report.selectedRelease.state,'DIAGNOSTIC_FILE_TOO_LARGE');
});

test('file hashing rejects over-budget binaries without reading them into the report',async t=>{
  const f=fixture(t),file=path.join(f.workspace,fileNames[1]),identity=fs.statSync(file).ino,original=fs.readSync;let changed=false,report;
  fs.readSync=(fd,...args)=>{const bytes=original(fd,...args);if(!changed&&fs.fstatSync(fd).ino===identity){changed=true;fs.appendFileSync(file,secret);}return bytes;};
  try{report=await f.collect({offline:true});}finally{fs.readSync=original;}
  assert.equal(changed,true);assert.equal(report.localInstalledFiles[1].state,'DIAGNOSTIC_FILE_CHANGED');assert.equal(report.localInstalledFiles[1].sha256,undefined);assert.equal(JSON.stringify(report).includes(secret),false);
  const fd=fs.openSync(file,'r+');fs.ftruncateSync(fd,32*1024*1024+1);fs.closeSync(fd);report=await f.collect({offline:true});assert.equal(report.localInstalledFiles[1].state,'DIAGNOSTIC_FILE_TOO_LARGE');assert.equal(report.localInstalledFiles[1].sha256,undefined);assert.ok(report.findings.some(item=>item.code==='LOCAL_COMPONENT_EVIDENCE_INCOMPLETE'));
});

test('reports write only to a fixed artifact directory, never overwrite an existing report, and reject directory links',async t=>{
  const f=fixture(t),report=await f.collect({offline:true}),file=writeDiagnosticReport(f.workspace,report);assert.equal(path.dirname(file),path.join(f.workspace,'.artifacts/diagnostics'));assert.equal(JSON.parse(fs.readFileSync(file)).reportId,report.reportId);assert.throws(()=>writeDiagnosticReport(f.workspace,report),error=>error.code==='EEXIST');
  const other=fixture(t),destination=path.join(other.workspace,'private');fs.mkdirSync(destination);fs.mkdirSync(path.join(other.workspace,'.artifacts'));fs.symlinkSync(destination,path.join(other.workspace,'.artifacts/diagnostics'),process.platform==='win32'?'junction':'dir');assert.throws(()=>writeDiagnosticReport(other.workspace,report),error=>error.code==='DIAGNOSTIC_FILE_UNSAFE');assert.deepEqual(fs.readdirSync(destination),[]);
});

test('CLI arguments reject duplicates, unknown destinations and unbounded timeouts',()=>{
  assert.deepEqual(diagnosticArguments(['--offline','--timeout-ms','1500']),{offline:true,timeoutMs:1500});
  for(const args of [['--output','x'],['--offline','--offline'],['--gateway'],['--timeout-ms','99999'],['--timeout-ms','NaN'],['--frontend','--offline'],['--timeout-ms','99']])assert.throws(()=>diagnosticArguments(args),error=>error.code==='DIAGNOSTIC_ARGUMENTS_INVALID');
});

test('standalone CLI works offline without starting services and rejects secret-bearing arguments without echoing them',async t=>{
  const f=fixture(t);for(const relative of ['scripts/export-diagnostics.mjs','gateway/diagnostic-report.mjs']){const target=path.join(f.workspace,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(new URL('../'+relative,import.meta.url),target);}
  const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(f.workspace,'scripts/export-diagnostics.mjs'),...args],{cwd:f.workspace,windowsHide:true,env:{...process.env,PRIVATE_TEST_KEY:secret},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('exit',code=>resolve({code,stdout,stderr}));});
  const exported=await run(['--offline']);assert.equal(exported.code,0,exported.stderr);const reply=JSON.parse(exported.stdout);assert.equal(reply.servicesModified,false);const report=fs.readFileSync(path.join(f.workspace,reply.file),'utf8');assert.equal(report.includes(secret),false);assert.equal(report.includes(f.workspace),false);assert.equal(fs.readFileSync(path.join(f.workspace,'.env'),'utf8'),'API_KEY='+secret);
  const invalid=await run(['--gateway','http://user:'+secret+'@127.0.0.1:8788/api']);assert.equal(invalid.code,1);assert.equal(invalid.stderr.includes(secret),false);assert.equal(invalid.stderr.includes(f.workspace),false);assert.equal(JSON.parse(invalid.stderr).code,'DIAGNOSTIC_ENDPOINT_INVALID');assert.equal(fs.readdirSync(path.join(f.workspace,'.artifacts/diagnostics')).length,1);
});
