import {routeGeometryApi} from './browser-api-route.cjs';
import {backendTestArguments} from '../tests/helpers/backend-test-runtime.mjs';
/* Real browser + real SSE + restarted isolated Gateway. Synthetic Pi RPC, no paid LLM. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-pi-browser-'));
const api='http://127.0.0.1:8905/api',artifacts=path.join(root,'.artifacts/pi-recovery');
fs.mkdirSync(artifacts,{recursive:true});
let gateway,browser,page;const checks=[],errors=[];
async function start(){
  gateway=spawn(process.execPath,backendTestArguments(root),{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GEOMETRY_PORT:'8905',GEOMETRY_DATA_DIR:data,PI_CLI_PATH:path.join(root,'tests/fixtures/pi-rpc-fixture.mjs'),PI_CLI_CWD:root}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Isolated Gateway startup timeout')),15000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
}
async function stop(){if(!gateway)return;const child=gateway;gateway=null;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
async function request(route,body,method='POST'){
  const response=await fetch(api+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  const result=await response.json();assert.ok(response.ok&&result.ok,`Test request failed: ${route}`);return result;
}
const summary=()=>request('/commands',{operation:'document.summary',documentId:'default'});
const log=()=>fs.readFileSync(path.join(data,'pi-sessions/webcad-default/fixture-commands.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
try{
  await start();await request('/commands',{operation:'primitive.box',documentId:'default',parameters:{width:20,depth:30,height:40}});
  const before=await summary();let expected=before;
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  let viewportReads=0;
  page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().endsWith('/commands')&&request.method()==='POST'&&request.postDataJSON()?.operation==='document.view')viewportReads++;});
  await routeGeometryApi(page,api);
  await page.goto(process.env.WORKBENCH_URL||'http://localhost:3000/',{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'AI 助手',exact:true}).click();
  const panel=page.getByTestId('pi-agent-panel'),composer=panel.getByRole('textbox',{name:'发送给 Pi Agent',exact:true});
  const online=()=>panel.locator('.pi-agent-status').filter({hasText:'会话在线'}).waitFor();
  const send=async message=>{await composer.fill(message);await panel.getByRole('button',{name:'发送',exact:true}).click();};
  await check('real SSE synchronizes native history before enabling the composer',async()=>{await online();assert.equal(await composer.isEnabled(),true);assert.equal(await panel.getByRole('button',{name:/^(Plan|Edit)$/}).count(),0);});
  await check('native full-message streaming stays deduplicated and folds tool/thinking details',async()=>{
    const readsBefore=viewportReads;
    await send('fixture:stream');await panel.getByText('Transport fixture phase 5',{exact:true}).waitFor();await online();
    await panel.getByRole('button',{name:'停止',exact:true}).waitFor({state:'detached'});
    assert.equal(await panel.getByText('Transport fixture phase 5',{exact:true}).count(),1);
    assert.equal(await panel.locator('.pi-agent-message.tool').count(),1);
    assert.equal(viewportReads-readsBefore,1,'Native tool end plus toolResult must reconcile the viewport once, not twice');
    for(const detail of await panel.locator('details').all())assert.equal(await detail.getAttribute('open'),null);
    await panel.locator('.pi-agent-message.tool summary').click();await panel.getByText(/transport-fixture-only/).last().waitFor();
    await page.screenshot({path:path.join(artifacts,'native-stream.png'),fullPage:true});
  });
  let generation;
  await check('snapshot/reply overlap cannot erase a newer native message',async()=>{
    const current=await request('/pi/sessions',{sessionId:'webcad-default',documentId:'default'});
    await request('/pi/sessions/webcad-default/commands',{streamId:current.streamId,documentId:'default',command:{type:'prompt',message:'fixture:arm-overlap'}});
    await panel.getByRole('button',{name:'压缩',exact:true}).click();await panel.getByText('during snapshot reply',{exact:true}).waitFor();await online();
    assert.equal(await panel.getByText('during snapshot reply',{exact:true}).count(),1);
  });
  await check('a real Gateway restart restores history and unsent input without replaying a prompt',async()=>{
    await send('fixture:pending');await panel.getByRole('button',{name:'停止',exact:true}).waitFor();await composer.fill('未发送的建模草稿');
    generation=(await request('/pi/sessions',{sessionId:'webcad-default',documentId:'default'})).streamId;
    await stop();await panel.locator('.pi-agent-status').filter({hasText:/离线|连接中/}).waitFor();await start();await online();
    const restored=await request('/pi/sessions',{sessionId:'webcad-default',documentId:'default'});assert.notEqual(restored.streamId,generation);
    assert.equal(await composer.inputValue(),'未发送的建模草稿');await panel.getByText('fixture:pending',{exact:true}).waitFor();
    assert.equal(log().filter(command=>command.type==='prompt'&&command.message.includes('fixture:pending')).length,1);
    assert.equal(log().some(command=>command.type==='prompt'&&command.message.includes('未发送的建模草稿')),false);
    await page.screenshot({path:path.join(artifacts,'gateway-recovered.png'),fullPage:true});
  });
  await check('new-process events render after recovery without being blocked by old cursors',async()=>{
    await send('fixture:stream');await panel.getByRole('button',{name:'停止',exact:true}).waitFor({state:'detached'});await online();
    assert.equal(await panel.getByText('Transport fixture phase 5',{exact:true}).count(),2);assert.equal(await panel.locator('.pi-agent-message.tool').count(),2);
  });
  await check('manual recovery reconciles actual CAD changes made while Pi was interrupted without rerunning its task',async()=>{
    await composer.fill('第二份未发送草稿');const count=log().filter(command=>command.type==='prompt').length;
    await request('/pi/sessions/webcad-default',null,'DELETE');await panel.locator('.pi-agent-status').filter({hasText:'已中断'}).waitFor();
    await page.waitForTimeout(650);assert.equal(await composer.inputValue(),'第二份未发送草稿');
    const unchanged=await summary();assert.equal(unchanged.stateToken,before.stateToken);
    expected=await request('/commands',{documentId:'default',operation:'primitive.box',baseRevision:unchanged.revision,parameters:{width:5,depth:7,height:9,x:50}});
    assert.equal(expected.bodyCount,before.bodyCount+1);
    assert.equal(await page.getByTestId('feature-tree').locator('[data-body-id]').count(),before.bodyCount,'No tool event was delivered for this isolated external edit');
    await panel.getByRole('button',{name:'重新连接已有会话',exact:true}).click();await online();
    await page.waitForFunction(total=>document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===total,expected.bodyCount);
    assert.equal(log().filter(command=>command.type==='prompt').length,count);assert.equal(await composer.inputValue(),'第二份未发送草稿');
  });
  await check('assistant controls remain usable at a narrow desktop width',async()=>{
    await page.setViewportSize({width:900,height:800});await composer.scrollIntoViewIfNeeded();
    const bounds=await composer.boundingBox();assert.ok(bounds.width>=200&&bounds.x>=0&&bounds.y+bounds.height<=800);
    await page.screenshot({path:path.join(artifacts,'narrow.png'),fullPage:true});
  });
  await check('native tool progress remains collapsed, expands live snapshots and settles without duplication',async()=>{
    await page.setViewportSize({width:1440,height:960});
    const count=await panel.locator('.pi-agent-message.tool').count();
    await send('fixture:progress');
    const details=panel.locator('.pi-agent-message.tool').last().locator('details');
    await details.getByText(/执行中/).waitFor();assert.equal(await details.getAttribute('open'),null);
    await details.locator('summary').click();
    await details.getByText(/Progress snapshot one and two/).waitFor();
    assert.equal(await panel.locator('.pi-agent-message.tool').count(),count+1);
    assert.equal(await details.getAttribute('open'),'');
    await panel.getByRole('button',{name:'停止',exact:true}).waitFor({state:'detached'});await online();
    assert.equal(await panel.locator('.pi-agent-message.tool').count(),count+1);
    assert.match(await panel.locator('.pi-agent-message.tool').last().locator('summary').innerText(),/完成/);
    await page.screenshot({path:path.join(artifacts,'native-tool-progress.png'),fullPage:true});
  });
  await check('an error or unknown mutation result reconciles real CAD once rather than leaving a stale viewport',async()=>{
    // Native agent_end and the successful prior tool reconcile independently.
    // Finish that flow before attributing reads to this next failed call.
    await page.waitForLoadState('networkidle');
    const stale=await summary();expected=await request('/commands',{documentId:'default',operation:'primitive.box',baseRevision:stale.revision,baseStateToken:stale.stateToken,parameters:{width:3,depth:4,height:5,x:80}});assert.equal(await page.getByTestId('feature-tree').locator('[data-body-id]').count(),stale.bodyCount);
    const readsBefore=viewportReads;await send('fixture:failed-mutation');await panel.getByRole('button',{name:'停止',exact:true}).waitFor({state:'detached'});await page.waitForFunction(total=>document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===total,expected.bodyCount);assert.equal(viewportReads-readsBefore,1);assert.match(await panel.locator('.pi-agent-message.tool').last().locator('summary').innerText(),/结果待核对/);await page.screenshot({path:path.join(artifacts,'unknown-mutation-reconciled.png'),fullPage:true});
  });
  await check('large native results stay collapsed and lazy, synchronize without reconnecting, and still reconcile the actual CAD viewport once',async()=>{
    await page.waitForLoadState('networkidle');
    const stale=await summary();expected=await request('/commands',{documentId:'default',operation:'primitive.box',baseRevision:stale.revision,baseStateToken:stale.stateToken,parameters:{width:2,depth:3,height:4,x:100}});
    const generation=(await request('/pi/sessions',{sessionId:'webcad-default',documentId:'default'})).streamId,readsBefore=viewportReads;
    await send('fixture:large-result');await panel.getByRole('button',{name:'停止',exact:true}).waitFor({state:'detached'});await online();await page.waitForLoadState('networkidle');
    await page.waitForFunction(total=>document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===total,expected.bodyCount);
    assert.equal(await panel.getByText(/正在读取完整原生历史/).count(),0,'The loading notice must disappear after the native snapshot was adopted');
    const details=panel.locator('.pi-agent-message.tool').last().locator('details');assert.equal(await details.getAttribute('open'),null);assert.equal(await details.locator('.pi-agent-message-content').count(),0,'Collapsed content must not allocate a multi-megabyte DOM text node');assert.match(await details.locator('summary').innerText(),/完成/);
    await details.locator('summary').click();const content=details.locator('.pi-agent-message-content');await content.waitFor();assert.ok((await content.textContent()).length<=24001);assert.ok((await content.textContent()).includes('LARGE_NATIVE_BEGIN'));await details.getByRole('button',{name:'末段',exact:true}).click();assert.ok((await content.textContent()).includes('LARGE_NATIVE_END'));assert.ok((await content.textContent()).length<=24001);await page.screenshot({path:path.join(artifacts,'large-native-detail-page.png'),fullPage:true});
    for(const width of [900,640]){await page.setViewportSize({width,height:800});await details.getByRole('button',{name:'首页',exact:true}).scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);for(const button of await details.getByRole('button').all()){const bounds=await button.boundingBox();assert.ok(bounds&&bounds.width>=40&&bounds.height>=40&&bounds.x>=0&&bounds.x+bounds.width<=width);}await page.screenshot({path:path.join(artifacts,`large-native-narrow-${width}.png`),fullPage:true});}
    await page.setViewportSize({width:1440,height:960});await details.locator('summary').click();await content.waitFor({state:'detached'});
    assert.equal((await request('/pi/sessions',{sessionId:'webcad-default',documentId:'default'})).streamId,generation);assert.equal(viewportReads-readsBefore,1,'Two oversized result hints must still reconcile one CAD call only once');assert.equal(log().filter(command=>command.type==='prompt'&&command.message.includes('fixture:large-result')).length,1);await page.screenshot({path:path.join(artifacts,'large-native-result.png'),fullPage:true});
  });
  await check('Pi conversation deletion shows pending and rejected states inside the confirmation',async()=>{
    const history = panel.getByRole('button',{name:'历史对话',exact:true});
    await history.click();
    const remove = panel.getByRole('region',{name:'Pi 历史对话'}).getByRole('button',{name:'删除',exact:true}).first();
    await remove.click();
    const dialog = page.getByRole('dialog',{name:'删除历史对话',exact:true});
    const confirm = dialog.getByRole('button',{name:'确认删除对话'});
    assert.equal(await dialog.getByRole('button',{name:'取消',exact:true}).evaluate(node=>node===document.activeElement),true);
    let release;
    const pending = new Promise(resolve=>{release=resolve;});
    const pattern='**/api/pi/sessions/*/commands';
    const rejectDeletion = async route=>{
      if(route.request().postDataJSON()?.command?.type!=='delete_conversation')return route.fallback();
      await pending;
      await route.fulfill({status:409,json:{ok:false,error:'测试：对话删除未确认。'}});
    };
    await page.route(pattern,rejectDeletion);
    try {
      await confirm.click();
      await dialog.getByRole('status').filter({hasText:'正在处理'}).waitFor();
      assert.equal(await dialog.getByRole('button',{name:'关闭弹窗'}).isDisabled(),true);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.isVisible(),true);
      release();
      await dialog.getByRole('alert').filter({hasText:'对话删除未确认'}).waitFor();
      assert.equal(await confirm.isDisabled(),true);
      await dialog.getByRole('button',{name:'关闭',exact:true}).click();
      assert.equal(await remove.evaluate(node=>node===document.activeElement),true);
    } finally {
      release();
      await page.unroute(pattern,rejectDeletion);
    }
  });
  const after=await summary();assert.equal(after.stateToken,expected.stateToken);assert.equal(after.revision,expected.revision);assert.equal(after.bodyCount,expected.bodyCount);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({ok:true,checks,scope:'real browser, SSE and Gateway restart; deterministic native Pi RPC fixture; explicit Box edits in isolated CAD data test viewport reconciliation; no paid LLM or automatic tool replay'},null,2));
  console.log(`${checks.length} real-browser Pi recovery checks passed; only explicit isolated CAD edits changed geometry.`);
}finally{
  await browser?.close();await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});
}
