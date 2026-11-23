const {routeGeometryApi}=require('./browser-api-route.cjs');
/* Real native replay and actual browser picking, always in an isolated workspace. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'..'), data = fs.mkdtempSync(path.join(os.tmpdir(),'cad-reference-ui-中文-'));
const api = 'http://127.0.0.1:8875/api', screenshots = path.join(root,'.artifacts','feature-repair');
fs.mkdirSync(screenshots,{recursive:true});
const gateway = spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8875',GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser, page, diagnostics=''; const errors=[], passed=[], states=new Map();
gateway.stderr.on('data',chunk=>diagnostics+=chunk);
async function cad(id,operation,parameters={},inputs={}) {
  const before=states.get(id),response=await fetch(api+'/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:id,operation,parameters,inputs,baseRevision:before?.revision??0,...(before?.stateToken?{baseStateToken:before.stateToken}:{})})});
  const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));states.set(id,result);return result;
}
async function open(id) {
  if(!page){page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await routeGeometryApi(page,api);}
  await page.goto(process.env.WORKBENCH_URL||'http://localhost:3000/',{waitUntil:'networkidle'});
  await page.evaluate(id=>{sessionStorage.setItem('occt.activeDocumentId',id);localStorage.setItem('occt.activeDocumentId',id);},id);
  await page.reload({waitUntil:'networkidle'});await page.waitForFunction(id=>document.querySelector('main.cad-shell')?.dataset.documentId===id,id);
  await page.getByTestId('feature-tree').locator('[data-body-id]').first().waitFor();
}
async function inspectCanvas(kind,index) {
  const canvas=page.getByTestId('feature-input-canvas');await canvas.scrollIntoViewIfNeeded();
  const point=await canvas.evaluate((node,{kind,index})=>{node.dispatchEvent(new Event('cad:verify-feature-input'));return JSON.parse(node.dataset[kind==='face'?'faceScreenPoints':'edgeScreenPoints']).find(item=>item.index===index);},{kind,index});
  assert.ok(point,`No projected ${kind} ${index}`);const bounds=await canvas.boundingBox();
  await page.mouse.click(bounds.x+point.x,bounds.y+point.y);
  await page.waitForFunction(index=>Number(document.querySelector('[data-testid="feature-input-canvas"]').dataset.selectedIndex)===index,index);
  const pixels=await canvas.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-feature-input'));return Number(node.dataset.highlightPixels);});assert.ok(pixels>4,'Actual selected topology must produce visible highlight pixels');
}
async function editFeature(type,id) {
  const tree=page.getByTestId('feature-tree'),label=tree.locator(`button.feature-tree-label[title^="${type} · ${id} ·"]`).first();
  for(let depth=0;depth<12&&!await label.count();depth++){
    const collapsed=tree.locator('.boolean-input-body[aria-expanded="false"] > .boolean-input-header');
    if(!await collapsed.count())break;await collapsed.first().click();
  }
  await label.dblclick();return page.getByTestId('feature-history-controls');
}
async function check(name,run){await run();passed.push(name);process.stdout.write('PASS '+name+'\n');}
async function holeFixture(id,mode){
  if(mode==='variable')await cad(id,'variable.set',{name:'holeX',type:'length',expression:'25 mm'});
  if(mode==='coordinate')await cad(id,'coordinate.set',{id:'hole_frame',name:'Hole Frame',origin:[25,25,-5],xAxis:[1,0,0],yAxis:[0,1,0]});
  const box=await cad(id,'primitive.box',{width:100,depth:100,height:20}),tool=await cad(id,'primitive.cylinder',mode==='coordinate'?{radius:5,height:30,coordinateSystemId:'hole_frame'}:{radius:5,height:30,x:mode==='variable'?'holeX':25,y:25,z:-5});
  const cut=await cad(id,'boolean.cut',{}, {targetBody:box.bodyId,toolBody:tool.bodyId});let rim;
  for(const edge of cut.edges){const m=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'edge',selectionId:edge.edgeId});if(m.curveType==='circle'&&Math.abs(m.centroid[2]-20)<1e-7){rim=edge.edgeId;break;}}
  const detail=await cad(id,'detail.fillet',{radius:1},{bodyId:box.bodyId,edgeId:rim});return {bodyId:box.bodyId,cut:cut.features.at(-1).id,feature:detail.features.at(-1).id};
}
async function selectOuterInput(id,feature,proposal){
  const read=await cad(id,'feature.input.preview',{proposal},{featureId:feature}),edge=read.inputPreview.presentation.edges.find(edge=>edge.points.every((value,index)=>index%3===2||Math.abs(value)<1e-7));
  assert.ok(edge);await inspectCanvas('edge',Number(edge.edgeId.split('-').at(-1)));
}
async function undoUsingRibbon(){await page.getByRole('button',{name:'关闭操作窗口',exact:true}).click();await page.getByRole('tab',{name:'工程',exact:true}).click();const done=page.waitForResponse(response=>response.url().endsWith('/commands')&&response.request().postDataJSON()?.operation==='document.undo');await page.locator('[data-command="edit.undo"]').click();assert.equal((await(await done).json()).ok,true);}
(async()=>{
  try {
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Isolated gateway timeout: '+diagnostics)),20000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
    browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    await check('a failed upstream edit opens the exact pre-Fillet input; cancel preserves model, draft and main camera',async()=>{
      const id='edge_ui',box=await cad(id,'primitive.box',{width:100,depth:100,height:20}),tool=await cad(id,'primitive.cylinder',{radius:5,height:30,x:25,y:25,z:-5});
      const toolFeature=tool.features.at(-1).id,cut=await cad(id,'boolean.cut',{}, {targetBody:box.bodyId,toolBody:tool.bodyId});
      let rim;for(const edge of cut.edges){const m=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'edge',selectionId:edge.edgeId});if(m.curveType==='circle'&&Math.abs(m.centroid[2]-20)<1e-7){rim=edge.edgeId;break;}}
      const final=await cad(id,'detail.fillet',{radius:1},{bodyId:box.bodyId,edgeId:rim});await open(id);
      const editor=await editFeature('primitive.cylinder',toolFeature);await editor.getByLabel('特征参数 x',{exact:true}).fill('200');
      const before=await cad(id,'document.view'),camera=await page.getByTestId('cad-viewport').evaluate(node=>{node.dispatchEvent(new Event('cad:verify-frame'));return node.dataset.cameraPose;});
      await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();const repair=page.getByTestId('feature-reference-repair');await repair.getByText('特征执行前输入 · 临时视图',{exact:true}).waitFor();
      const canvas=page.getByTestId('feature-input-canvas');await canvas.waitFor();
      const inputRequest=await cad(id,'feature.input.preview',{changes:{x:200}},{featureId:final.features.at(-1).id,editedFeatureId:toolFeature});
      const edge=inputRequest.inputPreview.presentation.edges.find(edge=>edge.points.every((value,i)=>i%3===2||Math.abs(value)<1e-7));assert.ok(edge);
      const index=Number(edge.edgeId.split('-').at(-1));await inspectCanvas('edge',index);
      await page.screenshot({path:path.join(screenshots,'edge-historical-input.png'),fullPage:true});
      await repair.getByRole('button',{name:'取消修复，保留参数草稿',exact:true}).click();
      assert.equal(await editor.getByLabel('特征参数 x',{exact:true}).inputValue(),'200');assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
      const cameraAfter=JSON.parse(await page.getByTestId('cad-viewport').evaluate(node=>{node.dispatchEvent(new Event('cad:verify-frame'));return node.dataset.cameraPose;}));
      JSON.parse(camera).forEach((value,index)=>assert.ok(Math.abs(value-cameraAfter[index])<1e-8,'Historical preview must preserve the main camera'));
      await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();await repair.getByTestId('feature-input-canvas').waitFor();await inspectCanvas('edge',index);
      await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).click();await repair.getByText('重算预览通过 · 尚未提交',{exact:true}).waitFor();
      assert.equal((await cad(id,'document.view')).stateToken,before.stateToken,'Validated preview must not commit');
      await page.screenshot({path:path.join(screenshots,'edge-verified-result.png'),fullPage:true});
      await repair.getByRole('button',{name:'提交参数与引用修复',exact:true}).click();await editor.getByText(/参数与引用已一起提交/).waitFor();
      const after=await cad(id,'document.view');assert.equal(after.revision,before.revision+1);
      const measure=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId});assert.ok(Math.abs(measure.volume-(200000-(1-Math.PI/4)*20))<1e-5);
      await editor.getByRole('button',{name:'← 撤销',exact:true}).click();await editor.getByText(/撤销完成/).waitFor();assert.deepEqual((await cad(id,'document.view')).features,before.features);
    });
    await check('Shell face reselection uses the six-face input and stale verification cannot overwrite another project edit',async()=>{
      const id='face_ui',box=await cad(id,'primitive.box',{width:30,depth:30,height:30});let top;
      for(const face of new Set(box.triangleFaceIds)){const m=await cad(id,'geometry.measure',{}, {bodyId:box.bodyId,selectionType:'face',selectionId:face});if(Math.abs(m.centroid[2]-30)<1e-7){top=face;break;}}
      const final=await cad(id,'detail.shell',{thickness:2,inward:true},{bodyId:box.bodyId,faceId:top}),feature=final.features.at(-1).id;
      await open(id);const editor=await editFeature('detail.shell',feature);await editor.getByRole('button',{name:'查看 / 更换输入引用',exact:true}).click();
      const repair=page.getByTestId('feature-reference-repair');await repair.getByTestId('feature-input-canvas').waitFor();
      await repair.getByTestId('feature-input-canvas').evaluate(node=>node.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
      await repair.getByText('临时视图已中断，请重新读取历史输入；未修改工程。',{exact:true}).waitFor();
      assert.equal(await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).isDisabled(),true);
      await repair.getByRole('button',{name:'重新读取输入',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="feature-input-canvas"]')?.dataset.contextState==='ready');
      const input=await cad(id,'feature.input.preview',{}, {featureId:feature});assert.equal(input.inputPreview.presentation.stats.faceCount,6);
      const p=input.inputPreview.presentation;let front;
      for(let triangle=0;triangle<p.triangleFaceIds.length;triangle++)if(p.indices.slice(triangle*3,triangle*3+3).every(vertex=>Math.abs(p.positions[vertex*3+1])<1e-7)){front=Number(p.triangleFaceIds[triangle].split('-').at(-1));break;}
      await inspectCanvas('face',front);await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).click();await repair.getByText('重算预览通过 · 尚未提交',{exact:true}).waitFor();
      await repair.getByRole('button',{name:'提交参数与引用修复',exact:true}).click();await editor.getByText(/参数与引用已一起提交/).waitFor();
      const changed=await cad(id,'document.view');assert.notEqual(changed.features.at(-1).stringParameters['selection.faceId'],final.features.at(-1).stringParameters['selection.faceId']);
      await editor.getByRole('button',{name:'查看 / 更换输入引用',exact:true}).click();await repair.getByTestId('feature-input-canvas').waitFor();
      await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).click();await repair.getByText('重算预览通过 · 尚未提交',{exact:true}).waitFor();
      const external=await cad(id,'property.type.create',{key:'Concurrent',name:'并发修改',targetScope:'project',association:'none',fields:[{key:'enabled',type:'bool'}]});assert.equal(external.revision,changed.revision,'A same-revision project-data change must invalidate the verified repair too');
      await repair.getByRole('button',{name:'提交参数与引用修复',exact:true}).click();await page.getByText('工程已变化，草稿保留，执行已阻止。',{exact:false}).first().waitFor();
      assert.equal((await cad(id,'document.view')).stateToken,external.stateToken);
      await page.screenshot({path:path.join(screenshots,'stale-reference-repair.png'),fullPage:true});
    });
    await check('multiple downstream reference repairs remain uncommitted until the whole proposed edit passes',async()=>{
      const id='multiple_ui',a=await cad(id,'primitive.box',{width:100,depth:100,height:20}),b=await cad(id,'primitive.box',{width:100,depth:100,height:20}),tool=await cad(id,'primitive.cylinder',{radius:5,height:30,x:25,y:25,z:-5}),edited=tool.features.at(-1).id,details=[];
      for(const target of [a.bodyId,b.bodyId]){
        const cut=await cad(id,'boolean.cut',{keepTool:true},{targetBody:target,toolBody:tool.bodyId});let rim;
        for(const edge of cut.edges){const m=await cad(id,'geometry.measure',{}, {bodyId:target,selectionType:'edge',selectionId:edge.edgeId});if(m.curveType==='circle'&&Math.abs(m.centroid[2]-20)<1e-7){rim=edge.edgeId;break;}}
        const fillet=await cad(id,'detail.fillet',{radius:1},{bodyId:target,edgeId:rim});details.push(fillet.features.at(-1).id);
      }
      const before=await cad(id,'document.view');await open(id);const editor=await editFeature('primitive.cylinder',edited);await editor.getByLabel('特征参数 x',{exact:true}).fill('200');await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();
      const repair=page.getByTestId('feature-reference-repair'),changes={x:200,selectionEdits:[]};
      for(const feature of details){
        await repair.locator('.feature-input-heading > span').getByText(feature,{exact:true}).waitFor();await repair.getByTestId('feature-input-canvas').waitFor();
        const read=await cad(id,'feature.input.preview',{changes},{featureId:feature,editedFeatureId:edited}),p=read.inputPreview;
        const edge=p.presentation.edges.find(edge=>edge.points.every((value,i)=>i%3===2||Math.abs(value)<1e-7)),index=Number(edge.edgeId.split('-').at(-1));
        await inspectCanvas('edge',index);changes.selectionEdits.push({documentId:id,featureId:feature,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:p.kind,inputFingerprint:p.inputFingerprint,index});
        await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).click();
      }
      await repair.getByText('重算预览通过 · 尚未提交',{exact:true}).waitFor();assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
      await repair.getByRole('button',{name:'提交参数与引用修复',exact:true}).click();await editor.getByText(/参数与引用已一起提交/).waitFor();
      const result=await cad(id,'document.view');assert.equal(result.revision,before.revision+1);for(const feature of details)assert.notEqual(result.features.find(f=>f.id===feature).stringParameters['selection.edgeId'],before.features.find(f=>f.id===feature).stringParameters['selection.edgeId']);
    });
    await check('Torus feature editing exposes both major and minor radii instead of filtering them as matrices',async()=>{
      const id='torus_ui',torus=await cad(id,'primitive.torus',{majorRadius:30,minorRadius:5});await open(id);
      const editor=await editFeature('primitive.torus',torus.features.at(-1).id);
      assert.equal(await editor.getByLabel('特征参数 majorRadius',{exact:true}).inputValue(),'30');
      await editor.getByLabel('特征参数 minorRadius',{exact:true}).fill('7');await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();
      await editor.getByText(/已重算/).waitFor();const measured=await cad(id,'geometry.measure',{}, {bodyId:torus.bodyId});assert.ok(Math.abs(measured.volume-2*Math.PI*Math.PI*30*49)<1e-5);
    });
    for(const mode of ['variable','coordinate'])await check(mode+' editor retains drafts and repairs the proposed historical input in one undoable edit',async()=>{
      const id=mode+'_editor_ui',f=await holeFixture(id,mode),before=await cad(id,'document.view');await open(id);
      const project=page.getByTestId('project-tree'),name=mode==='variable'?'holeX':'Hole Frame';await project.locator('button.managed-record').filter({has:page.locator('strong',{hasText:new RegExp('^'+name+'$')})}).dblclick();
      const editor=page.getByTestId(mode==='variable'?'project-data-variables':'project-data-coordinates'),field=mode==='variable'?editor.getByRole('textbox').nth(1):editor.getByLabel('原点 O',{exact:true});
      const value=mode==='variable'?'200 mm':'200, 25, -5';await field.fill(value);const save=editor.getByRole('button',{name:mode==='variable'?'保存变量':'保存坐标系',exact:true});await save.click();
      const repair=page.getByTestId('feature-reference-repair');await repair.getByTestId('feature-input-canvas').waitFor();assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
      await repair.getByRole('button',{name:'取消修复，保留参数草稿',exact:true}).click();assert.equal(await field.inputValue(),value);await save.click();await repair.getByTestId('feature-input-canvas').waitFor();
      const operation=mode==='variable'?'variable.set':'coordinate.set',parameters=mode==='variable'?{name:'holeX',type:'length',expression:'200 mm'}:{id:'hole_frame',name:'Hole Frame',kind:'cartesian',origin:[200,25,-5],xAxis:[1,0,0],yAxis:[0,1,0]};
      const changes=repair.locator('.feature-input-changes');assert.equal(await changes.getAttribute('open'),null);await changes.locator('summary').click();assert.ok((await changes.innerText()).includes(value));await changes.locator('summary').click();
      await selectOuterInput(id,f.feature,{operation,parameters});await page.screenshot({path:path.join(screenshots,mode+'-repair.png'),fullPage:true});
      await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).click();await repair.getByText('重算预览通过 · 尚未提交',{exact:true}).waitFor();assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
      await repair.getByRole('button',{name:'提交参数与引用修复',exact:true}).click();await editor.getByText('工程数据与引用修复已一起保存，可一次撤销。',{exact:true}).waitFor();
      const after=await cad(id,'document.view');assert.equal(after.revision,before.revision+1);if(mode==='variable')assert.equal(after.variables.find(v=>v.name==='holeX').value,200);else assert.deepEqual(after.coordinateSystems.find(c=>c.id==='hole_frame').origin,[200,25,-5]);
      await undoUsingRibbon();const undone=await cad(id,'document.view');for(const key of ['features','variables','coordinateSystems'])assert.deepEqual(undone[key],before[key]);
    });
    for(const entry of ['history','tree'])for(const action of ['suppress','restore','delete'])await check(entry+' '+action+' uses the same proposed-input repair without partial lifecycle changes',async()=>{
      const id=entry+'_'+action+'_ui',f=await holeFixture(id);if(action==='restore'){await cad(id,'feature.suppress',{}, {featureId:f.feature});await cad(id,'feature.suppress',{}, {featureId:f.cut});}
      const featureId=action==='restore'?f.feature:f.cut,type=action==='restore'?'detail.fillet':'boolean.cut',before=await cad(id,'document.view');await open(id);
      if(entry==='history'){
        const editor=await editFeature(type,featureId);await editor.getByRole('button',{name:action==='suppress'?'抑制 Feature':action==='restore'?'恢复 Feature':'删除 Feature',exact:true}).click();
      }else{
        const label=page.getByTestId('feature-tree').locator(`button.feature-tree-label[title^="${type} · ${featureId} ·"]`).first();await label.click({button:'right'});await page.getByRole('menuitem',{name:action==='suppress'?'抑制特征':action==='restore'?'恢复特征':'删除特征',exact:true}).click();
      }
      if(action==='delete')await page.getByRole('dialog',{name:/^删除特征/}).getByRole('button',{name:'确认删除',exact:true}).click();
      const repair=page.getByTestId('feature-reference-repair');await repair.getByTestId('feature-input-canvas').waitFor();assert.equal((await cad(id,'document.view')).stateToken,before.stateToken);
      await selectOuterInput(id,f.feature,{operation:'feature.'+action,inputs:{featureId},parameters:{}});await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).click();await repair.getByText('重算预览通过 · 尚未提交',{exact:true}).waitFor();
      await repair.getByRole('button',{name:'提交参数与引用修复',exact:true}).click();await page.getByTestId('feature-history-controls').getByText(/参数与引用已一起提交/).waitFor();
      const after=await cad(id,'document.view');assert.equal(after.revision,before.revision+1);assert.equal(after.features.find(f=>f.id===featureId)?.state,action==='delete'?undefined:action==='suppress'?'suppressed':'valid');await undoUsingRibbon();
      const undone=await cad(id,'document.view');assert.deepEqual(undone.features,before.features);
    });
    await check('reloading a conflicted tree repair discards its pending action instead of reopening an old proposal',async()=>{
      const id='tree_repair_reload',f=await holeFixture(id),before=await cad(id,'document.view');await open(id);
      await page.getByTestId('feature-tree').locator(`button.feature-tree-label[title^="boolean.cut · ${f.cut} ·"]`).first().click({button:'right'});await page.getByRole('menuitem',{name:'抑制特征',exact:true}).click();
      const repair=page.getByTestId('feature-reference-repair');await repair.getByTestId('feature-input-canvas').waitFor();await selectOuterInput(id,f.feature,{operation:'feature.suppress',inputs:{featureId:f.cut},parameters:{}});
      await repair.getByRole('button',{name:'使用此引用并验证重算',exact:true}).click();await repair.getByText('重算预览通过 · 尚未提交',{exact:true}).waitFor();
      const external=await cad(id,'property.type.create',{key:'ConcurrentTree',name:'并发树修改',targetScope:'project',association:'none',fields:[{key:'enabled',type:'bool'}]});assert.equal(external.revision,before.revision);
      await repair.getByRole('button',{name:'提交参数与引用修复',exact:true}).click();await page.getByText('工程已变化，草稿保留，执行已阻止。',{exact:false}).first().waitFor();await page.getByRole('button',{name:'重新载入（放弃草稿）',exact:true}).click();
      await page.getByTestId('feature-history-controls').getByRole('button',{name:'修改参数并重算',exact:true}).waitFor();assert.equal(await repair.count(),0);
      const after=await cad(id,'document.view');assert.equal(after.stateToken,external.stateToken);assert.deepEqual(after.features,before.features);
    });
    assert.deepEqual(errors,[]);process.stdout.write(JSON.stringify({passed:passed.length,browserErrors:errors,screenshots},null,2)+'\n');
  }catch(error){if(page){await page.screenshot({path:path.join(screenshots,'failure.png'),fullPage:true});process.stderr.write((await page.locator('body').innerText()).slice(0,12000)+'\n');}throw error;}
  finally{await browser?.close();const ended=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await ended;const resolved=path.resolve(data);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
