import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {chromium} from 'playwright';
import {createBackendRelease} from '../gateway/backend-release.mjs';

if (process.platform !== "win32") throw new Error("This verifier covers the Windows background service launcher.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(os.tmpdir(), "web-cad-service-test-"));
const runtime = path.join(scratch, "runtime-工程"), data = path.join(scratch, "persistent-data-工程");
const releases=path.join(scratch,'releases-发布');
const backendReleases=path.join(scratch,'backend-后台发布');
async function freePort() {
  const server=net.createServer(); await new Promise((resolve,reject) => {server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const port=server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
const frontendPort=await freePort(), gatewayPort=await freePort();
async function manage(action,options={}) {
  const args=["-NoProfile","-ExecutionPolicy","Bypass","-File",path.join(root,"scripts","start-web-cad-demo.ps1"),"-Action",action,"-Service",options.service||'All',"-FrontendPort",String(frontendPort),"-GatewayPort",String(options.gatewayPort||gatewayPort),"-DataDirectory",data,"-RuntimeDirectory",options.runtime||runtime,"-StartupTimeoutSeconds","90","-FrontendMode",options.mode||'Production',"-FrontendReleaseRoot",options.releases||releases,"-AsJson"];
  if(options.releaseId)args.push('-FrontendReleaseId',options.releaseId);
  args.push('-GatewayReleaseRoot',backendReleases,'-GatewayMode',options.gatewayMode||'Production');
  if(options.backendReleaseId)args.push('-GatewayReleaseId',options.backendReleaseId);
  const child=spawn("powershell.exe",args,{cwd:root,env:{...process.env,PI_CLI_PATH:path.join(root,'tests/fixtures/pi-rpc-fixture.mjs'),PI_CLI_CWD:root},windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr=""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data",chunk=>{stdout+=chunk;}); child.stderr.on("data",chunk=>{stderr+=chunk;});
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error(`Service action timed out: ${action}`));},180_000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    let exitAt=null;child.once('exit',()=>{exitAt=performance.now();});
    // Do not hide handle inheritance regressions by forcibly destroying pipes
    // after exit. The management process and its caller pipes must both close.
    child.once("close",code=>{clearTimeout(timer);
      if(exitAt===null||performance.now()-exitAt>1000){reject(Error('Service management pipes did not promptly close after process exit.'));return;}
      if(code!==0) {const error=new Error(`Service ${action} failed: ${stderr}`);error.stderr=stderr;reject(error);return;}
      try{resolve(JSON.parse(stdout.trim()));}catch(error){reject(new Error(`Invalid service response: ${stdout}\n${stderr}`,{cause:error}));}
    });
  });
}
async function command(operation,parameters={}) {
  const response=await fetch(`http://127.0.0.1:${gatewayPort}/api/commands`,{method:"POST",signal:AbortSignal.timeout(15_000),headers:{"Content-Type":"application/json"},body:JSON.stringify({protocolVersion:1,documentId:"service-check",operation,parameters})});
  const result=await response.json(); assert.equal(result.ok,true,JSON.stringify(result)); return result;
}
let foreign,verified=false;
const checks=[];
function pass(message) { checks.push(message); console.log(`PASS ${message}`); }
async function buildRelease(){
  const sentinel='must-not-enter-release';
  const build=spawn(process.execPath,['scripts/build-frontend-release.mjs','--release-root',releases],{cwd:root,env:{...process.env,PRIVATE_BUILD_TEST_SECRET:sentinel},windowsHide:true,stdio:['ignore','pipe','pipe']});let buildOutput='';build.stdout.on('data',chunk=>buildOutput+=chunk);build.stderr.on('data',chunk=>buildOutput+=chunk);
  await new Promise((resolve,reject)=>{build.once('error',reject);build.once('exit',code=>code===0?resolve():reject(Error('Isolated release build failed: '+buildOutput)));});
  const selection=JSON.parse(await readFile(path.join(releases,'selected.json'),'utf8')),directory=path.join(releases,selection.releaseId),manifest=JSON.parse(await readFile(path.join(directory,'release.json'),'utf8'));
  assert.equal(buildOutput.includes(sentinel),false);
  for(const file of manifest.files){
    assert.equal(file.file.split('/').some(part=>part==='.data'||part==='.env'||part.startsWith('.env.')||part==='pi-sessions'),false,'Release includes private input path');
    assert.equal((await readFile(path.join(directory,file.file))).includes(Buffer.from(sentinel)),false,'Release includes private environment sentinel');
  }
  return {selection,directory,manifest};
}
try {
  await assert.rejects(manage('Start'),error=>/Frontend release validation failed/.test(error.stderr));
  assert.equal((await manage('Status')).Services.length,0);pass('missing production release blocks startup before launching new services');
  const initial=await buildRelease(),selection=initial.selection,releaseDirectory=initial.directory,manifest=initial.manifest;
  assert.equal(manifest.apiMode,'same-origin');assert.ok(manifest.files.some(item=>item.file==='runtime/scripts/frontend-server.mjs'));pass('an isolated source snapshot builds a checked release with pinned runtime and no private environment');
  await assert.rejects(manage('Start'),error=>/Backend release validation failed/.test(error.stderr));assert.equal((await manage('Status')).Services.length,0);pass('missing backend snapshot blocks startup without falling back to workspace source');
  const backend=createBackendRelease({workspace:root,releaseRoot:backendReleases,nativeRuntime:true,piSdk:false});
  const first=await manage("Start"); assert.equal(first.Services.length,2); assert.ok(first.Services.every((item)=>item.State==="ready"));
  assert.equal(first.Services.find(item=>item.Name==='frontend').Mode,'Production');assert.equal(first.Services.find(item=>item.Name==='frontend').ReleaseId,selection.releaseId);
  assert.equal(path.resolve(first.DataDirectory),path.resolve(data)); pass("start waits for both real services and uses the explicit persistent directory");
  const backendHealth=await fetch(`http://127.0.0.1:${gatewayPort}/api/health`).then(response=>response.json());assert.equal(backendHealth.backendRelease.releaseId,backend.releaseId);assert.equal(backendHealth.backendRelease.mode,'project-code-snapshot');assert.equal(backendHealth.backendRelease.nativeRuntime.sha256,backend.native.sha256);assert.equal(first.Services.find(item=>item.Name==='gateway').Mode,'Production');pass('managed backend reports its fixed project and native runtime with external scope explicit');
  const second=await manage("Start"); assert.deepEqual(second.Services.map((item)=>item.Pid),first.Services.map((item)=>item.Pid)); pass("repeated start reuses healthy processes without duplicates");
  const box=await command("primitive.box",{width:12,depth:13,height:14,reset:true});
  const front=`http://127.0.0.1:${frontendPort}`,health=await fetch(front+'/__cad/health').then(response=>response.json());assert.equal(health.ownerPid,first.Services.find(item=>item.Name==='frontend').Pid);assert.equal(health.gatewayApi,`http://127.0.0.1:${gatewayPort}/api`);
  const bridged=await fetch(front+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:'service-check',operation:'document.summary'})}).then(response=>response.json());assert.equal(bridged.stateToken,box.stateToken);const denied=await fetch(front+'/api/commands',{method:'POST',headers:{Origin:'https://unrelated.example','Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);pass('production readiness proves owner and release; the runtime gateway port is bridged without rebuilding');
  await assert.rejects(manage('Start',{mode:'Development'}),error=>/mode differs/.test(error.stderr));assert.deepEqual((await manage('Status')).Services.map(item=>item.Pid),first.Services.map(item=>item.Pid));pass('switching runtime modes requires an explicit stop and never kills the healthy owner');
  const browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],requests=[],failed=[];page.on('pageerror',error=>{errors.push(error.message);console.error('Production browser error: '+error.message);});page.on('requestfailed',request=>failed.push({url:request.url(),error:request.failure()?.errorText}));page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))requests.push(request.url());});
    await page.addInitScript(()=>sessionStorage.setItem('occt.activeDocumentId','service-check'));await page.goto(front,{waitUntil:'networkidle'});
    try{await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]')?.dataset.renderedTriangles)>0);}catch(error){console.error('Production browser startup diagnostics: '+JSON.stringify({errors,requests,failed,body:(await page.locator('body').innerText()).slice(0,1000)}));throw error;}assert.ok(requests.length>0);assert.ok(requests.every(value=>new URL(value).origin===front));
    await page.getByRole('button',{name:'AI 助手',exact:true}).click();const panel=page.getByTestId('pi-agent-panel');await panel.locator('.pi-agent-status').filter({hasText:'会话在线'}).waitFor();await panel.getByRole('textbox',{name:'发送给 Pi Agent'}).fill('fixture:stream');await panel.getByRole('button',{name:'发送',exact:true}).click();await panel.getByText('Transport fixture phase 5',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'停止',exact:true}).waitFor({state:'detached'});assert.equal(await panel.locator('.pi-agent-message.tool').count(),1);assert.deepEqual(errors,[]);assert.equal((await command('document.summary')).stateToken,box.stateToken);
    const html=await fetch(front).then(response=>response.text());assert.equal(html.includes('/@vite/client'),false);pass('the real production browser hydrates CAD and streams Pi through the same-origin bridge without a paid LLM or CAD mutation');
  }finally{await browser.close();}
  for(let index=0;index<30;index++){assert.equal((await fetch(front)).status,200);assert.equal((await fetch(front+'/__cad/health').then(response=>response.json())).releaseId,selection.releaseId);}pass('repeated production page reads retain the same pinned release without a development worker');
  const upgraded=await buildRelease();assert.notEqual(upgraded.selection.releaseId,selection.releaseId);
  assert.equal((await fetch(front+'/__cad/health').then(response=>response.json())).releaseId,selection.releaseId);
  await assert.rejects(manage('Start'),error=>/pinned to a different release/.test(error.stderr));assert.deepEqual((await manage('Status')).Services.map(item=>item.Pid),first.Services.map(item=>item.Pid));
  pass('selecting a new build cannot replace live resources or silently restart the pinned frontend');
  await manage('Stop',{service:'Frontend'});const switched=await manage('Start',{service:'Frontend'});
  assert.equal(switched.Services.find(item=>item.Name==='gateway').Pid,first.Services.find(item=>item.Name==='gateway').Pid);assert.equal(switched.Services.find(item=>item.Name==='frontend').ReleaseId,upgraded.selection.releaseId);
  assert.equal((await fetch(front+'/__cad/health').then(response=>response.json())).releaseId,upgraded.selection.releaseId);assert.equal((await command('document.summary')).stateToken,box.stateToken);
  pass('an explicit frontend-only upgrade activates the selected release without restarting the Gateway or changing CAD');
  await manage('Stop',{service:'Frontend'});const rolledBack=await manage('Start',{service:'Frontend',releaseId:selection.releaseId});
  assert.equal(rolledBack.Services.find(item=>item.Name==='frontend').ReleaseId,selection.releaseId);assert.equal(rolledBack.Services.find(item=>item.Name==='gateway').Pid,first.Services.find(item=>item.Name==='gateway').Pid);assert.equal((await command('document.summary')).stateToken,box.stateToken);
  assert.equal(JSON.parse(await readFile(path.join(releases,'selected.json'),'utf8')).releaseId,upgraded.selection.releaseId);
  pass('an explicit prior release can be restored without changing selection, saved data or the live Gateway');
  const resource=manifest.files.find(item=>item.file.startsWith('dist/client/assets/')&&item.file.endsWith('.js')),resourcePath=path.join(releaseDirectory,resource.file),resourceBytes=await readFile(resourcePath);
  try{
    const changed=Buffer.from(resourceBytes);changed[0]^=1;await writeFile(resourcePath,changed);
    const unhealthy=await fetch(front+'/__cad/health');assert.equal(unhealthy.status,503);const detail=await unhealthy.json();assert.equal(detail.code,'FRONTEND_ASSET_CHANGED');assert.equal(detail.clientAssetsValid,false);
    const asset=await fetch(front+'/'+resource.file.slice('dist/client/'.length));assert.equal(asset.status,503);assert.equal(asset.headers.get('etag'),null);
    const status=await manage('Status');assert.equal(status.Services.find(item=>item.Name==='frontend').State,'unhealthy');assert.equal(status.Services.find(item=>item.Name==='frontend').Pid,rolledBack.Services.find(item=>item.Name==='frontend').Pid);assert.equal(status.Services.find(item=>item.Name==='gateway').State,'ready');
    assert.equal((await command('document.summary')).stateToken,box.stateToken);
  }finally{await writeFile(resourcePath,resourceBytes);}
  // Even restored bytes cannot certify the metadata captured by the running
  // process. Only an explicit validated restart establishes a new owner.
  assert.equal((await fetch(front+'/__cad/health')).status,503);await manage('Stop',{service:'Frontend'});await manage('Start',{service:'Frontend',releaseId:selection.releaseId});
  assert.equal((await fetch(front+'/__cad/health')).status,200);
  pass('live asset damage becomes unhealthy instead of ready or starting; explicit repair and validated restart restore readiness');
  const nextBackend=createBackendRelease({workspace:root,releaseRoot:backendReleases,nativeRuntime:true,piSdk:false}),beforeBackendSwitch=await manage('Status'),frontPid=beforeBackendSwitch.Services.find(item=>item.Name==='frontend').Pid;
  await assert.rejects(manage('Start',{service:'Gateway'}),error=>/pinned to a different release/.test(error.stderr));
  assert.deepEqual((await manage('Status')).Services.map(item=>item.Pid),beforeBackendSwitch.Services.map(item=>item.Pid));
  assert.equal((await fetch(`http://127.0.0.1:${gatewayPort}/api/health`).then(response=>response.json())).backendRelease.releaseId,backend.releaseId);pass('selecting a new backend cannot silently restart or replace the live backend');
  await manage('Stop',{service:'Gateway'});const backendUpgraded=await manage('Start',{service:'Gateway'});
  assert.equal(backendUpgraded.Services.find(item=>item.Name==='gateway').ReleaseId,nextBackend.releaseId);assert.equal(backendUpgraded.Services.find(item=>item.Name==='frontend').Pid,frontPid);assert.equal((await command('document.summary')).stateToken,box.stateToken);pass('explicit backend-only upgrade preserves the frontend owner and saved CAD state');
  await manage('Stop',{service:'Gateway'});const backendRollback=await manage('Start',{service:'Gateway',backendReleaseId:backend.releaseId});
  assert.equal(backendRollback.Services.find(item=>item.Name==='gateway').ReleaseId,backend.releaseId);assert.equal(backendRollback.Services.find(item=>item.Name==='frontend').Pid,frontPid);assert.equal((await command('document.summary')).stateToken,box.stateToken);assert.equal(JSON.parse(await readFile(path.join(backendReleases,'selected.json'),'utf8')).releaseId,nextBackend.releaseId);pass('explicit backend rollback keeps the selected newer build, frontend and engineering data unchanged');
  const competingPort=await freePort();
  await assert.rejects(manage('Start',{service:'Gateway',runtime:path.join(scratch,'competing-runtime'),gatewayPort:competingPort}),error=>/DATA_DIRECTORY_IN_USE/.test(error.stderr));
  const original=await manage('Status');assert.ok(original.Services.every(item=>item.State==='ready'));assert.equal((await command('document.summary')).stateToken,box.stateToken);pass('a different launcher registry and TCP port cannot bypass data ownership; the original service stays ready');
  const stopped=await manage("Stop"); assert.ok(stopped.Services.every((item)=>item.State==="stopped"));assert.equal(stopped.Services.find(item=>item.Name==='gateway').LastStopMode,'graceful'); pass("stop drains the registered Gateway cooperatively and terminates only registered service trees");
  await manage("Start"); const restored=await command("document.view"); assert.equal(restored.revision,box.revision); assert.equal(restored.bodyCount,1); pass("restart restores the saved CAD document from the same data directory");
  await manage("Stop");

  await writeFile(resourcePath,'corrupt');try{await assert.rejects(manage('Start',{releaseId:selection.releaseId}),error=>/Frontend release validation failed/.test(error.stderr));assert.ok((await manage('Status')).Services.every(item=>item.State==='stopped'));}finally{await writeFile(resourcePath,resourceBytes);}pass('a corrupt requested artifact is refused before service startup, without falling back to dev');
  const backendResource=path.join(nextBackend.directory,'runtime/shared/mesh-statistics.mjs'),backendResourceBytes=await readFile(backendResource);
  await writeFile(backendResource,'corrupt');try{await assert.rejects(manage('Start'),error=>/Backend release validation failed/.test(error.stderr));assert.ok((await manage('Status')).Services.every(item=>item.State==='stopped'));}finally{await writeFile(backendResource,backendResourceBytes);}pass('a corrupt selected backend prevents all startup without falling back to workspace source');
  const nativeFile=nextBackend.native.profiles.mesh.files.find(item=>item.file.endsWith('.dll')&&item.bytes<1024*1024),nativePath=path.join(nextBackend.directory,'native/mesh',nativeFile.file),nativeBytes=await readFile(nativePath);
  await writeFile(nativePath,Buffer.concat([nativeBytes,Buffer.from('damaged')]));try{await assert.rejects(manage('Start'),error=>/Backend release validation failed/.test(error.stderr));assert.ok((await manage('Status')).Services.every(item=>item.State==='stopped'));}finally{await writeFile(nativePath,nativeBytes);}pass('a damaged bundled native DLL blocks managed startup before either service starts');
  const dev=await manage('Start',{mode:'Development',gatewayMode:'Development'});assert.equal(dev.Services.find(item=>item.Name==='frontend').Mode,'Development');assert.equal(dev.Services.find(item=>item.Name==='gateway').Mode,'Development');assert.equal((await command('document.summary')).stateToken,box.stateToken);
  const legacyRegistryPath=path.join(runtime,'services.json'),legacyRegistry=JSON.parse(await readFile(legacyRegistryPath,'utf8')),legacyGateway=legacyRegistry.services.find(item=>item.name==='gateway');delete legacyGateway.gatewayMode;delete legacyGateway.releaseId;delete legacyGateway.manifestSha256;delete legacyGateway.sourceSha256;await writeFile(legacyRegistryPath,JSON.stringify(legacyRegistry));
  assert.equal((await manage('Status')).Services.find(item=>item.Name==='gateway').Mode,'WorkspaceSource');await assert.rejects(manage('Start',{service:'Gateway'}),error=>/mode differs/.test(error.stderr));assert.equal((await manage('Status')).Services.find(item=>item.Name==='gateway').Pid,dev.Services.find(item=>item.Name==='gateway').Pid);assert.equal((await command('document.summary')).stateToken,box.stateToken);pass('legacy workspace Gateway ownership stays visible and cannot be silently adopted as production');
  await manage('Stop');pass('explicit development mode remains available and does not alter saved engineering data');

  foreign=net.createServer((socket)=>socket.end("unrelated service")); await new Promise((resolve,reject)=>{foreign.once("error",reject);foreign.listen(frontendPort,"127.0.0.1",resolve);});
  await assert.rejects(manage("Start"),(error)=>/occupied by an unmanaged process/.test(error.stderr));
  assert.equal(foreign.listening,true); const status=await manage("Status"); assert.ok(status.Services.every((item)=>item.State==="stopped")); pass("port conflicts fail safely and roll back newly started services");
  await new Promise((resolve)=>foreign.close(resolve)); foreign=null;

  const registryPath=path.join(runtime,"services.json"), saved=await readFile(registryPath,"utf8"), registry=JSON.parse(saved);
  registry.services[0].pid=process.pid; registry.services[0].startedTicks="invalid-owner";
  await writeFile(registryPath,JSON.stringify(registry));
  await assert.rejects(manage("Stop"),(error)=>/no longer belongs/.test(error.stderr));
  assert.equal(process.kill(process.pid,0),true); pass("reused or forged PID records never stop an unrelated process");
  await writeFile(registryPath,saved);
  verified=true;console.log(JSON.stringify({passed:checks.length,checks},null,2));
} finally {
  if(foreign) await new Promise((resolve)=>foreign.close(resolve));
  let stopped=false; try {await manage("Stop"); stopped=true;} catch(error) {console.error("Inspect service test processes before removing:",scratch,error.message);}
  // Keep diagnostics and registry if cleanup cannot be proven.
  const resolved=path.resolve(scratch), tempRoot=path.resolve(os.tmpdir());
  if(stopped && verified && resolved.startsWith(tempRoot+path.sep) && path.basename(resolved).startsWith("web-cad-service-test-")) await rm(resolved,{recursive:true,force:true});
  else console.error('Preserved service acceptance diagnostics: '+resolved);
}
