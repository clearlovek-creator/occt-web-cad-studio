import {routeGeometryApi} from './browser-api-route.cjs';
/* Actual geometry, property-tree selection and highlight pixels. Isolated data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {createGeneratedFixture,movedBox} from '../tests/helpers/generated-topology-fixtures.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-generated-ui-中文-')),api='http://127.0.0.1:8882/api',screenshots=path.join(root,'.artifacts/generated-topology');fs.mkdirSync(screenshots,{recursive:true});
const states=new Map(),passed=[],errors=[];let browser,page,diagnostics='';
const gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8882',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});gateway.stderr.on('data',chunk=>diagnostics+=chunk);
async function cad(id,operation,parameters={},inputs={}){const state=states.get(id),r=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})})}),p=await r.json();assert.equal(p.ok,true,JSON.stringify(p));states.set(id,p);return p;}
async function open(id){if(!page){page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await routeGeometryApi(page,api);}await page.goto(process.env.WORKBENCH_URL||'http://localhost:3000/',{waitUntil:'networkidle'});await page.evaluate(id=>{sessionStorage.setItem('occt.activeDocumentId',id);localStorage.setItem('occt.activeDocumentId',id);},id);await page.reload({waitUntil:'networkidle'});await page.waitForFunction(id=>document.querySelector('main.cad-shell')?.dataset.documentId===id,id);}
async function selectedPixels(){return page.getByTestId('cad-viewport').evaluate(node=>{node.dispatchEvent(new Event('cad:verify-selection'));return Number(node.dataset.selectedFacePixels);});}
async function highlight(){
  // A one-pixel silhouette is not a useful visual verification of a Face.
  const minimum=1500;
  for(const view of ['顶视图','前视图','右视图']){await page.locator(`[title="${view}"]`).click();if(await selectedPixels()>minimum)return;}
  const viewport=page.getByTestId('cad-viewport');
  for(let turn=0;turn<7;turn++){const b=await viewport.boundingBox();await page.mouse.move(b.x+b.width*.4,b.y+b.height*.55);await page.mouse.down({button:'middle'});await page.mouse.move(b.x+b.width*.65,b.y+b.height*.55,{steps:8});await page.mouse.up({button:'middle'});if(await selectedPixels()>minimum)return;}
  throw Error('The selected generated Face never produced visible highlighted pixels in the composited scene');
}
(async()=>{try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Gateway startup timeout '+diagnostics)),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  for(const operation of ['detail.fillet','detail.chamfer','detail.shell','detail.thicken','detail.offset','detail.draft']){
    const id='generated_ui_'+operation.split('.')[1],f=await createGeneratedFixture(cad,id,operation),type=await cad(id,'property.type.create',{key:'GeneratedBoundary',targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]});
    const created=await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Generated boundary',value:{marker:7},target:{kind:'face',bodyId:f.result.bodyId,topologyId:f.face}});await open(id);
    const label=page.getByTestId('feature-tree').locator(`button.feature-tree-label[title^="primitive.box · ${f.base.features[0].id} ·"]`).first();await label.dblclick();const editor=page.getByTestId('feature-history-controls');for(const [key,value]of Object.entries(movedBox))await editor.getByLabel('特征参数 '+key,{exact:true}).fill(String(value));
    const mutation=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.operation==='feature.update');await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();const result=await(await mutation).json();assert.equal(result.ok,true,JSON.stringify(result));states.set(id,result);await page.getByRole('button',{name:'关闭操作窗口',exact:true}).click();
    const instance=(await cad(id,'property.instance.list')).instances.find(i=>i.instanceId===created.instance.instanceId);assert.equal(instance.state,'active');
    const row=page.getByTestId('project-tree').locator('button.managed-record').filter({has:page.locator('strong',{hasText:/^Generated boundary$/})});await row.waitFor();await page.waitForFunction(()=>{const row=[...document.querySelectorAll('button.managed-record')].find(n=>n.querySelector('strong')?.textContent==='Generated boundary');return row&&!row.classList.contains('invalid');});await row.click();await page.getByTestId('selection-readout').getByText(instance.target.topologyId,{exact:true}).waitFor();
    if(operation==='detail.shell'){
      await page.locator('[title="顶视图"]').click();assert.ok(await selectedPixels()>10,'The inner floor must be visible through the open top');
      const viewport=page.getByTestId('cad-viewport'),b=await viewport.boundingBox();await page.mouse.move(b.x+b.width*.5,b.y+b.height*.8);await page.mouse.down({button:'middle'});await page.mouse.move(b.x+b.width*.5,b.y+b.height*.2,{steps:12});await page.mouse.up({button:'middle'});
      const pose=await viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-frame'));return JSON.parse(node.dataset.cameraPose);});assert.ok(pose[2]<pose[5],'The occlusion check must observe the real shell from underneath');
      assert.equal(await selectedPixels(),0,'The outer floor must occlude the selected inner floor; an isolated-face mask would falsely pass');
    }
    await highlight();
    await page.screenshot({path:path.join(screenshots,operation.split('.')[1]+'-inherited.png'),fullPage:true});
    await page.getByRole('tab',{name:'工程',exact:true}).click();const undo=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.operation==='document.undo');await page.locator('[data-command="edit.undo"]').click();const undone=await(await undo).json();assert.equal(undone.ok,true);states.set(id,undone);const restored=(await cad(id,'property.instance.list')).instances.find(i=>i.instanceId===created.instance.instanceId);assert.equal(restored.state,'active');assert.equal(restored.target.topologyId,f.face);
    passed.push(operation);console.log('PASS '+operation+' properties follow the actual regenerated Face and remain selectable/highlighted');
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:passed.length,browserErrors:errors,screenshots},null,2));
}catch(e){if(page){await page.screenshot({path:path.join(screenshots,'failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(-12000));}throw e;}
finally{await page?.unrouteAll({behavior:'ignoreErrors'});await browser?.close();const done=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await done;assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
