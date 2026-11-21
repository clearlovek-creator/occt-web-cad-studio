import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { selectBackendRelease, validateBackendRelease } from '../gateway/backend-release.mjs';
import { selectRelease } from '../gateway/frontend-release.mjs';
import { startCadModelFixture } from '../tests/helpers/cad-model-fixture.mjs';
import { PI_RPC_TIMEOUTS } from '../shared/pi-rpc-timeouts.mjs';
const root = path.resolve(import.meta.dirname, '..'), backendRoot = path.resolve(process.env.CAD_TEST_BACKEND_RELEASE_ROOT || '.artifacts/pi-sdk-backend-releases'), release = selectBackendRelease(backendRoot, process.env.CAD_TEST_BACKEND_RELEASE_ID), frontendRoot = path.resolve(process.env.LOFT_UI_RELEASE_ROOT || '.artifacts/quality-sort-releases'), frontendRelease = selectRelease(frontendRoot, root);
assert.ok(release.sdk, 'This acceptance requires the genuine bundled Pi SDK, not a transport fixture.');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-sdk-browser-')), data = path.join(scratch, '工程'), runtime = path.join(scratch, '运行'), artifacts = path.resolve(process.env.PI_SDK_BROWSER_ARTIFACTS || path.join(root, '.artifacts/pi-sdk-browser'));
fs.mkdirSync(artifacts, { recursive: true });
async function freePort() { const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; }
const frontendPort = await freePort(), gatewayPort = await freePort(), front = `http://127.0.0.1:${frontendPort}`, api = front + '/api', fixture = await startCadModelFixture();
let browser, page, started = false, ready = false, verified = false;
const errors = [], checks = [];
async function manage(action) { const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/start-web-cad-demo.ps1'), '-Action', action, '-FrontendPort', String(frontendPort), '-GatewayPort', String(gatewayPort), '-DataDirectory', data, '-RuntimeDirectory', runtime, '-GatewayReleaseRoot', backendRoot, '-GatewayReleaseId', release.releaseId, '-FrontendReleaseRoot', frontendRoot, '-FrontendReleaseId', frontendRelease.releaseId, '-AsJson']; const child = spawn('powershell.exe', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AGENT_ALLOW_PRIVATE_URL: 'true', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', CAD_GEOMETRY_API_URL: 'http://127.0.0.1:1/api', PI_CLI_PATH: 'Z:/not-a-runtime/cli.mjs' } }); let out = '', diagnostic = ''; child.stdout.on('data', bytes => out += bytes); child.stderr.on('data', bytes => diagnostic = (diagnostic + bytes).slice(-16384)); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('SDK browser service action not confirmed: ' + action)), 150000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); if (code !== 0)
    reject(Error('SDK browser managed action ' + action + ': ' + diagnostic));
else
    try {
        resolve(JSON.parse(out));
    }
    catch (error) {
        reject(error);
    } }); }); }
