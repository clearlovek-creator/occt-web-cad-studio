/* Real isolated CAD/Gmsh and browser streaming checks. No paid model requests. */
import assert from 'node:assert/strict';
import {backendTestArguments} from '../tests/helpers/backend-test-runtime.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { stopTestChild } from '../tests/helpers/stop-test-child.mjs';
import { waitGatewayReady } from '../tests/helpers/wait-gateway-ready.mjs';
import { routeGeometryApi, geometryApiUrl } from './browser-api-route.cjs';
const root = path.resolve(import.meta.dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-wire-ui-中文-')), artifacts = path.join(root, '.artifacts/mesh-wire-ui');
fs.mkdirSync(artifacts, { recursive: true });
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const api = `http://127.0.0.1:${port}/api`;
let gateway, browser, page;
const checks = [], errors = [], wireRequests = [];
async function request(route, body) { const response = await fetch(api + route, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }), result = await response.json(); assert.ok(response.ok && result.ok, JSON.stringify(result)); return result; }
async function check(name, run) { await run(); checks.push(name); console.log('PASS ' + name); }
const traffic = () => page.evaluate(() => window.__meshWireTraffic);
const countVisible = () => page.getByTestId('cad-viewport').getAttribute('data-rendered-mesh-groups').then(Number);
async function settled() { await page.waitForFunction(() => { const data = document.querySelector('[data-testid="cad-viewport"]').dataset; return !document.querySelector('.body-mesh-visibility-button[aria-busy="true"]')&&Number(data.meshWantedChunks) > 0 && data.meshLoadedChunks === data.meshWantedChunks; }); }
try {
    gateway = spawn(process.execPath, backendTestArguments(root), { cwd: root, env: { ...process.env, GEOMETRY_DATA_DIR: data, GEOMETRY_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe','pipe'] });
    await waitGatewayReady(gateway);
    gateway.stdout.resume(); gateway.stderr.resume();
    const first = await request('/commands', { operation: 'primitive.box', parameters: { width: 10, depth: 8, height: 6 } }), second = await request('/commands', { operation: 'primitive.box', parameters: { width: 10, depth: 8, height: 6 } }), third = await request('/commands', { operation: 'primitive.box', parameters: { width: 5, depth: 5, height: 6, x: 16 } });
    const before = await request('/commands', { operation: 'document.summary' }), result = await request('/documents/default/mesh/jobs', { qualityThreshold: 0 }), render = result.mesh.render;
    assert.ok(render.storage);
    assert.equal(result.mesh.admission.status, 'accepted');
    const keysFor = id => new Set(render.groups.filter(group => group.bodyId === id).map(group => group.wireKey)), firstKeys = keysFor(first.bodyId), secondKeys = keysFor(second.bodyId), shared = [...firstKeys].filter(key => secondKeys.has(key));
    assert.ok(shared.length > 0, 'The fixture must contain a real shared Gmsh volume with both Body owners');
    browser = await chromium.launch({ executablePath: process.env.WORKBENCH_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/render'))
        wireRequests.push(request.url()); });
    await page.addInitScript(() => { const original = window.fetch.bind(window); window.__meshWireTraffic = []; window.fetch = (input, options) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href); if (url.pathname.endsWith('/render')) {
        window.__meshWireTraffic.push({ event: 'start', key: url.searchParams.get('wireKey') });
        options?.signal?.addEventListener('abort', () => window.__meshWireTraffic.push({ event: 'abort', key: url.searchParams.get('wireKey') }), { once: true });
    } return original(input, options); }; });
    await routeGeometryApi(page, api);
    await page.goto(process.env.WORKBENCH_URL || 'http://localhost:3000/', { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '网格', exact: true }).click();
    await page.locator('[data-command="analysis.mesh"]').click();
    const panel = page.getByTestId('mesh-workbench-panel'), tree = page.getByTestId('feature-tree'), viewport = page.getByTestId('cad-viewport'), row = id => tree.locator(`[data-body-id="${id}"]`), toggle = id => row(id).locator('.body-mesh-visibility-button');
    await check('a recovered default-hidden result loads ownership metadata but no wire bytes or geometry', async () => {
        await panel.locator('a.mesh-download').waitFor();
        await toggle(first.bodyId).waitFor();
        assert.equal(wireRequests.length, 0);
        assert.equal(await countVisible(), 0);
        assert.equal(Number(await viewport.getAttribute('data-mesh-resident-bytes')), 0);
        assert.equal(await toggle(first.bodyId).getAttribute('aria-pressed'), 'false');
    });
    await check('showing one Body fetches only its exact wire blocks and produces visible mesh pixels', async () => {
        await toggle(first.bodyId).click();
        await settled();
        assert.ok(wireRequests.length > 0);
        assert.ok(wireRequests.every(url => firstKeys.has(new URL(url).searchParams.get('wireKey'))));
        const wanted = [...firstKeys].reduce((sum, key) => sum + render.wires.find(wire => wire.key === key).chunks.length, 0);
        assert.equal(wireRequests.length, wanted);
        assert.equal(await countVisible(), wanted);
        const pixels = await viewport.locator('canvas').evaluate(canvas => new Promise(resolve => requestAnimationFrame(() => { const gl = canvas.getContext('webgl2'), bytes = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes); let cyan = 0; for (let i = 0; i < bytes.length; i += 4)
            if (bytes[i + 1] > bytes[i] + 35 && bytes[i + 2] > bytes[i] + 35)
                cyan++; resolve(cyan); })));
        assert.ok(pixels > 100, `Expected real visible cyan mesh lines, got ${pixels}`);
        await page.screenshot({ path: path.join(artifacts, 'body-wire.png'), fullPage: true });
    });
    await check('a shared volume is fetched and allocated only once, even with two visible Body owners', async () => {
        const requests = wireRequests.length, bytes = Number(await viewport.getAttribute('data-mesh-resident-bytes'));
        await toggle(second.bodyId).click();
        await settled();
        await page.getByText(/网格显示已就绪 · \d+ 块/).first().waitFor();
        assert.equal(wireRequests.length, requests);
        assert.equal(Number(await viewport.getAttribute('data-mesh-resident-bytes')), bytes);
        await toggle(first.bodyId).click();
        assert.ok(await countVisible() > 0);
        await toggle(second.bodyId).click();
        assert.equal(await countVisible(), 0);
        await toggle(first.bodyId).click();
        await settled();
        assert.equal(wireRequests.length, requests);
        await row(first.bodyId).locator('.body-visibility-button').click();
        await page.waitForFunction(() => document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups === '0');
        await row(first.bodyId).locator('.body-visibility-button').click();
        await settled();
        assert.equal(wireRequests.length, requests);
        await toggle(first.bodyId).click();
    });
    await check('pending Body validation is cancellable from the same button and a late success cannot restore it',async()=>{
        const pattern='**/api/mesh/jobs/*/visibility';let arrive,release,done;const arrived=new Promise(resolve=>arrive=resolve),finished=new Promise(resolve=>done=resolve);let held=false;
        const handler=async route=>{if(held){await route.fallback();return;}held=true;const response=await route.fetch({url:geometryApiUrl(route.request().url(),api)});arrive();await new Promise(resolve=>release=resolve);try{await route.fulfill({response});}finally{done();}};await page.route(pattern,handler);
        try{await toggle(third.bodyId).click();await arrived;assert.equal(await toggle(third.bodyId).getAttribute('aria-busy'),'true');assert.equal(await toggle(third.bodyId).getAttribute('aria-pressed'),'true');await page.screenshot({path:path.join(artifacts,'validation-pending.png'),fullPage:true});await toggle(third.bodyId).click();assert.equal(await toggle(third.bodyId).getAttribute('aria-pressed'),'false');release();await finished;assert.equal(await countVisible(),0);assert.equal(await toggle(third.bodyId).getAttribute('aria-busy'),'false');}finally{release?.();if(held)await finished;await page.unroute(pattern,handler);}
    });
    await check('late validation for a shared owner merges the latest visibility instead of resurrecting a hidden Body',async()=>{
        await toggle(first.bodyId).click();await settled();const pattern='**/api/mesh/jobs/*/visibility';let arrive,release,done;const arrived=new Promise(resolve=>arrive=resolve),finished=new Promise(resolve=>done=resolve);let held=false;const handler=async route=>{if(held){await route.fallback();return;}held=true;const response=await route.fetch({url:geometryApiUrl(route.request().url(),api)});arrive();await new Promise(resolve=>release=resolve);try{await route.fulfill({response});}finally{done();}};await page.route(pattern,handler);
        try{await toggle(second.bodyId).click();await arrived;await toggle(first.bodyId).click();assert.equal(await toggle(first.bodyId).getAttribute('aria-pressed'),'false');release();await finished;await settled();assert.equal(await toggle(first.bodyId).getAttribute('aria-pressed'),'false');assert.equal(await toggle(second.bodyId).getAttribute('aria-pressed'),'true');assert.ok(await countVisible()>0);await toggle(second.bodyId).click();}finally{release?.();if(held)await finished;await page.unroute(pattern,handler);}
    });
    await check('hiding a Body aborts its pending browser read and a late transport reply cannot display it', async () => {
        let release, arrive, finish;
        const arrived = new Promise(resolve => arrive = resolve), finished = new Promise(resolve => finish = resolve);
        const pattern = '**/api/mesh/jobs/*/render?*';
        let held = false;
        const handler = async (route) => { if (held) {
            await route.fallback();
            return;
        } held = true; const response = await route.fetch({ url: geometryApiUrl(route.request().url(), api) }); arrive(); await new Promise(resolve => release = resolve); try {
            await route.fulfill({ response });
        }
        finally {
            finish();
        } };
        await page.route(pattern, handler);
        try {
            await toggle(third.bodyId).click();
            await arrived;
            await page.getByText(/网格按需载入 · 0%/).first().waitFor();
            await page.screenshot({path:path.join(artifacts,'wire-loading.png'),fullPage:true});
            await toggle(third.bodyId).click();
            await page.waitForFunction(() => window.__meshWireTraffic.some(event => event.event === 'abort'));
            release();
            await finished;
            assert.equal(await countVisible(), 0);
            assert.equal(await toggle(third.bodyId).getAttribute('aria-pressed'), 'false');
        }
        finally {
            release?.();
            if (held)
                await finished;
            await page.unroute(pattern, handler);
        }
    });
    await check('the global toggle preserves per-Body display intent and narrow layouts keep progress readable', async () => {
        await toggle(third.bodyId).click();
        await settled();
        assert.ok([...keysFor(third.bodyId)].every(key => wireRequests.some(url => new URL(url).searchParams.get('wireKey') === key)));
        const calls = wireRequests.length;
        await panel.getByRole('button', { name: '隐藏网格', exact: true }).click();
        assert.equal(await countVisible(), 0);
        await panel.getByRole('button', { name: '显示网格', exact: true }).click();
        await settled();
        assert.equal(wireRequests.length, calls);
        await page.getByText(/网格显示已就绪 · \d+ 块/).first().waitFor();
        for (const width of [900, 640]) {
            await page.setViewportSize({ width, height: 800 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await page.screenshot({ path: path.join(artifacts, `wire-narrow-${width}.png`), fullPage: true });
        }
        await page.setViewportSize({ width: 1440, height: 960 });
    });
    await check('a corrupted transport block stops rendering with an actionable error and never silently retries', async () => {
        await page.reload({ waitUntil: 'networkidle' });
        await toggle(third.bodyId).waitFor();
        assert.equal(await countVisible(), 0);
        const pattern = '**/api/mesh/jobs/*/render?*', handler = async (route) => { const response = await route.fetch({ url: geometryApiUrl(route.request().url(), api) }), bytes = Buffer.from(await response.body()); bytes[0] ^= 1; await route.fulfill({ response, body: bytes }); };
        await page.route(pattern, handler);
        try {
            await toggle(third.bodyId).click();
            await page.getByText('网格显示数据内容校验失败。', { exact: true }).first().waitFor();
            assert.equal(await countVisible(), 0);
            const calls = (await traffic()).filter(row => row.event === 'start').length;
            await page.getByRole('tab', { name: '视图', exact: true }).click();
            assert.equal((await traffic()).filter(row => row.event === 'start').length, calls);
            await page.screenshot({ path: path.join(artifacts, 'wire-integrity-error.png'), fullPage: true });
        }
        finally {
            await page.unroute(pattern, handler);
        }
    });
    await check('an explicit hide/show after an integrity failure can recover and clears only the stale mesh error',async()=>{
        await toggle(third.bodyId).click();await toggle(third.bodyId).click();await settled();assert.ok(await countVisible()>0);await page.getByText('网格显示数据内容校验失败。',{exact:true}).first().waitFor({state:'hidden'});await page.getByText(/网格显示已就绪 · \d+ 块/).first().waitFor();await page.screenshot({path:path.join(artifacts,'wire-recovered.png'),fullPage:true});
    });
    const after = await request('/commands', { operation: 'document.summary' });
    assert.equal(after.revision, before.revision + 2, 'Only the two explicit Body visibility edits advance the document revision');
    const expectedFeatures=structuredClone(before.features),body=before.bodyMetadata.find(row=>row.bodyId===first.bodyId),prefix=`outputBodyMeta.${first.bodyId}.`;
    Object.assign(expectedFeatures[0].stringParameters,{[prefix+'color']:body.color,[prefix+'material']:body.material||'',[prefix+'name']:body.name,[prefix+'opacity']:body.opacity.toFixed(6),[prefix+'visible']:'true'});
    assert.deepEqual(after.features, expectedFeatures,'Only the normal saved display metadata may be added by the two explicit visibility edits');
    assert.deepEqual(after.bodyMetadata, before.bodyMetadata);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ ok: true, checks, wireRequests: wireRequests.length, scope: 'real small CAD/Gmsh meshes, shared ownership and native browser fetch/render; two explicit Body visibility edits; not a million-cell CAD meshing or GPU scale certificate' }, null, 2));
    console.log(`${checks.length} mesh wire browser checks passed.`);
}
catch (error) {
    if (page) {
        await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
        console.error((await page.locator('body').innerText()).slice(-6000));
    }
    throw error;
}
finally {
    await browser?.close();
    await stopTestChild(gateway);
    assert.equal(path.dirname(data), path.resolve(os.tmpdir()));
    assert.match(path.basename(data), /^cad-wire-ui-/);
    fs.rmSync(data, { recursive: true, force: true });
}
