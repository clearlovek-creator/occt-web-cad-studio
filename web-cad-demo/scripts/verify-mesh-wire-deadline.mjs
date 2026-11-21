/* Real private CAD/Gmsh + browser-owned fault injection at the fetch/stream
 * boundary. No provider calls, daily project edits or service replacement. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {backendTestArguments} from '../tests/helpers/backend-test-runtime.mjs';
import {stopTestChild} from '../tests/helpers/stop-test-child.mjs';
import {routeGeometryApi} from './browser-api-route.cjs';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-wire-deadline-ui-')),artifacts=path.join(root,'.artifacts/wire-deadline-ui');fs.mkdirSync(artifacts,{recursive:true});
const socket=net.createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));const api=`http://127.0.0.1:${port}/api`;
let gateway,browser,page,verified=false;const checks=[],errors=[];
async function request(route,body){const response=await fetch(api+route,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)}),value=await response.json();assert.ok(response.ok&&value.ok,JSON.stringify(value));return value;}
async function cad(operation,parameters={},inputs={}){const state=await request('/commands',{operation:'document.summary',documentId:'default'});return request('/commands',{documentId:'default',operation,parameters,inputs,baseRevision:state.revision,baseStateToken:state.stateToken});}
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
async function stop(){if(!gateway)return;const child=gateway,control=path.join(data,'.gateway-control.json');if(child.exitCode===null&&fs.existsSync(control)){const token=JSON.parse(fs.readFileSync(control));assert.equal(token.ownerPid,child.pid);const ended=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Private Gateway exit unconfirmed; preserve '+data)),25000);child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('Private Gateway shutdown '+code));});});await fetch(api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':token.token},signal:AbortSignal.timeout(3000)}).catch(()=>{});await ended;}await stopTestChild(child);gateway=null;}
const fault=()=>page.evaluate(()=>({requests:window.__wireFault.requests.map(row=>({key:row.key,aborted:row.aborted,mode:row.mode})),cancelled:window.__wireFault.cancelled,released:window.__wireFault.released,read:window.__wireFault.read,lateReads:window.__wireFault.lateReads,fragmentProduced:window.__wireFault.fragmentProduced,fragmentTotal:window.__wireFault.fragmentTotal,emptyProduced:window.__wireFault.emptyProduced}));
const viewport=()=>page.getByTestId('cad-viewport');
const toggle=id=>page.getByTestId('feature-tree').locator(`[data-body-id="${id}"] .body-mesh-visibility-button`);
async function mode(value){await page.evaluate(value=>{window.__wireFault.mode=value;},value);}
async function started(count){await page.waitForFunction(count=>window.__wireFault.requests.length>=count,count);}
async function settled(){await page.waitForFunction(()=>{const data=document.querySelector('[data-testid="cad-viewport"]').dataset;return Number(data.meshWantedChunks)>0&&data.meshLoadedChunks===data.meshWantedChunks;});}
async function deliver(){await page.evaluate(async()=>{const action=window.__wireFault.deliver;if(!action)throw Error('No held fetch response');window.__wireFault.deliver=null;await action();});}
const timeoutText='网格显示数据块读取超时，已停止显示；不会自动重复请求。';
try{
  gateway=spawn(process.execPath,backendTestArguments(root),{cwd:root,env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let diagnostic='';const timer=setTimeout(()=>reject(Error('Wire deadline Gateway startup '+diagnostic)),120000);gateway.once('error',reject);gateway.stderr.on('data',bytes=>diagnostic=(diagnostic+bytes).slice(-8192));gateway.stdout.on('data',bytes=>{if(String(bytes).includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
  const first=await cad('primitive.box',{width:10,depth:8,height:6}),second=await cad('primitive.box',{width:6,depth:6,height:6,x:20}),before=await cad('document.summary'),mesh=await request('/documents/default/mesh/jobs',{qualityThreshold:0});assert.equal(mesh.mesh.admission.status,'accepted');
  for(const id of [first.bodyId,second.bodyId]){const groups=mesh.mesh.render.groups.filter(group=>group.bodyId===id);assert.equal(groups.length,1);assert.equal(mesh.mesh.render.wires.find(wire=>wire.key===groups[0].wireKey).chunks.length,1);}
  browser=await chromium.launch({executablePath:process.env.WORKBENCH_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await routeGeometryApi(page,api);
  await page.addInitScript(()=>{
    sessionStorage.setItem('occt.activeDocumentId','default');const actual=window.fetch.bind(window);
    const state=window.__wireFault={mode:'normal',requests:[],cancelled:0,released:0,read:0,lateReads:0,deliver:null,fragmentProduced:0,fragmentTotal:0,emptyProduced:0};
    function instrument(stream){const original=stream.getReader.bind(stream);stream.getReader=()=>{const reader=original(),release=reader.releaseLock.bind(reader);reader.releaseLock=()=>{state.released++;release();};return reader;};return stream;}
    window.fetch=(input,init)=>{
      const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);if(!url.pathname.endsWith('/render'))return actual(input,init);
      const current=state.mode,row={key:url.searchParams.get('wireKey'),aborted:false,mode:current};state.requests.push(row);init?.signal?.addEventListener('abort',()=>{row.aborted=true;},{once:true});state.mode='normal';
      if(current==='held-fetch')return new Promise(resolve=>{state.deliver=async()=>{
        const response=await actual(input,{...init,signal:undefined}),body=response.body;
        Object.defineProperty(response,'body',{value:{cancel:()=>{state.cancelled++;void body?.cancel().catch(()=>{});return new Promise(()=>{});},getReader:()=>{state.lateReads++;throw Error('A retired fetch reply must not acquire a reader');}}});resolve(response);
      };});
      if(current==='held-stream')return actual(input,init).then(response=>{
        void response.body?.cancel().catch(()=>{});
        // A real ReadableStream whose source does not produce data and whose
        // cancel promise never settles. The wrapper ignores the fetch signal.
        const stream=new ReadableStream({pull(){state.read++;},cancel(){state.cancelled++;return new Promise(()=>{});}});
        return new Response(instrument(stream),{status:response.status,headers:response.headers});
      });
      if(current==='byte-stream'||current==='empty-stream')return actual(input,init).then(async response=>{
        const bytes=new Uint8Array(await response.arrayBuffer());state.fragmentTotal=bytes.length;let offset=0;
        const stream=new ReadableStream({pull(controller){if(current==='empty-stream'){if(state.emptyProduced++<5000)controller.enqueue(new Uint8Array(0));else controller.close();return;}if(offset===bytes.length){controller.close();return;}controller.enqueue(bytes.subarray(offset,++offset));state.fragmentProduced=offset;},cancel(){state.cancelled++;}});
        return new Response(instrument(stream),{status:response.status,headers:response.headers});
      });
      return actual(input,init);
    };
  });
  await page.goto(process.env.WORKBENCH_URL||'http://localhost:3000/',{waitUntil:'networkidle'});await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();await page.getByTestId('mesh-workbench-panel').locator('a.mesh-download').waitFor();await page.getByRole('button',{name:'关闭操作窗口',exact:true}).click();assert.equal((await fault()).requests.length,0);await page.clock.install();
  await check('an ignored fetch abort still produces the visible fifteen-second failure without automatic retry',async()=>{await mode('held-fetch');await toggle(first.bodyId).click();await started(1);await page.clock.fastForward(15001);await page.locator('.message-summary.error').filter({hasText:timeoutText}).waitFor();const state=await fault();assert.equal(state.requests.length,1);assert.equal(state.requests[0].aborted,true);assert.equal(Number(await viewport().getAttribute('data-rendered-mesh-groups')),0);await page.clock.fastForward(15001);assert.equal((await fault()).requests.length,1);await page.screenshot({path:path.join(artifacts,'timeout.png'),fullPage:true});});
  await check('late HTTP replies are discarded even when their cancel promise hangs, and an explicit hide/show recovers real mesh pixels',async()=>{await deliver();await page.waitForFunction(()=>window.__wireFault.cancelled===1);assert.equal((await fault()).lateReads,0);assert.equal(Number(await viewport().getAttribute('data-rendered-mesh-groups')),0);await toggle(first.bodyId).click();await toggle(first.bodyId).click();await settled();assert.equal((await fault()).requests.length,2);assert.equal(await page.locator('.message-summary.error').count(),0);const cyan=await viewport().locator('canvas').evaluate(canvas=>new Promise(resolve=>requestAnimationFrame(()=>{const gl=canvas.getContext('webgl2'),bytes=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);let count=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i+1]>bytes[i]+35&&bytes[i+2]>bytes[i]+35)count++;resolve(count);})));assert.ok(cyan>100,'Missing recovered cyan mesh pixels: '+cyan);await page.screenshot({path:path.join(artifacts,'recovered.png'),fullPage:true});});
  await check('hiding a stalled Body releases its slot for another Body and late data never revives the hidden group',async()=>{
    // A fresh viewport cache forces the first Body to require a real new read.
    await page.reload({waitUntil:'networkidle'});await toggle(first.bodyId).waitFor();await mode('held-fetch');await toggle(first.bodyId).click();await started(1);await toggle(first.bodyId).click();assert.equal((await fault()).requests[0].aborted,true);await toggle(second.bodyId).click();await settled();const resident=await viewport().getAttribute('data-mesh-resident-bytes');assert.equal((await fault()).requests.length,2);await deliver();await page.waitForFunction(()=>window.__wireFault.cancelled===1);assert.equal(await toggle(first.bodyId).getAttribute('aria-pressed'),'false');assert.equal(await viewport().getAttribute('data-mesh-resident-bytes'),resident);assert.equal(Number(await viewport().getAttribute('data-rendered-mesh-groups')),1);assert.equal(await page.locator('.message-summary.error').count(),0);
  });
  await check('a real silent ReadableStream with an endless cancel promise exits on time, releases its reader and permits explicit recovery',async()=>{
    await toggle(second.bodyId).click();await mode('held-stream');await toggle(first.bodyId).click();await started(3);await page.waitForFunction(()=>window.__wireFault.read>0);const beforeCancel=(await fault()).cancelled;await page.clock.fastForward(15001);await page.locator('.message-summary.error').filter({hasText:timeoutText}).waitFor();await page.waitForFunction(count=>window.__wireFault.cancelled===count+1&&window.__wireFault.released===1,beforeCancel);assert.equal(Number(await viewport().getAttribute('data-rendered-mesh-groups')),0);await toggle(first.bodyId).click();await toggle(first.bodyId).click();await settled();assert.equal(await page.locator('.message-summary.error').count(),0);await page.screenshot({path:path.join(artifacts,'stream-recovered.png'),fullPage:true});
  });
  await check('one-byte response fragments keep the real Body button responsive and cancellation stops production before the stream drains',async()=>{
    await page.reload({waitUntil:'networkidle'});await toggle(first.bodyId).waitFor();await mode('byte-stream');await toggle(first.bodyId).click();await page.waitForFunction(()=>window.__wireFault.fragmentProduced>4096&&window.__wireFault.fragmentProduced<window.__wireFault.fragmentTotal);await toggle(first.bodyId).click();await page.waitForFunction(()=>window.__wireFault.cancelled===1&&window.__wireFault.released===1);const state=await fault();assert.ok(state.fragmentTotal>16384&&state.fragmentProduced<state.fragmentTotal,JSON.stringify(state));assert.equal(Number(await viewport().getAttribute('data-rendered-mesh-groups')),0);assert.equal(await page.locator('.message-summary.error').count(),0);await page.screenshot({path:path.join(artifacts,'fragment-cancelled.png'),fullPage:true});
  });
  await check('empty response fragments trigger the explicit CPU-bound failure instead of relying on a byte or wall-time overflow',async()=>{
    await page.reload({waitUntil:'networkidle'});await toggle(first.bodyId).waitFor();await mode('empty-stream');await toggle(first.bodyId).click();await page.locator('.message-summary.error').filter({hasText:'网格显示字节流包含过多空片段，已停止读取。'}).waitFor();const state=await fault();assert.ok(state.emptyProduced<=4098,JSON.stringify(state));assert.equal(state.cancelled,1);assert.equal(state.released,1);assert.equal(state.requests.length,1);assert.equal(Number(await viewport().getAttribute('data-rendered-mesh-groups')),0);await page.screenshot({path:path.join(artifacts,'empty-fragments.png'),fullPage:true});
  });
  const after=await cad('document.summary');assert.equal(after.stateToken,before.stateToken);assert.deepEqual(after.features,before.features);assert.deepEqual(errors,[]);verified=true;console.log(JSON.stringify({passed:checks.length,browserErrors:errors,scope:'real CAD/Gmsh with browser-owned ignored-abort and endless-cancel faults; not proof of forcibly terminating arbitrary network implementations',screenshots:artifacts}));
}catch(error){if(page){await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(-4000));}console.error('Preserved private test data: '+data);throw error;}
finally{await browser?.close();await stop();if(verified){assert.equal(path.dirname(path.resolve(data)),path.resolve(os.tmpdir()));assert.ok(path.basename(data).startsWith('cad-wire-deadline-ui-'));fs.rmSync(data,{recursive:true,force:true});}}
