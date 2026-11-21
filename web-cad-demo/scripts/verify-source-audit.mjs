/* Read-only source-audit UI on an isolated project. No model-provider requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {routeGeometryApi} from './browser-api-route.cjs';
import {stopTestChild} from '../tests/helpers/stop-test-child.mjs';
import {decodeProjectPackage,PROJECT_MIME} from '../gateway/project-package.mjs';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-source-ui-中文-')),artifacts=path.join(root,'.artifacts','source-audit');fs.mkdirSync(artifacts,{recursive:true});
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));const api=`http://127.0.0.1:${port}/api`;
let gateway,browser,page,diagnostics='';const checks=[],errors=[];
const json=async(route,method='GET',body)=>{const response=await fetch(api+route,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});const value=await response.json();assert.equal(value.ok,true,JSON.stringify(value));return value;};
const command=async(operation='document.view',parameters={},inputs={})=>{const summary=await json('/documents/default');return json('/commands','POST',{documentId:'default',operation,parameters,inputs,baseRevision:summary.revision,baseStateToken:summary.stateToken});};
const check=async(name,run)=>{await run();checks.push(name);console.log('PASS '+name);};
try{
  gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:String(port),GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});gateway.stderr.on('data',chunk=>diagnostics+=chunk);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Source UI startup: '+diagnostics)),15000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(String(chunk).includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
  await command('primitive.box',{width:40,depth:30,height:20,reset:true});const exported=await json('/documents/default/exports/step','POST',{});const step=await fetch(`http://127.0.0.1:${port}`+exported.downloadUrl).then(response=>response.arrayBuffer());
  const imported=await fetch(api+'/documents/default/imports/step',{method:'POST',headers:{'content-type':'application/step'},body:step}).then(response=>response.json());assert.equal(imported.ok,true,JSON.stringify(imported));
  await command('variable.set',{name:'shift',type:'length',expression:'4 mm'});await command('transform.translate',{dx:'shift',dy:0,dz:0},{bodyId:imported.bodyId||imported.activeBodyId});await command('document.undo');
  const before=await command(),source=before.features.find(feature=>feature.type==='import.step').stringParameters.sourcePath;
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await routeGeometryApi(page,api);
  const requests=[],storageRequests=[];page.on('request',request=>{if(request.url().endsWith('/source-audit'))requests.push(request.method());if(request.url().endsWith('/source-catalog'))storageRequests.push(request.method());});
  await page.goto(process.env.WORKBENCH_URL||'http://localhost:3000/',{waitUntil:'networkidle'});
  const panel=page.getByTestId('source-audit-panel'),open=async()=>{await page.getByRole('tab',{name:'工程',exact:true}).click();await page.locator('[data-command="project.sources"]').click();await panel.waitFor();},close=()=>page.getByRole('button',{name:'关闭操作窗口',exact:true}).click();
  const complete=()=>panel.getByRole('status').filter({hasText:'来源完整性已验证'}).waitFor();
  await check('opening the source panel only reads existing jobs and real audits expose scoped source evidence',async()=>{
    await open();await panel.getByText('暂无当前工程检查报告',{exact:true}).waitFor();assert.equal(requests.filter(method=>method==='POST').length,0);
    await panel.getByRole('button',{name:'开始检查',exact:true}).click();await complete();
    const row=panel.locator('.source-audit-asset');assert.equal(await row.count(),1);assert.equal(await row.getAttribute('open'),null);await row.locator('summary').click();
    assert.match(await row.innerText(),/当前 1 · 撤销 [1-9]\d* · 重做 [1-9]\d*/);assert.match(await row.locator('.source-audit-hash').innerText(),/[a-f0-9]{64}/);
    assert.equal((await panel.innerText()).includes(data),false);assert.equal((await command()).stateToken,before.stateToken);await page.screenshot({path:path.join(artifacts,'verified.png'),fullPage:true});
  });
  await check('changed history marks the report stale and an explicit recheck never changes the project',async()=>{
    await command('variable.set',{name:'shift',type:'length',expression:'7 mm'});const changed=await command();await page.reload({waitUntil:'networkidle'});await open();await panel.getByText('报告已过期，请重新检查',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'重新检查',exact:true}).click();await complete();assert.equal((await command()).stateToken,changed.stateToken);
  });
  await check('missing STEP bytes are diagnosed from native checkpoint metadata without rerunning the model',async()=>{
    fs.renameSync(source,source+'.retained');const current=await command();await panel.getByRole('button',{name:'重新检查',exact:true}).click();await panel.locator('[data-source-status="missing"]').waitFor();await panel.locator('.source-audit-asset > summary').click();
    await panel.getByText('请恢复原始 STEP 文件；不要用同名的其他文件替换。',{exact:true}).waitFor();assert.equal((await command()).stateToken,current.stateToken);await page.screenshot({path:path.join(artifacts,'missing.png'),fullPage:true});fs.renameSync(source+'.retained',source);
  });
  await check('closing a dialog after the server accepts a start recovers the same job without another POST',async()=>{
    let accepted,release;const acceptedTask=new Promise(resolve=>accepted=resolve),gate=new Promise(resolve=>release=resolve);let starts=0;
    const hold=async route=>{if(route.request().method()!=='POST')return route.fallback();starts++;const response=await fetch(api+'/documents/default/source-audit',{method:'POST'}),body=await response.text();accepted();await gate;await route.fulfill({status:response.status,contentType:'application/json',body}).catch(()=>{});};
    await page.route('**/api/documents/default/source-audit',hold);await panel.getByRole('button',{name:'重新检查',exact:true}).click();await acceptedTask;await close();release();await page.unroute('**/api/documents/default/source-audit',hold);await open();await complete();assert.equal(starts,1);
  });
  await check('a non-JSON service failure remains readable and retries only the status query',async()=>{
    const broken=route=>route.fulfill({status:404,contentType:'text/plain',body:'Not Found'});await page.route('**/api/documents/default/source-audit',broken);await panel.getByRole('button',{name:'重查状态',exact:true}).click();await panel.getByRole('alert').filter({hasText:'HTTP 404'}).waitFor();assert.equal(await panel.getByRole('button',{name:'重新检查',exact:true}).isDisabled(),true);
    await page.unroute('**/api/documents/default/source-audit',broken);await panel.getByRole('button',{name:'重查状态',exact:true}).click();await complete();
  });
  await check('stop requires a terminal acknowledgement and never automatically resends DELETE',async()=>{
    const real=(await json('/documents/default/source-audit')).audit;let stopped=false,deletes=0;
    const fake=async route=>{const method=route.request().method();if(method==='DELETE'){deletes++;stopped=true;return route.fulfill({json:{ok:true,documentId:'default',audit:{...real,state:'stopping',phase:'stopping',integrityOK:false}}});}return route.fulfill({json:{ok:true,documentId:'default',audit:{...real,state:stopped?'cancelled':'running',phase:stopped?'cancelled':'sources',integrityOK:false}}});};
    await page.route('**/api/documents/default/source-audit',fake);await panel.getByRole('button',{name:'重查状态',exact:true}).click();await panel.getByRole('button',{name:'停止检查',exact:true}).click();await panel.getByText('检查已取消',{exact:true}).waitFor();assert.equal(deletes,1);await page.unroute('**/api/documents/default/source-audit',fake);
  });
  await check('long source reports paginate, filter and keep window controls reachable on narrow desktops',async()=>{
    const real=(await json('/documents/default/source-audit')).audit,many={...real,assets:Array.from({length:65},(_,index)=>({...real.assets[0],assetId:'asset-'+index,fileName:`来源-${String(index).padStart(2,'0')}-`+'very-long-import-name-'.repeat(5)+'.step'}))};
    const fake=route=>route.fulfill({json:{ok:true,documentId:'default',audit:many}});await page.route('**/api/documents/default/source-audit',fake);await panel.getByRole('button',{name:'重查状态',exact:true}).click();await panel.locator('.source-audit-asset').nth(49).waitFor();assert.equal(await panel.locator('.source-audit-asset').count(),50);
    await panel.getByRole('button',{name:'下一页',exact:true}).click();assert.equal(await panel.locator('.source-audit-asset').count(),15);await panel.getByLabel('查找 STEP 来源',{exact:true}).fill('来源-03-');assert.equal(await panel.locator('.source-audit-asset').count(),1);await panel.locator('.source-audit-asset > summary').click();
    for(const width of [900,640]){
      await page.setViewportSize({width,height:700});const controls=page.getByRole('button',{name:'关闭操作窗口',exact:true});const rect=await controls.boundingBox();assert.ok(rect&&rect.x>=0&&rect.y>=0&&rect.x+rect.width<=width&&rect.y+rect.height<=700);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const summary=panel.locator('.source-audit-asset > summary');await summary.scrollIntoViewIfNeeded();const rowBox=await summary.boundingBox(),bodyBox=await page.locator('.operation-window-body').boundingBox();assert.ok(rowBox.y>=bodyBox.y&&rowBox.y+rowBox.height<=bodyBox.y+bodyBox.height,'A source row must remain reachable through the real scroll container');
      await panel.locator('.source-audit-scope').scrollIntoViewIfNeeded();await panel.getByRole('button',{name:'重新检查',exact:true}).scrollIntoViewIfNeeded();assert.ok(await panel.getByRole('button',{name:'重新检查',exact:true}).isVisible());await summary.scrollIntoViewIfNeeded();
    }
    await page.screenshot({path:path.join(artifacts,'narrow.png'),fullPage:true});await close();await page.unroute('**/api/documents/default/source-audit',fake);
  });
  await check('storage scope reads shared native sources and quarantine without opening or recovering other projects',async()=>{
    await page.setViewportSize({width:1440,height:960});const saved=await fetch(api+'/documents/default/project/save',{method:'POST'});assert.equal(saved.status,200);const raw=decodeProjectPackage(Buffer.from(await saved.arrayBuffer())).geometry;
    const cloned=await fetch(api+'/documents/clone/project/open',{method:'POST',headers:{'content-type':PROJECT_MIME},body:raw}).then(response=>response.json());assert.equal(cloned.ok,true,JSON.stringify(cloned));
    const manifest=JSON.parse(fs.readFileSync(path.join(data,'history/clone/manifest.json'),'utf8')),bytes=fs.readFileSync(path.join(data,'history/clone',manifest.current)),hash=createHash('sha256').update(bytes).digest('hex'),quarantine=path.join(data,'history-quarantine/clone');fs.mkdirSync(quarantine,{recursive:true});fs.writeFileSync(path.join(quarantine,manifest.current+'-'+hash+'.corrupt'),bytes);fs.writeFileSync(path.join(data,'imports','retained.step'),'retained original');
    const baseline=await command();await open();await panel.getByRole('button',{name:'全部工程与恢复区',exact:true}).click();await panel.getByText('暂无存储清点报告',{exact:true}).waitFor();assert.equal(storageRequests.filter(method=>method==='POST').length,0);
    await panel.getByRole('button',{name:'开始检查',exact:true}).click();await panel.locator('.source-audit-asset').filter({hasText:path.basename(source)}).waitFor();await panel.getByLabel('查找 STEP 来源',{exact:true}).fill(path.basename(source));const row=panel.locator('.source-audit-asset');assert.equal(await row.count(),1);await row.locator('summary').click();await row.getByText(/关联 2 个工程/).waitFor();assert.match(await row.innerText(),/隔离 1/);assert.match(await row.innerText(),/clone/);assert.match(await row.innerText(),/default/);
    await row.getByText(/关联 2 个工程/).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,'storage-shared.png'),fullPage:true});
    await panel.getByLabel('查找 STEP 来源',{exact:true}).fill('retained.step');await panel.locator('.source-audit-asset > summary').click();await panel.getByText('本次清点未发现引用，不代表已证明可以删除；文件保持原样。',{exact:true}).waitFor();assert.equal(storageRequests.filter(method=>method==='POST').length,1);assert.equal((await command()).stateToken,baseline.stateToken);
  });
  await check('switching away from an in-flight storage reply never replaces the current-project report',async()=>{
    let accepted,release;const ready=new Promise(resolve=>accepted=resolve),gate=new Promise(resolve=>release=resolve);
    const delayed=async route=>{const response=await fetch(api+'/source-catalog'),body=await response.text();accepted();await gate;await route.fulfill({status:response.status,contentType:'application/json',body}).catch(()=>{});};
    await page.route('**/api/source-catalog',delayed);await panel.getByRole('button',{name:'重查状态',exact:true}).click();await ready;await panel.getByRole('button',{name:'当前工程',exact:true}).click();await complete();release();await page.unroute('**/api/source-catalog',delayed);assert.equal(await panel.getByRole('button',{name:'当前工程',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await panel.getByText(/关联 2 个工程/).count(),0);
    await close();
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,browserErrors:errors,screenshots:artifacts}));
}catch(error){console.error(error.stack||error);if(page)await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await browser?.close();await stopTestChild(gateway);assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
