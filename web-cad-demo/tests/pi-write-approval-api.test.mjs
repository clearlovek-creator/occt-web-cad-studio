import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createServer as createSocket} from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';
import {stopTestChild} from './helpers/stop-test-child.mjs';

const root = path.resolve(import.meta.dirname,'..');
const port = async () => {
  const listener = createSocket();
  await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve));
  const selected = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return selected;
};

function toolPayload(value, key) {
  if (typeof value === 'string') {
    try { return toolPayload(JSON.parse(value),key); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object') return undefined;
  if (Object.hasOwn(value,key)) return value;
  return Object.values(value).map(child => toolPayload(child,key)).find(Boolean);
}

test('native Pi and CAD MCP pause high-impact writes and bind one decision to one project state', {timeout:120000}, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(),'cad-pi-write-approval-'));
  const plans = new Map(), providerErrors = [], browserErrors = [];
  const model = 'approval-fixture';
  let gateway, frontend, browser, page, streamId, verified = false;
  const provider = createServer(async (request,response) => {
    try {
      assert.equal(request.url,'/v1/chat/completions');
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      const user = body.messages.findLast(message => message.role === 'user');
      const label = JSON.stringify(user.content).match(/APPROVAL_CASE_([a-z]+)/)?.[1];
      const plan = plans.get(label);
      assert.ok(plan,JSON.stringify(user));
      assert.ok(body.tools.some(tool => tool.function.name === 'batch_modify'));
      const turn = ++plan.turn;
      const lastResult = body.messages.findLast(message => message.role === 'tool');
      let call;
      if (turn === 1) call = {name:'query_model',arguments:{kind:'geometry-tree'}};
      else if (turn === 2) {
        const observed = toolPayload(lastResult.content,'stateToken');
        assert.match(observed.stateToken,/^[a-f0-9]{64}$/);
        call = {name:plan.name,arguments:{...plan.args,baseStateToken:observed.stateToken,baseRevision:observed.revision}};
      } else {
        assert.equal(turn,3,'Pi must not repeat a write after a decision.');
        plan.result = toolPayload(lastResult.content,'ok');
        assert.ok(plan.result,JSON.stringify(lastResult));
      }
      const delta = call ? {role:'assistant',tool_calls:[{index:0,id:`${label}-${turn}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}
        : {role:'assistant',content:'已收到工具结果。'};
      const frame = (value,finish) => ({id:`${label}-${turn}`,object:'chat.completion.chunk',created:1,model,choices:[{index:0,delta:value,finish_reason:finish}]});
      response.writeHead(200,{'content-type':'text/event-stream'});
      response.write('data: '+JSON.stringify(frame(delta,null))+'\n\n');
      response.write('data: '+JSON.stringify(frame({},call?'tool_calls':'stop'))+'\n\n');
      response.end('data: [DONE]\n\n');
    } catch (error) {
      providerErrors.push(error.message);
      response.writeHead(500,{'content-type':'application/json'});
      response.end(JSON.stringify({error:{message:'Local approval fixture failed'}}));
    }
  });
  await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
  try {
    const uiRelease = process.env.PI_APPROVAL_UI_RELEASE;
    const uiPort = uiRelease ? await port() : null;
    const uiUrl = uiPort ? `http://localhost:${uiPort}/` : null;
    const cwd = path.join(data,'pi-workspace');
    fs.mkdirSync(cwd);
    gateway = await gatedGeometryGateway(data,{
      PI_CLI_PATH:'',PI_CLI_CWD:cwd,TSX_TSCONFIG_PATH:path.resolve(root,'../pi/tsconfig.json'),
      PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',AGENT_ALLOW_PRIVATE_URL:'true',...(uiUrl?{WEB_ORIGIN:new URL(uiUrl).origin}:{}),
    });
    const api = gateway;
    const saved = await api.post('/agent/providers',{id:model,name:'Local approval fixture',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,
      protocol:'chat-completions',model,apiKey:'offline-fixture-not-a-real-secret'});
    assert.equal(saved.status,200,JSON.stringify(saved));
    const target = await api.cad('primitive.box',{width:10,depth:10,height:10});
    const cutter = await api.cad('primitive.box',{width:4,depth:4,height:12,x:2,y:2,z:-1});
    const sessionPath = '/pi/sessions/webcad-default';
    const created = await api.post('/pi/sessions',{sessionId:'webcad-default',documentId:'default',providerId:model});
    assert.equal(created.status,200,JSON.stringify(created));
    streamId = created.value.streamId;
    const approvalPath = sessionPath+`/write-approval?documentId=default&streamId=${streamId}`;
    const rpc = async command => {
      const result = await api.post(sessionPath+'/commands',{documentId:'default',streamId,command});
      assert.equal(result.status,200,JSON.stringify(result));
      assert.equal(result.value.response.success,true,JSON.stringify(result));
      return result.value.response.data;
    };
    await rpc({type:'set_model',provider:model,modelId:model});
    await rpc({type:'set_auto_retry',enabled:false});
    if (uiRelease) {
      frontend = spawn(process.execPath,['scripts/frontend-launch.mjs','--release',uiRelease,'--port',String(uiPort),'--gateway-api',api.api],
        {cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']});
      let logs = '';
      frontend.stderr.on('data',chunk => { logs += chunk; });
      await api.until(async () => {
        assert.equal(frontend.exitCode,null,logs);
        return (await fetch(new URL('/__cad/health',uiUrl)).then(response => response.json()).catch(()=>null))?.ok;
      },'Isolated frontend did not start',20000);
      browser = await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
      page = await browser.newPage({viewport:{width:1440,height:960}});
      page.on('pageerror',error => browserErrors.push(error.message));
      await page.addInitScript(() => {sessionStorage.setItem('occt.activeDocumentId','default');localStorage.setItem('occt.activeDocumentId','default');});
      await page.goto(uiUrl);
      await page.getByRole('button',{name:'AI 助手',exact:true}).click();
      await page.getByText('会话在线',{exact:true}).waitFor({timeout:15000});
    }
    const state = () => api.cad('document.summary');
    const card = () => page?.getByTestId('pi-write-approval');
    const observe = async () => (await api.get(approvalPath)).approval;
    const choose = (id,decision,headers) => api.post(approvalPath,{id,decision},headers);
    const pending = () => api.until(async () => {
      const approval = await observe();
      return approval?.status === 'pending' ? approval : null;
    },'The tool did not produce a pending approval');
    const prompt = async (label,name,args) => {
      const plan = {name,args,turn:0};
      plans.set(label,plan);
      if (page) {
        await page.getByRole('textbox',{name:'发送给 Pi Agent'}).fill('APPROVAL_CASE_'+label);
        await page.getByRole('button',{name:'发送',exact:true}).click();
      } else await rpc({type:'prompt',message:'APPROVAL_CASE_'+label});
      return plan;
    };
    const resultOf = async plan => {
      const result = await api.until(() => plan.result,'Pi did not report the original tool outcome');
      await api.until(async () => !(await rpc({type:'get_state'})).isStreaming,'Pi did not finish the tool turn');
      return result;
    };

    const create = await prompt('create','primitive__box',{parameters:{width:3,depth:4,height:5,x:30}});
    assert.equal((await resultOf(create)).ok,true);
    assert.equal(await observe(),null);
    const third = (await state()).bodyMetadata.find(body => ![target.bodyId,cutter.bodyId].includes(body.bodyId));
    const remove = {inputs:{bodyId:third.bodyId}};
    const original = await state();
    const rejected = await prompt('reject','body__delete',remove);
    const first = await pending();
    assert.deepEqual(first.steps[0].targets,[{id:third.bodyId,name:third.name,action:'删除'}]);
    assert.equal((await state()).stateToken,original.stateToken);
    assert.equal((await choose(first.id,'approve',{origin:'https://foreign.invalid'})).status,403);
    assert.equal((await choose(randomUUID(),'approve')).status,409);
    assert.equal((await api.post(approvalPath,{id:first.id,decision:'approve',inputs:{bodyId:target.bodyId}})).status,400);
    if (page) {
      await card().getByText(third.name,{exact:true}).waitFor();
      await page.reload();
      await page.getByRole('button',{name:'AI 助手',exact:true}).click();
      await card().getByText(third.bodyId+' · 删除',{exact:true}).waitFor();
      await card().getByRole('button',{name:'取消操作'}).click();
      await card().getByText('已取消',{exact:true}).waitFor();
    } else assert.equal((await choose(first.id,'cancel')).value.approval.status,'cancelled');
    assert.equal((await resultOf(rejected)).code,'PI_APPROVAL_REJECTED');
    assert.equal((await state()).stateToken,original.stateToken);

    const stale = await prompt('stale','body__delete',remove);
    const obsolete = await pending();
    await api.cad('primitive.box',{width:3,depth:3,height:3,x:50});
    assert.equal((await choose(obsolete.id,'approve')).value.code,'PI_APPROVAL_STALE');
    if (page) await card().getByText('工程已变化，确认已失效',{exact:true}).waitFor();
    assert.equal((await resultOf(stale)).code,'PI_APPROVAL_STALE');
    assert.ok((await state()).bodyMetadata.some(body => body.bodyId===third.bodyId));

    const queued = await prompt('queued','body__delete',remove);
    const preview = await pending();
    api.tell('arm-geometry'); await api.event('geometry-armed');
    const concurrent = api.post('/commands',{documentId:'default',operation:'primitive.box',parameters:{width:3,depth:3,height:3,x:60}});
    await api.event('geometry-held');
    assert.equal((await choose(preview.id,'approve')).status,200);
    await api.until(async () => (await api.get('/health')).lifecycle.documentActions.queued===1,'Approved task did not reach the mutation queue');
    const guardedTask = (await api.get('/documents/default/modeling-tasks')).tasks.find(task => task.operation==='body.delete' && task.phase==='queued');
    assert.ok(guardedTask);
    const replacement = await api.post('/commands',{documentId:'default',operation:'body.delete',requestId:guardedTask.requestKey,
      inputs:{bodyId:target.bodyId}},{'x-cad-task-id':guardedTask.taskId});
    assert.equal(replacement.value.code,'PI_APPROVAL_REQUIRED');
    api.tell('release-geometry');
    assert.equal((await concurrent).value.ok,true);
    assert.equal((await resultOf(queued)).code,'PI_APPROVAL_STALE');
    assert.ok((await state()).bodyMetadata.some(body => body.bodyId===third.bodyId));

    const accepted = await prompt('accept','body__delete',remove);
    const fresh = await pending();
    assert.notEqual(fresh.id,obsolete.id);
    if (page) {
      await card().getByText(third.bodyId+' · 删除',{exact:true}).waitFor();
      await card().getByRole('button',{name:'确认执行'}).click();
    } else assert.equal((await choose(fresh.id,'approve')).status,200);
    assert.equal((await resultOf(accepted)).ok,true);
    assert.equal((await choose(fresh.id,'approve')).status,409);
    assert.equal((await state()).bodyMetadata.some(body => body.bodyId===third.bodyId),false);
    assert.equal(api.events.filter(event => event.type==='fixture.native-request' && event.operation==='body.delete').length,1);

    const cut = await prompt('cut','boolean__cut',{inputs:{targetBodies:[target.bodyId],toolBodies:[cutter.bodyId]},parameters:{keepTarget:false}});
    const boolean = await pending();
    assert.deepEqual(boolean.steps[0].targets.map(({role,action})=>[role,action]),[['目标体','消耗'],['工具体','消耗']]);
    assert.equal((await choose(boolean.id,'approve')).status,200);
    assert.equal((await resultOf(cut)).ok,true);
    const afterCut = await state();
    assert.equal(afterCut.bodyMetadata.some(body=>body.bodyId===cutter.bodyId),false);

    const subjects = afterCut.bodyMetadata.slice(0,2);
    const apply = {steps:subjects.map(body=>({operation:'transform.translate',inputs:{bodyId:body.bodyId},parameters:{dx:2,dy:0,dz:0}}))};
    const batch = await prompt('batch','batch_modify',apply);
    const batchReview = await pending();
    assert.equal(batchReview.operation,'project.batch');
    assert.deepEqual(batchReview.steps.map(step=>step.targets[0].id),subjects.map(body=>body.bodyId));
    assert.equal((await state()).stateToken,afterCut.stateToken);
    assert.equal((await choose(batchReview.id,'approve')).status,200);
    assert.equal((await resultOf(batch)).ok,true);
    const translated = await state();
    assert.equal(translated.revision,afterCut.revision+2);
    assert.equal((await api.cad('document.undo')).revision,afterCut.revision);

    const stop = await prompt('stop','body__delete',{inputs:{bodyId:subjects[0].bodyId}});
    const stopped = await pending();
    await rpc({type:'abort'});
    await api.until(async () => !(await rpc({type:'get_state'})).isStreaming,'Pi remained active after stop');
    assert.equal((await observe()).status,'cancelled');
    assert.equal((await choose(stopped.id,'approve')).status,409);
    assert.equal(stop.turn,2);
    assert.equal(api.events.filter(event=>event.type==='fixture.native-request'&&event.operation==='body.delete').length,1);
    assert.deepEqual(providerErrors,[]);
    assert.deepEqual(browserErrors,[]);
    verified=true;
  } finally {
    await browser?.close();
    await stopTestChild(frontend);
    if (gateway) assert.equal(await gateway.stop(),0);
    provider.closeAllConnections();
    await new Promise(resolve=>provider.close(resolve));
    if (verified) {
      assert.equal(path.dirname(path.resolve(data)),path.resolve(os.tmpdir()));
      assert.ok(path.basename(data).startsWith('cad-pi-write-approval-'));
      fs.rmSync(data,{recursive:true,force:true});
    }
  }
});
