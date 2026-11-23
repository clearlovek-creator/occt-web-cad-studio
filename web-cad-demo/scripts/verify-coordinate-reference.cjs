const {routeGeometryApi}=require('./browser-api-route.cjs');
/* Real face picking and native coordinate dependencies in an isolated project. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-coordinate-ui-中文-'));
const api='http://127.0.0.1:8879/api',screenshots=path.join(root,'.artifacts','coordinate-reference');fs.mkdirSync(screenshots,{recursive:true});
const gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8879',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser,page,diagnostics='';const states=new Map(),passed=[],errors=[];
gateway.stderr.on('data',chunk=>diagnostics+=chunk);
async function cad(id,operation,parameters={},inputs={}){
  const state=states.get(id),response=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,baseRevision:state?.revision??0,...(state?.stateToken?{baseStateToken:state.stateToken}:{})})});
  const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));states.set(id,result);return result;
}
async function open(id){
  if(!page){page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await routeGeometryApi(page,api);}
  await page.goto(process.env.WORKBENCH_URL||'http://localhost:3000/',{waitUntil:'networkidle'});
  await page.evaluate(id=>{sessionStorage.setItem('occt.activeDocumentId',id);localStorage.setItem('occt.activeDocumentId',id);},id);
  await page.reload({waitUntil:'networkidle'});await page.waitForFunction(id=>document.querySelector('main.cad-shell')?.dataset.documentId===id,id);await page.getByTestId('feature-tree').locator('[data-body-id]').first().waitFor();
}
async function close(){const button=page.getByRole('button',{name:'关闭操作窗口',exact:true});if(await button.count())await button.click();}
async function pickFace(view='顶视图'){
  await page.getByRole('button',{name:'面',exact:true}).click();await page.locator(`[title="${view}"]`).click();
  const viewport=page.getByTestId('cad-viewport'),bounds=await viewport.boundingBox();await page.mouse.click(bounds.x+bounds.width*.5,bounds.y+bounds.height*.5);
  await page.waitForFunction(()=>document.querySelector('[data-testid="selection-readout"]')?.textContent.includes('face-'));
  const selected=(await page.getByTestId('selection-readout').innerText()).match(/face-\d+-\d+/)?.[0];assert.ok(selected);
  const pixels=await viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-selection'));return Number(node.dataset.selectedFacePixels);});assert.ok(pixels>10,'Face must actually be selected and highlighted');return selected;
}
async function editCoordinate(name){await page.getByTestId('project-tree').locator('button.managed-record').filter({has:page.locator('strong',{hasText:new RegExp('^'+name+'$')})}).dblclick();return page.getByTestId('project-data-coordinates');}
async function save(panel){const result=page.waitForResponse(response=>response.url().endsWith('/commands')&&response.request().postDataJSON()?.operation==='coordinate.set');await panel.getByRole('button',{name:'保存坐标系',exact:true}).click();return (await result).json();}
async function check(name,run){await run();passed.push(name);process.stdout.write('PASS '+name+'\n');}
async function holeFixture(id,driver){
  if(driver==='variable')await cad(id,'variable.set',{name:'holeX',type:'length',expression:'25 mm'});
  if(driver==='coordinate')await cad(id,'coordinate.set',{id:'hole_frame',name:'Hole Frame',origin:[25,25,-5],xAxis:[1,0,0],yAxis:[0,1,0]});
  const base=await cad(id,'primitive.box',{width:100,depth:100,height:20});
  const tool=await cad(id,'primitive.cylinder',driver==='coordinate'?{radius:5,height:30,coordinateSystemId:'hole_frame'}:{radius:5,height:30,x:driver==='variable'?'holeX':25,y:25,z:-5});
  const cut=await cad(id,'boolean.cut',{}, {targetBody:base.bodyId,toolBody:tool.bodyId});let face;
  for(const candidate of new Set(cut.triangleFaceIds)){const measured=await cad(id,'geometry.measure',{}, {bodyId:base.bodyId,selectionType:'face',selectionId:candidate});if(Math.abs(measured.area-2*Math.PI*5*20)<1e-3)face=candidate;}
  assert.ok(face);await cad(id,'coordinate.set',{id:'attached',name:'Attached frame',kind:'face',referenceBodyId:base.bodyId,referenceTopologyId:face});
  await cad(id,'primitive.box',{width:2,depth:4,height:6,coordinateSystemId:'attached'});return {base,tool,cut};
}
async function editFeature(type,id){
  const tree=page.getByTestId('feature-tree'),label=tree.locator(`button.feature-tree-label[title^="${type} · ${id} ·"]`).first();
  for(let depth=0;depth<12&&!await label.count();depth++){const collapsed=tree.locator('.boolean-input-body[aria-expanded="false"] > .boolean-input-header');if(!await collapsed.count())break;await collapsed.first().click();}
  await label.dblclick();return page.getByTestId('feature-history-controls');
}
function topFaceIndex(p,z){for(let t=0;t<p.triangleFaceIds.length;t++)if(p.indices.slice(t*3,t*3+3).every(v=>Math.abs(p.positions[v*3+2]-z)<1e-7))return Number(p.triangleFaceIds[t].split('-').at(-1));throw Error('Missing top Face');}
async function pickHistoricalFace(index){
  const canvas=page.getByTestId('feature-input-canvas');await canvas.waitFor();await canvas.scrollIntoViewIfNeeded();
  const point=await canvas.evaluate((node,index)=>{node.dispatchEvent(new Event('cad:verify-feature-input'));return JSON.parse(node.dataset.faceScreenPoints).find(point=>point.index===index);},index);
  assert.ok(point);const bounds=await canvas.boundingBox();await page.mouse.click(bounds.x+point.x,bounds.y+point.y);
  await page.waitForFunction(index=>Number(document.querySelector('[data-testid="feature-input-canvas"]').dataset.selectedIndex)===index,index);
  assert.ok(await canvas.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-feature-input'));return Number(node.dataset.highlightPixels);})>4);
}
async function finishJointRepair(id,before,repair){
  await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).click();await repair.getByText('重算预览通过 · 尚未提交',{exact:true}).waitFor();
  assert.equal((await cad(id,'document.view')).stateToken,before.stateToken,'Validation must not commit the original edit or coordinate replacement');
  await repair.getByRole('button',{name:'提交参数与引用修复',exact:true}).click();await repair.waitFor({state:'detached'});
  const result=await cad(id,'document.view');assert.equal(result.revision,before.revision+1);assert.equal(result.coordinateSystems.find(c=>c.id==='attached').referenceState,'resolved');return result;
}
(async()=>{
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Gateway startup timeout '+diagnostics)),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
    browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    await check('consecutive coordinates get free IDs and default three-point references move with the origin',async()=>{
      const id='coordinate_create_ui';
      await cad(id,'primitive.box',{width:20,depth:30,height:10});await open(id);
      await page.getByRole('tab',{name:'数据',exact:true}).click();
      const openEditor=()=>page.locator('[data-command="project.coordinates"]').click();
      const panel=page.getByTestId('project-data-coordinates');
      await openEditor();
      assert.equal(await panel.getByLabel('ID',{exact:true}).inputValue(),'local1');
      assert.equal((await save(panel)).ok,true);await close();
      await openEditor();
      assert.equal(await panel.getByLabel('ID',{exact:true}).inputValue(),'local2');
      await panel.getByLabel('ID',{exact:true}).fill('local1');
      await panel.getByRole('button',{name:'保存坐标系',exact:true}).click();
      await panel.getByText(/坐标系 ID 已存在/).waitFor();
      await panel.getByLabel('ID',{exact:true}).fill('local2');
      await panel.getByLabel('坐标系类型',{exact:true}).selectOption('threePoint');
      await panel.getByLabel('原点 O',{exact:true}).fill('0.5，0.5，0');
      assert.equal(await panel.getByLabel('X 轴点',{exact:true}).inputValue(),'1.5, 0.5, 0');
      assert.equal(await panel.getByLabel('XY 平面点',{exact:true}).inputValue(),'0.5, 1.5, 0');
      const saved=await save(panel);
      assert.equal(saved.ok,true,JSON.stringify(saved));
      assert.deepEqual(saved.coordinateSystems.filter(row=>row.id.startsWith('local')).map(row=>row.id),['local1','local2']);
      assert.deepEqual(saved.coordinateSystems.find(row=>row.id==='local2').origin,[.5,.5,0]);
      await close();
    });
    await check('XZ and YZ drive the grid, drag height and parameter handoff with grid-linked snapping',async()=>{
      const id='coordinate_plane_ui';
      await cad(id,'primitive.box',{width:80,depth:50,height:30});await open(id);
      const plane=page.getByLabel('构造平面',{exact:true}),grid=page.getByLabel('构造平面网格间距',{exact:true});
      const snap=page.getByLabel('构造平面吸附步长',{exact:true});
      const drag=page.getByRole('button',{name:'拖拽建模',exact:true});
      const align=page.getByRole('button',{name:'正视构造面',exact:true});
      const marker=page.locator('.construction-snap-marker[data-point]');
      const point=async()=>{await marker.waitFor();return (await marker.getAttribute('data-point')).split(',').map(Number);};
      assert.equal(await snap.inputValue(),'grid');
      assert.equal(await grid.inputValue(),'10');
      await plane.selectOption('XZ');
      await grid.selectOption('5');
      await page.getByRole('button',{name:'几何吸附',exact:true}).click();
      await align.click();await drag.click();
      const bounds=await page.getByTestId('cad-viewport').boundingBox();
      const x=bounds.x+bounds.width*.32,y=bounds.y+bounds.height*.53;
      await page.mouse.move(x,y);
      assert.ok((await point()).every(value=>value%5===0));
      await page.mouse.click(x,y);await page.mouse.move(x+120,y-85,{steps:8});
      await page.locator('.drag-dimension-readout').waitFor();
      await grid.selectOption('1');
      assert.equal(await page.locator('.drag-dimension-readout').count(),0);
      await grid.selectOption('5');
      await snap.selectOption('0.5');
      const manual=[];
      for(let offset=1;offset<8;offset++){await page.mouse.move(x+offset*6,y-offset*3);manual.push(...await point());}
      assert.ok(manual.every(value=>Number.isInteger(value*2)) && manual.some(value=>value%5!==0));
      await snap.selectOption('grid');
      await page.mouse.click(x,y);await page.mouse.move(x+120,y-85,{steps:8});await page.mouse.click(x+120,y-85);
      await page.mouse.move(x+120,y-200,{steps:8});
      const response=page.waitForResponse(r=>r.url().endsWith('/commands') && r.request().postDataJSON()?.operation==='primitive.box');
      await page.mouse.click(x+120,y-200);
      const packet=await response,params=packet.request().postDataJSON().parameters,result=await packet.json();
      assert.equal(result.ok,true,JSON.stringify(result));assert.equal(params.coordinatePlane,'XZ');
      assert.ok(params.height>=5 && params.height%5===0);
      const ys=result.positions.filter((_,index)=>index%3===1);
      assert.ok(Math.abs(Math.max(...ys))<1e-6 && Math.abs(Math.min(...ys)+params.height)<1e-6);
      await page.getByLabel('拖拽建模类型',{exact:true}).waitFor({state:'detached'});
      await plane.selectOption('YZ');await align.click();await drag.click();
      await page.getByLabel('拖拽建模类型',{exact:true}).selectOption('surface-rectangle');
      await page.mouse.click(x,y);await page.mouse.move(x+120,y-85,{steps:8});
      await page.locator('.drag-dimension-readout').waitFor();
      await page.keyboard.press('Alt+m');
      const editor=page.getByTestId('advanced-modeling-panel');
      assert.equal(await editor.getByLabel('建模参考平面',{exact:true}).inputValue(),'YZ');
      const surface=page.waitForResponse(r=>r.url().endsWith('/commands') && r.request().postDataJSON()?.operation==='surface.rectangle');
      await editor.getByRole('button',{name:'创建基础面',exact:true}).click();
      const current=await(await surface).json();
      assert.equal(current.ok,true,JSON.stringify(current));
      assert.ok(current.positions.filter((_,index)=>index%3===0).every(value=>Math.abs(value)<1e-6));
      await close();
    });
    await check('actual face picking creates an associative frame; source edits restore current origin and explicit rebind changes only on save',async()=>{
      const id='coordinate_ui',base=await cad(id,'primitive.box',{width:20,depth:30,height:10});await open(id);const top=await pickFace();
      await page.getByRole('tab',{name:'数据',exact:true}).click();await page.locator('[data-command="project.coordinates"]').click();const panel=page.getByTestId('project-data-coordinates');
      await panel.getByLabel('ID',{exact:true}).fill('attached');await panel.getByLabel('名称',{exact:true}).fill('Face frame');await panel.getByLabel('坐标系类型',{exact:true}).selectOption('face');
      assert.equal(await panel.getByLabel('面关联方式',{exact:true}).inputValue(),'associative');const created=await save(panel);assert.equal(created.ok,true,JSON.stringify(created));assert.equal(created.coordinateSystems.find(c=>c.id==='attached').referenceTopologyId,top);
      await panel.getByRole('status').filter({hasText:'关联有效'}).waitFor();assert.equal(await panel.getByLabel('原点 O',{exact:true}).inputValue(),'10, 15, 10');assert.equal(await panel.getByLabel('X 轴方向',{exact:true}).getAttribute('readonly'),'');await close();
      const feature=page.getByTestId('feature-tree').locator(`button.feature-tree-label[title^="primitive.box · ${base.features[0].id} ·"]`).first();await feature.dblclick();const editor=page.getByTestId('feature-history-controls');
      await editor.getByLabel('特征参数 width',{exact:true}).fill('40');await editor.getByLabel('特征参数 height',{exact:true}).fill('20');
      const edited=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.operation==='feature.update');await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();assert.equal((await(await edited).json()).ok,true);await close();
      const editing=await editCoordinate('Face frame');assert.equal(await editing.getByLabel('原点 O',{exact:true}).inputValue(),'20, 15, 20');await close();
      const front=await pickFace('前视图');assert.notEqual(front,top);const rebound=await editCoordinate('Face frame'),before=await cad(id,'document.view');
      await rebound.getByRole('button',{name:'使用当前选中面',exact:true}).click();assert.equal((await cad(id,'document.view')).stateToken,before.stateToken,'A replacement draft must not mutate the model');
      const saved=await save(rebound);assert.equal(saved.ok,true,JSON.stringify(saved));assert.equal(saved.coordinateSystems.find(c=>c.id==='attached').referenceTopologyId,front);
      assert.equal(Number((await rebound.getByLabel('原点 O',{exact:true}).inputValue()).split(',')[2]),10);await page.screenshot({path:path.join(screenshots,'face-frame-editor.png'),fullPage:true});await close();
    });
    await check('copying a persistent face frame uses its anchor and can be saved again without recapturing an old face number',async()=>{
      await page.getByTestId('project-tree').getByRole('button',{name:'Face frame操作',exact:true}).click();await page.getByRole('menuitem',{name:'复制',exact:true}).click();
      const panel=page.getByTestId('project-data-coordinates');assert.equal(await panel.getByLabel('ID',{exact:true}).inputValue(),'attached_copy');
      const copied=await save(panel);assert.equal(copied.ok,true,JSON.stringify(copied));const item=copied.coordinateSystems.find(c=>c.id==='attached_copy');assert.equal(item.associationMode,'associative');assert.equal(item.referenceState,'resolved');
      await panel.getByLabel('名称',{exact:true}).fill('Copied face frame');const renamed=await save(panel);assert.equal(renamed.ok,true,JSON.stringify(renamed));assert.equal(renamed.coordinateSystems.find(c=>c.id==='attached_copy').name,'Copied face frame');await close();
    });
    await check('an unresolved coordinate is visible in the tree and blocks drawing until explicitly rebound to a real current face',async()=>{
      const id='coordinate_broken_ui',base=await cad(id,'primitive.box',{width:100,depth:100,height:20}),tool=await cad(id,'primitive.cylinder',{radius:5,height:30,x:25,y:25,z:-5});
      const cut=await cad(id,'boolean.cut',{}, {targetBody:base.bodyId,toolBody:tool.bodyId});let face;
      for(const candidate of new Set(cut.triangleFaceIds)){const m=await cad(id,'geometry.measure',{}, {bodyId:base.bodyId,selectionType:'face',selectionId:candidate});if(Math.abs(m.area-2*Math.PI*5*20)<1e-3)face=candidate;}assert.ok(face);
      await cad(id,'coordinate.set',{id:'broken',name:'Broken frame',kind:'face',referenceBodyId:base.bodyId,referenceTopologyId:face});await cad(id,'feature.update',{x:200},{featureId:tool.features.at(-1).id});await open(id);
      const row=page.getByTestId('project-tree').locator('button.managed-record').filter({has:page.locator('strong',{hasText:/^Broken frame$/})});assert.ok((await row.getAttribute('class')).includes('invalid'));assert.match(await row.innerText(),/引用失效/);
      await page.getByLabel('构造坐标系',{exact:true}).selectOption('broken');await page.getByRole('button',{name:'拖拽建模',exact:true}).click();await page.locator('.construction-frame-warning').waitFor();
      const before=await cad(id,'document.view'),bounds=await page.getByTestId('cad-viewport').boundingBox();await page.mouse.click(bounds.x+bounds.width*.5,bounds.y+bounds.height*.5);await page.mouse.move(bounds.x+bounds.width*.6,bounds.y+bounds.height*.4);
      assert.equal(await page.locator('.drag-modeling-feedback').count(),0);assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
      await page.getByRole('button',{name:'参数建模',exact:true}).click();await close();await pickFace();const panel=await editCoordinate('Broken frame');await panel.getByRole('status').filter({hasText:'引用失效'}).waitFor();
      await panel.getByRole('button',{name:'使用当前选中面',exact:true}).click();const repaired=await save(panel);assert.equal(repaired.ok,true,JSON.stringify(repaired));await panel.getByRole('status').filter({hasText:'关联有效'}).waitFor();assert.equal(await page.locator('.construction-frame-warning').count(),0);
      await page.screenshot({path:path.join(screenshots,'rebound-frame.png'),fullPage:true});await close();
    });
    await check('coordinate editor remains readable and contained at a narrow viewport',async()=>{await editCoordinate('Broken frame');await page.setViewportSize({width:640,height:800});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await page.getByRole('button',{name:'关闭操作窗口',exact:true}).isVisible());const saveButton=page.getByRole('button',{name:'保存坐标系',exact:true});assert.equal(await saveButton.evaluate(node=>{const r=node.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===node;}),true,'Save must remain reachable while the Face reference explanation scrolls');await page.screenshot({path:path.join(screenshots,'narrow-frame-editor.png'),fullPage:true});});
    await check('upstream geometry edits repair a coordinate in a real historical face view; cancel, preview, commit and Undo are atomic',async()=>{
      await page.setViewportSize({width:1440,height:960});const id='coordinate_joint_ui',fixture=await holeFixture(id),before=await cad(id,'document.view');await open(id);
      const editor=await editFeature('primitive.cylinder',fixture.tool.features.at(-1).id);await editor.getByLabel('特征参数 x',{exact:true}).fill('200');
      await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();const repair=page.getByTestId('feature-reference-repair');await repair.getByText('坐标系历史来源 · 临时视图',{exact:true}).waitFor();
      const proposal={operation:'feature.update',inputs:{featureId:fixture.tool.features.at(-1).id},parameters:{x:200}};
      const inspected=await cad(id,'feature.input.preview',{proposal},{coordinateSystemId:'attached'}),index=topFaceIndex(inspected.inputPreview.presentation,20);await pickHistoricalFace(index);
      await repair.getByRole('button',{name:'取消修复，保留参数草稿',exact:true}).click();assert.equal(await editor.getByLabel('特征参数 x',{exact:true}).inputValue(),'200');assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
      await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();await repair.getByTestId('feature-input-canvas').waitFor();await pickHistoricalFace(index);
      await page.setViewportSize({width:640,height:800});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await pickHistoricalFace(index);
      const visibleCanvas=await repair.getByTestId('feature-input-canvas').evaluate(node=>{const r=node.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===node.querySelector('canvas');});assert.equal(visibleCanvas,true,'Narrow layout must leave the actual picking canvas visible, not covered by sticky actions');
      await page.screenshot({path:path.join(screenshots,'joint-repair-narrow.png'),fullPage:true});await page.setViewportSize({width:1440,height:960});
      const result=await finishJointRepair(id,before,repair);assert.deepEqual(result.coordinateSystems.find(c=>c.id==='attached').origin,[50,50,20]);await close();
      await page.getByRole('tab',{name:'工程',exact:true}).click();const undone=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.operation==='document.undo');await page.locator('[data-command="edit.undo"]').click();assert.equal((await(await undone).json()).ok,true);
      const restored=await cad(id,'document.view');assert.deepEqual(restored.coordinateSystems,before.coordinateSystems);assert.deepEqual(restored.features,before.features);
    });
    await check('suppressing a coordinate source allows choosing another real historical output instead of a final live Body',async()=>{
      const id='coordinate_source_ui',fixture=await holeFixture(id),before=await cad(id,'document.view');await open(id);const editor=await editFeature('boolean.cut',fixture.cut.features.at(-1).id);await editor.getByRole('button',{name:'抑制 Feature',exact:true}).click();
      const repair=page.getByTestId('feature-reference-repair');await repair.getByRole('alert').filter({hasText:'历史来源'}).waitFor();
      await repair.getByLabel('坐标系历史来源',{exact:true}).selectOption(`${fixture.base.features[0].id}:${fixture.base.bodyId}`);await repair.getByTestId('feature-input-canvas').waitFor();
      const proposal={operation:'feature.suppress',inputs:{featureId:fixture.cut.features.at(-1).id},parameters:{}};
      const inspected=await cad(id,'feature.input.preview',{proposal},{coordinateSystemId:'attached',sourceFeatureId:fixture.base.features[0].id,sourceBodyId:fixture.base.bodyId});await pickHistoricalFace(topFaceIndex(inspected.inputPreview.presentation,20));
      await page.screenshot({path:path.join(screenshots,'joint-repair-source.png'),fullPage:true});const result=await finishJointRepair(id,before,repair);assert.equal(result.coordinateSystems.find(c=>c.id==='attached').referenceFeatureId,fixture.base.features[0].id);await close();
    });
    for(const driver of ['variable','coordinate'])await check(`${driver} edits use the same coordinate repair flow and preserve the original project-data draft`,async()=>{
      const id='coordinate_driver_ui_'+driver;await holeFixture(id,driver);const before=await cad(id,'document.view');await open(id);let panel;
      if(driver==='variable'){
        await page.getByTestId('project-tree').locator('button.managed-record').filter({has:page.locator('strong',{hasText:/^holeX$/})}).dblclick();panel=page.getByTestId('project-data-variables');await panel.getByLabel('变量表达式',{exact:true}).fill('200 mm');await panel.getByRole('button',{name:'保存变量',exact:true}).click();
      }else{panel=await editCoordinate('Hole Frame');await panel.getByLabel('原点 O',{exact:true}).fill('200, 25, -5');await panel.getByRole('button',{name:'保存坐标系',exact:true}).click();}
      const repair=page.getByTestId('feature-reference-repair');await repair.getByTestId('feature-input-canvas').waitFor();
      const proposal=driver==='variable'?{operation:'variable.set',parameters:{name:'holeX',type:'length',expression:'200 mm'}}:{operation:'coordinate.set',parameters:{id:'hole_frame',name:'Hole Frame',kind:'cartesian',origin:[200,25,-5],xAxis:[1,0,0],yAxis:[0,1,0]}};
      const inspected=await cad(id,'feature.input.preview',{proposal},{coordinateSystemId:'attached'});await pickHistoricalFace(topFaceIndex(inspected.inputPreview.presentation,20));const result=await finishJointRepair(id,before,repair);assert.deepEqual(result.coordinateSystems.find(c=>c.id==='attached').origin,[50,50,20]);await close();
    });
    await check('deleting a shared source lets multiple coordinate repairs advance individually without committing the first one',async()=>{
      const id='coordinate_shared_deleted_ui',fixture=await holeFixture(id);await cad(id,'coordinate.set',{id:'second',name:'Second frame',kind:'face',copyReferenceFrom:'attached'});await cad(id,'primitive.box',{width:2,depth:2,height:2,coordinateSystemId:'second'});
      const before=await cad(id,'document.view');await open(id);const editor=await editFeature('boolean.cut',fixture.cut.features.at(-1).id);await editor.getByRole('button',{name:'删除 Feature',exact:true}).click();await page.getByRole('dialog',{name:/^删除特征/}).getByRole('button',{name:'确认删除',exact:true}).click();
      const repair=page.getByTestId('feature-reference-repair'),proposal={operation:'feature.delete',inputs:{featureId:fixture.cut.features.at(-1).id},parameters:{}};const owners=[];
      for(let step=0;step<2;step++){
        await repair.getByRole('alert').filter({hasText:'历史来源'}).waitFor();const owner=await repair.locator('.feature-input-heading > span').innerText();assert.ok(!owners.includes(owner));owners.push(owner);
        await repair.getByLabel('坐标系历史来源',{exact:true}).selectOption(`${fixture.base.features[0].id}:${fixture.base.bodyId}`);await repair.getByTestId('feature-input-canvas').waitFor();
        const inspected=await cad(id,'feature.input.preview',{proposal},{coordinateSystemId:owner,sourceFeatureId:fixture.base.features[0].id,sourceBodyId:fixture.base.bodyId});await pickHistoricalFace(topFaceIndex(inspected.inputPreview.presentation,20));
        if(step===0){await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).click();await repair.getByRole('status').filter({hasText:'已暂存 1 项引用'}).waitFor();assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);}
      }
      const result=await finishJointRepair(id,before,repair);for(const name of ['attached','second'])assert.equal(result.coordinateSystems.find(c=>c.id===name).referenceFeatureId,fixture.base.features[0].id);await close();
      const restored=await cad(id,'document.undo');assert.deepEqual(restored.coordinateSystems,before.coordinateSystems);assert.deepEqual(restored.features,before.features);
    });
    assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:passed.length,browserErrors:errors,screenshots},null,2));
  }catch(error){if(page){await page.screenshot({path:path.join(screenshots,'failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(-14000));}throw error;}
  finally{await page?.unrouteAll({behavior:'ignoreErrors'});await browser?.close();const stopped=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await stopped;if(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep))fs.rmSync(data,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
