/* Called only by the isolated, frozen same-origin STEP browser harness. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openLegacyStepProject} from '../tests/helpers/legacy-step-project.mjs';
import {selectGeometry} from '../tests/helpers/generated-topology-fixtures.mjs';

export async function verifyNamingUpgradeInteractions({page,check,cad,data,artifacts,documentId,onBoundary}){
  const commands=[],listener=request=>{if(request.url().endsWith('/api/commands')&&request.method()==='POST')commands.push(request.postDataJSON());};page.on('request',listener);
  const panel=page.getByTestId('naming-upgrade-panel'),window=page.getByTestId('operation-window');
  const count=operation=>commands.filter(item=>item.operation===operation).length;
  const open=async()=>{await page.getByRole('tab',{name:'工程',exact:true}).click();await page.locator('[data-command="project.sources"]').click();await window.getByRole('button',{name:'引用升级',exact:true}).click();await panel.getByText('后台支持精确历史验证',{exact:true}).waitFor();};
  const close=()=>window.getByRole('button',{name:'关闭操作窗口',exact:true}).click();
  async function clickReply(name,operation){const reply=page.waitForResponse(response=>response.url().endsWith('/api/commands')&&response.request().postDataJSON()?.operation===operation);await panel.getByRole('button',{name,exact:true}).click();return (await reply).json();}
  async function validate(){assert.equal((await clickReply(count('document.naming.preview')?'重新验证':'验证升级','document.naming.preview')).ok,true);await panel.getByText('验证通过，可以升级',{exact:true}).waitFor();}
  async function synchronize(){await clickReply('核对工程','document.view');}
  function sameState(actual,before){for(const key of ['revision','stateToken','stateSequence','features','bodyMetadata','entityIdentities','history'])assert.deepEqual(actual[key],before[key],key);}
  try{
    await check('maintenance is reachable in existing source navigation and opening it sends no upgrade or verification command',async()=>{
      const before=await cad(documentId,'document.summary');await open();assert.equal(count('document.naming.preview'),0);assert.equal(count('document.naming.upgrade'),0);assert.equal(await panel.getByRole('button',{name:'升级引用',exact:true}).isDisabled(),true);sameState(await cad(documentId,'document.summary'),before);
    });
    await check('read-only verification enables one explicit upgrade action and remains legible at desktop, 900px and 640px',async()=>{
      const before=await cad(documentId,'document.summary');await validate();sameState(await cad(documentId,'document.summary'),before);assert.equal(await panel.getByRole('button',{name:'升级引用',exact:true}).isEnabled(),true);
      for(const width of [1440,900,640]){
        await page.setViewportSize({width,height:960});await panel.getByRole('button',{name:'升级引用',exact:true}).scrollIntoViewIfNeeded();
        const bounds=await window.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1);
        const controls=await panel.locator('button').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>({height:node.getBoundingClientRect().height,right:node.getBoundingClientRect().right,left:node.getBoundingClientRect().left})));assert.ok(controls.every(control=>control.height>=40&&control.left>=0&&control.right<=width+1));
        await page.screenshot({path:path.join(artifacts,`naming-preview-${width}.png`),fullPage:true});
      }
      await page.setViewportSize({width:1440,height:960});
    });
    await check('a same-revision engineering-property edit invalidates the old report without an automatic retry',async()=>{
      const before=await cad(documentId,'document.summary'),previews=count('document.naming.preview');await cad(documentId,'property.type.create',{key:'MaintenanceStateOnly',targetScope:'project',association:'none',fields:[{key:'note',type:'bool'}]});
      const after=await cad(documentId,'document.summary');assert.equal(after.revision,before.revision);assert.notEqual(after.stateToken,before.stateToken);await synchronize();await panel.getByText('验证已过期',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'升级引用',exact:true}).isDisabled(),true);assert.equal(count('document.naming.preview'),previews);assert.equal(count('document.naming.upgrade'),0);
      await validate();
    });
    await check('native source mismatch is explained in the panel, preserves the project and does not offer a confirmation bypass',async()=>{
      const before=await cad(documentId,'document.summary'),source=before.features.find(item=>item.type==='import.step').stringParameters.sourcePath;
      assert.ok(path.resolve(source).startsWith(path.resolve(data)+path.sep));const bytes=fs.readFileSync(source);
      try{fs.appendFileSync(source,'\n');const failed=await clickReply('升级引用','document.naming.upgrade');assert.equal(failed.ok,false);assert.equal(failed.code,'STEP_REPLAY_SOURCE_CHANGED');await panel.getByText('STEP 来源需要核对',{exact:true}).first().waitFor();assert.equal(await panel.getByRole('button',{name:'升级引用',exact:true}).isDisabled(),true);assert.equal(await panel.getByRole('button',{name:'确认执行',exact:true}).count(),0);await page.screenshot({path:path.join(artifacts,'naming-source-rejected.png'),fullPage:true});}
      finally{fs.writeFileSync(source,bytes);}
      sameState(await cad(documentId,'document.summary'),before);await validate();
    });
    await check('a lost committed reply remains unknown after a read and recovers the same idempotent receipt without a second revision',async()=>{
      const before=await cad(documentId,'document.summary');let drop=true;
      const handler=async route=>{const input=route.request().postDataJSON();if(input.operation==='document.naming.upgrade'&&drop){drop=false;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');}else await route.continue();};
      await page.route('**/api/commands',handler);
      try{await panel.getByRole('button',{name:'升级引用',exact:true}).click();await panel.getByText('执行结果尚未确认',{exact:true}).waitFor();}
      finally{await page.unroute('**/api/commands',handler);}
      const committed=await cad(documentId,'document.summary');assert.equal(committed.revision,before.revision+1);assert.equal(committed.features[0].numberParameters.importNamingVersion,1);
      await synchronize();await panel.getByText('执行结果尚未确认',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'升级引用',exact:true}).isDisabled(),true);
      assert.equal((await clickReply('按原请求恢复','document.naming.upgrade')).ok,true);await panel.getByText('引用升级已完成',{exact:true}).waitFor();
      sameState(await cad(documentId,'document.summary'),committed);const writes=commands.filter(item=>item.operation==='document.naming.upgrade');assert.ok(writes.at(-1).options.idempotencyKey);assert.equal(writes.at(-1).options.idempotencyKey,writes.at(-2).options.idempotencyKey);assert.equal(writes.at(-1).baseStateToken,writes.at(-2).baseStateToken);
      await onBoundary(2);await page.screenshot({path:path.join(artifacts,'naming-recovered-receipt.png'),fullPage:true});
    });
    await check('the maintenance Undo restores the complete legacy state once and does not silently redo it',async()=>{
      const before=await cad(documentId,'document.summary');assert.equal((await clickReply('撤销本次升级','document.undo')).ok,true);await panel.getByText('升级已撤销',{exact:true}).waitFor();
      const after=await cad(documentId,'document.summary');assert.equal(after.revision,before.revision-1);assert.equal(after.features[0].numberParameters.importNamingVersion,undefined);await onBoundary(2);assert.equal(await panel.getByRole('button',{name:'撤销本次升级',exact:true}).count(),0);
      await panel.getByRole('button',{name:'验证升级',exact:true}).click();await panel.getByText('验证通过，可以升级',{exact:true}).waitFor();
    });
    await check('closing an in-flight operation does not cancel or resend the committed mutation; reopening reads the current version',async()=>{
      const before=await cad(documentId,'document.summary'),writes=count('document.naming.upgrade');let release,acknowledge;
      const gate=new Promise(resolve=>release=resolve),ack=new Promise(resolve=>acknowledge=resolve);
      const handler=async route=>{if(route.request().postDataJSON().operation!=='document.naming.upgrade')return route.continue();const response=await route.fetch();acknowledge(response.status());await gate;await route.fulfill({response});};
      await page.route('**/api/commands',handler);
      try{
        await panel.getByRole('button',{name:'升级引用',exact:true}).click();let timer;try{assert.equal(await Promise.race([ack,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Private upgrade commit receipt did not arrive')),20000))]),200);}finally{clearTimeout(timer);}
        await close();release();await open();await panel.getByText('当前导入无需升级',{exact:true}).waitFor();assert.equal(count('document.naming.upgrade'),writes+1);assert.equal((await cad(documentId,'document.summary')).revision,before.revision+1);assert.equal(await panel.getByRole('button',{name:'升级引用',exact:true}).isDisabled(),true);
      }finally{release();await page.unroute('**/api/commands',handler);}
      await close();
    });
    await check('an older native capability declaration cannot enable maintenance even while the CAD service is healthy',async()=>{
      const handler=async route=>{const response=await route.fetch(),value=await response.json();delete value.capabilities.nativeGeometry.features['immutable-step-topology-v1'].upgrade;await route.fulfill({response,json:value});};
      await page.route('**/api/health',handler);
      try{await page.getByRole('tab',{name:'工程',exact:true}).click();await page.locator('[data-command="project.sources"]').click();await window.getByRole('button',{name:'引用升级',exact:true}).click();await panel.getByText('当前后台未声明支持此升级',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'升级引用',exact:true}).isDisabled(),true);}
      finally{await page.unroute('**/api/health',handler);await close();}
    });
  }finally{page.off('request',listener);}
}

