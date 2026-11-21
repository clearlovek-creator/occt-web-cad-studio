/* Real folded STEP, sealed candidate, private project and browser. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {selectBackendRelease,validateBackendRelease} from '../gateway/backend-release.mjs';
import {selectRelease,validateRelease} from '../gateway/frontend-release.mjs';
import {gatedGeometryGateway} from '../tests/helpers/gated-geometry-gateway.mjs';
import {createMeshSelfIntersectionFixture} from '../tests/helpers/mesh-self-intersection-fixture.mjs';

const root=path.resolve(import.meta.dirname,'..');
const backendRoot=path.resolve(process.env.CAD_TEST_BACKEND_RELEASE_ROOT||'.artifacts/mesh-self-intersection-backend-releases');
const frontendRoot=path.resolve(process.env.LOFT_UI_RELEASE_ROOT||'.artifacts/mesh-storage-releases');
const backend=selectBackendRelease(backendRoot,process.env.CAD_TEST_BACKEND_RELEASE_ID),frontend=selectRelease(frontendRoot,root);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cad-solid-self-ui-')),data=path.join(scratch,'data'),runtime=path.join(scratch,'runtime');
const artifacts=path.resolve(process.env.MESH_SELF_UI_ARTIFACTS||'.artifacts/mesh-self-intersection-browser');
fs.mkdirSync(data);fs.mkdirSync(artifacts,{recursive:true});
const fixture=createMeshSelfIntersectionFixture(),socket=net.createServer();
await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;
await new Promise(resolve=>socket.close(resolve));const url=`http://localhost:${port}/`;
let f,browser,page,started=false,verified=false;const checks=[],errors=[];
async function front(action){
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/start-web-cad-demo.ps1'),'-Action',action,'-Service','Frontend','-FrontendPort',String(port),'-GatewayPort',String(f.port),'-DataDirectory',data,'-RuntimeDirectory',runtime,'-FrontendReleaseRoot',frontendRoot,'-FrontendReleaseId',frontend.releaseId,'-AsJson'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',diagnostics='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>diagnostics+=bytes);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,diagnostics);return JSON.parse(output);
}
async function check(name,action){await action();checks.push(name);console.log('PASS '+name);}
try{
  f=await gatedGeometryGateway(data,{CAD_TEST_GATEWAY_RELEASE_ROOT:backendRoot,CAD_TEST_GATEWAY_RELEASE_ID:backend.releaseId,WEB_ORIGIN:new URL(url).origin,GEOMETRY_WORKER_TIMEOUT_MS:'60000',PI_OFFLINE:'1'});
  const state=await f.cad('document.summary'),command={protocolVersion:1,operation:'step.import',documentId:'default',requestId:randomUUID(),fileName:'folded.step',expectedBytes:fixture.step.length,baseRevision:state.revision,baseStateToken:state.stateToken};
  const reserved=await f.post('/documents/default/imports/step/tasks',{command});assert.equal(reserved.status,201);
  const imported=await fetch(f.api+'/documents/default/imports/step',{method:'POST',headers:{'content-type':'application/step','x-cad-task-id':reserved.value.modelingTask.taskId,'x-request-id':command.requestId,'x-file-name':command.fileName,'x-base-revision':String(command.baseRevision),'x-base-state-token':command.baseStateToken},body:fixture.step}).then(r=>r.json());assert.equal(imported.ok,true,JSON.stringify(imported));
  const healthy=await f.cad('primitive.box',{width:2,depth:2,height:2,x:5}),before=await f.cad('document.summary');
  started=true;await front('Start');
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{sessionStorage.setItem('occt.activeDocumentId','default');localStorage.setItem('occt.activeDocumentId','default');});
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]')?.dataset.visibleBodies)===2);
  await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
  const panel=page.getByTestId('mesh-workbench-panel'),report=page.locator('.mesh-preparation-panel');
  await check('deep diagnosis refuses real self-intersection without starting Gmsh or changing geometry',async()=>{
    await panel.getByRole('checkbox',{name:'深入自交检查（预览时较慢）'}).check();
    await panel.getByRole('button',{name:'诊断并预览修复',exact:true}).click();
    await report.getByText('几何准备被阻止',{exact:true}).waitFor();
    assert.equal(await report.getByRole('button',{name:'使用此快照剖分',exact:true}).isDisabled(),true);
    assert.equal((await f.cad('document.summary')).stateToken,before.stateToken);
    assert.equal(f.events.some(row=>row.type==='fixture.mesh-start'),false);
    await report.getByRole('button',{name:'展开诊断明细',exact:true}).click();
    await report.locator('li[data-severity="error"]').filter({hasText:'自交／内部交叉'}).first().waitFor();
  });
  let faceTarget;
  await check('diagnostic selection identifies an actual original face and visibly highlights it',async()=>{
    const jobs=(await f.get('/documents/default/mesh/jobs')).jobs,result=await f.get('/mesh/jobs/'+jobs[0].jobId);
    const issues=result.preparation.diagnostics.bodies[0].before.issues;
    faceTarget=issues.find(row=>row.code==='SELF_INTERSECTION'&&row.target?.kind==='face').target;
    const original=report.locator('details').filter({has:page.locator('summary').filter({hasText:/^原始问题/})}).first();
    const row=original.locator('li[data-severity="error"]').filter({hasText:'自交／内部交叉'}).filter({hasText:`face #${issues.find(item=>item.target?.topologyId===faceTarget.topologyId).index}`}).first();
    await row.getByRole('button',{name:'定位原几何',exact:true}).click();
    await page.getByTestId('selection-readout').getByText(faceTarget.topologyId,{exact:true}).waitFor();
    await page.waitForFunction(()=>{const node=document.querySelector('[data-testid="cad-viewport"]');node?.dispatchEvent(new Event('cad:verify-selection'));return Number(node?.dataset.selectedFacePixels)>0;});
    assert.equal(faceTarget.bodyId,imported.bodyMetadata[0].bodyId);
  });
  await check('desktop and compact layouts retain readable diagnostics without page overflow',async()=>{
    for(const width of [1440,640]){await page.setViewportSize({width,height:1000});await report.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.screenshot({path:path.join(artifacts,`self-intersection-${width}.png`),fullPage:true});}
  });
  await check('geometry changes keep the historical report but disable obsolete source selection',async()=>{
    await f.cad('feature.update',{width:3},{featureId:healthy.features.at(-1).id});
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]')?.dataset.visibleBodies)===2);
    await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
    // The current diagnostic is restored automatically; do not click a hidden
    // history action or assume the already selected report is unselected.
    await report.getByText('来源已变化或无法验证。可查看历史报告，不能预览、定位或复用。',{exact:true}).waitFor();
    await report.getByRole('button',{name:'展开诊断明细',exact:true}).click();
    for(const button of await report.getByRole('button',{name:'定位原几何',exact:true}).all())assert.equal(await button.isDisabled(),true);
    assert.equal(f.events.some(row=>row.type==='fixture.mesh-start'),false);
  });
  assert.deepEqual(errors,[]);validateBackendRelease(backend.directory);validateRelease(frontend.directory,root);
  const result={ok:true,passed:checks.length,checks,frontend:frontend.releaseId,backend:backend.releaseId,browserErrors:errors,paidProviderCalls:0,realFoldedStep:true,visibleSourceFacePixels:true};
  fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});verified=true;console.log(JSON.stringify(result));
}catch(error){if(page){await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});console.error((await page.locator('body').innerText().catch(()=>'')).slice(-5000));}throw error;
}finally{
  await browser?.close();let stopped=!started;if(started){const status=await front('Stop');stopped=status.Services.every(service=>service.State==='stopped');}
  const code=f?await f.stop():null;
  if(verified&&stopped&&code===0){fixture.cleanup();assert.equal(path.dirname(scratch),path.resolve(os.tmpdir()));assert.match(path.basename(scratch),/^cad-solid-self-ui-/);fs.rmSync(scratch,{recursive:true,force:true});}
  else console.error('Retained self-intersection UI diagnostics: '+scratch);
}
