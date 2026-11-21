/* Real failed catalog/retry backend with a controlled lost HTTP reply. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {selectRelease,validateRelease} from '../gateway/frontend-release.mjs';
import {selectBackendRelease,validateBackendRelease} from '../gateway/backend-release.mjs';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
import {gatedGeometryGateway} from '../tests/helpers/gated-geometry-gateway.mjs';
const root=path.resolve(import.meta.dirname,'..'),frontend=selectRelease(path.resolve(process.env.LOFT_UI_RELEASE_ROOT||'.artifacts/mesh-catalog-ui-frontend-releases'),root),backend=selectBackendRelease(path.resolve(process.env.CAD_TEST_BACKEND_RELEASE_ROOT||'.artifacts/mesh-catalog-ui-backend-releases'));
const artifacts=path.resolve(process.env.MESH_CATALOG_UI_ARTIFACTS||'.artifacts/mesh-catalog-ui-browser');assert.ok(artifacts.startsWith(path.join(root,'.artifacts')+path.sep)&&!fs.existsSync(artifacts));fs.mkdirSync(artifacts,{recursive:true});
const data=path.join(artifacts,'data'),store=new MeshJobStore(data),jobId='mesh-00000000-0000-4000-8000-000000000001';
for(const documentId of ['default','other'])store.save({jobId,documentId,state:'cancelled',createdAt:'2026-11-17T00:00:00.000Z'});
const metadata=doc=>path.join(store.directory({jobId,documentId:doc}),'metadata.json'),sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=['default','other'].map(doc=>sha(metadata(doc)));
let gateway,front,browser,page,frontOutput='',frontendExitCode=null,frontendSignal=null,frontClosed=false,releaseReply;const checks=[],errors=[],screenshots=[];let posts=0,listAvailable=false;
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
async function port(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const contrast=(a,b)=>{const lum=color=>{const c=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return .2126*c[0]+.7152*c[1]+.0722*c[2];};const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
try{
  gateway=await gatedGeometryGateway(data,{CAD_TEST_GATEWAY_RELEASE_ROOT:path.dirname(backend.directory),CAD_TEST_GATEWAY_RELEASE_ID:backend.releaseId});
  const box=await gateway.cad('primitive.box',{width:4,depth:5,height:6}),stateToken=box.stateToken;
  await gateway.until(async()=>{const h=await gateway.get('/mesh/catalog');return h.meshCatalog.state==='unavailable';},'Initial conflict did not settle');
  const p=await port(),origin='http://127.0.0.1:'+p;
  front=spawn(process.execPath,[path.join(frontend.directory,'runtime/scripts/frontend-server.mjs'),'--release',frontend.directory,'--port',String(p),'--gateway-api',gateway.api],{cwd:root,env:{...process.env,NODE_ENV:'production'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  front.stdout.on('data',b=>frontOutput=(frontOutput+b).slice(-65536));front.stderr.on('data',b=>frontOutput=(frontOutput+b).slice(-65536));
  front.once('close',(code,signal)=>{frontendExitCode=code;frontendSignal=signal;frontClosed=true;});
  const deadline=Date.now()+30000;for(;;){assert.equal(front.exitCode,null,frontOutput);try{if((await fetch(origin)).ok)break;}catch{}assert.ok(Date.now()<deadline,'Frontend startup unconfirmed: '+frontOutput);await delay(50);}
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/mesh/catalog/recover'))posts++;});
  await page.goto(origin,{waitUntil:'networkidle'});await page.locator('[data-testid="feature-tree"] [data-body-id="'+box.bodyId+'"]').waitFor();await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
  const panel=page.getByTestId('mesh-workbench-panel'),notice=page.getByTestId('mesh-catalog-notice'),start=panel.getByRole('button',{name:'开始剖分（结果默认隐藏）',exact:true});
  await check('real catalog conflict is readable in the existing panel without an empty-history claim or new modal',async()=>{
    await notice.getByRole('heading',{name:'网格历史未就绪'}).waitFor();assert.match(await notice.innerText(),/同名任务记录/);assert.equal(await start.isDisabled(),true);assert.equal(await panel.getByText('当前工程还没有剖分任务。',{exact:true}).count(),0);
    await panel.locator('.mesh-task-history > summary').click();assert.match(await panel.locator('.mesh-task-history > summary').innerText(),/暂不可读/);assert.equal(posts,0);
  });
  await check('desktop and narrow failure states retain readable contrast, wrapping and a 40px retry target',async()=>{
    for(const width of [1440,900,640]){
      await page.setViewportSize({width,height:1000});await notice.scrollIntoViewIfNeeded();
      const layout=await notice.evaluate(el=>{const box=el.getBoundingClientRect(),s=getComputedStyle(el),text=el.querySelector('p'),button=el.querySelector('button');return {x:box.x,right:box.right,width:innerWidth,overflow:el.scrollWidth-el.clientWidth,bg:s.backgroundColor,text:getComputedStyle(text).color,buttonHeight:button.getBoundingClientRect().height};});
      assert.ok(layout.x>=0&&layout.right<=layout.width+1,JSON.stringify(layout));assert.ok(layout.overflow<=1);assert.ok(layout.buttonHeight>=40);assert.ok(contrast(layout.text,layout.bg)>=4.5);
      const screenshot=path.join(artifacts,`failure-${width}.png`);await page.screenshot({path:screenshot});screenshots.push(path.basename(screenshot));
    }
  });
  await page.setViewportSize({width:1440,height:1000});await panel.getByRole('spinbutton',{name:'质量阈值',exact:true}).fill('0.35');
  await check('an explicit retry that still encounters the conflict stays failed without reposting or touching geometry',async()=>{
    const old=(await gateway.get('/mesh/catalog')).meshCatalog.attemptId;const retry=notice.getByRole('button',{name:'重新读取网格历史',exact:true});await retry.focus();await page.keyboard.press('Enter');
    await gateway.until(async()=>{const c=(await gateway.get('/mesh/catalog')).meshCatalog;return c.state==='unavailable'&&c.attemptId!==old;},'Retry did not reach its actual failure');
    await retry.waitFor();await page.waitForFunction(()=>!document.querySelector('[data-testid="mesh-catalog-notice"] button')?.disabled);assert.equal(posts,1);assert.equal((await gateway.get('/documents/default')).stateToken,stateToken);assert.deepEqual(['default','other'].map(doc=>sha(metadata(doc))),before);
  });
  await check('a held lost reply disables duplicate clicks and reconciles read-only after the actual conflict is corrected',async()=>{
    const source=store.directory({jobId,documentId:'other'}),retained=path.join(data,'retained-conflict');assert.ok(source.startsWith(data+path.sep)&&retained.startsWith(data+path.sep));fs.renameSync(source,retained);
    let posted;const accepted=new Promise(resolve=>posted=resolve),hold=new Promise(resolve=>releaseReply=resolve);
    await page.route('**/documents/default/mesh/jobs',route=>route.request().method()==='GET'&&!listAvailable?route.abort('failed'):route.continue());
    await page.route('**/mesh/catalog/recover',async route=>{await route.fetch();posted();await hold;await route.abort('failed');});
    const retry=notice.getByRole('button',{name:'重新读取网格历史',exact:true});await retry.focus();await page.keyboard.press('Enter');await accepted;
    assert.equal(await notice.getByRole('button').isDisabled(),true);await notice.getByRole('button').evaluate(button=>button.click());assert.equal(posts,2);
    const screenshot=path.join(artifacts,'pending-lost-reply.png');await page.screenshot({path:screenshot});screenshots.push(path.basename(screenshot));releaseReply();
    await notice.getByRole('button',{name:'核对读取状态',exact:true}).waitFor({timeout:15000});await gateway.until(async()=>{const c=(await gateway.get('/mesh/catalog')).meshCatalog;assert.notEqual(c.state,'unavailable',JSON.stringify(c));return c.state==='ready';},'Actual catalog worker did not finish');
    assert.equal(await start.isDisabled(),true);assert.equal(await panel.locator('.mesh-catalog-success').count(),0);assert.equal(await panel.getByText('当前工程还没有剖分任务。',{exact:true}).count(),0);assert.match(await panel.locator('.mesh-task-history > summary').innerText(),/未读取|读取中/);
    assert.equal(sha(metadata('default')),before[0]);assert.equal(sha(path.join(retained,'metadata.json')),before[1]);assert.equal((await gateway.get('/documents/default')).stateToken,stateToken);
  });
  await check('a ready backend with an unreadable list stays unknown until a read-only manual check publishes the real rows',async()=>{
    const check=notice.getByRole('button',{name:'核对读取状态',exact:true});await page.waitForFunction(()=>!document.querySelector('[data-testid="mesh-catalog-notice"] button')?.disabled);await check.focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>{const notice=document.querySelector('[data-testid="mesh-catalog-notice"]');return notice?.getAttribute('data-state')==='ready'&&!notice.querySelector('button')?.disabled;});
    assert.match(await panel.locator('.mesh-task-history > summary').innerText(),/未读取/);assert.equal(await panel.locator('.mesh-catalog-success').count(),0);assert.equal(await start.isDisabled(),true);assert.equal(posts,2);
    const unconfirmed=path.join(artifacts,'ready-but-list-unconfirmed.png');await page.screenshot({path:unconfirmed});screenshots.push(path.basename(unconfirmed));
    listAvailable=true;await notice.getByRole('button',{name:'核对读取状态',exact:true}).focus();await page.keyboard.press('Enter');
    await panel.getByText('网格历史已重新读取，当前工程 1 条记录；未重新剖分。',{exact:true}).waitFor({timeout:15000});await notice.waitFor({state:'detached'});assert.equal(posts,2);assert.equal(await start.isEnabled(),true);assert.equal(await panel.getByRole('spinbutton',{name:'质量阈值',exact:true}).inputValue(),'0.35');
  });
  await check('successful keyboard recovery restores focus to task history without adding a confirmation step',async()=>{
    const focused=await page.evaluate(()=>document.activeElement?.matches('.mesh-task-history > summary'));assert.equal(focused,true);assert.equal(await panel.locator('.mesh-task-history').evaluate(el=>el.open),true);
    const screenshot=path.join(artifacts,'recovered-history.png');await page.screenshot({path:screenshot});screenshots.push(path.basename(screenshot));assert.deepEqual(errors,[]);
  });
  await browser.close();browser=null;
  front.kill();const stopDeadline=Date.now()+15000;while(!frontClosed){assert.ok(Date.now()<stopDeadline,'Frontend exit remains unconfirmed: '+front.pid);await delay(20);}assert.ok(frontendExitCode===0||frontendSignal==='SIGTERM');front=null;
  const gatewayExitCode=await gateway.stop();assert.equal(gatewayExitCode,0);gateway=null;validateRelease(frontend.directory,root);validateBackendRelease(backend.directory);
  const result={ok:true,passed:checks.length,checks,frontend:frontend.releaseId,backend:backend.releaseId,browserErrors:errors,screenshots,recoveryPosts:posts,geometryUnchanged:true,originalRecordsPreserved:true,childrenExited:true,frontendExitCode,frontendSignal,gatewayExitCode,paidProviderCalls:0,scope:'Real failed catalog and retry; only transport reply loss is controlled. Current machine/software WebGL, not industrial/GPU qualification.'};fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
}catch(error){fs.writeFileSync(path.join(artifacts,'failure.txt'),error.stack||String(error));fs.writeFileSync(path.join(artifacts,'frontend.log'),frontOutput);try{await page?.screenshot({path:path.join(artifacts,'failure.png')});}catch{}throw error;
}finally{
  releaseReply?.();await browser?.close();if(front&&!frontClosed){front.kill();const end=Date.now()+15000;while(!frontClosed){assert.ok(Date.now()<end,'Retain unconfirmed frontend '+front.pid);await delay(20);}}
  if(gateway)assert.equal(await gateway.stop(),0);fs.writeFileSync(path.join(artifacts,'frontend.log'),frontOutput);
}
