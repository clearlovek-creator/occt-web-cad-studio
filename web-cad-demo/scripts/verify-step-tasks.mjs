/* Real frozen UI + OCCT; gates delay replies/OS exit, never fabricate geometry. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {selectBackendRelease, validateBackendRelease} from '../gateway/backend-release.mjs';
import {selectRelease} from '../gateway/frontend-release.mjs';
import {selectNativeTestRuntime} from './test-native-runtime.mjs';
import {gatedGeometryGateway} from '../tests/helpers/gated-geometry-gateway.mjs';
import {stopTestChild} from '../tests/helpers/stop-test-child.mjs';

const root = path.resolve(import.meta.dirname, '..');
const backendRoot = path.resolve(process.env.CAD_TEST_BACKEND_RELEASE_ROOT || '.artifacts/step-task-backend-releases');
const frontendRoot = path.resolve(process.env.LOFT_UI_RELEASE_ROOT || '.artifacts/step-task-ui-releases');
const backend = selectBackendRelease(backendRoot, process.env.CAD_TEST_BACKEND_RELEASE_ID), frontend = selectRelease(frontendRoot, root), native = selectNativeTestRuntime(root);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-step-task-browser-')), data = path.join(scratch, 'data');
const artifacts = path.resolve(process.env.STEP_TASK_UI_ARTIFACTS || '.artifacts/step-task-browser-first');
fs.mkdirSync(data); fs.mkdirSync(artifacts, {recursive: true});
const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const frontendPort = server.address().port; await new Promise(resolve => server.close(resolve));
const url = `http://localhost:${frontendPort}/`;
let f, browser, page, frontendProcess, verified = false;
const checks = [], errors = [], uploads = [], control = [];
async function startFrontend() {
  frontendProcess = spawn(process.execPath, ['scripts/frontend-launch.mjs', '--release', frontend.directory, '--port', String(frontendPort), '--gateway-api', f.api], {cwd: root, windowsHide:true, stdio:['ignore','pipe','pipe']});
  let diagnostics = '', startupError;
  frontendProcess.on('error', error => startupError = error);
  frontendProcess.stdout.on('data', bytes => diagnostics = (diagnostics + bytes).slice(-16384));
  frontendProcess.stderr.on('data', bytes => diagnostics = (diagnostics + bytes).slice(-16384));
  await f.until(async () => {
    if (startupError) throw startupError;
    assert.equal(frontendProcess.exitCode, null, diagnostics);
    const health = await fetch(new URL('/__cad/health', url)).then(response => response.json()).catch(() => null);
    return health?.ok && health.releaseId === frontend.releaseId;
  }, 'Frozen frontend did not start', 20000);
}
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name); }
const strip = () => page.getByTestId('modeling-task-status');
const report = () => page.getByTestId('step-import-status');
async function state() { return {model: await f.cad('document.summary'), raw: (await f.cad('property.list')).propertyRecords, typed: (await f.cad('property.instance.list')).instances}; }
async function sameProject(before) {
  const after = await state();
  for (const key of ['stateToken', 'revision', 'bodyMetadata', 'features', 'variables', 'materials', 'coordinateSystems', 'entityIdentities']) assert.deepEqual(after.model[key], before.model[key], key);
  assert.deepEqual(after.raw, before.raw); assert.deepEqual(after.typed, before.typed);
}
async function visibleBodies(count) {
  await page.waitForFunction(expected => Number(document.querySelector('[data-testid="cad-viewport"]')?.dataset.visibleBodies) === expected, count);
  const pixels = await page.getByTestId('cad-viewport').evaluate(node => { node.dispatchEvent(new Event('cad:verify-frame')); return Number(node.dataset.renderedBodyPixels); });
  assert.ok(pixels > 100, 'Actual geometry must reach the viewport, not just the model tree');
}
async function choose(bytes, name) {
  if (await page.getByRole('button', {name: '关闭操作窗口', exact: true}).count()) await page.getByRole('button', {name: '关闭操作窗口', exact: true}).click();
  await page.getByRole('tab', {name: '工程', exact: true}).click();
  const chooser = page.waitForEvent('filechooser'); await page.locator('[data-command="file.importStep"]').click();
  await (await chooser).setFiles({name, mimeType: 'application/step', buffer: bytes});
}
async function active(phase) { await page.locator(`[data-testid="modeling-task-status"][data-phase="${phase}"]`).waitFor(); return strip().getAttribute('data-task-id'); }
async function heldImport(bytes, name) {
  const before = (await f.cad('document.summary')).bodyCount;
  const at = f.events.length; f.tell('arm-step'); await f.event('step-armed', at); await choose(bytes, name);
  assert.equal((await f.event('step-held', at)).bodyCount, before + 2);
  return {at, taskId: await active('executing')};
}
async function cancelHeld(at) {
  f.tell('arm-geometry-exit'); await f.event('geometry-exit-armed', at);
  await strip().getByRole('button', {name: '取消操作', exact: true}).click();
  await f.event('geometry-exit-held', at); await active('stopping');
  assert.equal(await strip().getByRole('button', {name: '取消操作', exact: true}).isDisabled(), true);
  f.tell('release-geometry-exit'); await active('cancelled');
  await strip().getByText('此操作未提交，原工程已恢复。', {exact: true}).waitFor();
}
try {
  f = await gatedGeometryGateway(data, {CAD_TEST_GATEWAY_RELEASE_ROOT: backendRoot, CAD_TEST_GATEWAY_RELEASE_ID: backend.releaseId, WEB_ORIGIN: new URL(url).origin, GEOMETRY_WORKER_TIMEOUT_MS: '30000', GEOMETRY_WORKER_STOP_TIMEOUT_MS: '10000', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1'});
  await f.cad('primitive.box', {width: 7, depth: 8, height: 9}, {}, 'source');
  await f.cad('primitive.sphere', {radius: 2, x: 30}, {}, 'source');
  assert.equal((await f.post('/documents/source/exports/step', {})).value.ok, true);
  const download = await fetch(f.api + '/exports/source/download'); assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  const body = await f.cad('primitive.box', {width: 10, depth: 20, height: 30});
  const type = await f.cad('property.type.create', {key: 'StepBrowserData', association: 'required', targetScope: 'body', fields: [{key: 'enabled', type: 'bool'}]});
  await f.cad('property.instance.create', {typeId: type.type.typeId, value: {enabled: true}, target: {kind: 'body', bodyId: body.bodyId}});
  await f.cad('property.set', {key: 'stepBrowserMarker', type: 'int', value: 39}, {kind: 'body', bodyId: body.bodyId});
  await f.cad('variable.set', {name: 'stepBrowserSize', type: 'length', expression: '12 mm'});
  const baseline = await state();
  await startFrontend();
  browser = await chromium.launch({executablePath: process.env.WORKBENCH_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  page = await browser.newPage({viewport: {width: 1440, height: 1000}}); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes('/modeling-tasks')) control.push({path: pathname, method: request.method()});
    if (request.method() === 'POST' && pathname.endsWith('/imports/step')) uploads.push({taskId: request.headers()['x-cad-task-id'], requestId: request.headers()['x-request-id']});
  });
  await page.addInitScript(() => { localStorage.setItem('occt.activeDocumentId', 'default'); sessionStorage.setItem('occt.activeDocumentId', 'default'); });
  await page.goto(url, {waitUntil: 'networkidle'}); await visibleBodies(1);
  await check('opening the frozen workbench reads STEP task state without importing or registering anything', async () => {
    assert.equal(uploads.length, 0); assert.equal((await f.get('/documents/default/modeling-tasks')).tasks.length, 0); await sameProject(baseline);
  });
  await check('partial upload uses one readable task strip and keyboard cancel waits for real upload cleanup without entering OCCT', async () => {
    let upstream, release, completed; const held = new Promise(resolve => release = resolve), handled = new Promise(resolve => completed = resolve), at = f.events.length;
    const handler = async route => {
      const headers = {...route.request().headers(), 'content-length': String(bytes.length)}; delete headers.host; delete headers.connection;
      upstream = httpRequest(f.api + '/documents/default/imports/step', {method: 'POST', headers}, response => response.resume());
      upstream.on('error', () => {}); upstream.write(bytes.subarray(0, 100));
      try {
        await held;
        // Cancelling the real upstream can already close the browser request.
        // Only that expected closure is tolerated, not arbitrary route failures.
        await route.abort('failed').catch(error => { if (!error.message.includes('Route is already handled')) throw error; });
      } finally { completed(); }
    };
    await page.route('**/imports/step', handler);
    try {
      const name = '接收中_工业零件_2026_装配空间与源文件身份验证.step'; await choose(bytes, name); await active('receiving');
      await strip().getByText('STEP 导入 · ' + name, {exact: true}).waitFor(); assert.equal(await report().count(), 0);
      const cancel = strip().getByRole('button', {name: '取消操作', exact: true});
      for (const width of [1440, 640]) {
        await page.setViewportSize({width, height: 1000});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.ok((await cancel.boundingBox()).height >= 40); await page.screenshot({path: path.join(artifacts, `receiving-${width}.png`), fullPage: true});
      }
      await page.setViewportSize({width: 1440, height: 1000}); await cancel.focus(); await page.keyboard.press('Enter'); await active('cancelled');
      await strip().getByText('该命令未执行。', {exact: true}).waitFor();
      assert.equal(f.events.slice(at).some(item => item.type === 'fixture.native-request' && item.operation === 'step.import'), false);
      assert.deepEqual(fs.readdirSync(path.join(data, 'pending-step-inputs')), []); await sameProject(baseline);
    } finally { upstream?.destroy(); release(); if (upstream) await handled; await page.unroute('**/imports/step', handler); }
    await f.until(() => (f.events.filter(item => item.type === 'fixture.native-request' && item.operation === 'step.import').length === 0), 'Unexpected native STEP');
  });
  await check('malformed STEP shows confirmed restoration in the common task strip and preserves the complete existing project', async () => {
    const count = uploads.length; await choose(Buffer.from('not a STEP file'), '格式错误.step'); await active('failed');
    await strip().getByText('此操作未提交，原工程已恢复。', {exact: true}).waitFor(); assert.equal(uploads.length, count + 1);
    assert.equal(await report().count(), 0); await visibleBodies(1); await sameProject(baseline);
    await strip().locator('summary').click(); assert.ok((await strip().locator('dd').last().innerText()).length > 0);
    await strip().screenshot({path: path.join(artifacts, 'failed-restored.png')});
  });
  await check('cancelling real converted geometry waits for OS exit and restores typed properties, variables, history and viewport', async () => {
    const {at, taskId} = await heldImport(bytes, '转换中取消.step'); assert.equal(uploads.at(-1).taskId, taskId);
    assert.equal(await report().count(), 0); await cancelHeld(at); await sameProject(baseline); await visibleBodies(1);
    assert.deepEqual(fs.readdirSync(path.join(data, 'pending-step-inputs')), []); assert.deepEqual(fs.readdirSync(path.join(data, 'imports')), []);
  });
  await check('durable STEP publication disables cancel, reports two new Bodies and renders the original Body alongside them', async () => {
    const {at} = await heldImport(bytes, '提交边界.step'); f.tell('arm-task-commit'); await f.event('task-commit-armed', at); f.tell('release-geometry');
    await f.event('task-commit-held', at); await active('committing');
    assert.equal(await strip().getByRole('button', {name: '取消操作', exact: true}).isDisabled(), true);
    await strip().getByText('正在写入完整工程，暂不可取消。', {exact: true}).waitFor();
    await strip().screenshot({path: path.join(artifacts, 'committing.png')}); f.tell('release-geometry');
    await visibleBodies(3); await report().waitFor(); assert.equal((await state()).model.bodyCount, 3);
    await report().getByText(/导入报告 · 2 个 Body/).waitFor();
  });
  await check('a lost successful upload response recovers its original receipt without a second upload and updates the viewport', async () => {
    const count = uploads.length, handler = async route => { await route.fetch(); await route.abort('failed'); };
    await page.route('**/imports/step', handler);
    try {
      await choose(bytes, '回执恢复.step');
      await f.until(async () => uploads.length === count + 1 && control.some(item => item.path.endsWith('/' + uploads.at(-1).taskId + '/result')), 'Original task receipt was not requested');
      await report().getByText('回执恢复.step', {exact: true}).waitFor(); await visibleBodies(5); assert.equal(uploads.length, count + 1);
      const result = await f.get('/documents/default/modeling-tasks/' + uploads.at(-1).taskId); assert.equal(result.modelingTask.phase, 'succeeded');
      const identity = uploads.at(-1);
      const journal = page.getByTestId('command-journal');
      const journalButton = page.getByRole('button', {name:/^命令日志/});
      await journalButton.click();
      const entry = journal.locator('details').filter({hasText:identity.taskId});
      await entry.locator('summary').getByText(/^完成/).waitFor();
      assert.equal(await entry.count(), 1);
      assert.ok((await entry.textContent()).includes(identity.requestId));
      await journalButton.click();
    } finally { await page.unroute('**/imports/step', handler); }
  });
  await check('undo and redo affect only the latest STEP append while the original Body stays in the viewport', async () => {
    const before = await state();
    await page.getByRole('tab', {name:'工程',exact:true}).click();
    await page.locator('[data-command="edit.undo"]').click();
    await visibleBodies(3);
    const undone = await state();
    assert.deepEqual(undone.model.features, before.model.features.slice(0,-1));
    assert.deepEqual(undone.raw, baseline.raw);
    assert.deepEqual(undone.typed, baseline.typed);
    await page.locator('[data-command="edit.redo"]').click();
    await visibleBodies(5);
    assert.deepEqual((await state()).model.features, before.model.features);
  });
  await check('page reload restores the same converting task and cancellation does not upload or execute STEP again', async () => {
    const before = await state(), count = uploads.length, sources = fs.readdirSync(path.join(data, 'imports'));
    const {at, taskId} = await heldImport(bytes, '刷新后取消.step');
    await page.reload({waitUntil: 'domcontentloaded'});
    const journal = page.getByTestId('command-journal');
    const journalButton = page.getByRole('button', {name:/^命令日志/});
    await journalButton.click();
    const entry = journal.locator('details').filter({hasText:taskId});
    await entry.locator('summary').click();
    const lookup = page.waitForRequest(request => new URL(request.url()).searchParams.get('requestId') === uploads.at(-1).requestId
      && new URL(request.url()).pathname.endsWith('/command-journal'));
    await entry.getByRole('button', {name:'核对结果'}).click();
    assert.equal((await lookup).method(), 'GET');
    await journal.getByText('原请求仍在执行。', {exact:true}).waitFor();
    await journalButton.click();
    await page.locator(`[data-testid="modeling-task-status"][data-task-id="${taskId}"][data-phase="executing"]`).waitFor();
    assert.equal(uploads.length, count + 1); await cancelHeld(at); await sameProject(before); await visibleBodies(5);
    assert.equal(uploads.length, count + 1); assert.deepEqual(fs.readdirSync(path.join(data, 'imports')), sources);
    for (const width of [1440, 640]) { await page.setViewportSize({width, height: 1000}); await page.screenshot({path: path.join(artifacts, `cancelled-${width}.png`), fullPage: true}); }
  });
  assert.deepEqual(errors, []); validateBackendRelease(backend.directory); verified = true;
  const result = {ok: true, passed: checks.length, checks, backend: backend.releaseId, frontend: frontend.releaseId, nativeSha256: backend.native.sha256, testManifestSha256: native.manifestSha256, browserErrors: errors, paidProviderCalls: 0, scope: 'Frozen frontend/backend with real OCCT STEP conversion, streamed partial upload and OS exit gates; upload/native cancellation, full-project rollback, protected commit, exact receipt recovery, reload without duplicate upload and desktop/narrow task readability. Does not qualify project-file or Pi cancellation.'};
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  if (page) { await page.screenshot({path: path.join(artifacts, 'failure.png'), fullPage: true}).catch(() => {}); console.error((await page.locator('body').innerText().catch(() => '')).slice(-9000)); }
  throw error;
} finally {
  await browser?.close();
  const [frontendStop, gatewayStop] = await Promise.allSettled([stopTestChild(frontendProcess), f ? f.stop() : null]);
  const frontendStopped = frontendStop.status === 'fulfilled', code = gatewayStop.status === 'fulfilled' ? gatewayStop.value : null;
  if (verified && frontendStopped && code === 0) { assert.equal(path.dirname(scratch), path.resolve(os.tmpdir())); assert.ok(path.basename(scratch).startsWith('cad-step-task-browser-')); fs.rmSync(scratch, {recursive: true, force: true}); }
  else console.error('Preserved STEP task browser diagnostics: ' + scratch);
  if (!frontendStopped) throw frontendStop.reason;
  if (gatewayStop.status === 'rejected') throw gatewayStop.reason;
}
