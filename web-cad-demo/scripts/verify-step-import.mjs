import {routeGeometryApi} from './browser-api-route.cjs';
/* Real STEP/OCCT and browser, isolated data. No model provider calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
import {stopTestChild} from '../tests/helpers/stop-test-child.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-step-import-browser-')),fixtures=path.join(data,'fixtures'),api='http://127.0.0.1:8914/api',artifacts=path.join(root,'.artifacts/step-import');fs.mkdirSync(artifacts,{recursive:true});
let gateway,browser;const checks=[],errors=[],eventPositions=new WeakMap();
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
async function summary(){const result=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:'default',operation:'document.summary'})}).then(r=>r.json());assert.equal(result.ok,true);return result;}
async function launch(){
  const child=spawn(process.execPath,['tests/fixtures/gateway-shutdown.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8914',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.events=[];child.diagnostics='';let lines='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{lines+=chunk;let at;while((at=lines.indexOf('\n'))>=0){const line=lines.slice(0,at);lines=lines.slice(at+1);try{child.events.push(JSON.parse(line));}catch{}}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('STEP browser Gateway timeout: '+child.diagnostics)),15000);child.once('error',reject);child.stderr.on('data',chunk=>child.diagnostics+=chunk);child.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});return child;
}
const tell=type=>gateway.stdin.write(JSON.stringify({type})+'\n');
async function event(type){const child=gateway,positions=eventPositions.get(child)||new Map();eventPositions.set(child,positions);const until=Date.now()+10000;for(;;){const index=child.events.findIndex((item,index)=>index>(positions.get(type)??-1)&&item.type==='fixture.'+type);if(index>=0){positions.set(type,index);return child.events[index];}assert.ok(Date.now()<until,'Expected actual STEP event '+type+' '+child.diagnostics);await new Promise(resolve=>setTimeout(resolve,5));}}
try{
  const worker=process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe'),env={...process.env,PATH:[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:\\msys64\\ucrt64\\bin',process.env.PATH].join(path.delimiter)};
  const generated=spawnSync(path.join(path.dirname(worker),'step_import_tests.exe'),['--fixture-output',fixtures],{env,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(generated.status,0,generated.error?.message||generated.stderr||generated.stdout);fs.writeFileSync(path.join(fixtures,'bad.step'),'not a STEP file');
  gateway=await launch();
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
  let uploadCount=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/imports/step'))uploadCount++;});
  await routeGeometryApi(page,api);
  await page.goto(process.env.WORKBENCH_URL||'http://localhost:3000/',{waitUntil:'networkidle'});await page.getByRole('tab',{name:'工程',exact:true}).click();
  const chooseFile=async file=>{const chooser=page.waitForEvent('filechooser');await page.locator('[data-command="file.importStep"]').click();await (await chooser).setFiles(file);};
  const upload=async file=>{const reply=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/imports/step'));await chooseFile(file);return (await reply).status();};
  const report=page.getByTestId('step-import-status');
  await check('a real mixed STEP import reaches the tree and renders actual geometry without dropping source topology',async()=>{
    assert.equal(await upload(path.join(fixtures,'mixed.step')),200);const result=await summary();assert.equal(result.bodyCount,5);assert.deepEqual(result.bodyMetadata.map(body=>body.kind).sort(),['solid','solid','sheet','wire','shape'].sort());
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===5);await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedTriangles)>0);
    const pixels=await page.getByTestId('cad-viewport').evaluate(node=>{node.dispatchEvent(new Event('cad:verify-frame'));return Number(node.dataset.renderedBodyPixels);});assert.ok(pixels>100,'Imported solids/sheets must produce actual pixels, not only tree rows');await page.screenshot({path:path.join(artifacts,'mixed.png'),fullPage:true});
  });
  await check('durable import diagnostics fold, hide, reopen and recover on page reload without another upload',async()=>{
    await report.locator('[role="status"]').filter({hasText:'导入完成'}).waitFor();const details=report.locator('details');assert.equal(await details.getAttribute('open'),null);
    const count=uploadCount;await details.locator('summary').click();await report.getByText('其他几何',{exact:true}).waitFor();assert.match(await details.innerText(),/装配已展开为 Body/);assert.match(await details.innerText(),/来源单位/);
    assert.ok((await report.getByRole('button',{name:'隐藏 STEP 导入报告'}).boundingBox()).height>=40);
    await page.screenshot({path:path.join(artifacts,'diagnostics.png'),fullPage:true});
    await report.getByRole('button',{name:'隐藏 STEP 导入报告'}).click();assert.equal(await report.count(),0);
    await page.getByRole('button',{name:/显示 STEP 导入报告/}).click();await report.waitFor();
    await page.reload({waitUntil:'networkidle'});await report.locator('[role="status"]').filter({hasText:'导入完成'}).waitFor();assert.equal(uploadCount,count);
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===5);
  });
  await check('actual converting status survives page reload and completion synchronizes the current model without reupload',async()=>{
    await page.getByRole('tab',{name:'工程',exact:true}).click();tell('arm-step');await event('step-armed');await chooseFile(path.join(fixtures,'solids.step'));await event('step-held');
    await page.waitForFunction(()=>document.querySelector('[data-testid="step-import-status"]')?.dataset.phase==='converting');
    assert.match(await report.locator('[aria-current="step"]').innerText(),/4\s*转换几何/);
    assert.equal(await report.getByRole('progressbar').count(),0,'No invented completion percentage');
    const count=uploadCount;await page.screenshot({path:path.join(artifacts,'converting.png'),fullPage:true});
    page.once('dialog',dialog=>void dialog.accept());await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('[data-testid="step-import-status"]')?.dataset.phase==='converting');assert.equal(uploadCount,count);
    tell('release-geometry');await page.waitForFunction(()=>document.querySelector('[data-testid="step-import-status"]')?.dataset.phase==='complete');
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===2);assert.equal((await summary()).bodyCount,2);assert.equal(uploadCount,count);
  });
  await check('a malformed STEP reports failure while the complete previously displayed project remains intact',async()=>{
    await page.getByRole('tab',{name:'工程',exact:true}).click();const before=await summary();assert.equal(await upload(path.join(fixtures,'bad.step')),400);await page.getByText(/OCCT could not parse the STEP file/).first().waitFor();const after=await summary();assert.equal(after.stateToken,before.stateToken);assert.deepEqual(after.features,before.features);assert.equal(await page.getByTestId('feature-tree').locator('[data-body-id]').count(),2);assert.equal(await report.getAttribute('data-phase'),'failed');await report.getByText(/原工程保持导入前状态/).waitFor();await page.screenshot({path:path.join(artifacts,'failed-preserves-project.png'),fullPage:true});
  });
  await check('a committed import with a lost production-bridge reply stays unknown and reconciles without another upload',async()=>{
    const before=uploadCount,postPattern='**/api/documents/default/imports/step',statusPattern='**/api/documents/default/imports/step/status*';
    // Pause status observation only, not the actual OCCT transaction. The real
    // Gateway commits before the simulated production bridge loses its reply.
    const hideStatus=route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,documentId:'default',stepImportStatus:null})});
    const loseReply=async route=>{
      const committed=await route.fetch({url:api+'/documents/default/imports/step'});assert.equal(committed.status(),200);
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,code:'FRONTEND_GATEWAY_UNAVAILABLE',error:'后台连接中断；没有重发请求，请核对工程。',recoverable:false})});
    };
    await page.route(statusPattern,hideStatus);await page.route(postPattern,loseReply);
    try{
      assert.equal(await upload(path.join(fixtures,'mixed.step')),503);
      await page.waitForFunction(()=>document.querySelector('[data-testid="step-import-status"]')?.dataset.phase==='unknown');
      assert.equal((await summary()).bodyCount,5);assert.equal(await page.getByTestId('feature-tree').locator('[data-body-id]').count(),2,'An unreceived commit cannot be claimed as an adopted display');
      assert.equal(uploadCount,before+1);await page.screenshot({path:path.join(artifacts,'bridge-outcome-unknown.png'),fullPage:true});
    }finally{await page.unroute(statusPattern,hideStatus);await page.unroute(postPattern,loseReply);}
    await report.getByRole('button',{name:'核对当前工程',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="step-import-status"]')?.dataset.phase==='complete'&&document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===5);
    assert.equal(uploadCount,before+1,'Read-only reconciliation must never upload again');
    // Restore this isolated fixture through a new, explicit successful import.
    assert.equal(await upload(path.join(fixtures,'solids.step')),200);await page.waitForFunction(()=>document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===2);
  });
  await check('an interrupted import is diagnosed after a real Gateway restart without resubmitting it',async()=>{
    const before=await summary();tell('arm-step');await event('step-armed');await chooseFile(path.join(fixtures,'mixed.step'));await event('step-held');
    const count=uploadCount;await stopTestChild(gateway);gateway=await launch();page.once('dialog',dialog=>void dialog.accept());await page.reload({waitUntil:'networkidle'});
    await page.waitForFunction(()=>['interrupted','unknown'].includes(document.querySelector('[data-testid="step-import-status"]')?.dataset.phase));
    await report.getByRole('button',{name:'核对当前工程',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===2);
    const after=await summary();assert.equal(after.revision,before.revision);assert.deepEqual(after.features,before.features);assert.equal(uploadCount,count);await page.screenshot({path:path.join(artifacts,'interrupted.png'),fullPage:true});
  });
  await check('import diagnostics and reconciliation controls stay reachable in a narrow workbench',async()=>{
    await page.setViewportSize({width:900,height:700});await report.getByRole('button',{name:'核对当前工程',exact:true}).waitFor();
    await page.screenshot({path:path.join(artifacts,'narrow-status.png'),fullPage:true});
    for(const name of ['核对当前工程','隐藏 STEP 导入报告']){const box=await report.getByRole('button',{name,exact:true}).boundingBox();assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=900&&box.y+box.height<=700,JSON.stringify({name,box}));}
    await page.getByRole('button',{name:/^消息 /}).click();
    assert.ok((await page.getByTestId('cad-viewport').boundingBox()).height>=70,'Expanded messages and import diagnostics must leave a usable viewport');
    const close=await report.getByRole('button',{name:'隐藏 STEP 导入报告'}).boundingBox();assert.ok(close&&close.y+close.height<=700,'Report actions must remain reachable with expanded messages');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(artifacts,'narrow-status.png'),fullPage:true});
  });
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({ok:true,checks,browserErrors:errors,scope:'real browser, real STEP and OCCT; isolated generated mixed topology, not an industrial import corpus; no LLM calls'},null,2));console.log(`${checks.length} STEP browser checks passed.`);
}finally{await browser?.close();await stopTestChild(gateway);assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
