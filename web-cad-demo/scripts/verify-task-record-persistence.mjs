/* Compare the retained old backend and the candidate using real OCCT and a sealed UI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {selectRelease,validateRelease} from '../gateway/frontend-release.mjs';
import {selectBackendRelease,validateBackendRelease} from '../gateway/backend-release.mjs';
import {createLoftRepairFixture,loftRepairFaceIndex} from '../tests/helpers/loft-repair-fixtures.mjs';
const root=path.resolve(import.meta.dirname,'..'),frontend=selectRelease(path.resolve(process.env.LOFT_UI_RELEASE_ROOT||'.artifacts/mesh-catalog-ui-sealed-frontend-releases'),root);
const artifacts=path.resolve(process.env.TASK_RECORD_BROWSER_ARTIFACTS||'.artifacts/task-report-browser');assert.ok(artifacts.startsWith(path.join(root,'.artifacts')+path.sep)&&!fs.existsSync(artifacts));fs.mkdirSync(artifacts,{recursive:true});
const delay=()=>new Promise(resolve=>setTimeout(resolve,25));
async function port(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const value=s.address().port;await new Promise(resolve=>s.close(resolve));return value;}
function start(args,env){
    const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']}),record={child,closed:false,code:null,signal:null,output:'',error:null};
    record.done=new Promise(resolve=>child.once('close',(code,signal)=>{Object.assign(record,{closed:true,code,signal});resolve();}));child.once('error',error=>record.error=error);
    const append=bytes=>record.output=(record.output+bytes).slice(-65536);child.stdout.on('data',append);child.stderr.on('data',append);return record;
}
async function until(check,record,label,timeout=45000){const end=Date.now()+timeout;for(;;){if(await check())return;if(record.error)throw record.error;assert.equal(record.closed,false,label+'; child closed: '+record.output);assert.ok(Date.now()<end,label+'; deadline is not proof of exit: '+record.output);await delay();}}
async function stop(record,api,data){
    if(!record||record.closed)return;
    if(api){const control=JSON.parse(fs.readFileSync(path.join(data,'.gateway-control.json'),'utf8'));await fetch(api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':control.token}});}else record.child.kill();
    const end=Date.now()+15000;while(!record.closed){assert.ok(Date.now()<end,'Owned child exit unconfirmed; retain '+data);await delay();}await record.done;
}
const results=[];
for(const [name,backendRoot]of [['old','.artifacts/mesh-catalog-ui-backend-releases'],['candidate',process.env.CAD_TEST_BACKEND_RELEASE_ROOT||'.artifacts/task-report-backend-releases']]){
    const backend=selectBackendRelease(path.resolve(backendRoot)),directory=path.join(artifacts,name),data=path.join(directory,'data');fs.mkdirSync(data,{recursive:true});
    const api='http://127.0.0.1:'+await port()+'/api',origin='http://127.0.0.1:'+await port();let gateway,front,browser,page,result;
    const errors=[],commands=[];
    try{
        gateway=start(['tests/fixtures/task-record-gateway.mjs'],{CAD_TEST_TASK_RECORD_BACKEND_ROOT:path.resolve(backendRoot),GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:new URL(api).port,WEB_ORIGIN:origin,PI_OFFLINE:'1'});
        await until(()=>gateway.output.includes('Geometry gateway ready'),gateway,'Isolated task-record gateway not ready');
        front=start([path.join(frontend.directory,'runtime/scripts/frontend-server.mjs'),'--release',frontend.directory,'--port',new URL(origin).port,'--gateway-api',api],{NODE_ENV:'production'});
        await until(()=>front.output.includes('"phase":"ready"'),front,'Sealed frontend not ready');
        const id='task_record_repair',states=new Map();
        async function cad(documentId,operation,parameters={},inputs={}){const state=states.get(documentId),value=await fetch(api+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId,operation,parameters,inputs,requestId:randomUUID(),baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})})}).then(r=>r.json());assert.equal(value.ok,true,JSON.stringify(value));states.set(documentId,value);return value;}
        const fixture=await createLoftRepairFixture(cad,id),before=await cad(id,'document.view');
        browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
        page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().endsWith('/commands')){const body=request.postDataJSON();commands.push({operation:body.operation,preview:body.options?.preview===true});}});
        await page.addInitScript(id=>{sessionStorage.setItem('occt.activeDocumentId',id);localStorage.setItem('occt.activeDocumentId',id);},id);await page.goto(origin,{waitUntil:'networkidle'});await page.waitForFunction(id=>document.querySelector('main.cad-shell')?.dataset.documentId===id,id);
        const tree=page.getByTestId('feature-tree'),label=tree.locator(`button.feature-tree-label[title^="primitive.box · ${fixture.tool.features.at(-1).id} ·"]`).first();
        for(let n=0;n<16&&!await label.count();n++)await tree.locator('.boolean-input-body[aria-expanded="false"] > .boolean-input-header').first().click();await label.dblclick();
        const editor=page.getByTestId('feature-history-controls');await editor.getByLabel('特征参数 x',{exact:true}).fill('8');
        const update=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.operation==='feature.update'&&!r.request().postDataJSON()?.options?.preview);
        const inspection=name==='candidate'?page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.operation==='feature.input.preview'):null;
        await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();const response=await update,failed=await response.json();
        assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
        if(name==='old'){
            assert.equal(await editor.getByLabel('特征参数 x',{exact:true}).inputValue(),'8');
            assert.equal(response.status(),503);assert.equal(failed.code,'MODELING_TASK_REPORT_UNAVAILABLE');await page.getByText('建模任务阶段无法持久保存，未继续新的执行阶段。',{exact:true}).first().waitFor();assert.equal(commands.some(command=>command.operation==='feature.input.preview'),false);assert.ok(gateway.output.includes('fixture.redundant-cleanup-denied'));
        }else{
            assert.equal(failed.code,'LOFT_SECTION_UNRESOLVED');const preview=await(await inspection).json();assert.equal(preview.ok,true,JSON.stringify(preview));const source=preview.inputPreview,index=loftRepairFaceIndex(source.presentation,10,8),repair=page.getByTestId('feature-reference-repair'),canvas=repair.getByTestId('feature-input-canvas');await canvas.waitFor();await canvas.focus();
            for(let n=0;n<=source.presentation.stats.faceCount+1&&Number(await canvas.getAttribute('data-selected-index'))!==index;n++)await page.keyboard.press('ArrowRight');assert.equal(Number(await canvas.getAttribute('data-selected-index')),index);
            await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).click();await repair.getByText('重算预览通过 · 尚未提交',{exact:true}).waitFor();assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
            const commit=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.operation==='feature.update'&&!r.request().postDataJSON()?.options?.preview);await repair.getByRole('button',{name:'提交参数与引用修复',exact:true}).click();const committed=await(await commit).json();assert.equal(committed.ok,true,JSON.stringify(committed));assert.equal(committed.revision,before.revision+1);states.set(id,committed);await repair.waitFor({state:'detached'});
            assert.deepEqual((await cad(id,'document.undo')).features,before.features);assert.equal(commands.filter(command=>command.operation==='feature.update'&&!command.preview).length,2);assert.ok(gateway.output.includes('fixture.task-record-published'));assert.equal(gateway.output.includes('fixture.redundant-cleanup-denied'),false);
        }
        await page.screenshot({path:path.join(directory,'result.png'),fullPage:true});assert.deepEqual(errors,[]);
        result={name,backend:backend.releaseId,sourceSha256:backend.sourceSha256,observedCode:failed.code,commands,browserErrors:errors,geometryBeforeDecisionUnchanged:true,repairCommittedOnce:name==='candidate',oneUndoRestored:name==='candidate',paidProviderCalls:0};
    }catch(error){
        if(page)await page.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});
        fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:error.message,commands,browserErrors:errors},null,2),{flag:'wx'});throw error;
    }finally{
        await browser?.close();await stop(front,null,data);await stop(gateway,api,data);fs.writeFileSync(path.join(directory,'gateway.log'),gateway?.output||'');fs.writeFileSync(path.join(directory,'frontend.log'),front?.output||'');
        if(result){assert.equal(gateway.code,0);result.childrenExited=Boolean(gateway.closed&&front.closed);result.gatewayExitCode=gateway.code;result.frontendExitCode=front.code;result.frontendSignal=front.signal;fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});results.push(result);console.log('PASS '+name+' '+result.observedCode);}
    }
    validateBackendRelease(backend.directory);
}
validateRelease(frontend.directory,root);assert.equal(results.length,2);fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({ok:true,frontend:frontend.releaseId,frontendSourceSha256:frontend.sourceSha256,results,paidProviderCalls:0},null,2),{flag:'wx'});
