/* Actual UI controls and WebGL opacity uniforms against a sealed native candidate. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {selectRelease,validateRelease} from '../gateway/frontend-release.mjs';
import {selectBackendRelease,validateBackendRelease} from '../gateway/backend-release.mjs';
import {gatedGeometryGateway} from '../tests/helpers/gated-geometry-gateway.mjs';
const root=path.resolve(import.meta.dirname,'..'),frontend=selectRelease(path.resolve(process.env.LOFT_UI_RELEASE_ROOT||'.artifacts/mesh-recovery-final-frontend-releases'),root),backendRoot=path.resolve(process.env.CAD_TEST_BACKEND_RELEASE_ROOT||'.artifacts/body-display-backend-releases'),backend=selectBackendRelease(backendRoot);
const artifacts=path.resolve(process.env.BODY_DISPLAY_BROWSER_ARTIFACTS||'.artifacts/body-display-browser');assert.ok(artifacts.startsWith(path.join(root,'.artifacts')+path.sep)&&!fs.existsSync(artifacts));fs.mkdirSync(artifacts,{recursive:true});
const checks=[],screenshots=[],errors=[],shaderProof=[];let appearanceAudit=null,gateway,front,browser,page,result,closed=false,frontCode=null,frontSignal=null,output='';
const delay=()=>new Promise(resolve=>setTimeout(resolve,25));
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;}
async function screenshot(name){await page.screenshot({path:path.join(artifacts,name)});screenshots.push(name);}
async function actualOpacity(value){await page.waitForFunction(expected=>window.__bodyOpacityProof?.some(actual=>Math.abs(actual-expected)<1e-6),value);shaderProof.push({expected:value,observed:await page.evaluate(()=>window.__bodyOpacityProof)});}
async function clearProof(){await page.evaluate(()=>{window.__bodyOpacityProof=[];});}
const opacitySlider=form=>form.getByRole('slider',{name:/^(Body opacity|不透明度)$/});
async function openEditor(){await page.locator('.body-tree-label').first().dblclick();const form=page.locator('.body-appearance-editor');await opacitySlider(form).waitFor();return form;}
async function closeEditor(){await page.getByRole('button',{name:'关闭操作窗口',exact:true}).click();}
async function createPage(origin,documentId){
  const context=await browser.newContext({viewport:{width:1440,height:960}}),tab=await context.newPage();tab.setDefaultTimeout(20000);tab.on('pageerror',error=>errors.push(error.message));
  await tab.addInitScript(id=>{
    sessionStorage.setItem('occt.activeDocumentId',id);localStorage.setItem('occt.activeDocumentId',id);window.__bodyOpacityProof=[];
    const names=new WeakMap();
    for(const type of [window.WebGLRenderingContext,window.WebGL2RenderingContext])if(type){
      const proto=type.prototype,get=proto.getUniformLocation,set=proto.uniform1f;
      proto.getUniformLocation=function(program,name){const location=get.call(this,program,name);if(location)names.set(location,name);return location;};
      proto.uniform1f=function(location,value){if(names.get(location)==='opacity'&&window.__bodyOpacityProof.length<4096&&!window.__bodyOpacityProof.includes(value))window.__bodyOpacityProof.push(value);return set.call(this,location,value);};
    }
  },documentId);
  await tab.goto(origin,{waitUntil:'networkidle'});await tab.getByTestId('cad-viewport').locator('canvas').waitFor();return tab;
}
try{
  const origin='http://127.0.0.1:'+await freePort();gateway=await gatedGeometryGateway(path.join(artifacts,'data'),{CAD_TEST_GATEWAY_RELEASE_ROOT:backendRoot,WEB_ORIGIN:origin,PI_OFFLINE:'1'});const box=await gateway.cad('primitive.box',{width:20,depth:20,height:20});await gateway.cad('body.update',{name:'Display fixture',color:'#336699',opacity:.35},{bodyId:box.bodyId});
  front=spawn(process.execPath,[path.join(frontend.directory,'runtime/scripts/frontend-server.mjs'),'--release',frontend.directory,'--port',new URL(origin).port,'--gateway-api',gateway.api],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'production'}});front.once('close',(code,signal)=>{closed=true;frontCode=code;frontSignal=signal;});const append=bytes=>output=(output+bytes).slice(-32768);front.stdout.on('data',append);front.stderr.on('data',append);const deadline=Date.now()+30000;while(!output.includes('"phase":"ready"')){assert.equal(closed,false,output);assert.ok(Date.now()<deadline,'Frontend observation expired, exit not implied');await delay();}
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await createPage(origin,'default');
  await check('the appearance editor and actual WebGL shader both receive persisted Body opacity',async()=>{await actualOpacity(.35);const form=await openEditor();assert.equal(await opacitySlider(form).inputValue(),'0.35');const percent=form.getByRole('spinbutton',{name:'不透明度百分比',exact:true});if(await percent.count())assert.equal(await percent.inputValue(),'35');else assert.match(await form.innerText(),/35% 不透明/);appearanceAudit=await form.evaluate(el=>{const input=el.querySelector('input[type="color"]'),style=getComputedStyle(input),rect=input.getBoundingClientRect();return {value:input.value,width:rect.width,height:rect.height,padding:style.padding,background:style.backgroundColor,color:style.color,swatch:getComputedStyle(input,'::-webkit-color-swatch').backgroundColor};});await screenshot('initial-opacity.png');});
  await check('keyboard adjustment commits one appearance change and updates the actual material opacity',async()=>{const form=page.locator('.body-appearance-editor'),slider=opacitySlider(form);await slider.focus();for(let i=0;i<4;i++)await page.keyboard.press('ArrowRight');assert.equal(await slider.inputValue(),'0.55');await clearProof();await form.getByRole('button',{name:'保存几何设置',exact:true}).click();await form.getByText('几何设置已保存。',{exact:true}).waitFor();await actualOpacity(.55);assert.equal((await gateway.cad('document.summary')).bodyMetadata[0].opacity,.55);await screenshot('keyboard-saved.png');await closeEditor();});
  await check('Undo and Redo restore both the editor value and rendered opacity without a page refresh',async()=>{await clearProof();await page.getByRole('button',{name:'撤销',exact:true}).click();await actualOpacity(.35);let form=await openEditor();assert.equal(await opacitySlider(form).inputValue(),'0.35');await closeEditor();await clearProof();await page.getByRole('button',{name:'重做',exact:true}).click();await actualOpacity(.55);form=await openEditor();assert.equal(await opacitySlider(form).inputValue(),'0.55');await screenshot('redo-opacity.png');await closeEditor();});
  await check('a portable project opened in a separate browser context restores native and rendered opacity',async()=>{const saved=await fetch(gateway.api+'/documents/default/project/save',{method:'POST'});assert.equal(saved.status,200);const opened=await fetch(gateway.api+'/documents/display-copy/project/open',{method:'POST',headers:{'content-type':'application/vnd.webcad.project'},body:Buffer.from(await saved.arrayBuffer())});assert.equal(opened.status,200,await opened.text());page=await createPage(origin,'display-copy');await actualOpacity(.55);const form=await openEditor();assert.equal(await opacitySlider(form).inputValue(),'0.55');assert.equal(await form.getByRole('textbox',{name:'Body 名称',exact:true}).inputValue(),'Display fixture');await screenshot('portable-opacity.png');});
  await check('narrow-screen appearance controls remain reachable and display the recovered value',async()=>{await page.setViewportSize({width:640,height:960});const form=page.locator('.body-appearance-editor'),slider=opacitySlider(form);await slider.scrollIntoViewIfNeeded();const bounds=await slider.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=641);assert.equal(await slider.inputValue(),'0.55');assert.equal(await form.getByRole('button',{name:'保存几何设置',exact:true}).isVisible(),true);await screenshot('narrow-opacity.png');});
  if(process.env.BODY_APPEARANCE_EDITOR_MODE)await (await import('./verify-appearance-editor.mjs')).verifyAppearanceEditor({page,artifacts,check,screenshot,gateway,mode:process.env.BODY_APPEARANCE_EDITOR_MODE});
  assert.deepEqual(errors,[]);result={ok:true,passed:checks.length,checks,frontend:frontend.releaseId,backend:backend.releaseId,appearanceAudit,shaderProof,screenshots,browserErrors:errors,paidProviderCalls:0,scope:'Actual OCCT native snapshots, UI keyboard/editor values and WebGL opacity uniforms under Chrome software rendering; not GPU/industrial assembly qualification or pixel equivalence.'};
}catch(error){if(page)await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});const diagnostics=page?await page.evaluate(()=>({opacity:window.__bodyOpacityProof,viewport:{...document.querySelector('[data-testid="cad-viewport"]')?.dataset},editor:document.querySelector('[aria-label="Body opacity"]')?.value})).catch(()=>null):null;fs.writeFileSync(path.join(artifacts,'failure.json'),JSON.stringify({error:error.message,checks,browserErrors:errors,diagnostics},null,2),{flag:'wx'});throw error;}
finally{
  await browser?.close();if(front&&!closed){front.kill();const deadline=Date.now()+15000;while(!closed){assert.ok(Date.now()<deadline,'Owned frontend exit unconfirmed; preserve test data');await delay();}}
  const gatewayCode=gateway?await gateway.stop():null;fs.writeFileSync(path.join(artifacts,'frontend.log'),output);
  if(result){assert.equal(gatewayCode,0);result.childrenExited=closed;result.frontendExitCode=frontCode;result.frontendSignal=frontSignal;result.gatewayExitCode=gatewayCode;fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));}
}
validateRelease(frontend.directory,root);validateBackendRelease(backend.directory);
