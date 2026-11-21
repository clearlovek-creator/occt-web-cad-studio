/* Real browser, isolated OCCT projects and actual Windows source transactions.
 * Never uses the user's data directory or a model-provider prompt. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {stopTestChild} from '../tests/helpers/stop-test-child.mjs';
import {decodeProjectPackage,PROJECT_MIME} from '../gateway/project-package.mjs';
import {selectRelease} from '../gateway/frontend-release.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-source-restore-browser-中文-')),artifacts=path.join(root,'.artifacts/source-restoration');fs.mkdirSync(artifacts,{recursive:true});
async function freePort(){const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));return port;}
const port=await freePort(),frontendPort=await freePort(),api=`http://127.0.0.1:${port}/api`,frontend=`http://127.0.0.1:${frontendPort}/`,release=selectRelease(path.join(root,'.releases'),root);
let gateway,browser,page;const checks=[],errors=[],requests=[],dialogs=[],downloadDiagnostics=[];
let frontendStarted=false;
async function manageFrontend(action){
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/start-web-cad-demo.ps1'),'-Action',action,'-Service','Frontend','-FrontendPort',String(frontendPort),'-GatewayPort',String(port),'-DataDirectory',data,'-RuntimeDirectory',path.join(data,'test-frontend'),'-FrontendReleaseId',release.releaseId,'-AsJson'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',diagnostic='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>diagnostic+=chunk);
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{child.stdout.destroy();child.stderr.destroy();if(code===0)resolve();else reject(Error('Isolated frontend '+action+' failed: '+diagnostic));});});return JSON.parse(output.trim());
}
const json=async(route,method='GET',body)=>{const response=await fetch(api+route,{method,...(body!==undefined?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)}),result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));return result;};
const wait=async read=>{for(let count=0;count<500;count++){const result=await read();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Source recovery browser fixture did not settle');};
async function start(){let diagnostic='';gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:String(port),GEOMETRY_DATA_DIR:data,WEB_ORIGIN:new URL(frontend).origin},windowsHide:true,stdio:['ignore','pipe','pipe']});gateway.stderr.on('data',chunk=>diagnostic+=chunk);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Source recovery browser startup '+diagnostic)),15000);gateway.once('error',error=>{clearTimeout(timer);reject(error);});gateway.stdout.on('data',chunk=>{if(String(chunk).includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){await stopTestChild(gateway);gateway=null;}
async function command(operation,parameters={},inputs={}){const state=await json('/documents/default');return json('/commands','POST',{documentId:'default',operation,parameters,inputs,baseRevision:state.revision,baseStateToken:state.stateToken});}
function protectedFiles(){const result={},walk=directory=>{if(!fs.existsSync(directory))return;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())walk(file);else result[path.relative(data,file)]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');}};for(const name of ['history','property-schemas'])walk(path.join(data,name));return result;}
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
try{
  await start();await command('primitive.box',{width:32,depth:24,height:12});const exported=await json('/documents/default/exports/step','POST',{}),step=Buffer.from(await fetch(`http://127.0.0.1:${port}`+exported.downloadUrl).then(response=>response.arrayBuffer()));
  const imported=await fetch(api+'/documents/default/imports/step',{method:'POST',headers:{'content-type':'application/step'},body:step}).then(response=>response.json());assert.equal(imported.ok,true,JSON.stringify(imported));
  const type=await command('property.type.create',{key:'RecoveryEvidence',name:'恢复验证数据',targetScope:'project',association:'none',fields:[{key:'frequency',type:'double',default:3}]});await command('property.instance.create',{typeId:type.type.typeId,name:'Setup1',value:{frequency:3},target:null});
  const before=await command('document.summary'),target=before.features.find(feature=>feature.type==='import.step').stringParameters.sourcePath,original=fs.readFileSync(target);
  const packed=await fetch(api+'/documents/default/project/save',{method:'POST'});assert.equal(packed.status,200);const raw=decodeProjectPackage(Buffer.from(await packed.arrayBuffer())).geometry;
  const clone=await fetch(api+'/documents/shared/project/open',{method:'POST',headers:{'content-type':PROJECT_MIME},body:raw}).then(response=>response.json());assert.equal(clone.ok,true,JSON.stringify(clone));
  const baseline=protectedFiles();fs.appendFileSync(target,'\n/* changed source for isolated recovery */');
  // Use the actual production same-origin bridge. Chromium attachment downloads
  // bypass Playwright's rewritten navigation path; remapping /files would test
  // a different network topology and can cancel before any Gateway request.
  frontendStarted=true;await manageFrontend('Start');const deployed=await fetch(new URL('/__cad/health',frontend)).then(response=>response.json());assert.equal(deployed.releaseId,release.releaseId);assert.equal(deployed.gatewayApi,api);assert.equal(deployed.apiMode,'same-origin');
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>{dialogs.push(dialog.message());void dialog.dismiss();});
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/')){assert.equal(url.origin,new URL(frontend).origin);requests.push({path:url.pathname,method:request.method()});}});
  page.context().on('requestfailed',request=>{if(request.url().includes('/files/'))downloadDiagnostics.push({url:request.url(),failure:request.failure()});});
  page.context().on('response',response=>{if(response.url().includes('/files/'))downloadDiagnostics.push({url:response.url(),status:response.status(),headers:response.headers()});});
  await page.goto(frontend,{waitUntil:'networkidle'});
  const audit=page.getByTestId('source-audit-panel'),panel=page.getByTestId('source-restore-panel'),close=()=>page.getByRole('button',{name:'关闭操作窗口',exact:true}).click();
  const open=async()=>{await page.getByRole('tab',{name:'工程',exact:true}).click();await page.locator('[data-command="project.sources"]').click();await audit.waitFor();};
  const inspect=async()=>{const button=audit.getByRole('button',{name:/^(开始检查|重新检查)$/});await button.click();await audit.locator('[data-source-status="changed"], [data-source-status="missing"]').waitFor();const first=audit.locator('.source-audit-asset').first();if(await first.getAttribute('open')===null)await first.locator('summary').click();await first.getByRole('button',{name:'选择原始文件恢复',exact:true}).click();await panel.waitFor();};
  const choose=async(buffer=original)=>{await panel.getByLabel('选择原始 STEP 文件',{exact:true}).setInputFiles({name:'original.step',mimeType:'application/step',buffer});await panel.getByRole('button',{name:'上传并校验原始文件',exact:true}).click();};
  const prepared=()=>panel.getByRole('button',{name:'恢复原始来源',exact:true}).waitFor({state:'visible'});
  const currentId=()=>panel.locator('.source-restore-detail > [role="status"] > code').innerText();
  const stateText=value=>panel.locator('.source-restore-detail > [role="status"] > strong').filter({hasText:value}).waitFor();
  let id,releaseUpload,heldRoute;
  await check('recovery history opens read-only and an accepted upload survives closing without a second POST',async()=>{
    await open();await page.getByRole('button',{name:'恢复记录',exact:true}).click();await panel.waitFor();await panel.getByText('当前范围暂无恢复记录。',{exact:true}).waitFor();assert.equal(requests.filter(item=>item.path.startsWith('/api/source-restores')&&item.method==='POST').length,0);
    await panel.getByRole('button',{name:'返回来源检查',exact:true}).click();await inspect();
    let accepted,completed,failed;const acceptedPromise=new Promise(resolve=>accepted=resolve),hold=new Promise(resolve=>releaseUpload=resolve),fulfilled=new Promise((resolve,reject)=>{completed=resolve;failed=reject;});
    heldRoute=async route=>{try{const result=await route.fetch();const body=await result.json();assert.equal(body.ok,true,JSON.stringify(body));id=body.restoration.operationId;accepted();await hold;await route.fulfill({response:result});completed();}catch(error){failed(error);}};
    await page.route('**/api/source-restores/**/prepare?*',heldRoute);await choose();await acceptedPromise;await close();
    await wait(async()=>{const result=await json('/source-restores/'+id);return result.restoration.state==='prepared'&&!result.restoration.serviceBusy;});
    await open();await page.getByRole('button',{name:'恢复记录',exact:true}).click();await prepared();assert.equal(await panel.getByRole('button',{name:'恢复原始来源',exact:true}).isDisabled(),true,'A held receipt cannot prematurely enable the next mutation');
    releaseUpload();await fulfilled;await page.unroute('**/api/source-restores/**/prepare?*',heldRoute);await page.waitForFunction(()=>{const button=[...document.querySelectorAll('[data-testid="source-restore-panel"] button')].find(item=>item.textContent==='恢复原始来源');return button&&!button.disabled;});
    assert.equal(await currentId(),id);assert.equal(requests.filter(item=>item.path.endsWith('/prepare')&&item.method==='POST').length,1);assert.equal(fs.readFileSync(target,'utf8').endsWith('/* changed source for isolated recovery */'),true);assert.deepEqual(protectedFiles(),baseline);
    await panel.getByText(/影响工程 · 2 个/).waitFor();await page.screenshot({path:path.join(artifacts,'prepared.png'),fullPage:true});
  });
  await check('a lost commit reply is recovered by GET without a confirmation dialog, duplicated commit or changed CAD files',async()=>{
    const lost=async route=>{const result=await route.fetch();assert.equal((await result.json()).ok,true);await wait(async()=>{const record=(await json('/source-restores/'+id)).restoration;return record.state==='committed'&&!record.serviceBusy;});await route.abort('failed');};
    await page.route('**/api/source-restores/*/commit',lost);await panel.getByRole('button',{name:'恢复原始来源',exact:true}).click();await stateText('来源已恢复');await panel.getByText('已通过原操作记录核对结果；没有重发写请求。',{exact:true}).waitFor();await page.unroute('**/api/source-restores/*/commit',lost);
    assert.deepEqual(fs.readFileSync(target),original);assert.equal(requests.filter(item=>item.path===`/api/source-restores/${id}/commit`).length,1);assert.equal((await command('document.summary')).stateToken,before.stateToken);assert.deepEqual(protectedFiles(),baseline);assert.deepEqual(dialogs,[]);
    await panel.locator('.source-restore-materials > summary').click();const downloadPromise=page.waitForEvent('download');await panel.getByRole('link',{name:'下载 · 操作前保留副本',exact:true}).click();const download=await downloadPromise;const downloaded=path.join(artifacts,'retained-before.step');try{await download.saveAs(downloaded);}catch(error){console.error('Attachment download diagnostics',JSON.stringify({failure:await download.failure(),requests:downloadDiagnostics}));throw error;}assert.equal(fs.readFileSync(downloaded,'utf8').endsWith('/* changed source for isolated recovery */'),true);await page.screenshot({path:path.join(artifacts,'committed.png'),fullPage:true});
  });
  await check('explicit rollback retains both versions and a stale report cannot offer a restore action',async()=>{
    await panel.getByText(/旧文件可能仍然损坏/).waitFor();await panel.getByRole('button',{name:'回退到恢复前',exact:true}).click();await stateText('已回退来源');assert.equal(fs.readFileSync(target,'utf8').endsWith('/* changed source for isolated recovery */'),true);assert.deepEqual(protectedFiles(),baseline);
    await panel.getByRole('button',{name:'返回来源检查',exact:true}).click();await audit.getByText('报告已过期，请重新检查',{exact:true}).waitFor();assert.equal(await audit.getByRole('button',{name:'选择原始文件恢复',exact:true}).count(),0);
  });
  await check('a wrong candidate remains a failed record and never enables file replacement',async()=>{
    await inspect();await choose(Buffer.concat([original,Buffer.from('\nnot the original')]));await stateText('校验或操作未完成');await panel.getByText('SOURCE_RESTORE_CONFLICT',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'恢复原始来源',exact:true}).count(),0);assert.equal(fs.readFileSync(target,'utf8').endsWith('/* changed source for isolated recovery */'),true);assert.deepEqual(protectedFiles(),baseline);
    await panel.getByRole('button',{name:'放弃，保留材料',exact:true}).click();await stateText('已放弃，材料保留');
  });
  let interrupted;
  await check('a missing source uses a new original-byte plan and restart reconciles an actually interrupted native install',async()=>{
    fs.unlinkSync(target);await panel.getByRole('button',{name:'返回来源检查',exact:true}).click();await inspect();await choose();await prepared();interrupted=await currentId();
    await wait(async()=>!(await json('/source-restores/'+interrupted)).restoration.serviceBusy);await close();await stop();
    const child=spawn(process.execPath,[path.join(root,'tests/fixtures/source-restore-crash-fixture.mjs'),data,interrupted,'commit'],{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.resume();let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);
    try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Crash fixture timeout '+diagnostic)),10000);child.once('exit',code=>{clearTimeout(timer);try{assert.equal(code,88,diagnostic);resolve();}catch(error){reject(error);}});child.once('error',error=>{clearTimeout(timer);reject(error);});});}finally{await stopTestChild(child);}
    assert.deepEqual(fs.readFileSync(target),original);await start();assert.equal(fs.existsSync(target),false);await page.reload({waitUntil:'networkidle'});await open();await page.getByRole('button',{name:'恢复记录',exact:true}).click();await prepared();assert.equal(await currentId(),interrupted);await panel.getByText(/未自动继续建模或再次提交/).waitFor();assert.deepEqual(protectedFiles(),baseline);
    await panel.getByRole('button',{name:'恢复原始来源',exact:true}).click();await stateText('来源已恢复');await panel.getByText(/重新恢复为文件缺失状态/).waitFor();assert.deepEqual(fs.readFileSync(target),original);
  });
  await check('startup blocking is visible, disables modeling, keeps diagnosis available and does not retry activation',async()=>{
    await close();await stop();fs.writeFileSync(target,'external unknown version');await start();const previous=requests.length;await page.reload({waitUntil:'networkidle'});const banner=page.getByRole('status',{name:'来源事务状态',exact:true});await banner.getByText('来源事务待复核，建模暂时阻断',{exact:true}).waitFor();
    await page.getByRole('tab',{name:'建模',exact:true}).click();assert.equal(await page.locator('[data-command="primitive.box"]').isDisabled(),true);for(const name of ['拖拽建模','参数建模'])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);assert.equal(await page.getByLabel('构造坐标系',{exact:true}).isDisabled(),true);
    await page.waitForResponse(response=>response.url().endsWith('/api/health')&&response.request().method()==='GET');assert.equal(requests.slice(previous).filter(item=>item.path==='/api/projects/default/activate').length,1,'A blocked load must not be automatically resubmitted');
    await banner.getByRole('button',{name:'查看来源恢复记录',exact:true}).click();await panel.getByRole('button',{name:'查看阻断记录',exact:true}).click();await stateText('事务待人工复核');assert.equal(await currentId(),interrupted);assert.deepEqual(protectedFiles(),baseline);
    // Startup already exposes the same diagnostic. Observe this explicit
    // review's receipt and actual terminal state before changing bytes; merely
    // finding the old error can race the still-running review itself.
    const reviewing=page.waitForResponse(response=>response.url().endsWith(`/source-restores/${interrupted}/review`)&&response.request().method()==='POST');await panel.getByRole('button',{name:'重新核对事务',exact:true}).click();assert.equal((await reviewing).status(),202);
    await wait(async()=>{const record=(await json('/source-restores/'+interrupted)).restoration;return !record.serviceBusy&&record.requestErrorCode==='SOURCE_RESTORE_EXTERNAL_CHANGE';});await page.waitForFunction(()=>{const button=[...document.querySelectorAll('[data-testid="source-restore-panel"] button')].find(item=>item.textContent==='重新核对事务');return button&&!button.disabled;});await panel.getByText('SOURCE_RESTORE_EXTERNAL_CHANGE',{exact:true}).waitFor();assert.equal(fs.readFileSync(target,'utf8'),'external unknown version');
    fs.writeFileSync(target,original);await panel.getByRole('button',{name:'重新核对事务',exact:true}).click();await stateText('来源已恢复');await close();await banner.getByText('来源阻断已解除',{exact:true}).waitFor();await banner.getByRole('button',{name:'重新载入工程',exact:true}).click();await page.waitForFunction(count=>Number(document.querySelector('[data-testid="cad-viewport"]')?.dataset.attachedBodies)===count,before.bodyCount);assert.equal(await banner.count(),0);assert.deepEqual(protectedFiles(),baseline);
  });
  await check('all-project inventory separates retained material ownership from real geometry inputs',async()=>{
    await open();await audit.getByRole('button',{name:'全部工程与恢复区',exact:true}).click();await audit.getByRole('button',{name:/^(开始检查|重新检查)$/}).click();await audit.locator('.source-audit-asset').filter({hasText:'candidate.step'}).first().waitFor();
    const row=audit.locator('.source-audit-asset').filter({hasText:'candidate.step'}).first();await row.locator('summary').click();await row.getByText(/不是建模输入/).waitFor();assert.equal(await row.getByRole('button',{name:'选择原始文件恢复',exact:true}).count(),0);await row.getByRole('button',{name:'查看所属恢复记录',exact:true}).click();await panel.waitFor();await panel.locator('.source-restore-detail').waitFor();assert.equal(await page.getByRole('button',{name:'全部工程记录',exact:true}).getAttribute('aria-pressed'),'true');assert.deepEqual(protectedFiles(),baseline);
  });
  await check('narrow recovery screens keep readable proofs, scrollable details and reachable window controls',async()=>{
    await page.setViewportSize({width:900,height:700});await panel.locator('.source-restore-proofs').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);let bounds=await page.getByRole('button',{name:'关闭操作窗口',exact:true}).boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=700);await page.screenshot({path:path.join(artifacts,'narrow-900.png'),fullPage:true});
    await page.setViewportSize({width:640,height:700});await panel.locator('.source-restore-materials > summary').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);bounds=await page.getByRole('button',{name:'关闭操作窗口',exact:true}).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=640);await page.screenshot({path:path.join(artifacts,'narrow-640.png'),fullPage:true});
  });
  assert.deepEqual(errors,[]);assert.deepEqual(dialogs,[]);assert.deepEqual(protectedFiles(),baseline);console.log(JSON.stringify({passed:checks.length,browserErrors:errors,screenshots:artifacts}));
}finally{await browser?.close();if(frontendStarted)await manageFrontend('Stop');await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
