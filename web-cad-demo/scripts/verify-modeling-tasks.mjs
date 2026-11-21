import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {selectBackendRelease,validateBackendRelease} from '../gateway/backend-release.mjs';
import {selectRelease} from '../gateway/frontend-release.mjs';
import {selectNativeTestRuntime} from './test-native-runtime.mjs';
import {gatedGeometryGateway} from '../tests/helpers/gated-geometry-gateway.mjs';

const root=path.resolve(import.meta.dirname,'..'),backendRoot=path.resolve(process.env.CAD_TEST_BACKEND_RELEASE_ROOT||'.artifacts/modeling-task-backend-releases'),frontendRoot=path.resolve(process.env.LOFT_UI_RELEASE_ROOT||'.artifacts/modeling-task-ui-releases');
const backend=selectBackendRelease(backendRoot,process.env.CAD_TEST_BACKEND_RELEASE_ID),frontend=selectRelease(frontendRoot,root),native=selectNativeTestRuntime(root);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cad-modeling-task-browser-')),data=path.join(scratch,'data'),runtime=path.join(scratch,'runtime'),artifacts=path.resolve(process.env.MODELING_TASK_UI_ARTIFACTS||'.artifacts/modeling-task-browser');
fs.mkdirSync(data);fs.mkdirSync(artifacts,{recursive:true});
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
const frontendPort=await freePort(),url=`http://localhost:${frontendPort}/`;
let f,browser,page,frontStarted=false,verified=false;const checks=[],errors=[],mutationRequests=[],controlRequests=[],batchRequests=[];
const qualifyBatches=process.env.MODELING_TASK_BATCH_UI==='1';
async function front(action){
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/start-web-cad-demo.ps1'),'-Action',action,'-Service','Frontend','-FrontendPort',String(frontendPort),'-GatewayPort',String(f.port),'-DataDirectory',data,'-RuntimeDirectory',runtime,'-FrontendReleaseRoot',frontendRoot,'-FrontendReleaseId',frontend.releaseId,'-AsJson'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',diagnostics='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>diagnostics=(diagnostics+bytes).slice(-16384));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,diagnostics);return JSON.parse(output);
}
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
const strip=()=>page.getByTestId('modeling-task-status');
async function state(){return f.cad('document.summary');}
async function visibleBodies(count){await page.waitForFunction(expected=>Number(document.querySelector('[data-testid="cad-viewport"]')?.dataset.visibleBodies)===expected,count);const pixels=await page.getByTestId('cad-viewport').evaluate(node=>{node.dispatchEvent(new Event('cad:verify-frame'));return Number(node.dataset.renderedBodyPixels);});assert.ok(pixels>100,'Actual geometry pixels must be visible');}
async function openBox(width='23 mm'){
  if(await page.getByRole('button',{name:'关闭操作窗口',exact:true}).count())await page.getByRole('button',{name:'关闭操作窗口',exact:true}).click();
  await page.getByRole('tab',{name:'建模',exact:true}).click();await page.locator('[data-command="primitive.box"]').click();
  const panel=page.getByTestId('advanced-modeling-panel');await panel.getByLabel('长度 X',{exact:true}).fill(width);await panel.getByLabel('深度 Y',{exact:true}).fill('4 mm');await panel.getByLabel('高度 Z',{exact:true}).fill('5 mm');return panel;
}
async function submitHeld(width='23 mm',{commit=false}={}){
  const panel=await openBox(width),armedAt=f.events.length;f.tell(commit?'arm-task-commit':'arm-geometry');await f.event(commit?'task-commit-armed':'geometry-armed',armedAt);
  const heldAt=f.events.length;await panel.getByRole('button',{name:'创建基础体',exact:true}).click();await f.event(commit?'task-commit-held':'geometry-held',heldAt);eventOffset=f.events.length;
  await page.locator(`[data-testid="modeling-task-status"][data-phase="${commit?'committing':'executing'}"]`).waitFor();
  const taskId=await strip().getAttribute('data-task-id');assert.ok(taskId);return {panel,taskId};
}
let eventOffset=0,before;
async function beginMissingBatch(variable){
  const panel=await openBox(variable),at=f.events.length;f.tell('arm-geometry');await f.event('geometry-armed',at);
  await panel.getByRole('button',{name:'创建基础体',exact:true}).click();await panel.getByRole('dialog',{name:'创建缺失变量',exact:true}).waitFor();await panel.getByRole('button',{name:'创建并重试',exact:true}).click();await f.event('geometry-held',at);
  await page.locator('[data-testid="modeling-task-status"][data-phase="executing"]').waitFor();await strip().getByText('批量建模',{exact:true}).waitFor();return {panel,taskId:await strip().getAttribute('data-task-id'),at};
}
try{
  f=await gatedGeometryGateway(data,{CAD_TEST_GATEWAY_RELEASE_ROOT:backendRoot,CAD_TEST_GATEWAY_RELEASE_ID:backend.releaseId,WEB_ORIGIN:new URL(url).origin,GEOMETRY_WORKER_TIMEOUT_MS:'30000',GEOMETRY_WORKER_STOP_TIMEOUT_MS:'10000',PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1'});
  const box=await f.cad('primitive.box',{width:10,depth:20,height:30}),type=await f.cad('property.type.create',{key:'TaskBrowserBoundary',targetScope:'body',association:'required',fields:[{key:'enabled',type:'bool'}]});
  await f.cad('property.instance.create',{typeId:type.type.typeId,value:{enabled:true},target:{kind:'body',bodyId:box.bodyId}});await f.cad('property.set',{key:'taskBrowserMarker',type:'int',value:37},{kind:'body',bodyId:box.bodyId});await f.cad('variable.set',{name:'taskSize',type:'length',expression:'20 mm'});
  before={model:await state(),raw:(await f.cad('property.list')).propertyRecords,typed:(await f.cad('property.instance.list')).instances};
  frontStarted=true;await front('Start');browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());
  page.on('request',request=>{const pathName=new URL(request.url()).pathname;if(pathName.includes('/modeling-tasks'))controlRequests.push({path:pathName,method:request.method()});if(pathName==='/api/commands'&&request.method()==='POST'){const body=request.postDataJSON();if(body.operation==='primitive.box')mutationRequests.push({operation:body.operation,taskId:request.headers()['x-cad-task-id']});}});
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/command-batches'&&request.method()==='POST')batchRequests.push({body:request.postDataJSON(),taskId:request.headers()['x-cad-task-id']});});
  await page.addInitScript(()=>{localStorage.setItem('occt.activeDocumentId','default');sessionStorage.setItem('occt.activeDocumentId','default');});await page.goto(url,{waitUntil:'networkidle'});await visibleBodies(1);
  await check('task restoration and status reads do not register or execute a modeling command',async()=>{assert.equal(mutationRequests.length,0);assert.equal((await f.get('/documents/default/modeling-tasks')).tasks.length,0);assert.equal((await state()).stateToken,before.model.stateToken);});
  await check('a real executed Box can be cancelled by keyboard while native exit is held; status remains stopping and draft expressions remain intact',async()=>{
    f.tell('arm-geometry-exit');await f.event('geometry-exit-armed');const {panel,taskId}=await submitHeld('taskSize + 3 mm');assert.equal(mutationRequests.at(-1).taskId,taskId);
    const cancel=strip().getByRole('button',{name:'取消操作',exact:true});await cancel.focus();assert.equal(await cancel.evaluate(node=>node===document.activeElement),true);await page.keyboard.press('Enter');await f.event('geometry-exit-held');await page.locator('[data-testid="modeling-task-status"][data-phase="stopping"]').waitFor();assert.equal(await strip().getByRole('button',{name:'取消操作',exact:true}).isDisabled(),true);await visibleBodies(1);
    for(const width of [1440,900,640]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);const bounds=await strip().boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1);await page.screenshot({path:path.join(artifacts,`stopping-${width}.png`),fullPage:true});}
    await page.setViewportSize({width:1440,height:1000});f.tell('release-geometry-exit');await page.locator('[data-testid="modeling-task-status"][data-phase="cancelled"]').waitFor();assert.equal(await panel.getByLabel('长度 X',{exact:true}).inputValue(),'taskSize + 3 mm');
    const restored=await state();for(const key of ['revision','stateToken','features','bodyMetadata','entityIdentities','coordinateSystems','variables'])assert.deepEqual(restored[key],before.model[key],key);assert.deepEqual((await f.cad('property.list')).propertyRecords,before.raw);assert.deepEqual((await f.cad('property.instance.list')).instances,before.typed);assert.equal(controlRequests.filter(request=>request.path.endsWith('/cancel')).length,1);
    await strip().getByText('任务详情',{exact:true}).click();assert.equal(await strip().locator('dd').first().evaluate(node=>getComputedStyle(node).userSelect),'text');await strip().getByRole('button',{name:'收起任务状态提示',exact:true}).click();
  });
  await check('closing the parameter window is not a cancellation and the eventual committed Body reaches the real viewport once',async()=>{const count=controlRequests.filter(request=>request.path.endsWith('/cancel')).length;await submitHeld('24 mm');await page.getByRole('button',{name:'关闭操作窗口',exact:true}).click();assert.equal(controlRequests.filter(request=>request.path.endsWith('/cancel')).length,count);f.tell('release-geometry');await visibleBodies(2);assert.equal((await state()).bodyCount,2);});
  await check('commit stage disables cancel and explains the protected publication boundary without a confirmation dialog',async()=>{await submitHeld('25 mm',{commit:true});assert.equal(await strip().getByRole('button',{name:'取消操作',exact:true}).isDisabled(),true);await strip().getByText('正在写入完整工程，暂不可取消。',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog',{name:/确认/}).count(),0);await strip().screenshot({path:path.join(artifacts,'committing-strip.png')});f.tell('release-geometry');await visibleBodies(3);});
  await check('a lost committed reply is recovered through the original task receipt, without submitting another Box',async()=>{
    const previous=mutationRequests.length,handler=async route=>{const input=route.request().postDataJSON();if(input.operation==='primitive.box'){await route.fetch();await route.abort('failed');}else await route.continue();};await page.route('**/api/commands',handler);
    try{const panel=await openBox('26 mm');await panel.getByRole('button',{name:'创建基础体',exact:true}).click();await visibleBodies(4);assert.equal(mutationRequests.length,previous+1);assert.ok(controlRequests.some(request=>request.path.endsWith('/result')));}finally{await page.unroute('**/api/commands',handler);}
  });
  await check('page reload restores the same active task and can cancel it without replaying the original mutation',async()=>{
    const beforeReload=await state(),previous=mutationRequests.length,{taskId}=await submitHeld('27 mm');await page.reload({waitUntil:'domcontentloaded'});await page.locator(`[data-testid="modeling-task-status"][data-task-id="${taskId}"][data-phase="executing"]`).waitFor();assert.equal(mutationRequests.length,previous+1);
    f.tell('arm-geometry-exit');await f.event('geometry-exit-armed',eventOffset);eventOffset=f.events.length;await strip().getByRole('button',{name:'取消操作',exact:true}).click();await f.event('geometry-exit-held',eventOffset);eventOffset=f.events.length;f.tell('release-geometry-exit');await page.locator('[data-testid="modeling-task-status"][data-phase="cancelled"]').waitFor();await visibleBodies(4);assert.equal((await state()).stateToken,beforeReload.stateToken);assert.equal(mutationRequests.length,previous+1);
  });
  await check('explicit task-record cleanup removes only terminal records and never edits project geometry or history',async()=>{const model=await state();await page.getByRole('button',{name:/^命令日志/}).click();const response=page.waitForResponse(response=>response.request().method()==='DELETE'&&response.url().endsWith('/modeling-tasks'));await page.getByRole('button',{name:'清理后台已完成任务',exact:true}).click();const result=await(await response).json();assert.ok(result.cleanup.deleted>=5,JSON.stringify(result));assert.equal((await state()).stateToken,model.stateToken);assert.equal((await f.get('/documents/default/modeling-tasks')).tasks.length,0);});
  if(qualifyBatches){
    await check('a real missing-variable batch cancels as one task, retains its expression draft and restores both geometry and variable in the existing readable status strip',async()=>{
      const base=await state(),at=f.events.length;f.tell('arm-geometry-exit');await f.event('geometry-exit-armed',at);const {panel,taskId}=await beginMissingBatch('batchDraftSize');assert.equal(batchRequests.at(-1).taskId,taskId);assert.equal(batchRequests.at(-1).body.operation,'project.batch');const supplemental=panel.getByRole('dialog',{name:'创建缺失变量',exact:true});assert.equal(await supplemental.getByRole('button',{name:'取消',exact:true}).isDisabled(),true);assert.equal(await supplemental.getByRole('combobox').isDisabled(),true);assert.equal(await supplemental.getByRole('textbox').isDisabled(),true);assert.equal(await panel.locator('.exchange-message').count(),0);
      const cancel=strip().getByRole('button',{name:'取消操作',exact:true});await cancel.focus();await page.keyboard.press('Enter');await f.event('geometry-exit-held',at);await page.locator('[data-testid="modeling-task-status"][data-phase="stopping"]').waitFor();
      for(const width of [1440,640]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.ok((await cancel.boundingBox()).height>=40);await page.screenshot({path:path.join(artifacts,`batch-stopping-${width}.png`),fullPage:true});}
      await page.setViewportSize({width:1440,height:1000});f.tell('release-geometry-exit');await page.locator('[data-testid="modeling-task-status"][data-phase="cancelled"]').waitFor();await visibleBodies(4);assert.equal(await panel.getByLabel('长度 X',{exact:true}).inputValue(),'batchDraftSize');assert.equal(await supplemental.getByRole('button',{name:'取消',exact:true}).isEnabled(),true);assert.equal(await supplemental.getByRole('textbox').inputValue(),'10 mm');const after=await state();for(const key of ['stateToken','revision','bodyCount','variables','features','entityIdentities'])assert.deepEqual(after[key],base[key],key);
    });
    await check('a lost successful batch reply recovers its exact aggregate and reaches the actual viewport once without repeating either step',async()=>{
      const count=batchRequests.length,handler=async route=>{await route.fetch();await route.abort('failed');};await page.route('**/api/command-batches',handler);
      try{const panel=await openBox('batchReceiptSize');await panel.getByRole('button',{name:'创建基础体',exact:true}).click();await panel.getByRole('dialog',{name:'创建缺失变量',exact:true}).waitFor();await panel.getByRole('button',{name:'创建并重试',exact:true}).click();await visibleBodies(5);assert.equal(batchRequests.length,count+1);assert.equal((await state()).variables.filter(item=>item.name==='batchReceiptSize').length,1);assert.ok(controlRequests.some(item=>item.path.endsWith('/'+batchRequests.at(-1).taskId+'/result')));}finally{await page.unroute('**/api/command-batches',handler);}
    });
    await check('a batch enters protected publication only after its steps and disables cancellation before the real final checkpoint',async()=>{
      const {at}=await beginMissingBatch('batchCommitSize');f.tell('arm-task-commit');await f.event('task-commit-armed',at);f.tell('release-geometry');await f.event('task-commit-held',at);await page.locator('[data-testid="modeling-task-status"][data-phase="committing"]').waitFor();await strip().getByText('批量建模',{exact:true}).waitFor();assert.equal(await strip().getByRole('button',{name:'取消操作',exact:true}).isDisabled(),true);await strip().screenshot({path:path.join(artifacts,'batch-committing.png')});f.tell('release-geometry');await visibleBodies(6);
    });
    await check('reloading during an active batch restores its same task identity and cancels all steps without resending the original batch',async()=>{
      const base=await state(),count=batchRequests.length,{taskId,at}=await beginMissingBatch('batchReloadSize');await page.reload({waitUntil:'domcontentloaded'});await page.locator(`[data-testid="modeling-task-status"][data-task-id="${taskId}"][data-phase="executing"]`).waitFor();assert.equal(batchRequests.length,count+1);f.tell('arm-geometry-exit');await f.event('geometry-exit-armed',at);await strip().getByRole('button',{name:'取消操作',exact:true}).click();await f.event('geometry-exit-held',at);f.tell('release-geometry-exit');await page.locator('[data-testid="modeling-task-status"][data-phase="cancelled"]').waitFor();await visibleBodies(6);const after=await state();assert.equal(after.stateToken,base.stateToken);assert.deepEqual(after.variables,base.variables);assert.equal(batchRequests.length,count+1);
    });
    await check('completed single and batch task metadata clears together without altering the committed model or variable set',async()=>{
      const base=await state();await page.getByRole('button',{name:/^命令日志/}).click();const response=page.waitForResponse(response=>response.request().method()==='DELETE'&&response.url().endsWith('/modeling-tasks'));await page.getByRole('button',{name:'清理后台已完成任务',exact:true}).click();const result=await(await response).json();assert.ok(result.cleanup.deleted>=8);assert.equal((await f.get('/documents/default/modeling-tasks')).tasks.length,0);const after=await state();assert.equal(after.stateToken,base.stateToken);assert.deepEqual(after.variables,base.variables);
    });
  }
  assert.deepEqual(errors,[]);validateBackendRelease(backend.directory);verified=true;
  const result={ok:true,passed:checks.length,checks,backend:backend.releaseId,frontend:frontend.releaseId,nativeSha256:backend.native.sha256,testManifestSha256:native.manifestSha256,browserErrors:errors,paidProviderCalls:0,batches:qualifyBatches,scope:`Frozen frontend/backend with test-only native reply and exit gates; actual interactive single-command ${qualifyBatches?'and atomic-batch ':''}task cancellation, full engineering rollback, publication protection, exact receipt recovery, reload without replay and explicit terminal-metadata cleanup. Does not qualify ${qualifyBatches?'':'batches, '}STEP, project-file or Pi cancellation.`};fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page){await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});console.error((await page.locator('body').innerText().catch(()=>'' )).slice(-10000));}throw error;}
finally{await browser?.close();let frontendStopped=!frontStarted;if(frontStarted){const result=await front('Stop');frontendStopped=result.Services.every(service=>service.State==='stopped');}const gatewayExit=f?await f.stop():null;if(verified&&frontendStopped&&gatewayExit===0){assert.equal(path.dirname(scratch),path.resolve(os.tmpdir()));assert.ok(path.basename(scratch).startsWith('cad-modeling-task-browser-'));fs.rmSync(scratch,{recursive:true,force:true});}else console.error('Preserved modeling task browser diagnostics: '+scratch);}
