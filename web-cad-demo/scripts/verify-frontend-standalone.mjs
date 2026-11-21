/* Run only a copied frozen frontend in an empty application host. Node/Windows
 * are explicit external prerequisites, not a clean-machine installer claim. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {selectRelease,validateRelease,copyCertifiedFiles,hashFile,fileInventory} from '../gateway/frontend-release.mjs';
import {selectBackendRelease,validateBackendRelease} from '../gateway/backend-release.mjs';
import {gatedGeometryGateway} from '../tests/helpers/gated-geometry-gateway.mjs';

const root=path.resolve(import.meta.dirname,'..');
const frontend=selectRelease(path.resolve(process.env.LOFT_UI_RELEASE_ROOT||'.artifacts/frontend-standalone-releases'),root);
const backendRoot=path.resolve(process.env.CAD_TEST_BACKEND_RELEASE_ROOT||'.artifacts/frontend-standalone-backend-releases'),backend=selectBackendRelease(backendRoot);
assert.equal(frontend.version,2);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cad-frontend-standalone-')),host=path.join(scratch,'空白 工程主目录'),copied=path.join(host,frontend.releaseId),data=path.join(scratch,'isolated-data');
const artifacts=path.resolve(process.env.FRONTEND_STANDALONE_ARTIFACTS||'.artifacts/frontend-standalone-browser');
fs.mkdirSync(host);fs.mkdirSync(data);fs.mkdirSync(artifacts,{recursive:true});
const checks=[],errors=[],children=[];let gateway,browser,page,verified=false;
const delay=()=>new Promise(resolve=>setTimeout(resolve,20));
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;}
function startFrontend(port){
  // Do not inherit NODE_PATH, NODE_OPTIONS, development PATH or provider secrets.
  const allowed=new Set(['SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA']);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toUpperCase())));
  Object.assign(env,{PATH:path.join(process.env.SystemRoot,'System32'),NODE_ENV:'production'});
  const child=spawn(process.execPath,[path.join(copied,'runtime/scripts/frontend-server.mjs'),'--release',copied,'--port',String(port),'--gateway-api',gateway.api],{cwd:host,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const record={child,output:'',closed:false,code:null,signal:null,error:null};
  record.done=new Promise(resolve=>child.once('close',(code,signal)=>{Object.assign(record,{closed:true,code,signal});resolve();}));
  child.once('error',error=>{record.error=error;});
  const append=bytes=>{record.output=(record.output+bytes).slice(-32768);};child.stdout.on('data',append);child.stderr.on('data',append);children.push(record);return record;
}
async function until(predicate,record,message,timeout=30000){
  const deadline=Date.now()+timeout;
  for(;;){const result=await predicate();if(result)return result;if(record.error)throw record.error;assert.ok(!record.closed,message+'; child closed: '+record.output);assert.ok(Date.now()<deadline,message+'; observation deadline, exit not implied: '+record.output);await delay();}
}
async function stopFrontend(record){
  if(!record.closed)record.child.kill();
  const deadline=Date.now()+15000;while(!record.closed){assert.ok(Date.now()<deadline,'Owned frontend exit unconfirmed; retain scratch: '+scratch);await delay();}await record.done;
}
try{
  await check('copied release contains its complete certified runner and licenses but the host has no source, lock or development dependencies',async()=>{
    copyCertifiedFiles(frontend.directory,copied,[...frontend.files,{file:'release.json',bytes:fs.statSync(path.join(frontend.directory,'release.json')).size,sha256:hashFile(path.join(frontend.directory,'release.json'))}]);
    assert.equal(validateRelease(copied).releaseId,frontend.releaseId);assert.deepEqual(fs.readdirSync(host),[frontend.releaseId]);
    for(const name of ['app','gateway','scripts','package.json','package-lock.json','node_modules','.env'])assert.equal(fs.existsSync(path.join(host,name)),false);
    assert.deepEqual(fileInventory(copied),fileInventory(frontend.directory));
  });
  const port=await freePort(),origin=`http://127.0.0.1:${port}`;
  gateway=await gatedGeometryGateway(data,{CAD_TEST_GATEWAY_RELEASE_ROOT:backendRoot,CAD_TEST_GATEWAY_RELEASE_ID:backend.releaseId,WEB_ORIGIN:origin,GEOMETRY_WORKER_TIMEOUT_MS:'60000',PI_OFFLINE:'1'});
  const running=startFrontend(port);
  await check('frozen entry boots from the empty Chinese/spaced host on system-only PATH and exposes the exact selected release',async()=>{
    await until(()=>running.output.includes('"phase":"ready"'),running,'Standalone frontend not ready');
    const response=await fetch(origin+'/__cad/health'),health=await response.json();assert.equal(response.status,200);assert.equal(health.releaseId,frontend.releaseId);assert.equal(health.ownerPid,running.child.pid);assert.equal(health.clientAssetsValid,true);
  });
  await check('all certified client assets are served from the copied release and same-origin requests reach the sealed backend',async()=>{
    for(const file of frontend.files.filter(item=>/^dist\/client\/assets\/.*\.(?:js|css)$/.test(item.file))){const response=await fetch(origin+'/'+file.file.slice('dist/client/'.length));assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,file.bytes);assert.equal((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'),file.sha256);}
    const health=await fetch(origin+'/api/health').then(response=>response.json());assert.equal(health.backendRelease.releaseId,backend.releaseId);
  });
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
  if(process.env.VIEWPORT_DEMAND_MODE)await (await import('./verify-viewport-demand.mjs')).installViewportDrawProbe(page);
  await page.addInitScript(()=>{sessionStorage.setItem('occt.activeDocumentId','default');localStorage.setItem('occt.activeDocumentId','default');});
  await check('actual browser hydrates a real OCCT Box through the same-origin project read',async()=>{
    const before=await fetch(origin+'/api/documents/default').then(response=>response.json());
    const response=await fetch(origin+'/api/commands',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({operation:'primitive.box',documentId:'default',requestId:randomUUID(),baseRevision:before.revision,baseStateToken:before.stateToken,parameters:{width:10,depth:20,height:30},inputs:{}})});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.ok,true);
    const initialRead=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/projects/default/view');
    await page.goto(origin,{waitUntil:'domcontentloaded'});await initialRead;await page.getByTestId('cad-viewport').locator('canvas').waitFor();
    await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]')?.dataset.visibleBodies)===1&&Number(document.querySelector('[data-testid="cad-viewport"]')?.dataset.renderedTriangles)>0);
    const summary=await gateway.cad('document.summary');assert.equal(summary.bodyCount,1);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(artifacts,'standalone-real-box.png'),fullPage:true});
  });
  if(process.env.VIEWPORT_DEMAND_MODE)await (await import('./verify-viewport-demand.mjs')).verifyViewportDemand({page,origin,artifacts,check,mode:process.env.VIEWPORT_DEMAND_MODE});
  if(process.env.VIEWPORT_DEMAND_WORKFLOWS==='1')await (await import('./verify-viewport-workflows.mjs')).verifyViewportWorkflows({origin,artifacts});
  const baseline=await gateway.cad('document.summary');
  await browser.close();browser=null;await stopFrontend(running);
  const vendorFile=path.join(copied,'runtime/vendor/vinext/dist/server/prod-server.js'),original=fs.readFileSync(vendorFile);
  await check('tampering a copied runtime blocks a new launch before listening and never changes the project or original release',async()=>{
    fs.appendFileSync(vendorFile,'\n// changed after certification\n');const badPort=await freePort(),rejected=startFrontend(badPort),deadline=Date.now()+30000;
    while(!rejected.closed){assert.ok(Date.now()<deadline,'Rejected launch exit unconfirmed; preserve scratch: '+scratch);await delay();}await rejected.done;
    assert.equal(rejected.code,1);assert.match(rejected.output,/随包生产运行器/);assert.ok(!rejected.output.includes('"phase":"ready"'));await assert.rejects(fetch(`http://127.0.0.1:${badPort}/__cad/health`,{signal:AbortSignal.timeout(2000)}));
    assert.equal((await gateway.cad('document.summary')).stateToken,baseline.stateToken);validateRelease(frontend.directory,root);fs.writeFileSync(vendorFile,original);validateRelease(copied);
  });
  await check('the restored copy restarts without installing anything or regenerating a build',async()=>{
    const restarted=startFrontend(port);await until(()=>restarted.output.includes('"phase":"ready"'),restarted,'Restored frontend not ready');assert.equal((await fetch(origin+'/__cad/health').then(response=>response.json())).releaseId,frontend.releaseId);assert.equal((await gateway.cad('document.summary')).stateToken,baseline.stateToken);await stopFrontend(restarted);
  });
  validateBackendRelease(backend.directory);assert.deepEqual(errors,[]);verified=true;
}finally{
  if(!verified&&page&&!page.isClosed()){await page.screenshot({path:path.join(artifacts,'failed-page.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(artifacts,'failed-browser.json'),JSON.stringify({errors,viewport:await page.getByTestId('cad-viewport').evaluate(node=>({...node.dataset})).catch(()=>null)},null,2));}
  await browser?.close();for(const record of children)await stopFrontend(record);
  const backendCode=gateway?await gateway.stop():null;
  if(verified){assert.equal(backendCode,0);assert.ok(children.every(record=>record.closed));const result={ok:true,passed:checks.length,checks,frontend:frontend.releaseId,backend:backend.releaseId,runnerFiles:frontend.productionRuntime.files.length,runnerBytes:frontend.productionRuntime.files.reduce((sum,file)=>sum+file.bytes,0),browserErrors:errors,paidProviderCalls:0,childrenExited:true,backendExitCode:backendCode,nodeVersion:process.versions.node,scope:'Copied frontend only; no host source/lock/node_modules, system-only PATH, external absolute Node executable on the current Windows machine; not a bundled Node installer, clean OS/VM, or complete offline distribution.'};fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});assert.equal(path.dirname(scratch),path.resolve(os.tmpdir()));assert.match(path.basename(scratch),/^cad-frontend-standalone-/);fs.rmSync(scratch,{recursive:true,force:true});console.log(JSON.stringify(result));}
  else console.error('Retained standalone frontend diagnostics: '+scratch);
}
