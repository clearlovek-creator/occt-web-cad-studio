/* Current-host portable composition acceptance, not a clean OS qualification. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {validateWorkbenchBundle,workbenchFileInventory} from '../gateway/workbench-bundle.mjs';
import {copyCertifiedFiles,hashFile} from '../gateway/frontend-release.mjs';
import {startCadModelFixture} from '../tests/helpers/cad-model-fixture.mjs';
import {PI_RPC_TIMEOUTS} from '../shared/pi-rpc-timeouts.mjs';

const argument=process.argv.indexOf('--bundle');if(argument<0||!process.argv[argument+1])throw Error('An explicit --bundle directory is required.');
const original=validateWorkbenchBundle(path.resolve(process.argv[argument+1])),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cad-workbench-bundle-')),host=path.join(scratch,'无开发环境 空白目录'),copy=path.join(host,original.releaseId),data=path.join(scratch,'用户工程'),runtime=path.join(scratch,'服务记录'),artifacts=path.resolve(process.env.WORKBENCH_BUNDLE_ARTIFACTS||'.artifacts/workbench-bundle-acceptance');
fs.mkdirSync(host);fs.mkdirSync(artifacts,{recursive:true});
const checks=[],errors=[],handles=[];let browser,page,started=false,verified=false,provider;
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;}
const frontendPort=await freePort(),gatewayPort=await freePort(),origin=`http://127.0.0.1:${frontendPort}`,api=origin+'/api';
async function manage(action,{dataDirectory=data,runtimeDirectory=runtime}={}){
  const allowed=new Set(['SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','PROGRAMDATA','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE']);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toUpperCase())));
  Object.assign(env,{PATH:path.join(process.env.SystemRoot,'System32')+';'+path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0'),NODE_OPTIONS:'--import Z:/invalid-inherited-hook.mjs',NODE_PATH:'Z:/invalid-inherited-packages',PI_CLI_PATH:'Z:/invalid-pi.mjs',PI_CLI_CWD:'Z:/invalid-cwd',GEOMETRY_WORKER_PATH:'Z:/invalid-worker.exe',MESH_WORKER_PATH:'Z:/invalid-mesh.exe',PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',AGENT_ALLOW_PRIVATE_URL:'true',GEOMETRY_WORKER_TIMEOUT_MS:'60000',MESH_WORKER_TIMEOUT_MS:'120000'});
  const child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(copy,'Start-WebCAD.ps1'),'-Action',action,'-FrontendPort',String(frontendPort),'-GatewayPort',String(gatewayPort),'-DataDirectory',dataDirectory,'-RuntimeDirectory',runtimeDirectory,'-AsJson'],{cwd:host,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const handle={child,closed:false,action};handles.push(handle);let output='',diagnostic='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>{diagnostic=(diagnostic+bytes).slice(-16384);fs.appendFileSync(path.join(artifacts,'management-stderr.log'),bytes);});
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Bundle action observation expired, exit not implied: '+action+' PID '+child.pid+' scratch '+scratch)),360000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);handle.closed=true;resolve(code);});});
  if(code!==0)throw Object.assign(Error('Bundle '+action+' failed: '+diagnostic),{actionCode:code,output,diagnostic});return JSON.parse(output);
}
async function request(route,body){const response=await fetch(api+route,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
const registry=()=>JSON.parse(fs.readFileSync(path.join(runtime,'services.json'),'utf8'));
try{
  await check('only the certified bundle is copied to an empty Chinese/spaced host; no workspace, host Node, npm or secrets are copied',async()=>{
    copyCertifiedFiles(original.directory,copy,workbenchFileInventory(original.directory));validateWorkbenchBundle(copy);assert.deepEqual(fs.readdirSync(host),[original.releaseId]);
    for(const name of['package-lock.json','node_modules','.env','app','gateway'])assert.equal(fs.existsSync(path.join(host,name)),false);
    assert.equal(fs.existsSync(path.join(copy,'.env')),false);assert.equal(fs.existsSync(path.join(copy,'app/.env')),false);
  });
  await check('mutable data within the immutable bundle or through a junction is refused before creating a service registry',async()=>{
    const forbidden=path.join(copy,'must-not-create'),alternate=path.join(scratch,'must-not-create-runtime');
    await assert.rejects(manage('Start',{dataDirectory:forbidden,runtimeDirectory:alternate}),/outside the immutable bundle/);assert.equal(fs.existsSync(forbidden),false);assert.equal(fs.existsSync(alternate),false);
    const alias=path.join(scratch,'mutable-alias');fs.symlinkSync(copy,alias,'junction');await assert.rejects(manage('Start',{dataDirectory:path.join(alias,'must-not-create'),runtimeDirectory:alternate}),/cannot pass through links/);assert.equal(fs.existsSync(forbidden),false);assert.equal(fs.existsSync(alternate),false);fs.unlinkSync(alias);
  });
  await check('system-only PATH and deliberately invalid inherited runtime hooks still start both services on the bundled Node',async()=>{
    started=true;const status=await manage('Start');assert.ok(status.Services.every(service=>service.State==='ready'));const rows=registry().services;assert.equal(rows.length,2);for(const row of rows)assert.equal(row.executable.toLowerCase(),path.join(copy,'node/node.exe').toLowerCase());
    assert.equal((await request('/health')).backendRelease.releaseId,original.backend.releaseId);assert.equal((await fetch(origin+'/__cad/health').then(response=>response.json())).releaseId,original.frontend.releaseId);
  });
  provider=await startCadModelFixture();
  await request('/agent/providers',{id:'sdk-fixture',name:'Portable local SDK acceptance',baseUrl:provider.baseUrl,protocol:'chat-completions',model:'sdk-fixture',apiKey:'local-fixture-not-a-provider-secret'});
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(()=>sessionStorage.setItem('occt.activeDocumentId','default'));
  let session,messages,baseline;
  await check('the actual portable browser/SDK/MCP/OCCT loop creates one Box and updates pixels without a refresh or paid provider',async()=>{
    await page.goto(origin,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'AI 助手',exact:true}).click();const panel=page.getByTestId('pi-agent-panel');await panel.locator('.pi-agent-status').filter({hasText:'会话在线'}).waitFor({timeout:PI_RPC_TIMEOUTS.browserStartupMs});
    session=await request('/pi/sessions',{sessionId:'webcad-default',documentId:'default'});
    for(const command of[{type:'set_model',provider:'sdk-fixture',modelId:'sdk-fixture'},{type:'set_auto_retry',enabled:false}])await request('/pi/sessions/webcad-default/commands',{documentId:'default',streamId:session.streamId,command});
    await panel.getByRole('textbox',{name:'发送给 Pi Agent'}).fill('Create one box 10 by 20 by 30. Query the document first.');await panel.getByRole('button',{name:'发送',exact:true}).click();await panel.getByText('The CAD tool confirmed one box.',{exact:true}).waitFor();await panel.getByRole('button',{name:'停止',exact:true}).waitFor({state:'detached'});
    await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]')?.dataset.renderedTriangles)>0);baseline=await request('/commands',{documentId:'default',operation:'document.summary'});assert.equal(baseline.bodyCount,1);const measure=await request('/commands',{documentId:'default',operation:'geometry.measure',inputs:{bodyId:baseline.bodies[0].id||baseline.bodies[0].bodyId}});assert.ok(Math.abs(measure.volume-6000)<1e-6);assert.deepEqual(provider.tools,['query_model','primitive__box']);assert.equal(provider.requests.length,3);assert.deepEqual(provider.errors,[]);
    messages=(await request('/pi/sessions/webcad-default/commands',{documentId:'default',streamId:session.streamId,command:{type:'get_messages'}})).response.data.messages;assert.ok(messages.some(message=>message.role==='toolResult'&&message.toolName==='primitive__box'&&!message.isError));await page.screenshot({path:path.join(artifacts,'portable-sdk-real-box.png'),fullPage:true});
  });
  await check('sealed Gmsh meshes the project and the bundled source inspector reopens a real project package',async()=>{
    const result=await request('/documents/default/mesh/jobs',{qualityThreshold:0});assert.equal(result.mesh.admission.status,'accepted');assert.ok(result.mesh.elementCount>0);
    const saved=await fetch(api+'/documents/default/project/save',{method:'POST',signal:AbortSignal.timeout(30000)});assert.equal(saved.status,200,await saved.clone().text());const bytes=Buffer.from(await saved.arrayBuffer());assert.ok(bytes.length>100);
    const opened=await fetch(api+'/documents/portable_copy/project/open',{method:'POST',headers:{'content-type':'application/vnd.webcad.project'},body:bytes,signal:AbortSignal.timeout(30000)});assert.equal(opened.status,200,await opened.clone().text());assert.equal((await opened.json()).bodyCount,1);
  });
  await browser.close();browser=null;
  await check('normal stop is graceful and restart restores the exact engineering state and native Pi message history without replay',async()=>{
    const stopped=await manage('Stop');assert.ok(stopped.Services.every(service=>service.State==='stopped'));assert.equal(stopped.Services.find(service=>service.Name==='gateway').LastStopMode,'graceful');started=false;
    started=true;assert.ok((await manage('Start')).Services.every(service=>service.State==='ready'));assert.equal((await request('/commands',{documentId:'default',operation:'document.summary'})).stateToken,baseline.stateToken);
    session=await request('/pi/sessions',{sessionId:'webcad-default',documentId:'default'});const restored=(await request('/pi/sessions/webcad-default/commands',{documentId:'default',streamId:session.streamId,command:{type:'get_messages'}})).response.data.messages;assert.deepEqual(restored,messages);assert.equal(provider.requests.length,3);
  });
  const license=path.join(copy,'node/provenance/LICENSE'),licenseBefore=fs.readFileSync(license);
  await check('damaged runtime material blocks Start without touching live owners, but certified Stop still exits them gracefully',async()=>{
    const owners=registry().services.map(row=>row.pid);fs.appendFileSync(license,'\nmodified after certification\n');try{
      await assert.rejects(manage('Start'),/Complete bundle verification failed/);const status=await manage('Status');assert.ok(status.Services.every(service=>service.State==='ready'));assert.deepEqual(registry().services.map(row=>row.pid),owners);assert.equal((await request('/commands',{documentId:'default',operation:'document.summary'})).stateToken,baseline.stateToken);
      const stopped=await manage('Stop');assert.ok(stopped.Services.every(service=>service.State==='stopped'));assert.equal(stopped.Services.find(service=>service.Name==='gateway').LastStopMode,'graceful');started=false;
    }finally{fs.writeFileSync(license,licenseBefore);}
  });
  await check('unexpected bundle files are refused and the original release, source inputs and restored copy remain certified',async()=>{
    const unexpected=path.join(copy,'unexpected.txt');fs.writeFileSync(unexpected,'must not be silently accepted');try{await assert.rejects(manage('Start'),/Complete bundle verification failed/);}finally{fs.unlinkSync(unexpected);}validateWorkbenchBundle(copy);validateWorkbenchBundle(original.directory);assert.equal(hashFile(path.join(copy,'workbench.json')),original.manifestSha256);assert.deepEqual(errors,[]);assert.equal(provider.requests.length,3);assert.deepEqual(provider.errors,[]);
  });
  await check('a changed Node executable is rejected before executing application code or changing stopped registry/data records',async()=>{
    // Deliberate binary damage is LAST. Windows can retain an image mapping
    // after exit and refuse in-place truncation. Preserve this forensic copy;
    // immutable releases are recovered from a new certified version, not by
    // overwriting a recently used executable in place.
    const node=path.join(copy,'node/node.exe'),registryBefore=fs.readFileSync(path.join(runtime,'services.json')),shutdownBefore=fs.readFileSync(path.join(data,'.gateway-last-shutdown.json'));
    fs.appendFileSync(node,'changed');assert.notEqual(hashFile(node),original.node.executable.sha256);await assert.rejects(manage('Start'),/no application code executed/);assert.deepEqual(fs.readFileSync(path.join(runtime,'services.json')),registryBefore);assert.deepEqual(fs.readFileSync(path.join(data,'.gateway-last-shutdown.json')),shutdownBefore);assert.ok((await manage('Status')).Services.every(service=>service.State==='stopped'));validateWorkbenchBundle(original.directory);
  });
  verified=true;
}catch(error){if(page)await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});console.error('Portable bundle acceptance failed: '+error.stack);throw error;
}finally{
  await browser?.close();let stopped=!started;if(started){const status=await manage('Stop');stopped=status.Services.every(service=>service.State==='stopped');}await provider?.close();
  if(verified&&stopped&&handles.every(handle=>handle.closed)){
    assert.equal(path.dirname(scratch),path.resolve(os.tmpdir()));assert.match(path.basename(scratch),/^cad-workbench-bundle-/);
    const result={ok:true,passed:checks.length,checks,bundle:original.releaseId,bundleManifestSha256:original.manifestSha256,frontend:original.frontend.releaseId,backend:original.backend.releaseId,browserErrors:errors,paidProviderCalls:0,localProtocolRequests:provider.requests.length,allManagementHandlesClosed:true,normalGatewayStop:'graceful',tamperedCopyRetained:true,retainedScratch:scratch,tamperedNodeSha256:hashFile(path.join(copy,'node/node.exe')),originalNodeSha256:original.node.executable.sha256,scope:'Copied complete bundle, bundled official-checksum-matched Node, system-only inherited PATH and invalid development overrides on the current Windows host; not clean OS/VM, installer, full license audit or cross-data upgrade qualification.'};fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
  }else console.error('Retained portable bundle diagnostics: '+scratch);
}