async function request(route, body) { const response = await fetch(api + route, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) }), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; }
async function check(name, run) { await run(); checks.push(name); console.log('PASS ' + name); }
try {
    started = true;
    const status = await manage('Start');
    assert.ok(status.Services.every(service => service.State === 'ready'));
    ready = true;
    assert.equal((await request('/health')).backendRelease.piSdk.manifestSha256, release.sdk.manifest.sha256);
    await request('/agent/providers', { id: 'sdk-fixture', name: 'Local SDK acceptance', baseUrl: fixture.baseUrl, protocol: 'chat-completions', model: 'sdk-fixture', apiKey: 'local-fixture-not-a-provider-secret' });
    browser = await chromium.launch({ executablePath: process.env.WORKBENCH_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => sessionStorage.setItem('occt.activeDocumentId', 'default'));
    await page.goto(front, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
    const panel = page.getByTestId('pi-agent-panel');
    await panel.locator('.pi-agent-status').filter({ hasText: '会话在线' }).waitFor({ timeout: PI_RPC_TIMEOUTS.browserStartupMs });
    const session = await request('/pi/sessions', { sessionId: 'webcad-default', documentId: 'default' });
    await request('/pi/sessions/webcad-default/commands', { documentId: 'default', streamId: session.streamId, command: { type: 'set_model', provider: 'sdk-fixture', modelId: 'sdk-fixture' } });
    await request('/pi/sessions/webcad-default/commands', { documentId: 'default', streamId: session.streamId, command: { type: 'set_auto_retry', enabled: false } });
    await check('the real sealed SDK queries and creates through the assistant UI, and CAD pixels update without refresh', async () => {
        await panel.getByRole('textbox', { name: '发送给 Pi Agent' }).fill('Create one box 10 by 20 by 30. Query the document first.');
        await panel.getByRole('button', { name: '发送', exact: true }).click();
        await panel.getByText('The CAD tool confirmed one box.', { exact: true }).waitFor();
        await panel.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'detached' });
        await page.waitForFunction(() => Number(document.querySelector('[data-testid="cad-viewport"]')?.dataset.renderedTriangles) > 0);
        const summary = await request('/commands', { documentId: 'default', operation: 'document.summary' });
        assert.equal(summary.bodyCount, 1);
        const measure = await request('/commands', { documentId: 'default', operation: 'geometry.measure', inputs: { bodyId: summary.bodies[0].bodyId || summary.bodies[0].id } });
        assert.ok(Math.abs(measure.volume - 6000) < 1e-6);
        assert.deepEqual(fixture.tools, ['query_model', 'primitive__box']);
        assert.equal(fixture.requests.length, 3);
        assert.deepEqual(fixture.errors, []);
        await page.screenshot({ path: path.join(artifacts, 'sealed-sdk-created.png'), fullPage: true });
    });
    await check('native SDK tool receipts stay collapsed and can reveal their actual request/result without duplicates', async () => {
        const rows = panel.locator('.pi-agent-message.tool');
        assert.equal(await rows.count(), 2);
        assert.equal(await rows.locator('details[open]').count(), 0);
        const last = rows.last();
        await last.locator('summary').click();
        await last.locator('details[open] .pi-agent-message-content').waitFor();
        const detail = await last.locator('.pi-agent-message-content').innerText();
        assert.match(detail, /"width": 10/);
        assert.match(detail, /body-1/);
        await last.locator('summary').click();
        await last.locator('.pi-agent-message-content').waitFor({ state: 'detached' });
        assert.equal(await rows.count(), 2);
        assert.equal(fixture.requests.length, 3);
    });
    await check('real SDK history and controls remain readable at narrow widths without replaying the model task', async () => {
        for (const width of [900, 640]) {
            await page.setViewportSize({ width, height: 780 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.ok(await panel.getByRole('textbox', { name: '发送给 Pi Agent' }).isVisible());
            await page.screenshot({ path: path.join(artifacts, `sealed-sdk-${width}.png`), fullPage: true });
        }
        const messages = (await request('/pi/sessions/webcad-default/commands', { documentId: 'default', streamId: session.streamId, command: { type: 'get_messages' } })).response.data.messages;
        assert.ok(messages.some(message => message.role === 'toolResult' && message.toolName === 'primitive__box' && !message.isError));
        assert.equal(fixture.requests.length, 3);
        assert.deepEqual(errors, []);
    });
    verified = true;
    console.log(JSON.stringify({ passed: checks.length, backendRelease: release.releaseId, sdkVersion: release.sdk.sdkVersion, frontendRelease: frontendRelease.releaseId, browserErrors: errors, paidProviderCalls: 0, screenshots: artifacts }));
}
catch (error) {
    console.error('SDK browser acceptance failed: ' + error.stack);
    if (page)
        await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
    throw error;
}
finally {
    await browser?.close();
    let stopped = false;
    if (started) {
        const status = await manage('Stop');
        stopped = status.Services.every(service => service.State === 'stopped');
        if (ready)
            assert.equal(status.Services.find(service => service.Name === 'gateway')?.LastStopMode, 'graceful');
    }
    await fixture.close();
    validateBackendRelease(release.directory);
    if (stopped && verified) {
        assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
        assert.match(path.basename(scratch), /^cad-sdk-browser-/);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    else
        console.error('Preserved SDK browser diagnostics: ' + scratch);
}