/** Real archived proofs: never fabricated health responses or guessed topology IDs. */
export async function verifyArchivedNamingUpgradeInteractions({page,check,cad,api,artifacts,returnDocumentId}){
  const id='upgrade_archive_ui',bad='upgrade_archive_bad_ui',near=(a,b)=>Math.abs(a-b)<1e-5;
  const panel=page.getByTestId('naming-upgrade-panel'),window=page.getByTestId('operation-window');
  const load=async documentId=>{await page.evaluate(value=>sessionStorage.setItem('occt.activeDocumentId',value),documentId);await page.reload({waitUntil:'networkidle'});await page.waitForFunction(value=>document.querySelector('main.cad-shell')?.dataset.documentId===value,documentId);};
  const open=async()=>{await page.getByRole('tab',{name:'工程',exact:true}).click();await page.locator('[data-command="project.sources"]').click();await window.getByRole('button',{name:'引用升级',exact:true}).click();await panel.getByText('后台支持精确历史验证',{exact:true}).waitFor();};
  const close=()=>window.getByRole('button',{name:'关闭操作窗口',exact:true}).click();
  const ui=async(operation,action)=>{const reply=page.waitForResponse(response=>response.url().endsWith('/commands')&&response.request().postDataJSON()?.operation===operation&&!response.request().postDataJSON()?.options?.preview);await action();return (await reply).json();};
  const typed=async(documentId,instanceId)=>(await cad(documentId,'property.instance.list')).instances.find(item=>item.instanceId===instanceId);
  let featureId,bodyId,badFeatureId,instances=[],before,rawBefore,typedBefore;
  try{
    await check('archived native outputs are previewed with separate counts without restoring geometry, properties or dormant coordinates',async()=>{
      const legacy=await openLegacyStepProject(api,'upgrade_modern',id),pattern=await cad(id,'pattern.linear',{count:2,spacing:20,directionX:1,directionY:0,directionZ:0},{bodyId:legacy.activeBodyId});featureId=pattern.features.at(-1).id;bodyId=pattern.features.at(-1).outputBodies.at(-1);
      const view=await cad(id,'body.presentation',{}, {bodyId}),face=await selectGeometry(cad,id,view,'face',m=>near(m.centroid[2],20)),edge=await selectGeometry(cad,id,view,'edge',m=>near(m.centroid[0],20)&&near(m.centroid[1],0)&&near(m.length,20));
      for(const [kind,topologyId] of [['face',face],['edge',edge]]){
        const type=await cad(id,'property.type.create',{key:'ArchivedBoundary'+kind,targetScope:kind,association:'required',fields:[{key:'marker',type:'int'}]}),created=await cad(id,'property.instance.create',{typeId:type.type.typeId,name:'Archived '+kind+' boundary',value:{marker:81},target:{kind,bodyId,topologyId}});instances.push(created.instance.instanceId);
        await cad(id,'property.set',{key:'archiveMarker',type:'int',value:81},{kind,bodyId,topologyId});
      }
      await cad(id,'coordinate.set',{id:'archived_frame',name:'Archived Face frame',kind:'face',referenceBodyId:bodyId,referenceTopologyId:face});await cad(id,'feature.suppress',{}, {featureId});
      before=await cad(id,'document.summary');rawBefore=(await cad(id,'property.list')).propertyRecords;typedBefore=await Promise.all(instances.map(instance=>typed(id,instance)));
      assert.ok(typedBefore.every(item=>item.state!=='active'));assert.equal(before.coordinateSystems.find(item=>item.id==='archived_frame').referenceState,'unresolved');
      await load(id);await open();const preview=await ui('document.naming.preview',()=>panel.getByRole('button',{name:'验证升级',exact:true}).click());assert.equal(preview.ok,true);assert.equal(preview.importedNamingUpgrade.archivedSourceCount,1);assert.ok(preview.importedNamingUpgrade.archivedProofCount>0);
      await panel.getByText('验证通过，可以升级',{exact:true}).waitFor();
      for(const [label,key] of [['归档来源','archivedSourceCount'],['归档输出证据','archivedProofCount'],['归档引用检查','archivedReferenceCount']])assert.equal(await panel.locator('.naming-upgrade-report dl > div').filter({has:page.locator('dt',{hasText:label})}).locator('dd').innerText(),String(preview.importedNamingUpgrade[key]));
      const unchanged=await cad(id,'document.summary');for(const key of ['revision','stateToken','features','bodyMetadata','coordinateSystems','entityIdentities'])assert.deepEqual(unchanged[key],before[key],key);
      await panel.getByText('归档证据已逐项验证并保留原记录；不会提前恢复几何或激活孤立属性。',{exact:true}).waitFor();
      for(const width of [1440,640]){await page.setViewportSize({width,height:960});await panel.getByRole('button',{name:'升级引用',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,`archive-preview-${width}.png`),fullPage:true});}
      await page.setViewportSize({width:1440,height:960});
    });
    await check('workbench archived upgrade keeps orphaned associations dormant and preserves every original identity and frame',async()=>{
      const result=await ui('document.naming.upgrade',()=>panel.getByRole('button',{name:'升级引用',exact:true}).click());assert.equal(result.ok,true);await panel.getByText('引用升级已完成',{exact:true}).waitFor();
      const after=await cad(id,'document.summary');assert.equal(after.revision,before.revision+1);assert.equal(after.features.find(item=>item.id===featureId).state,'suppressed');assert.equal(after.bodyMetadata.some(item=>item.bodyId===bodyId),false);assert.deepEqual(after.entityIdentities,before.entityIdentities);assert.deepEqual(after.coordinateSystems,before.coordinateSystems);assert.deepEqual((await cad(id,'property.list')).propertyRecords,rawBefore);assert.deepEqual(await Promise.all(instances.map(instance=>typed(id,instance))),typedBefore);await close();
    });
    await check('explicit UI restoration and Pattern editing recover the actual archived Face and Edge, coordinate and visible highlight',async()=>{
      await page.getByTestId('feature-tree').locator(`button.feature-tree-label[title^="pattern.linear · ${featureId} ·"]`).first().dblclick();const editor=page.getByTestId('feature-history-controls');
      assert.equal((await ui('feature.restore',()=>editor.getByRole('button',{name:'恢复 Feature',exact:true}).click())).ok,true);await editor.getByLabel('特征参数 spacing',{exact:true}).fill('30');assert.equal((await ui('feature.update',()=>editor.getByRole('button',{name:'修改参数并重算',exact:true}).click())).ok,true);await close();
      for(const [index,kind] of ['face','edge'].entries()){const record=await typed(id,instances[index]);assert.equal(record.state,'active');assert.deepEqual(record.value,{marker:81});const measured=await cad(id,'geometry.measure',{}, {bodyId:record.target.bodyId,selectionType:kind,selectionId:record.target.topologyId});assert.ok(near(measured.centroid[0],kind==='face'?45:30));assert.ok(near(kind==='face'?measured.area:measured.length,kind==='face'?1200:20));}
      const frame=(await cad(id,'document.summary')).coordinateSystems.find(item=>item.id==='archived_frame');assert.equal(frame.referenceState,'resolved');assert.ok(near(frame.origin[0],45));
      const row=page.getByTestId('project-tree').locator('button.managed-record').filter({has:page.locator('strong',{hasText:/^Archived face boundary$/})});await row.click();await page.getByTestId('selection-readout').getByText((await typed(id,instances[0])).target.topologyId,{exact:true}).waitFor();await page.locator('[title="顶视图"]').click();const pixels=await page.getByTestId('cad-viewport').evaluate(node=>{node.dispatchEvent(new Event('cad:verify-selection'));return Number(node.dataset.selectedFacePixels);});assert.ok(pixels>1000);await page.screenshot({path:path.join(artifacts,'archive-restored-inherited-face.png'),fullPage:true});
    });
    await check('an unprovable archived definition explains the rejection and links to its exact suppressed feature without modifying it',async()=>{
      const legacy=await openLegacyStepProject(api,'upgrade_modern',bad),pattern=await cad(bad,'pattern.linear',{count:2,spacing:20,directionX:1,directionY:0,directionZ:0},{bodyId:legacy.activeBodyId}),sourceId=pattern.features.at(-1).id;await cad(bad,'feature.suppress',{}, {featureId:sourceId});await cad(bad,'feature.update',{spacing:30},{featureId:sourceId});const unchanged=await cad(bad,'document.summary');
      badFeatureId=sourceId;
      await load(bad);await open();const failure=await ui('document.naming.preview',()=>panel.getByRole('button',{name:'验证升级',exact:true}).click());assert.equal(failure.ok,false);assert.equal(failure.code,'IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED');await panel.getByText('归档输出证据不一致',{exact:true}).first().waitFor();assert.equal(await panel.getByRole('button',{name:'升级引用',exact:true}).isDisabled(),true);await panel.locator('.naming-upgrade-failure summary').click();await page.screenshot({path:path.join(artifacts,'archive-unverified-actionable.png'),fullPage:true});await panel.getByRole('button',{name:'检查归档来源特征',exact:true}).click();assert.equal(await page.getByTestId('feature-history-controls').getByLabel('可编辑特征',{exact:true}).inputValue(),sourceId);assert.equal(await page.getByTestId('feature-history-controls').getByLabel('特征参数 spacing',{exact:true}).inputValue(),'30');
      const after=await cad(bad,'document.summary');for(const key of ['revision','stateToken','features','bodyMetadata','entityIdentities','history'])assert.deepEqual(after[key],unchanged[key],key);await close();
    });
    await check('a retained failure cannot offer an exact source link after that feature is explicitly removed and state is refreshed',async()=>{
      await open();const failure=await ui('document.naming.preview',()=>panel.getByRole('button',{name:'验证升级',exact:true}).click());assert.equal(failure.code,'IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED');await panel.getByRole('button',{name:'检查归档来源特征',exact:true}).waitFor();
      await cad(bad,'feature.delete',{}, {featureId:badFeatureId});assert.equal((await ui('document.view',()=>panel.getByRole('button',{name:'核对工程',exact:true}).click())).ok,true);
      assert.equal(await panel.getByRole('button',{name:'检查归档来源特征',exact:true}).count(),0);await panel.getByRole('button',{name:'查看特征历史',exact:true}).waitFor();await close();
    });
  }finally{await page.setViewportSize({width:1440,height:960});await load(returnDocumentId);}
}
