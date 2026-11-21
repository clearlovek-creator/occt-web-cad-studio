/* Read-only release gate on the real workbench. Never submits LLM prompts or CAD edits. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';

const root=path.resolve(import.meta.dirname,'..');
const argument=process.argv[process.argv.indexOf('--audit')+1];
assert.ok(process.argv.includes('--audit')&&argument,'Specify --audit with a previously captured project audit.');
const baseline=JSON.parse(fs.readFileSync(path.resolve(argument),'utf8'));
assert.equal(baseline.format,'web-cad-project-audit');
const api=process.env.DEPLOYED_API_ROOT||'http://127.0.0.1:8788/api';
const url=process.env.WORKBENCH_URL||'http://localhost:3000/';
const releaseIndex=process.argv.indexOf('--expect-release'),expectedRelease=releaseIndex>=0?process.argv[releaseIndex+1]:null;
if(releaseIndex>=0)assert.match(expectedRelease||'',/^frontend-[0-9]{13}-[a-f0-9-]{36}$/,'Specify a valid expected production release ID.');
const artifacts=path.join(root,'.artifacts','deployed-workbench');
fs.mkdirSync(artifacts,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const checks=[],errors=[],apiRequests=[],sourceAuditMethods=[];let releaseHealth=null;
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
try{
  const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const parsed=new URL(request.url());if(parsed.pathname==='/api'||parsed.pathname.startsWith('/api/'))apiRequests.push(parsed);if(parsed.pathname.endsWith('/source-audit')||parsed.pathname==='/api/source-catalog')sourceAuditMethods.push(request.method());});
  // Browser storage selects the audited project only. It does not create a project.
  await page.addInitScript(documentId=>{sessionStorage.setItem('occt.activeDocumentId',documentId);},baseline.documentId);
  const navigation=await page.goto(url,{waitUntil:'networkidle'});
  assert.equal(navigation?.status(),200,'The deployed frontend must return HTTP 200 before checking its application state.');
  if(expectedRelease)await check('deployed production owner serves the expected release and same-origin Gateway without HMR',async()=>{
    const response=await fetch(new URL('/__cad/health',url));assert.equal(response.status,200);releaseHealth=await response.json();
    assert.equal(releaseHealth.ok,true);assert.equal(releaseHealth.format,'web-cad-frontend');assert.equal(releaseHealth.mode,'Production');assert.equal(releaseHealth.releaseId,expectedRelease);assert.equal(releaseHealth.apiMode,'same-origin');assert.equal(releaseHealth.clientAssetsValid,true);assert.equal(releaseHealth.gatewayApi,api);
    assert.ok(Number.isInteger(releaseHealth.ownerPid)&&releaseHealth.ownerPid>0);assert.equal((await navigation.text()).includes('/@vite/client'),false);
    const direct=await fetch(api+'/health').then(reply=>reply.json()),bridged=await fetch(new URL('/api/health',url)).then(reply=>reply.json());assert.equal(bridged.ok,true);assert.equal(bridged.storage.writer.ownerPid,direct.storage.writer.ownerPid);
  });
  await check('deployed workbench loads the exact audited project and visible CAD geometry',async()=>{
    await page.waitForFunction(expected=>{
      const shell=document.querySelector('main.cad-shell'),view=document.querySelector('[data-testid="cad-viewport"]');
      return shell?.dataset.documentId===expected.documentId&&document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===expected.bodyCount&&view?.dataset.contextState==='ready';
    },baseline);
    if(baseline.bodyCount>0&&baseline.bodies.some(body=>body.visible!==false)){
      await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedTriangles)>0);
      const pixels=await page.getByTestId('cad-viewport').evaluate(node=>{node.dispatchEvent(new Event('cad:verify-frame'));return Number(node.dataset.renderedBodyPixels);});
      assert.ok(pixels>100,'The real viewport must render CAD pixels, not just tree entries');
    }
  });
  await check('deployed STEP status endpoint is read-only and client task layout is available',async()=>{
    const response=await fetch(`${api}/documents/${encodeURIComponent(baseline.documentId)}/imports/step/status`);
    assert.equal(response.status,200);const result=await response.json();assert.equal(result.ok,true);assert.equal(result.documentId,baseline.documentId);
    assert.equal(await page.locator('.import-output-slot').count(),1);
    assert.equal(await page.getByText(/导入记录暂不可用/).count(),0);
  });
  await check('native Pi reconnects the saved session while idle, without replaying a modeling request',async()=>{
    await page.getByRole('button',{name:'AI 助手',exact:true}).click();const panel=page.getByTestId('pi-agent-panel');
    await panel.locator('.pi-agent-status').filter({hasText:'会话在线'}).waitFor();
    assert.equal(await panel.getByRole('button',{name:/^(Plan|Edit)$/}).count(),0);
    assert.equal(await panel.getByRole('textbox',{name:'发送给 Pi Agent',exact:true}).isEnabled(),true);
    assert.equal(await panel.getByRole('button',{name:'停止',exact:true}).count(),0);
    await page.screenshot({path:path.join(artifacts,'desktop.png'),fullPage:true});
  });
  await check('deployed source audit opens read-only and does not submit a new inspection',async()=>{
    const route=`/documents/${encodeURIComponent(baseline.documentId)}/source-audit`,response=await fetch(api+route);assert.equal(response.status,200);const report=await response.json();assert.equal(report.ok,true);assert.equal(report.documentId,baseline.documentId);
    await page.getByRole('button',{name:'关闭 AI 助手',exact:true}).click();await page.getByRole('tab',{name:'工程',exact:true}).click();await page.locator('[data-command="project.sources"]').click();const panel=page.getByTestId('source-audit-panel');await panel.waitFor();
    await page.waitForFunction(()=>{const panel=document.querySelector('[data-testid="source-audit-panel"]');return panel&&!panel.textContent.includes('正在读取检查记录');});assert.equal(await panel.getByRole('alert').count(),0);assert.ok(sourceAuditMethods.includes('GET'));assert.equal(sourceAuditMethods.includes('POST'),false);
    await page.screenshot({path:path.join(artifacts,'source-audit.png'),fullPage:true});
  });
  await check('deployed storage scope is available without automatically scanning or recovering other projects',async()=>{
    const response=await fetch(api+'/source-catalog');assert.equal(response.status,200);const report=await response.json();assert.equal(report.ok,true);assert.equal(report.documentId,'@storage');
    const panel=page.getByTestId('source-audit-panel');await panel.getByRole('button',{name:'全部工程与恢复区',exact:true}).click();await page.waitForFunction(()=>{const panel=document.querySelector('[data-testid="source-audit-panel"]');return panel&&!panel.textContent.includes('正在读取检查记录');});assert.equal(await panel.getByRole('alert').count(),0);assert.equal(sourceAuditMethods.includes('POST'),false);await page.screenshot({path:path.join(artifacts,'source-storage.png'),fullPage:true});
  });
  assert.deepEqual(errors,[]);
  if(expectedRelease){assert.ok(apiRequests.length>0);assert.ok(apiRequests.every(request=>request.origin===new URL(url).origin),'Production browser API requests must use the workbench origin');}
  fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({ok:true,documentId:baseline.documentId,revision:baseline.revision,bodyCount:baseline.bodyCount,release:releaseHealth,checks,browserErrors:errors,scope:'Real deployed workbench and saved Pi session; no geometry writes, import uploads or LLM prompts. Pair with audit-project-state before/after.'},null,2));
  console.log(`${checks.length} deployed browser checks passed.`);
}finally{await browser.close();}
