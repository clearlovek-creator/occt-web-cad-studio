/* Browser probes count actual WebGL draw calls, not only application counters.
 * Imported by the isolated standalone verifier before navigation. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function installViewportDrawProbe(page){
  await page.addInitScript(()=>{
    window.__cadDrawCalls=0;
    for(const type of [window.WebGLRenderingContext,window.WebGL2RenderingContext]){
      if(!type)continue;
      for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
        const original=type.prototype[name];if(typeof original!=='function')continue;
        type.prototype[name]=function(...args){window.__cadDrawCalls++;return Reflect.apply(original,this,args);};
      }
    }
  });
}

export async function assertHistoricalViewportIdle(page,canvas){
  assert.equal(await canvas.getAttribute('data-frame-mode'),'on-demand');
  await page.waitForFunction(()=>{const value=window.__cadDrawCalls;if(window.__cadHistoricalLast!==value){window.__cadHistoricalLast=value;window.__cadHistoricalAt=performance.now();return false;}return performance.now()-window.__cadHistoricalAt>=150;},{},{timeout:12000});
  const calls=await page.evaluate(async()=>{const before=window.__cadDrawCalls;await new Promise(resolve=>setTimeout(resolve,300));return window.__cadDrawCalls-before;});
  assert.equal(calls,0,'Historical selection and main scene must both settle without WebGL draws.');
}

export async function verifyViewportDemand({page,origin,artifacts,check,mode}){
  assert.ok(['baseline','candidate'].includes(mode));
  const viewport=page.getByTestId('cad-viewport'),measurements=[];
  const sample=async(label,duration=350)=>{
    const result=await page.evaluate(async duration=>{
      const start=performance.now(),before=window.__cadDrawCalls;
      await new Promise(resolve=>setTimeout(resolve,duration));
      return {drawCalls:window.__cadDrawCalls-before,elapsedMs:performance.now()-start};
    },duration);measurements.push({label,...result});return result;
  };
  const settle=async()=>{
    await page.waitForFunction(()=>{
      const value=window.__cadDrawCalls;
      if(window.__cadLastDraw!==value){window.__cadLastDraw=value;window.__cadLastDrawAt=performance.now();return false;}
      return performance.now()-window.__cadLastDrawAt>=180;
    },{},{timeout:12000});
  };
  const assertIdle=async label=>{await settle();const result=await sample(label);assert.equal(result.drawCalls,0,JSON.stringify(result));};
  if(mode==='baseline'){
    await check('unchanged baseline continuously submits WebGL work for an idle real OCCT Box',async()=>{
      const result=await sample('baseline-idle',700);assert.ok(result.drawCalls>0,JSON.stringify(result));
    });
  }else{
    await check('main viewport settles to zero actual WebGL draw calls for a static real model',async()=>{
      assert.equal(await viewport.getAttribute('data-frame-mode'),'on-demand');await assertIdle('candidate-idle');
    });
    await check('standard camera changes repaint immediately and settle again',async()=>{
      const before=await viewport.getAttribute('data-viewport-render-frames');
      await page.getByRole('button',{name:'顶视图',exact:true}).click();
      await page.waitForFunction(before=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.viewportRenderFrames)>Number(before),before);
      await assertIdle('after-standard-view');
    });
    await check('real middle-button orbit retains damping and stops after the camera settles',async()=>{
      await page.getByRole('button',{name:'轴测视图',exact:true}).click();await settle();
      await viewport.evaluate(node=>{window.__cadPointers=[];const canvas=node.querySelector('canvas');for(const name of ['pointerdown','pointermove','pointerup'])canvas.addEventListener(name,e=>window.__cadPointers.push({name,button:e.button,buttons:e.buttons}));});
      const rect=await viewport.locator('canvas').boundingBox(),before=await viewport.getAttribute('data-viewport-render-frames');
      await page.mouse.move(rect.x+rect.width*.55,rect.y+rect.height*.5);await page.mouse.down({button:'middle'});
      await page.mouse.move(rect.x+rect.width*.65,rect.y+rect.height*.57,{steps:8});await page.mouse.up({button:'middle'});
      console.log(JSON.stringify({orbitBefore:before,orbitAfter:await viewport.getAttribute('data-viewport-render-frames'),pointerEvents:await page.evaluate(()=>window.__cadPointers),hit:await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.outerHTML.slice(0,200),{x:rect.x+rect.width*.65,y:rect.y+rect.height*.57})}));
      await page.waitForFunction(before=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.viewportRenderFrames)>Number(before)+2,before);
      await assertIdle('after-orbit-damping');
    });
    const body=page.getByTestId('feature-tree').locator('[data-body-id]').filter({has:page.locator('.body-visibility-button')}).first();
    await check('body hiding and showing repaint the actual scene without a polling render loop',async()=>{
      await body.locator('.body-visibility-button').click();
      await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.visibleBodies)===0);
      await assertIdle('hidden-body');
      await body.locator('.body-visibility-button').click();
      await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.visibleBodies)===1);
      await assertIdle('shown-body');
    });
    await check('tree selection repaints visible selection and then returns to idle',async()=>{
      const before=await viewport.getAttribute('data-viewport-render-frames');
      await body.locator('.body-tree-label').click();
      await page.waitForFunction(before=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.viewportRenderFrames)>Number(before),before);
      await assertIdle('body-selection');
    });
    await check('dock resizing redraws once layout changes without resuming a permanent loop',async()=>{
      const separator=page.getByRole('separator',{name:'Resize project tree width'}),before=await viewport.getAttribute('data-viewport-render-frames');
      await separator.focus();await page.keyboard.press('ArrowRight');
      await page.waitForFunction(before=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.viewportRenderFrames)>Number(before),before);
      await assertIdle('dock-resize');
    });
    await check('an actual lost WebGL context stops work and restoration redraws the preserved model',async()=>{
      await viewport.evaluate(node=>{const gl=node.querySelector('canvas').getContext('webgl2'),extension=gl.getExtension('WEBGL_lose_context');if(!extension)throw Error('Context-loss extension unavailable.');window.__cadLostContextExtension=extension;extension.loseContext();});
      await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.contextState==='lost');
      assert.equal((await sample('actual-context-lost')).drawCalls,0);
      await page.evaluate(()=>window.__cadLostContextExtension.restoreContext());
      await page.waitForFunction(()=>{const v=document.querySelector('[data-testid="cad-viewport"]');return v.dataset.contextState==='ready'&&Number(v.dataset.visibleBodies)===1&&Number(v.dataset.renderedTriangles)>0;});
      await assertIdle('context-restored');
    });
    await page.screenshot({path:path.join(artifacts,'viewport-demand-restored.png'),fullPage:true});
  }
  const state=await fetch(origin+'/api/documents/default').then(r=>r.json());assert.equal(state.bodyCount,1);
  const result={ok:true,mode,measurements,bodyCount:state.bodyCount,revision:state.revision,paidProviderCalls:0,scope:'Actual local OCCT Box and browser WebGL calls under Chrome software rendering; no industrial assembly/GPU or power-consumption qualification.'};
  fs.writeFileSync(path.join(artifacts,'viewport-demand.json'),JSON.stringify(result,null,2),{flag:'wx'});return result;
}
