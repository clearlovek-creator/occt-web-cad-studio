/* Real CAD/Gmsh + persisted numeric-report fault injection + real browser.
 * Test-owned data only; never mutates or restarts the user's services. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
import {stopTestChild} from '../tests/helpers/stop-test-child.mjs';
import {routeGeometryApi} from './browser-api-route.cjs';
import {backendTestArguments} from '../tests/helpers/backend-test-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-admission-ui-中文-')),artifacts=path.join(root,'.artifacts/mesh-admission-ui');fs.mkdirSync(artifacts,{recursive:true});
const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));const api=`http://127.0.0.1:${port}/api`;
let gateway,browser,page;const checks=[],errors=[];
async function start(){
  gateway=spawn(process.execPath,backendTestArguments(root),{cwd:root,env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let diagnostic='';const timer=setTimeout(()=>reject(Error('Mesh admission Gateway startup '+diagnostic)),15000);gateway.once('error',reject);gateway.stderr.on('data',chunk=>diagnostic+=chunk);gateway.stdout.on('data',chunk=>{if(String(chunk).includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
}
async function stop(){await stopTestChild(gateway);gateway=null;}
async function request(route,body){const response=await fetch(api+route,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)}),result=await response.json();assert.ok(response.ok&&result.ok,JSON.stringify(result));return result;}
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
try{
  await start();await request('/commands',{documentId:'default',operation:'primitive.box',parameters:{width:12,depth:10,height:8}});
  const before=await request('/commands',{documentId:'default',operation:'document.summary'}),accepted=await request('/documents/default/mesh/jobs',{qualityThreshold:0}),bad=await request('/documents/default/mesh/jobs',{qualityThreshold:0});
  assert.equal(accepted.mesh.admission.status,'accepted');assert.equal(bad.mesh.admission.status,'accepted');await stop();
  // Inject a contradictory numeric quality report into a test-owned job. The
  // original MSH and real tetra corner coordinates remain available to diagnose.
  const store=new MeshJobStore(data),job=store.load().find(row=>row.jobId===bad.meshJob.jobId),result=store.readResult(job),indexPath=store.qualityOutput(job),index=JSON.parse(fs.readFileSync(indexPath));
  index.cells[0].minJacobian=-Math.abs(index.cells[0].minJacobian||1);fs.writeFileSync(indexPath,JSON.stringify(index));
  job.artifact=store.writeResult(job,result);job.meshSummary.admission=result.mesh.admission;store.save(job);assert.equal(result.mesh.admission.status,'blocked');await start();
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await routeGeometryApi(page,api);
  await page.goto(process.env.WORKBENCH_URL||'http://localhost:3000/',{waitUntil:'networkidle'});await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
  const panel=page.getByTestId('mesh-workbench-panel'),viewport=page.getByTestId('cad-viewport'),tree=page.getByTestId('feature-tree');
  await check('source freshness and engineering admission are separate, and blocked meshes cannot be shown normally',async()=>{
    await panel.locator('a.mesh-download[href*="'+job.jobId+'"]').waitFor();await panel.getByRole('status',{name:'网格验收',exact:true}).filter({hasText:'验收未通过'}).waitFor();
    await panel.getByRole('status',{name:'网格有效性',exact:true}).filter({hasText:'有效'}).waitFor();assert.equal(await panel.getByRole('button',{name:'显示网格',exact:true}).isDisabled(),true);assert.equal(await tree.locator('.body-mesh-visibility-button').count(),0);
    assert.match(await panel.locator('.mesh-quality-panel:not(.mesh-boundary-panel) > summary').innerText(),/问题 1 \//,'Collapsed quality count must use verified numbers, not the contradictory native zero');
    assert.equal(Number(await viewport.getAttribute('data-rendered-mesh-groups')),0);const download=panel.getByRole('link',{name:'下载诊断 .msh',exact:true});assert.match(await download.getAttribute('href'),/diagnostic=1/);
    await panel.getByRole('status',{name:'网格验收'}).locator(':scope > details:not(.mesh-topology-samples) > summary').click();await panel.getByText('存在反转四面体。',{exact:false}).waitFor();await page.screenshot({path:path.join(artifacts,'blocked-admission.png'),fullPage:true});
  });
  await check('a blocked mesh keeps real bad-cell geometry locatable without rendering the full mesh or mutating CAD',async()=>{
    const quality=panel.locator('.mesh-quality-panel:not(.mesh-boundary-panel)');await quality.locator(':scope > summary').click();await quality.getByLabel('质量问题类型',{exact:true}).selectOption('inverted');
    const locate=quality.getByRole('button',{name:/^定位单元 /}).first();await locate.waitFor();assert.equal(await locate.isEnabled(),true);await locate.click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.highlightedQualityElements==='1');assert.ok(await viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-quality'));return Number(node.dataset.qualityHighlightPixels);})>10);assert.equal(Number(await viewport.getAttribute('data-rendered-mesh-groups')),0);
    assert.equal((await request('/commands',{documentId:'default',operation:'document.summary'})).stateToken,before.stateToken);await page.screenshot({path:path.join(artifacts,'blocked-cell-located.png'),fullPage:true});
  });
  await check('the browser download action reaches the real gated backend and explicitly labels diagnostic files',async()=>{
    const url='/mesh/outputs/'+path.basename(bad.mesh.outputPath),normal=await fetch(api+url);assert.equal(normal.status,409);assert.equal((await normal.json()).code,'MESH_ADMISSION_REQUIRED');
    const response=page.waitForResponse(value=>value.url().includes(job.jobId+'.msh?diagnostic=1')),download=page.waitForEvent('download');await panel.getByRole('link',{name:'下载诊断 .msh',exact:true}).click();const receipt=await response;assert.equal(receipt.status(),200);assert.equal(receipt.headers()['x-cad-mesh-admission'],'blocked');assert.match((await download).suggestedFilename(),/^diagnostic-/);
  });
  await check('heavy quality reads survive the old 15-second cutoff and closing the report cancels the pending request',async()=>{
    const quality=panel.locator('.mesh-quality-panel:not(.mesh-boundary-panel)'),pattern=new RegExp(`/mesh/jobs/${job.jobId}/quality\\?`),payload=await request(`/mesh/jobs/${job.jobId}/quality?issue=inverted&limit=10`);
    const hold=()=>{let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);const handler=async route=>{started(route.request());await gate;if(route.request().failure()){await route.abort().catch(()=>{});return;}await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)});};return {release:()=>release(),ready,handler};};
    const slow=hold();await page.route(pattern,slow.handler);
    try{await page.clock.install();await quality.getByRole('button',{name:'查询已有结果',exact:true}).click();const pending=await slow.ready;await page.clock.fastForward(16000);assert.equal(pending.failure(),null);assert.equal(await quality.getByRole('status').filter({hasText:'正在载入质量数据'}).isVisible(),true);slow.release();await quality.getByRole('button',{name:/^定位单元 /}).first().waitFor();}
    finally{slow.release();await page.unroute(pattern,slow.handler);}
    const cancelled=hold();await page.route(pattern,cancelled.handler);
    try{await quality.getByRole('button',{name:'查询已有结果',exact:true}).click();await cancelled.ready;const failed=page.waitForEvent('requestfailed',{predicate:request=>pattern.test(request.url())});await quality.locator(':scope > summary').click();const request=await failed;assert.match(request.failure().errorText,/ABORTED|CANCELLED/i);}
    finally{cancelled.release();await page.unroute(pattern,cancelled.handler);}
    assert.equal((await request('/commands',{documentId:'default',operation:'document.summary'})).stateToken,before.stateToken);
  });
  await check('admission details remain readable with reachable controls at 900 and 640 pixel widths',async()=>{
    for(const width of [900,640]){await page.setViewportSize({width,height:800});const admission=panel.getByRole('status',{name:'网格验收'});await admission.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.equal(await admission.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);const close=await page.getByRole('button',{name:'关闭操作窗口',exact:true}).boundingBox();assert.ok(close&&close.x>=0&&close.y>=0&&close.x+close.width<=width&&close.y+close.height<=800);await page.screenshot({path:path.join(artifacts,`blocked-narrow-${width}.png`),fullPage:true});}
    await page.setViewportSize({width:1440,height:960});
  });
  await check('an accepted historical result is independently revalidated and can still render its Body groups',async()=>{
    await panel.locator('.mesh-task-history > summary').click();const row=panel.locator('.mesh-task-history li').filter({hasText:accepted.meshJob.jobId.slice(-8)});await row.getByRole('button',{name:'查看结果',exact:true}).click();await panel.locator('a.mesh-download[href*="'+accepted.meshJob.jobId+'"]').waitFor();
    await panel.getByRole('status',{name:'网格验收'}).filter({hasText:'验收通过'}).waitFor();assert.equal(await panel.getByRole('link',{name:'下载 .msh',exact:true}).count(),1);await panel.getByRole('button',{name:'显示网格',exact:true}).click();await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups)>0);assert.ok(await tree.locator('.body-mesh-visibility-button').count()>0);await page.screenshot({path:path.join(artifacts,'accepted-admission.png'),fullPage:true});
  });
  assert.deepEqual(errors,[]);assert.equal((await request('/commands',{documentId:'default',operation:'document.summary'})).stateToken,before.stateToken);fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({ok:true,checks,scope:'real OCCT/Gmsh, persisted numeric-report fault injection, restart, browser and HTTP download; isolated data; not a general mesh intersection certification'},null,2));console.log(`${checks.length} mesh admission browser checks passed.`);
}catch(error){if(page){await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(-7000));}throw error;}
finally{await browser?.close();await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
