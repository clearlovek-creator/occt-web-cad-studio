/* Real CAD/Gmsh base mesh, test-owned consistent MSH/index fault injection,
 * and real WebGL pixels. No daily project writes or provider calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { MeshJobStore } from '../gateway/mesh-job-store.mjs';
import { addQualityValue } from '../shared/mesh-statistics.mjs';
import { backendTestArguments } from '../tests/helpers/backend-test-runtime.mjs';
import { stopTestChild } from '../tests/helpers/stop-test-child.mjs';
import { routeGeometryApi } from './browser-api-route.cjs';
const root = path.resolve(import.meta.dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-topology-location-ui-')), artifacts = path.join(root, '.artifacts/mesh-topology-location-ui');
fs.mkdirSync(artifacts, { recursive: true });
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const api = `http://127.0.0.1:${port}/api`;
let gateway, browser, page, verified = false;
const checks = [], errors = [];
async function start() { gateway = spawn(process.execPath, backendTestArguments(root), { cwd: root, env: { ...process.env, GEOMETRY_DATA_DIR: data, GEOMETRY_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { let diagnostic = ''; const timer = setTimeout(() => reject(Error('Topology Gateway startup deadline: ' + diagnostic)), 120000); gateway.once('error', reject); gateway.stderr.on('data', bytes => diagnostic = (diagnostic + bytes).slice(-8192)); gateway.stdout.on('data', bytes => { if (String(bytes).includes('Geometry gateway ready')) {
    clearTimeout(timer);
    resolve();
} }); }); }
async function stop() { if (!gateway)
    return; const child = gateway, control = path.join(data, '.gateway-control.json'); if (child.exitCode === null && fs.existsSync(control)) {
    const token = JSON.parse(fs.readFileSync(control));
    assert.equal(token.ownerPid, child.pid);
    const ending = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Private Gateway exit unconfirmed; preserve ' + data)), 25000); child.once('exit', code => { clearTimeout(timer); if(code===0)resolve();else reject(Error('Gateway shutdown ' + code)); }); });
    await fetch(api + '/runtime/shutdown', { method: 'POST', headers: { 'x-cad-shutdown-token': token.token }, signal: AbortSignal.timeout(3000) }).catch(() => { });
    await ending;
} await stopTestChild(child); gateway = null; }
async function request(route, body) { const response = await fetch(api + route, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) }), value = await response.json(); assert.ok(response.ok && value.ok, JSON.stringify(value)); return value; }
async function cad(operation, parameters = {}, inputs = {}) { const current = await request('/commands', { documentId: 'default', operation: 'document.summary' }); return request('/commands', { documentId: 'default', operation, parameters, inputs, baseRevision: current.revision, baseStateToken: current.stateToken }); }
function inject(jobId, kind) {
    const store = new MeshJobStore(data), job = store.load().find(row => row.jobId === jobId), result = store.readResult(job), index = JSON.parse(fs.readFileSync(store.qualityOutput(job)));
    assert.ok(index.cells.every(cell => cell.order === 1 && cell.elementType === 4));
    let cell = { ...index.cells[0], corners: [...index.cells[0].corners] };
    if (kind === 'face-orientation') {
        const faces = new Map();
        for (const value of index.cells)
            for (let omitted = 0; omitted < 4; omitted++) {
                const nodes = value.corners.filter((_, i) => i !== omitted), key = [...nodes].sort((a, b) => a - b).join(',');
                if (!faces.has(key))
                    faces.set(key, { count: 0, cell: value, omitted, nodes });
                faces.get(key).count++;
            }
        const chosen = [...faces.values()].find(face => face.count === 1);
        assert.ok(chosen);
        cell = { ...chosen.cell, corners: [...chosen.cell.corners] };
        const center = [0, 1, 2].map(axis => chosen.nodes.reduce((sum, node) => sum + index.positions[node * 3 + axis], 0) / 3), old = cell.corners[chosen.omitted];
        cell.corners[chosen.omitted] = index.positions.length / 3;
        index.positions.push(...center.map((value, axis) => (value + index.positions[old * 3 + axis]) / 2));
    }
    if(kind==='spatial-overlap'){
        const otherOwner=index.cells.find(value=>value.volumeTag!==cell.volumeTag);assert.ok(otherOwner,'Cross-Body fault requires two real source volumes');cell.volumeTag=otherOwner.volumeTag;cell.bodyIds=[...otherOwner.bodyIds];
        const original=cell.corners.map(n=>index.positions.slice(n*3,n*3+3)),center=[0,1,2].map(axis=>original.reduce((sum,p)=>sum+p[axis],0)/4);
        cell.corners=original.map(point=>{const n=index.positions.length/3;index.positions.push(...point.map((value,axis)=>center[axis]+(value-center[axis])*.25));return n;});
        cell.minJacobian/=64;cell.maxJacobian/=64;
        // Self-consistent but false boundary/quality claims must not defeat the
        // new independent spatial gate. This is controlled fault injection,
        // not a claim that these interior faces belong to the real CAD surface.
        result.mesh.boundaryMapping.surfaces.find(surface=>surface.adjacentSolidIds.length===1&&!surface.embeddedSolidIds?.length).elementCount+=4;
    }
    cell.elementId = String(index.cells.reduce((max, value) => BigInt(value.elementId) > max ? BigInt(value.elementId) : max, 0n) + 1n);
    index.cells.push(cell);
    const total = { sum: 0, compensation: 0 };
    for (const value of index.cells)
        addQualityValue(total, value.quality);
    Object.assign(result.mesh.quality, { tetraCount: index.cells.length, finiteCount: index.cells.length, averageQuality: (total.sum + total.compensation) / index.cells.length, summation: 'neumaier-v1' });
    result.mesh.nodeCount = index.positions.length / 3;
    result.mesh.elementCount = index.cells.length;
    fs.writeFileSync(store.qualityOutput(job), JSON.stringify(index));
    const msh = ['$MeshFormat', '2.2 0 8', '$EndMeshFormat', '$Nodes', String(index.positions.length / 3)];
    for (let n = 0; n < index.positions.length / 3; n++)
        msh.push(`${n + 1} ${index.positions.slice(n * 3, n * 3 + 3).join(' ')}`);
    msh.push('$EndNodes', '$Elements', String(index.cells.length));
    for (const value of index.cells)
        msh.push(`${value.elementId} 4 2 1 ${value.volumeTag} ${value.corners.map(node => node + 1).join(' ')}`);
    msh.push('$EndElements', '');
    fs.writeFileSync(store.output(job), msh.join('\n'));
    job.artifact = store.writeResult(job, result);
    job.meshSummary = { ...job.meshSummary, nodeCount: result.mesh.nodeCount, elementCount: result.mesh.elementCount, admission: result.mesh.admission };
    store.save(job);
    assert.equal(result.mesh.admission.status, 'blocked');
    assert.equal(result.mesh.admission.counts.badCount, 0);
    if(kind==='spatial-overlap'){
        assert.equal(result.mesh.admission.spatial.overlapPairCount,1);
        assert.deepEqual(result.mesh.admission.reasons.filter(row=>row.severity==='error').map(row=>row.code),['OVERLAPPING_TETRAHEDRA']);
    }else assert.ok(result.mesh.admission.topology.samples.some(sample => sample.kind === kind));
    return { job, result };
}
async function check(name, run) { await run(); checks.push(name); console.log('PASS ' + name); }
try {
    await start();
    const box = await cad('primitive.box', { width: 12, depth: 10, height: 8 });await cad('primitive.box',{width:6,depth:6,height:6,x:20});const before = await cad('document.summary'), duplicate = await request('/documents/default/mesh/jobs', { qualityThreshold: 0 }), face = await request('/documents/default/mesh/jobs', { qualityThreshold: 0 }), spatial=await request('/documents/default/mesh/jobs',{qualityThreshold:0});
    await stop();
    const duplicateFault = inject(duplicate.meshJob.jobId, 'duplicate-tetra'), faceFault = inject(face.meshJob.jobId, 'face-orientation'), spatialFault=inject(spatial.meshJob.jobId,'spatial-overlap');
    await start();
    browser = await chromium.launch({ executablePath: process.env.WORKBENCH_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    await routeGeometryApi(page, api);
    await page.addInitScript(() => sessionStorage.setItem('occt.activeDocumentId', 'default'));
    await page.goto(process.env.WORKBENCH_URL || 'http://localhost:3000/', { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '网格', exact: true }).click();
    await page.locator('[data-command="analysis.mesh"]').click();
    const panel = page.getByTestId('mesh-workbench-panel'), viewport = page.getByTestId('cad-viewport'), samples = () => panel.getByTestId('mesh-topology-samples');
    async function select(jobId) { const history = panel.locator('.mesh-task-history'); if (await history.getAttribute('open') === null)
        await history.locator(':scope > summary').click(); const row = history.locator('li').filter({ hasText: jobId.slice(-8) }), load = row.getByRole('button', { name: '查看结果', exact: true }); if (await load.count())
        await load.click(); await panel.locator(`a.mesh-download[href*="${jobId}"]`).waitFor(); if (await samples().getAttribute('open') === null)
        await samples().locator(':scope > summary').click(); }
    async function pixels(faceRequired = false) { await page.waitForFunction(() => document.querySelector('[data-testid="cad-viewport"]').dataset.highlightedQualityElements === '1'); const values = await viewport.evaluate(node => { node.dispatchEvent(new Event('cad:verify-quality')); return { all: Number(node.dataset.qualityHighlightPixels), face: Number(node.dataset.qualityTopologyFacePixels) }; }); assert.ok(values.all > 10, JSON.stringify(values)); if (faceRequired)
        assert.ok(values.face > 10, JSON.stringify(values)); }
    await check('positive numeric quality cannot hide topology failures, and exact sample rows are available without rendering the mesh', async () => { await select(duplicate.meshJob.jobId); await samples().getByText('重复四面体', { exact: true }).first().waitFor(); assert.equal(Number(await viewport.getAttribute('data-rendered-mesh-groups')), 0); assert.equal(await panel.getByRole('button', { name: '显示网格', exact: true }).isDisabled(), true); assert.equal(duplicateFault.result.mesh.admission.counts.badCount, 0); assert.match(await samples().innerText(), new RegExp(duplicateFault.result.mesh.admission.topology.samples[0].elementId)); });
    await check('keyboard activation locates the real duplicate tetrahedron with pixels, no complete mesh and no CAD writes', async () => {
        const locate = samples().getByRole('button', { name: '定位连接样例 1', exact: true });
        await locate.focus();
        await page.keyboard.press('Enter');
        await pixels();
        assert.match(await page.getByRole('status', { name: '单元定位', exact: true }).innerText(), /重复四面体/);
        assert.equal(await locate.getAttribute('aria-pressed'), 'true');
        await locate.hover();
        const hoverColor = await locate.evaluate(node => getComputedStyle(node).backgroundColor);
        await page.mouse.down();
        const activeColor = await locate.evaluate(node => getComputedStyle(node).backgroundColor);
        assert.notEqual(activeColor, hoverColor, 'Pointer press must have visible feedback, not only a hover state');
        await page.mouse.up();
        assert.equal((await cad('document.summary')).stateToken, before.stateToken);
        await page.screenshot({ path: path.join(artifacts, 'duplicate-highlight.png'), fullPage: true });
    });
    await check('a public-face fault highlights the actual triangular face as well as its participating tetrahedron', async () => { await select(face.meshJob.jobId); const index = faceFault.result.mesh.admission.topology.samples.findIndex(sample => sample.kind === 'face-orientation'); await samples().getByRole('button', { name: `定位连接样例 ${index + 1}`, exact: true }).click(); await pixels(true); assert.equal(await viewport.getAttribute('data-highlighted-quality-faces'), '1'); await page.screenshot({ path: path.join(artifacts, 'common-face-highlight.png'), fullPage: true }); });
    await check('Body hide/show suspends and restores diagnostic geometry without exposing hidden faces', async () => { const hide = page.getByTestId('feature-tree').locator('.body-visibility-button').first(); await hide.click(); await page.waitForFunction(() => document.querySelector('[data-testid="cad-viewport"]').dataset.highlightedQualityElements === '0'); assert.ok(await samples().getByRole('button', { name: /定位连接样例/ }).first().isDisabled()); await hide.click(); await pixels(true); });
    await check('WebGL recovery rebuilds the same common-face sample instead of enabling the failed mesh', async () => { const canvas = await viewport.locator('canvas').elementHandle(); await canvas.evaluate(node => { const extension = node.getContext('webgl2').getExtension('WEBGL_lose_context'); assertUnused(extension); function assertUnused(value) { if (!value)
        throw Error('Context-loss testing unavailable'); } extension.loseContext(); setTimeout(() => extension.restoreContext(), 200); }); await page.waitForTimeout(700); await pixels(true); assert.equal(Number(await viewport.getAttribute('data-rendered-mesh-groups')), 0); });
    await check('narrow sample rows keep readable text, a forty-pixel action and reachable window controls', async () => { for (const width of [900, 640]) {
        await page.setViewportSize({ width, height: 800 });
        const button = samples().getByRole('button', { name: '定位连接样例 1', exact: true });
        await button.scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await samples().evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        const box = await button.boundingBox();
        assert.ok(box.height >= 40);
        assert.ok(await samples().locator('strong').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 12));
        const close = await page.getByRole('button', { name: '关闭操作窗口', exact: true }).boundingBox();
        assert.ok(close.x >= 0 && close.y >= 0 && close.x + close.width <= width && close.y + close.height <= 800);
        await page.screenshot({ path: path.join(artifacts, `sample-${width}.png`), fullPage: true });
    } await page.setViewportSize({ width: 1440, height: 960 }); });
    await check('clearing the sample removes both cell and face overlays and never writes geometry', async () => { const beforeClear=await cad('document.summary');await samples().getByRole('button', { name: '清除样例定位', exact: true }).click(); assert.equal(await viewport.getAttribute('data-highlighted-quality-elements'), '0'); assert.equal(await viewport.getAttribute('data-highlighted-quality-faces'), '0'); const state = await cad('document.summary'); assert.equal(state.bodyCount, before.bodyCount); assert.equal(state.stateToken,beforeClear.stateToken);assert.deepEqual(state.features, beforeClear.features); });
    await check('independent positive-quality cells with spatial overlap are blocked by the spatial gate even when every previous admission check is satisfied',async()=>{
        const beforeSelect=await cad('document.summary');
        await select(spatial.meshJob.jobId);
        const admission=panel.getByRole('status',{name:'网格验收',exact:true}),details=admission.locator(':scope > details:not(.mesh-topology-samples)');
        if(await details.getAttribute('open')===null)await details.locator(':scope > summary').click();
        await admission.getByText(/存在线性四面体的正体积空间重叠/).waitFor();
        assert.equal(await admission.getAttribute('data-status'),'blocked');
        assert.equal(await panel.getByRole('button',{name:'显示网格',exact:true}).isDisabled(),true);
        assert.equal(Number(await viewport.getAttribute('data-rendered-mesh-groups')),0);
        assert.equal(spatialFault.result.mesh.admission.counts.badCount,0);
        assert.equal(spatialFault.result.mesh.admission.topology.samples.length,0);
        assert.equal((await cad('document.summary')).stateToken,beforeSelect.stateToken);
        await page.screenshot({path:path.join(artifacts,'spatial-overlap-blocked.png'),fullPage:true});
    });
    const pairs=()=>panel.getByTestId('mesh-spatial-samples');
    async function pairPixels(){await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.highlightedQualityElements==='2');const values=await viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-quality'));return {all:Number(node.dataset.qualityHighlightPixels),peer:Number(node.dataset.qualitySpatialPeerPixels)};});assert.ok(values.all>10&&values.peer>10,JSON.stringify(values));assert.equal(Number(await viewport.getAttribute('data-rendered-mesh-groups')),0);}
    await check('a cross-Body overlap locates both certified tetrahedra and renders the peer as real separate pixels without numerical flag fabrication',async()=>{
        const beforeLocate=await cad('document.summary');if(await pairs().getAttribute('open')===null)await pairs().locator(':scope > summary').click();
        const button=pairs().getByRole('button',{name:'定位重叠样例 1',exact:true});await button.focus();await page.keyboard.press('Enter');await pairPixels();
        const sample=spatialFault.result.mesh.admission.spatial.samples[0];assert.notEqual(sample.cells[0].bodyIds[0],sample.cells[1].bodyIds[0]);
        assert.match(await page.getByRole('status',{name:'单元定位',exact:true}).innerText(),/A .* ↔ B/);assert.equal((await cad('document.summary')).stateToken,beforeLocate.stateToken);
        await page.screenshot({path:path.join(artifacts,'spatial-pair-highlight.png'),fullPage:true});
    });
    await check('hiding only the peer Body suspends both overlays while the primary Body remains visible, and showing the peer restores the same pair',async()=>{
        const sample=spatialFault.result.mesh.admission.spatial.samples[0],peerBody=sample.cells[1].bodyIds[0],primaryBody=sample.cells[0].bodyIds[0],hide=page.getByTestId('feature-tree').locator(`[data-body-id="${peerBody}"] .body-visibility-button`);
        await hide.click();await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.highlightedQualityElements==='0');
        assert.ok((await cad('document.summary')).bodyMetadata.find(body=>body.bodyId===primaryBody).visible!==false);assert.equal(await viewport.getAttribute('data-highlighted-quality-peers'),'0');assert.ok(await pairs().getByRole('button',{name:'定位重叠样例 1',exact:true}).isDisabled());
        await hide.click();await pairPixels();
    });
    await check('WebGL recovery rebuilds both members of the selected pair without enabling a rejected mesh',async()=>{
        await viewport.locator('canvas').evaluate(node=>{const extension=node.getContext('webgl2').getExtension('WEBGL_lose_context');if(!extension)throw Error('Context-loss testing unavailable');extension.loseContext();setTimeout(()=>extension.restoreContext(),200);});await page.waitForTimeout(700);await pairPixels();
    });
    await check('pair rows and dual-ID readouts remain readable on 900 and 640 pixel viewports with forty-pixel controls',async()=>{
        for(const width of [900,640]){await page.setViewportSize({width,height:800});const button=pairs().getByRole('button',{name:'定位重叠样例 1',exact:true});await button.scrollIntoViewIfNeeded();assert.ok((await button.boundingBox()).height>=40);assert.equal(await pairs().evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.ok((await page.getByRole('status',{name:'单元定位',exact:true}).getByRole('button',{name:'清除单元定位',exact:true}).boundingBox()).height>=40);await page.screenshot({path:path.join(artifacts,`spatial-pair-${width}.png`),fullPage:true});}await page.setViewportSize({width:1440,height:960});
    });
    await check('clearing a spatial pair removes both diagnostic members and leaves geometry and features byte-for-byte unchanged',async()=>{
        const beforeClear=await cad('document.summary');await pairs().getByRole('button',{name:'清除重叠定位',exact:true}).click();assert.equal(await viewport.getAttribute('data-highlighted-quality-elements'),'0');assert.equal(await viewport.getAttribute('data-highlighted-quality-peers'),'0');const after=await cad('document.summary');assert.equal(after.stateToken,beforeClear.stateToken);assert.deepEqual(after.features,beforeClear.features);
    });
    await check('geometry changes preserve the historical samples but disable their use on the current model', async () => { await cad('feature.update', { width: 14 }, { featureId: box.features[0].id }); await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('tab', { name: '网格', exact: true }).click(); await page.locator('[data-command="analysis.mesh"]').click(); await select(face.meshJob.jobId); assert.ok(await samples().getByRole('button', { name: /定位连接样例/ }).first().isDisabled()); assert.equal(Number(await viewport.getAttribute('data-highlighted-quality-elements') || 0), 0); await samples().getByText('来源几何已变化或无法验证，样例保留，定位已禁用。', { exact: true }).waitFor();await select(spatial.meshJob.jobId);if(await pairs().getAttribute('open')===null)await pairs().locator(':scope > summary').click();assert.ok(await pairs().getByRole('button',{name:'定位重叠样例 1',exact:true}).isDisabled());assert.equal(Number(await viewport.getAttribute('data-highlighted-quality-peers')||0),0); });
    assert.deepEqual(errors, []);
    verified = true;
    console.log(JSON.stringify({ passed: checks.length, browserErrors: errors, scope: 'real CAD/Gmsh base, test-owned MSH/index faults and false boundary claims, real WebGL pixels; linear overlap gate, not arbitrary curved intersection certification', screenshots: artifacts }));
}
catch (error) {
    if (page)
        await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
    console.error('Preserved topology UI data: ' + data);
    throw error;
}
finally {
    await browser?.close();
    await stop();
    if (verified) {
        assert.equal(path.dirname(data), path.resolve(os.tmpdir()));
        assert.match(path.basename(data), /^cad-topology-location-ui-/);
        fs.rmSync(data, { recursive: true, force: true });
    }
}
