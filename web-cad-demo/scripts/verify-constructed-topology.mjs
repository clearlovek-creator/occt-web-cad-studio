import {routeGeometryApi} from './browser-api-route.cjs';
/* Real parameter editing, property-tree selection and composited highlight. Isolated data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {selectGeometry} from '../tests/helpers/generated-topology-fixtures.mjs';
import {constructedPatterns} from '../tests/helpers/constructed-topology-fixtures.mjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-constructed-ui-中文-')),api='http://127.0.0.1:8884/api',screenshots=path.join(root,'.artifacts/constructed-topology');fs.mkdirSync(screenshots,{recursive:true});
const states=new Map(),passed=[],errors=[];let browser,page,diagnostics='';
const gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8884',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});gateway.stderr.on('data',chunk=>diagnostics+=chunk);
async function cad(id,operation,parameters={},inputs={}){const state=states.get(id),r=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})})}),p=await r.json();assert.equal(p.ok,true,JSON.stringify(p));states.set(id,p);return p;}
async function open(id){if(!page){page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await routeGeometryApi(page,api);}await page.goto(process.env.WORKBENCH_URL||'http://localhost:3000/',{waitUntil:'networkidle'});await page.evaluate(id=>{sessionStorage.setItem('occt.activeDocumentId',id);localStorage.setItem('occt.activeDocumentId',id);},id);await page.reload({waitUntil:'networkidle'});await page.waitForFunction(id=>document.querySelector('main.cad-shell')?.dataset.documentId===id,id);}
async function edit(id,type,featureId,changes){await page.getByTestId('feature-tree').locator(`button.feature-tree-label[title^="${type} · ${featureId} ·"]`).first().dblclick();const editor=page.getByTestId('feature-history-controls');for(const [key,value]of Object.entries(changes))await editor.getByLabel('特征参数 '+key,{exact:true}).fill(String(value));
  if(type==='pattern.rectangular'){assert.equal(await editor.getByLabel('特征参数 count',{exact:true}).count(),0);assert.ok(await editor.getByLabel('阵列实例总数',{exact:true}).isVisible());await page.screenshot({path:path.join(screenshots,'rectangular-edit-derived-total.png'),fullPage:true});}
  const response=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.operation==='feature.update');await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();const result=await(await response).json();assert.equal(result.ok,true,JSON.stringify(result));states.set(id,result);await page.getByRole('button',{name:'关闭操作窗口',exact:true}).click();return result;}
async function highlighted(){
  const viewport=page.getByTestId('cad-viewport'),pixels=()=>viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-selection'));return Number(node.dataset.selectedFacePixels);});
  for(const view of ['顶视图','前视图','右视图']){await page.locator(`[title="${view}"]`).click();if(await pixels()>1000)return;}
  for(let turn=0;turn<7;turn++){const b=await viewport.boundingBox();await page.mouse.move(b.x+b.width*.4,b.y+b.height*.55);await page.mouse.down({button:'middle'});await page.mouse.move(b.x+b.width*.65,b.y+b.height*.55,{steps:8});await page.mouse.up({button:'middle'});if(await pixels()>1000)return;}
  throw Error('The actual selected Face is not visibly highlighted');
}
(async()=>{try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Gateway startup timeout '+diagnostics)),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  for(const operation of ['detail.sweep','detail.pipe','detail.revolve',...Object.keys(constructedPatterns)]){
    const id='constructed_ui_'+operation.split('.')[1],pattern=operation.startsWith('pattern.'),base=await cad(id,pattern?'primitive.box':'surface.rectangle',pattern?{width:10,depth:8,height:6,x:20}:{width:10,height:8,x:20});
    const result=await cad(id,operation,pattern?constructedPatterns[operation].parameters:operation==='detail.revolve'?{angleDegrees:90,axisY:1,axisZ:0}:{pathX:0,pathY:0,pathZ:12},pattern?{bodyId:base.bodyId}:{bodyId:base.bodyId,faceId:base.triangleFaceIds[0]}),bodyId=pattern?result.features.at(-1).outputBodies.at(-1):result.bodyId,view=await cad(id,'body.presentation',{}, {bodyId});
    const face=await selectGeometry(cad,id,view,'face',m=>operation==='detail.revolve'?Math.abs(m.centroid[0])<1e-4&&Math.abs(m.centroid[2]+20)<1e-4:Math.abs(m.centroid[2]-(pattern?6:12))<1e-4);
    const type=await cad(id,'property.type.create',{key:'ConstructedBoundary',targetScope:'face',association:'required',fields:[{key:'marker',type:'int'}]}),created=await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Tracked boundary',value:{marker:7},target:{kind:'face',bodyId,topologyId:face}});await open(id);
    await edit(id,base.features[0].type,base.features[0].id,pattern?{width:14,depth:10,height:9,x:50,y:40,z:5}:{width:16,height:10,x:40,y:30,z:5});
    if(operation==='pattern.rectangular'){const changed=await edit(id,operation,result.features.at(-1).id,{countX:3});assert.equal(changed.features.at(-1).outputBodies[4],bodyId);}
    const instance=(await cad(id,'property.instance.list')).instances.find(i=>i.instanceId===created.instance.instanceId);assert.equal(instance.state,'active');assert.equal(instance.target.bodyId,bodyId);
    const measured=await cad(id,'geometry.measure',{}, {bodyId,selectionType:'face',selectionId:instance.target.topologyId}),expected=pattern?constructedPatterns[operation].expected:operation==='detail.revolve'?[5,30,-40]:[40,30,17];expected.forEach((v,i)=>assert.ok(Math.abs(measured.centroid[i]-v)<1e-4,JSON.stringify(measured.centroid)));
    const row=page.getByTestId('project-tree').locator('button.managed-record').filter({has:page.locator('strong',{hasText:/^Tracked boundary$/})});await row.waitFor();await row.click();await page.getByTestId('selection-readout').getByText(instance.target.topologyId,{exact:true}).waitFor();await highlighted();
    await page.screenshot({path:path.join(screenshots,operation.replace('.','-')+'-inherited.png'),fullPage:true});passed.push(operation);console.log('PASS '+operation+' real feature edits preserve the intended Body/Face and visible highlight');
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:passed.length,browserErrors:errors,screenshots},null,2));
}catch(e){if(page)await page.screenshot({path:path.join(screenshots,'failure.png'),fullPage:true});throw e;}
finally{await page?.unrouteAll({behavior:'ignoreErrors'});await browser?.close();const done=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await done;assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
