const {routeGeometryApi,geometryApiUrl}=require('./browser-api-route.cjs');
/* Real-browser regression on an isolated gateway. Never mutates the user's project. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {stopTestChild}=require('../tests/helpers/stop-test-child.mjs');
const {backendTestArguments}=require('../tests/helpers/backend-test-runtime.mjs');
const {decodeProjectPackage}=require('../gateway/project-package.mjs');
const { ObservedCommandClient } = require('../tests/helpers/observed-command-client.mjs');
const observedClient = new ObservedCommandClient();
function loadBrowserDriver() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean);
  for (const candidate of candidates) { try { return require(candidate); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; } }
  throw new Error('Playwright is unavailable. Install it locally or set PLAYWRIGHT_MODULE to its module path.');
}
const { chromium } = loadBrowserDriver();
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-workbench-ui-'));
const gatewayPort = process.env.WORKBENCH_TEST_GATEWAY_PORT || '8859';
const api = `http://127.0.0.1:${gatewayPort}/api`;
const workbenchUrl = process.env.WORKBENCH_URL || 'http://localhost:3000/';
const screenshots = path.resolve(process.env.WORKBENCH_BROWSER_ARTIFACTS || path.join(root, '.artifacts', 'workbench'));
fs.mkdirSync(screenshots, { recursive: true });
const passed = [];
const gateway = spawn(process.execPath, backendTestArguments(root), { cwd: root, env: { ...process.env, GEOMETRY_PORT: gatewayPort, GEOMETRY_DATA_DIR: data, WEB_ORIGIN: new URL(workbenchUrl).origin }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, page;
let diagnostics = '';
let revision = 0;
gateway.stderr.on('data', (chunk) => { diagnostics += chunk; });
async function command(operation, parameters = {}, inputs = {}) {
  const documentId = page ? (await page.locator('main.cad-shell').getAttribute('data-document-id')) || 'default' : 'default';
  const response = await fetch(api + '/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(observedClient.prepare({ operation, documentId, baseRevision: revision, parameters, inputs })) });
  const result = await response.json(); observedClient.observe(result,documentId);assert.equal(result.ok, true, JSON.stringify(result)); if (Number.isInteger(result.revision)) revision = result.revision; return result;
}
async function check(name, fn) { await fn(); passed.push(name); process.stdout.write(`PASS ${name}\n`); }
async function expectEvent(promise, label, timeout = 12000) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function assertModelVisible() {
  try {await page.waitForFunction(()=>{const view=document.querySelector('[data-testid="cad-viewport"]');return Number(view.dataset.attachedBodies)>0 && Number(view.dataset.visibleBodies)>0 && Number(view.dataset.frustumBodies)>0 && Number(view.dataset.renderedTriangles)>0;},{},{timeout:8000});
    const pixels=await page.getByTestId('cad-viewport').evaluate(node=>{node.dispatchEvent(new Event('cad:verify-frame'));return Number(node.dataset.renderedBodyPixels);});
    assert.ok(pixels>100,`Actual Body pixels must be rendered, received ${pixels}`);
  }
  catch(error){console.error('Viewport diagnostics:',await page.getByTestId('cad-viewport').evaluate(node=>({...node.dataset})));throw error;}
}
(async () => {
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Isolated gateway startup timeout: ' + diagnostics)), 20000); gateway.once('error', reject); gateway.stdout.on('data', (chunk) => { if (chunk.includes('Geometry gateway ready')) { clearTimeout(timer); resolve(); } }); });
    const box = await command('primitive.box', { width: 20, depth: 20, height: 20, reset: true });
    const cylinder = await command('primitive.cylinder', { radius: 5, height: 15, x: 30 });
    await command('material.set', { name: 'FR4', category: 'dielectric', relativePermittivity: 4.4, conductivity: 0, color: '#c9aa64' });
    await command('body.update', { material: 'FR4', name: 'Substrate' }, { bodyId: box.bodyId });
    await command('variable.set', { name: 'boardWidth', type: 'length', expression: '50 mm' });
    await command('coordinate.set', { id: 'local_test', name: 'Local Test', kind: 'cartesian', origin: [4, 5, 6], xAxis: [1, 0, 0], yAxis: [0, 1, 0] });
    const faceId = box.triangleFaceIds[0];
    const wave = await command('property.type.create', { key: 'WavePort', name: 'WavePort', targetScope: 'face', association: 'required', fields: [{ key: 'frequency', label: '频率', type: 'double', required: true }, { key: 'enabled', label: '启用', type: 'bool' }, { key: 'modes', label: '模式数', type: 'int' }, { key: 'offset', label: '偏移表达式', type: 'expression' }, { key: 'axis', label: '方向', type: 'vector3' }, { key: 'mode', label: '模式', type: 'enum', options: ['TE', 'TM'] }] });
    const port = await command('property.instance.create', { typeId: wave.type.typeId, name: 'Port1', value: { frequency: 3, enabled: true, modes: 2, offset: 'boardWidth / 2', axis: [1, 0, 0], mode: 'TE' }, target: { kind: 'face', bodyId: box.bodyId, topologyId: faceId } });
    await command('property.instance.create', { typeId: wave.type.typeId, name: 'Port2', value: { frequency: 6 }, target: { kind: 'face', bodyId: box.bodyId, topologyId: faceId } });
    const solver = await command('property.type.create', { key: 'SolverSetup', name: '求解设置', targetScope: 'project', association: 'none', fields: [{ key: 'frequency', label: '求解频率', type: 'double', required: true }] });
    await command('property.instance.create', { typeId: solver.type.typeId, name: 'Setup1', value: { frequency: 3 }, target: null });
    const installedChrome = process.env.WORKBENCH_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    browser = await chromium.launch({ ...(fs.existsSync(installedChrome) ? { executablePath: installedChrome } : {}), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    // Continue the request to the isolated gateway instead of route.fetch():
    // route.fetch buffers SSE forever and can reject when the browser closes.
    await routeGeometryApi(page,api);
    await page.goto(workbenchUrl, { waitUntil: 'networkidle' });
    await page.locator('[data-body-id="' + box.bodyId + '"]').waitFor();
    await assertModelVisible();
    const project = page.getByTestId('project-tree');
    const geometry = page.getByTestId('feature-tree');
    const close = async () => { const button = page.getByRole('button', { name: '关闭操作窗口', exact: true }); if (await button.count()) await button.click(); };
    await check('one-line viewport controls and a usable narrow viewport with the assistant', async () => {
      await page.setViewportSize({ width: 1600, height: 960 });
      const centerY = async (locator) => { const r = await locator.boundingBox(); assert.ok(r); return r.y + r.height / 2; };
      const projection = page.getByLabel('投影方式', { exact: true });
      const frame = page.getByLabel('构造坐标系', { exact: true });
      const step = page.getByLabel('构造平面吸附步长', { exact: true });
      const settings = page.getByRole('button', { name:'面板设置', exact:true });
      const y = await centerY(projection);
      for (const control of [frame, step, settings]) assert.ok(Math.abs(await centerY(control) - y) < 3);
      await page.setViewportSize({ width: 390, height: 760 });
      const assistant = page.getByRole('button', { name:'AI 助手', exact:true });
      await page.route('**/api/pi/sessions**', route => route.fulfill({ status:503, json:{ok:false,error:'fixture'} }));
      await assistant.click();
      const screen = await page.getByTestId('cad-viewport').boundingBox();
      assert.ok(screen.height >= 255, `narrow viewport height = ${screen.height}px`);
      await step.scrollIntoViewIfNeeded();
      assert.ok(await page.locator('.view-tabs').evaluate(el => el.scrollLeft > 0));
      await settings.click();
      await page.getByRole('button', { name:'恢复全部面板', exact:true }).click();
      await page.unroute('**/api/pi/sessions**');
      await page.setViewportSize({ width: 1440, height: 960 });
      await assertModelVisible();
    });
    await check('tree menu toggle and Escape leave the active editor open', async () => {
      const more = project.locator('.tree-more').first();
      await more.click();
      assert.equal(await more.getAttribute('aria-expanded'), 'true');
      await more.click();
      assert.equal(await more.getAttribute('aria-expanded'), 'false');
      await page.locator('[data-command="primitive.box"]').click();
      await page.getByTestId('cad-viewport').focus();
      await page.keyboard.press('Shift+F10');
      const menu = page.getByRole('menu', { name:'视口操作' });
      await menu.waitFor();
      await page.keyboard.press('End');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), '清除选择');
      await page.keyboard.press('Escape');
      await menu.waitFor({ state:'detached' });
      assert.ok(await page.getByTestId('operation-window').isVisible());
      await close();
    });
    await check('handoff ribbon categories, single-row tools and ordered project tree', async () => {
      const tabs = ['工程','建模','变换','布尔','特征','网格','检查','修复','分析','测量','视图','数据','工具','扩展'];
      assert.deepEqual(await page.getByRole('tab').allTextContents(), tabs);
      assert.deepEqual(await project.locator('.studio-project-branches > li > .managed-tree-row strong').allTextContents(), ['变量','几何','材料','坐标系','属性类型']);
      assert.equal(await page.locator('[data-command^="primitive."]').count(), 9);
      assert.equal(await page.locator('[data-command^="surface."]').count(), 5);
      assert.deepEqual(await page.locator('.workbench-tool-group > small').allTextContents(), ['基础体','基础面','生成几何']);
      const rows = await page.locator('.ribbon-tools').first().evaluate(node => new Set([...node.children].map(item => Math.round(item.getBoundingClientRect().top))).size);
      assert.equal(rows, 1);
      for (const tab of tabs) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        const toolGroups = await page.locator('.workbench-tool-group').evaluateAll(groups => groups.map(group => Array.from(group.querySelectorAll('button'), button => button.dataset.command)));
        assert.ok(toolGroups.length > 0 && toolGroups.every(commands => commands.length > 0 && commands.every(Boolean)), tab);
      }
      await page.getByRole('tab', { name: '建模', exact: true }).click();
    });
    await check('viewport projection, wireframe and pane restoration', async () => {
      const viewport = page.getByTestId('cad-viewport');
      const projection = page.getByLabel('投影方式');
      const display = page.getByLabel('模型显示模式');
      await projection.selectOption('orthographic');
      await page.getByRole('button', { name: '顶视图', exact: true }).click();
      assert.equal(await viewport.getAttribute('data-projection'), 'orthographic');
      await display.selectOption('wire');
      await page.waitForFunction(() => document.querySelector('[data-testid="cad-viewport"]')?.dataset.renderedTriangles === '0');
      const wirePixels = await viewport.evaluate(node => { node.dispatchEvent(new Event('cad:verify-frame')); return Number(node.dataset.renderedBodyPixels); });
      assert.ok(wirePixels > 50, 'line mode should render the model edges');
      await display.selectOption('edges');
      await projection.selectOption('perspective');
      await page.getByRole('button', { name: '轴测视图', exact: true }).click();
      const capture = page.waitForEvent('download');
      await page.getByRole('button', { name: '截图', exact: true }).click();
      assert.equal((await capture).suggestedFilename(), 'OCCT_Web_Studio_Viewport.png');
      const before = await viewport.boundingBox();
      for (const name of ['隐藏工程管理', '隐藏属性面板', '隐藏命令面板', '隐藏消息面板']) await page.getByRole('button', { name, exact: true }).click();
      const after = await viewport.boundingBox();
      assert.ok(after.width > before.width + 500 && after.height > before.height + 100);
      await page.getByRole('button', { name: '面板设置', exact: true }).click();
      await page.getByRole('button', { name: '恢复全部面板', exact: true }).click();
      await assertModelVisible();
    });
    await check('both trees visible; instances nested only under their type', async () => { assert.ok(await project.isVisible()); assert.ok(await geometry.isVisible()); const type = project.getByRole('button', { name: /WavePort/ }).filter({ has: page.locator('strong') }).first(); assert.ok(await type.isVisible()); const branch = project.locator('li').filter({ has: page.locator('button strong', { hasText: /^WavePort$/ }) }).last(); assert.equal(await branch.getByRole('button', { name: /Port[12]/ }).count(), 4); assert.equal(await geometry.getByText('Port1', { exact: true }).count(), 0); });
    await check('materials group bodies without losing feature history', async () => { assert.equal(await geometry.locator('[data-material="FR4"] [data-body-id="' + box.bodyId + '"]').count(), 1); assert.equal(await geometry.locator('[data-material="unassigned"] [data-body-id="' + cylinder.bodyId + '"]').count(), 1); assert.ok(await geometry.locator('[data-body-id="' + box.bodyId + '"] .body-feature-list').isVisible()); });
    await page.screenshot({ path: path.join(screenshots, 'desktop.png'), fullPage: true });
    await check('primitive direct buttons open the correct expression fields', async () => { await page.locator('[data-command="primitive.cylinder"]').click(); assert.equal(await page.getByTestId('advanced-modeling-panel').locator('select[aria-label="基础体类型"]').isVisible(), false); assert.equal(await page.getByTestId('advanced-modeling-panel').locator('select[aria-label="基础体类型"]').inputValue(), 'cylinder'); assert.ok(await page.getByText('半径', { exact: true }).isVisible()); await close(); });
    await check('face-dependent tools preserve their input and volume measures the owning solid', async () => {
      await project.getByRole('button', { name: /Port1 face/ }).click();
      await page.getByTestId('selection-readout').getByText(`面拾取 · ${faceId}`, {exact:true}).waitFor();
      await page.locator('[data-command="feature.revolve"]').click();
      const editor = page.getByTestId('operation-window');
      await editor.getByText(faceId, {exact:false}).first().waitFor();
      await close();
      await page.getByRole('tab',{name:'分析',exact:true}).click();
      await page.locator('[data-command="analysis.volume"]').click();
      const measurement = page.getByTestId('measurement-panel');
      assert.equal(await measurement.locator('.measurement-target strong').textContent(), `体 · ${box.bodyId}`);
      await measurement.getByTestId('run-measure').click();
      await measurement.locator('[data-metric="volume"]').waitFor();
      await close();
      await page.getByRole('tab',{name:'建模',exact:true}).click();
    });
    await check('shape check results remain scoped to the geometry that was checked', async () => {
      await geometry.locator('[data-body-id="' + box.bodyId + '"] .body-tree-label').click();
      await page.getByRole('tab',{name:'检查',exact:true}).click();
      await page.locator('[data-command="analysis.shapeCheck"]').click();
      await page.getByTestId('run-shape-check').click();
      const editor = page.getByTestId('operation-window');
      await editor.locator('dl.model-info').waitFor();
      await geometry.locator('[data-body-id="' + cylinder.bodyId + '"] .body-tree-label').click();
      await editor.locator('dl.model-info').waitFor({ state:'detached' });
      await close();
      await page.getByRole('tab',{name:'建模',exact:true}).click();
    });
    await check('instance edits restore typed values and immutable keys', async () => { await project.getByRole('button', { name: /Port1 工程属性|Port1 face/ }).dblclick(); const panel = page.getByTestId('property-schema-panel'); await panel.getByLabel('频率', { exact: true }).waitFor(); assert.equal(await panel.getByLabel('频率', { exact: true }).inputValue(), '3'); assert.equal(await panel.getByLabel('启用', { exact: true }).isChecked(), true); assert.equal(await panel.getByLabel('偏移表达式').inputValue(), 'boardWidth / 2'); assert.equal(await panel.getByLabel('方向', { exact: true }).inputValue(), '1, 0, 0'); assert.equal(await panel.getByLabel('属性类型', { exact: true }).isDisabled(), true); assert.equal(await panel.locator('input[aria-label*="Key"]').count(), 0); await panel.getByLabel('频率', { exact: true }).fill('4.5'); await panel.getByRole('button', { name: '保存实例', exact: true }).click(); await page.getByText('实例已保存，工程树已同步。').waitFor(); const listed = await command('property.instance.list'); assert.equal(listed.instances.find((item) => item.instanceId === port.instance.instanceId).value.frequency, 4.5); await close(); });
    await check('project data double-click restores only that record', async () => { await project.locator('button.managed-record').filter({ has: page.locator('strong', { hasText: /^boardWidth$/ }) }).dblclick(); const panel = page.getByTestId('project-data-variables'); assert.equal(await panel.getByRole('textbox').nth(0).inputValue(), 'boardWidth'); assert.equal(await panel.getByRole('textbox').nth(1).inputValue(), '50 mm'); assert.equal(await panel.locator('.project-data-list').count(), 0); await close(); });
    await check('right-click and keyboard menus work with protected data', async () => { await project.getByRole('button', { name: /Global/ }).first().click({ button: 'right' }); const menu = page.getByRole('menu', { name: 'Global操作' }); await menu.waitFor(); assert.equal(await menu.getByRole('menuitem', { name: /删除/ }).isDisabled(), true); await page.keyboard.press('Escape'); assert.equal(await menu.count(), 0); await project.getByRole('button', { name: '变量操作', exact: true }).focus(); await page.keyboard.press('Shift+F10'); await page.getByRole('menu', { name: '变量操作' }).waitFor(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); });
    await check('Body row is legible and material edits preserve ID, selection and history', async () => {
      const body = geometry.locator('[data-body-id="' + box.bodyId + '"]');
      const name = body.locator('.body-tree-label strong');
      const row = body.locator('.body-tree-node');
      const rowBounds = await row.boundingBox(); const historyBounds = await body.locator('.body-feature-list').boundingBox();
      assert.ok(rowBounds.height <= 20 && historyBounds.y >= rowBounds.y + rowBounds.height - 1);
      assert.equal(await body.locator('.feature-tree-label strong').first().textContent(), 'createBox');
      assert.ok(await name.isVisible()); assert.ok((await name.boundingBox()).width > 70);
      const foreground = await name.evaluate((node) => getComputedStyle(node).color); assert.notEqual(foreground, 'rgb(255, 255, 255)');
      await body.locator('.body-tree-label').dblclick();
      await page.getByLabel('Body 材料', { exact: true }).selectOption('Copper');
      await page.getByRole('button', { name: '保存几何设置', exact: true }).click();
      await geometry.locator('[data-material="Copper"] [data-body-id="' + box.bodyId + '"]').waitFor();
      assert.equal(await body.getAttribute('aria-selected'), 'true');
      assert.ok(await body.locator('.body-feature-list').isVisible()); await close();
    });
    await check('new property type and multiple instances are created from their type node', async () => {
      await project.getByRole('button', { name: '属性类型操作', exact: true }).click(); await page.getByRole('menuitem', { name: '新增属性类型', exact: true }).click();
      const manager = page.getByTestId('property-type-manager');
      await manager.getByLabel('属性类型 Key', { exact: true }).fill('ThermalSetup');
      await manager.getByLabel('属性类型名称', { exact: true }).fill('热设置');
      await manager.getByRole('button', { name: /添加属性/ }).click();
      await manager.getByLabel('字段 1 Key', { exact: true }).fill('temperature');
      await manager.getByLabel('字段 1 名称', { exact: true }).fill('温度');
      await manager.getByRole('button', { name: '创建类型', exact: true }).click();
      await project.getByRole('button', { name: '热设置操作', exact: true }).waitFor(); await close();
      for (const [index, value] of [300, 350].entries()) {
        await project.getByRole('button', { name: '热设置操作', exact: true }).click(); await page.getByRole('menuitem', { name: '新增实例', exact: true }).click();
        const panel = page.getByTestId('property-schema-panel'); await panel.getByLabel('温度', { exact: true }).fill(String(value));
        await panel.getByLabel('属性实例名称').fill('Thermal' + (index + 1)); await panel.getByRole('button', { name: '创建实例', exact: true }).click();
        await project.getByRole('button', { name: 'Thermal' + (index + 1) + '操作', exact: true }).waitFor(); await close();
      }
      await project.getByRole('button', { name: 'Thermal1操作', exact: true }).click(); await page.getByRole('menuitem', { name: '删除实例', exact: true }).click();
      await project.getByRole('button', { name: 'Thermal1操作', exact: true }).waitFor({ state: 'detached' });
      assert.ok(await project.getByRole('button', { name: 'Thermal2操作', exact: true }).isVisible());
    });
    await check('property-only Undo and Redo refresh project instances without changing geometry or its revision',async()=>{
      const before=await command('document.summary'),actions=page.locator('.desktop-titlebar');
      await actions.getByRole('button',{name:'撤销',exact:true}).click();await project.getByRole('button',{name:'Thermal1操作',exact:true}).waitFor();
      const restored=await command('document.summary');assert.equal(restored.revision,before.revision);assert.deepEqual(restored.entityIdentities,before.entityIdentities);assert.equal(restored.bodyCount,before.bodyCount);await assertModelVisible();
      await project.locator('button.managed-record').filter({has:page.locator('strong',{hasText:/^Thermal1$/})}).dblclick();const panel=page.getByTestId('property-schema-panel');await panel.getByLabel('温度',{exact:true}).waitFor();assert.equal(await panel.getByLabel('温度',{exact:true}).inputValue(),'300');await close();
      await actions.getByRole('button',{name:'重做',exact:true}).click();await project.getByRole('button',{name:'Thermal1操作',exact:true}).waitFor({state:'detached'});assert.ok(await project.getByRole('button',{name:'Thermal2操作',exact:true}).isVisible());
      assert.equal((await command('document.summary')).revision,before.revision);await page.screenshot({path:path.join(screenshots,'property-history-undo-redo.png'),fullPage:true});
    });
    await check('coordinate editor restores axes and origin; material custom fields persist', async () => {
      await project.locator('button.managed-record').filter({ has: page.locator('strong', { hasText: /^Local Test$/ }) }).dblclick();
      const panel = page.getByTestId('project-data-coordinates'); assert.equal(await panel.getByRole('textbox').nth(2).inputValue(), '4, 5, 6');
      assert.equal(await panel.getByRole('textbox').nth(3).inputValue(), '1, 0, 0'); assert.equal(await panel.getByRole('textbox').nth(4).inputValue(), '0, 1, 0'); await close();
      await project.locator('button.managed-record').filter({ has: page.locator('strong', { hasText: /^FR4$/ }) }).dblclick();
      const material = page.getByTestId('project-data-materials'); await material.getByRole('button', { name: '添加属性', exact: true }).click();
      await material.getByLabel('属性 Key', { exact: true }).fill('lossTangent'); await material.getByLabel('属性值', { exact: true }).fill('0.02');
      await material.getByRole('button', { name: '保存材料', exact: true }).click(); await material.getByText('材料 FR4 已保存。', { exact: true }).waitFor();
      const summary = await command('document.summary'); assert.equal(summary.materials.find((item) => item.name === 'FR4').customProperties.lossTangent.value, 0.02); await close();
    });
    await check('conformal mesh stays hidden initially and uses one grid icon per Body', async () => {
      await page.getByRole('tab', { name: '网格', exact: true }).click(); await page.locator('[data-command="analysis.mesh"]').click();
      const mesh = page.getByTestId('mesh-workbench-panel'); const meshResponse = page.waitForResponse((response) => response.url().includes('/documents/default/mesh/jobs') && response.request().method() === 'POST'); await mesh.getByRole('button', { name: '开始剖分（结果默认隐藏）', exact: true }).click();
      let meshPayload = await (await meshResponse).json(); assert.equal(meshPayload.meshJob.selection.kind, 'all');
      assert.equal(meshPayload.mesh,undefined,'Background submission must not pretend the mesh already exists');
      await mesh.locator('.mesh-job-card').waitFor({ timeout: 60000 });
      meshPayload = await (await fetch(api+'/mesh/jobs/'+meshPayload.meshJob.jobId)).json();assert.equal(meshPayload.meshJob.state,'complete');
      await mesh.getByRole('status',{name:'网格有效性'}).filter({hasText:'有效'}).waitFor();
      const icons = geometry.locator('.body-mesh-visibility-button'); assert.equal(await icons.count(), 2); assert.equal(await icons.first().getAttribute('aria-pressed'), 'false');
      assert.equal(await icons.first().locator('svg path').count(), 1);
      await icons.first().click(); await geometry.locator('.body-mesh-visibility-button[aria-pressed="true"]').waitFor(); assert.equal(await icons.first().getAttribute('aria-pressed'), 'true');
      await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups)>0);
      const body = geometry.locator('[data-body-id="' + box.bodyId + '"]'); await body.locator('.body-visibility-button').click(); await body.locator('.body-visibility-button[aria-pressed="false"]').waitFor();
      await body.locator('.body-visibility-button').click(); await body.locator('.body-visibility-button[aria-pressed="true"]').waitFor(); assert.equal(await body.locator('.body-mesh-visibility-button').getAttribute('aria-pressed'), 'true');
      await mesh.getByRole('button', { name: '展开文件级工具', exact: true }).click(); await mesh.locator('.mesh-advanced select').selectOption('quality'); await mesh.locator('.mesh-advanced input').fill(meshPayload.mesh.outputPath);
      await mesh.getByRole('button', { name: '运行文件级工具', exact: true }).click(); await mesh.getByText('质量分析完成', { exact: true }).waitFor();
      await close(); await page.getByRole('tab', { name: '建模', exact: true }).click(); await page.screenshot({ path: path.join(screenshots, 'mesh-icons.png'), fullPage: true });
    });
    await check('CAD face provenance lists split surfaces and current property values without altering geometry or mesh visibility',async()=>{
      const before=await command('document.summary');await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
      const mesh=page.getByTestId('mesh-workbench-panel'),boundary=mesh.locator('.mesh-boundary-panel');await boundary.locator(':scope > summary').click();
      await boundary.getByRole('table',{name:'CAD 面与网格面对应'}).waitFor();await boundary.getByLabel('面来源 Body',{exact:true}).selectOption(box.bodyId);
      const row=boundary.getByRole('row').filter({hasText:faceId});await row.getByText('Port1 · WavePort',{exact:true}).waitFor();
      await row.getByText('Port1 · WavePort',{exact:true}).click();await row.locator('dd').filter({hasText:/^4\.5$/}).waitFor();
      const viewport=page.getByTestId('cad-viewport'),visible=await viewport.getAttribute('data-rendered-mesh-groups');
      await row.getByRole('button',{name:`定位 CAD 面 ${box.bodyId} ${faceId}`,exact:true}).click();await boundary.getByLabel('当前 CAD 面网格来源').filter({hasText:faceId}).waitFor();
      assert.ok(await viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-selection'));return Number(node.dataset.selectedFacePixels);})>10,'Locating a CAD source face must draw its actual highlighted geometry');
      assert.equal(await viewport.getAttribute('data-rendered-mesh-groups'),visible,'Inspecting CAD face ownership must not change mesh visibility');
      const body=geometry.locator('[data-body-id="'+box.bodyId+'"]');await body.locator('.body-visibility-button').click();await body.locator('.body-visibility-button[aria-pressed="false"]').waitFor();assert.equal(await row.getByRole('button',{name:/^定位 CAD 面 /}).isDisabled(),true);
      await body.locator('.body-visibility-button').click();await body.locator('.body-visibility-button[aria-pressed="true"]').waitFor();
      assert.equal((await command('document.summary')).revision,before.revision+2,'Only the explicit Body hide/show actions may change revision');
      await page.screenshot({path:path.join(screenshots,'mesh-face-provenance.png'),fullPage:true});await close();await page.getByRole('tab',{name:'建模',exact:true}).click();
    });
    await check('quality distribution filters saved tetrahedra, focuses real cells and respects hidden Bodies',async()=>{
      const before=await command('document.summary');await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
      const mesh=page.getByTestId('mesh-workbench-panel'),quality=mesh.locator('.mesh-quality-panel:not(.mesh-boundary-panel)');await quality.locator(':scope > summary').click();
      await quality.getByLabel('质量筛选阈值',{exact:true}).fill('1');await quality.getByRole('button',{name:'查询已有结果',exact:true}).click();
      await quality.getByRole('table',{name:'网格问题单元'}).waitFor();
      await quality.getByLabel('质量结果 Body',{exact:true}).selectOption(box.bodyId);
      await quality.getByRole('button',{name:/^定位单元 /}).first().waitFor();
      const query=await (await fetch(api+'/documents/default/mesh/jobs')).json(),jobId=query.jobs[0].jobId;
      const saved=await (await fetch(api+'/mesh/jobs/'+jobId+'/quality?threshold=1&bodyId='+box.bodyId+'&limit=10')).json();assert.ok(saved.total>10);
      await quality.locator('.mesh-quality-distribution > summary').click();await quality.getByRole('table',{name:'四面体质量分布'}).waitFor();
      await page.screenshot({path:path.join(screenshots,'mesh-quality-distribution.png'),fullPage:true});await quality.locator('.mesh-quality-distribution > summary').click();
      await quality.getByRole('button',{name:'下一页',exact:true}).click();await quality.locator('.mesh-quality-pagination').getByText(new RegExp('11–')).waitFor();
      const viewport=page.getByTestId('cad-viewport'),groupsBefore=await viewport.getAttribute('data-rendered-mesh-groups');
      const locate=quality.getByRole('button',{name:/^定位单元 /}).first();await locate.click();
      await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.highlightedQualityElements==='1');
      const pixels=await viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-quality'));return Number(node.dataset.qualityHighlightPixels);});assert.ok(pixels>10,'Actual selected tetrahedron pixels must be drawn');
      assert.equal(await viewport.getAttribute('data-rendered-mesh-groups'),groupsBefore,'Diagnostic selection must not turn on the entire mesh');
      assert.equal((await command('document.summary')).revision,before.revision,'Quality queries and focus must not mutate geometry');
      await page.screenshot({path:path.join(screenshots,'mesh-quality-located.png'),fullPage:true});
      const oldCanvas=await viewport.locator('canvas').elementHandle();await oldCanvas.evaluate(canvas=>{const extension=canvas.getContext('webgl2').getExtension('WEBGL_lose_context');extension.loseContext();setTimeout(()=>extension.restoreContext(),200);});
      await page.waitForFunction(old=>!old.isConnected,oldCanvas);await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.contextState==='ready'&&document.querySelector('[data-testid="cad-viewport"]').dataset.highlightedQualityElements==='1');
      assert.ok(await viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-quality'));return Number(node.dataset.qualityHighlightPixels);})>10,'Context recovery must rebuild the diagnostic geometry');
      const body=geometry.locator('[data-body-id="'+box.bodyId+'"]');await body.locator('.body-visibility-button').click();await body.locator('.body-visibility-button[aria-pressed="false"]').waitFor();
      await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.highlightedQualityElements==='0');assert.equal(await locate.isDisabled(),true);
      await body.locator('.body-visibility-button').click();await body.locator('.body-visibility-button[aria-pressed="true"]').waitFor();await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.highlightedQualityElements==='1');
      await page.getByRole('status',{name:'单元定位'}).getByRole('button',{name:'清除单元定位',exact:true}).click();assert.equal(await viewport.getAttribute('data-highlighted-quality-elements'),'0');
      await locate.click();await close();await page.getByRole('tab',{name:'建模',exact:true}).click();
    });
    await check('mesh query identities hide obsolete rows, reject late failures and keep nested details independent',async()=>{
      const before=await command('document.summary');await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();const mesh=page.getByTestId('mesh-workbench-panel');
      for(const kind of ['quality','boundary']){
        const panel=mesh.locator(kind==='quality'?'.mesh-quality-panel:not(.mesh-boundary-panel)':'.mesh-boundary-panel'),filter=panel.getByLabel(kind==='quality'?'质量结果 Body':'面来源 Body',{exact:true}),table=panel.getByRole('table',{name:kind==='quality'?'网格单元明细':'CAD 面与网格面对应'});
        await panel.locator(':scope > summary').click();if(kind==='quality')await panel.getByLabel('质量问题类型',{exact:true}).selectOption('all');await table.waitFor();
        let release,began,finished,held=false,reads=0;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>began=resolve),done=new Promise(resolve=>finished=resolve),pattern=`**/api/mesh/jobs/*/${kind}?*`;
        const routeQuery=async route=>{reads++;const query=new URL(route.request().url()).searchParams;
          if(query.get('bodyId')===box.bodyId&&!held){held=true;began();await gate;try{await route.fulfill({status:500,json:{ok:false,error:'obsolete filtered query failed'}});}finally{finished();}return;}
          const response=await route.fetch({url:geometryApiUrl(route.request().url(),api)});await route.fulfill({response});
        };
        await page.route(pattern,routeQuery);
        try{
          await filter.selectOption(box.bodyId);await started;assert.equal(await table.count(),0,'A new filter must hide obsolete rows while it is pending');if(kind==='quality')assert.equal(await panel.getByLabel('质量统计',{exact:true}).count(),0,'Do not relabel old statistics as the new filter');
          await filter.selectOption(cylinder.bodyId);await table.waitFor();const newest=await table.innerText();assert.ok(newest.includes(before.bodyMetadata.find(body=>body.bodyId===cylinder.bodyId).name));if(kind==='quality')assert.match(await panel.locator('.mesh-quality-list-heading').innerText(),/^单元明细/);
          release();await done;await page.waitForTimeout(50);assert.equal(await panel.getByRole('alert').count(),0);assert.equal(await table.innerText(),newest,'Late errors cannot replace the current query');
          const count=reads;if(kind==='quality'){const nested=panel.locator('.mesh-quality-distribution > summary');await nested.click();await nested.click();await page.waitForTimeout(30);assert.equal(reads,count,'Nested details must not restart their parent query');}
          await panel.locator(':scope > summary').click();await panel.locator(':scope > summary').click();await table.waitFor();assert.equal(reads,count+1,'Reopening a report performs a fresh read');
          await page.screenshot({path:path.join(screenshots,`mesh-${kind}-query-identity.png`),fullPage:true});
        }finally{release();await page.unroute(pattern,routeQuery);}
        await panel.locator(':scope > summary').click();
      }
      assert.equal((await command('document.summary')).stateToken,before.stateToken);await close();await page.getByRole('tab',{name:'建模',exact:true}).click();
    });
    await check('mesh validity is visible, stale geometry never renders old mesh, and Undo restores its exact source',async()=>{
      const feature=(await command('document.summary')).features.find(item=>item.type==='primitive.box');
      await geometry.locator(`button.feature-tree-label[title^="primitive.box · ${feature.id} ·"]`).first().dblclick();
      const editor=page.getByTestId('feature-history-controls');await editor.getByLabel('特征参数 height',{exact:true}).fill('25');
      const response=page.waitForResponse(response=>response.url().endsWith('/commands')&&response.request().postDataJSON()?.operation==='feature.update');
      await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();assert.equal((await (await response).json()).ok,true);await close();
      await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();const mesh=page.getByTestId('mesh-workbench-panel');
      await mesh.getByRole('status',{name:'网格有效性'}).filter({hasText:'已过期'}).waitFor();
      await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups)===0);assert.equal(await geometry.locator('.body-mesh-visibility-button').count(),0);
      assert.equal(await page.getByTestId('cad-viewport').getAttribute('data-highlighted-quality-elements'),'0');
      const quality=mesh.locator('.mesh-quality-panel:not(.mesh-boundary-panel)');await quality.locator(':scope > summary').click();await quality.getByLabel('质量问题类型',{exact:true}).selectOption('all');await quality.getByRole('table',{name:'网格单元明细'}).waitFor();
      assert.equal(await quality.getByRole('button',{name:/^定位单元 /}).first().isDisabled(),true);await quality.locator(':scope > summary').click();
      await page.screenshot({path:path.join(screenshots,'mesh-stale.png'),fullPage:true});
      await mesh.getByRole('button',{name:'隐藏网格',exact:true}).click();assert.equal(await mesh.getByRole('button',{name:'显示网格',exact:true}).isDisabled(),true);
      await page.getByRole('button',{name:'撤销',exact:true}).click();await mesh.locator('.mesh-validity.current').waitFor();
      await mesh.getByRole('button',{name:'显示网格',exact:true}).click();await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups)>0);
      await page.screenshot({path:path.join(screenshots,'mesh-source-restored.png'),fullPage:true});await close();await page.getByRole('tab',{name:'建模',exact:true}).click();
    });
    await check('mesh results recover across page reload without turning on their rendering',async()=>{
      const before=await command('document.summary');
      await page.reload({waitUntil:'networkidle'});await assertModelVisible();
      await geometry.locator('.body-mesh-visibility-button').first().waitFor();
      assert.equal(await geometry.locator('.body-mesh-visibility-button[aria-pressed="true"]').count(),0);
      await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups)===0);
      await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
      const mesh=page.getByTestId('mesh-workbench-panel');await mesh.locator('.mesh-job-card').waitFor();
      await mesh.getByRole('status',{name:'网格有效性'}).filter({hasText:'有效'}).waitFor();
      await mesh.locator('.mesh-task-history summary').click();assert.equal(await mesh.locator('.mesh-task-history li[data-state="complete"]').count(),1);
      assert.equal((await command('document.summary')).revision,before.revision);
      await page.screenshot({path:path.join(screenshots,'mesh-recovered.png'),fullPage:true});await close();
    });
    await check('historical mesh selection loads one result at a time and resets display intent',async()=>{
      const existing=(await (await fetch(api+'/documents/default/mesh/jobs')).json()).jobs,first=existing[0];
      const before=await command('document.summary');
      await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
      const mesh=page.getByTestId('mesh-workbench-panel');await mesh.getByRole('spinbutton',{name:'质量阈值',exact:true}).fill('0.3');
      const submission=page.waitForResponse(response=>response.url().includes('/documents/default/mesh/jobs')&&response.request().method()==='POST');
      await mesh.getByRole('button',{name:'开始剖分（结果默认隐藏）',exact:true}).click();const next=(await (await submission).json()).meshJob;
      await mesh.locator('a.mesh-download[href*="'+next.jobId+'"]').waitFor({timeout:60000});
      await mesh.locator('.mesh-task-history summary').click();assert.equal(await mesh.locator('li[data-state="complete"]').count(),2);
      await mesh.getByRole('button',{name:'查看结果',exact:true}).click();await mesh.locator('a.mesh-download[href*="'+first.jobId+'"]').waitFor();
      assert.equal(await geometry.locator('.body-mesh-visibility-button[aria-pressed="true"]').count(),0);
      await mesh.getByRole('button',{name:'显示网格',exact:true}).click();await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups)>0);
      await mesh.getByRole('button',{name:'查看结果',exact:true}).click();await mesh.locator('a.mesh-download[href*="'+next.jobId+'"]').waitFor();
      await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups)===0);
      assert.equal(await geometry.locator('.body-mesh-visibility-button[aria-pressed="true"]').count(),0);
      assert.equal((await command('document.summary')).revision,before.revision);
      await page.screenshot({path:path.join(screenshots,'mesh-history.png'),fullPage:true});await close();
    });
    await check('background mesh cancellation survives dialog close and page reload without resubmission',async()=>{
      const before=await command('document.summary'),existing=(await (await fetch(api+'/documents/default/mesh/jobs')).json()).jobs;
      const template=existing[0],jobId='mesh-11111111-1111-4111-8111-111111111111';let state='running',submissions=0,cancels=0;
      let holdList=true,releaseList,listBegan,releaseDetail,detailBegan;
      const listGate=new Promise(resolve=>releaseList=resolve),listStarted=new Promise(resolve=>listBegan=resolve);
      const detailGate=new Promise(resolve=>releaseDetail=resolve),detailStarted=new Promise(resolve=>detailBegan=resolve);
      const detailPayload=await (await fetch(api+'/mesh/jobs/'+template.jobId)).json();
      const active=()=>({...template,jobId,state,visible:false,requestedVisible:false,createdAt:new Date().toISOString()});
      const jobsRoute=async route=>{
        if(route.request().method()==='POST'){submissions++;return route.fulfill({status:202,json:{ok:true,meshJob:active()}});}
        if(holdList){holdList=false;listBegan();await listGate;return route.fulfill({json:{ok:true,documentId:'default',jobs:existing}});}
        return route.fulfill({json:{ok:true,documentId:'default',jobs:[active(),...existing]}});
      };
      const cancelRoute=async route=>{cancels++;state='cancelled';return route.fulfill({json:{ok:true,meshJob:active()}});};
      const detailRoute=async route=>{detailBegan();await detailGate;return route.fulfill({json:detailPayload});};
      await page.route('**/api/documents/default/mesh/jobs',jobsRoute);await page.route('**/api/mesh/jobs/'+jobId+'/cancel',cancelRoute);
      await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
      let mesh=page.getByTestId('mesh-workbench-panel');await mesh.locator('.mesh-task-history summary').click();await mesh.getByRole('button',{name:'刷新任务记录',exact:true}).click();await expectEvent(listStarted,'the held mesh history request');
      await mesh.getByRole('button',{name:'开始剖分（结果默认隐藏）',exact:true}).click();
      const corrected=page.waitForResponse(async response=>response.url().endsWith('/documents/default/mesh/jobs')&&response.request().method()==='GET'&&(await response.json()).jobs.some(job=>job.jobId===jobId));
      releaseList();await corrected;
      await mesh.getByRole('status',{name:'网格任务状态'}).filter({hasText:'剖分中'}).waitFor();await close();
      await page.route('**/api/mesh/jobs/'+template.jobId,detailRoute);
      await page.reload({waitUntil:'domcontentloaded'});await assertModelVisible();await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
      mesh=page.getByTestId('mesh-workbench-panel');await mesh.getByRole('status',{name:'网格任务状态'}).filter({hasText:'剖分中'}).waitFor();
      const history=mesh.locator('.mesh-task-history');
      await history.locator('summary').click();
      await history.locator(`li[data-job-id="${template.jobId}"]`).getByRole('button',{name:'查看结果',exact:true}).click();
      await expectEvent(detailStarted,'the overlapping historical mesh detail request');
      assert.equal(submissions,1,'Refresh and reopening must not create another task');
      assert.equal(await mesh.getByRole('button',{name:'取消剖分',exact:true}).isEnabled(),true,'Loading an old artifact must not block cancellation');
      await page.screenshot({path:path.join(screenshots,'mesh-running.png'),fullPage:true});
      await mesh.getByRole('button',{name:'取消剖分',exact:true}).click();await mesh.getByRole('status',{name:'网格任务状态'}).waitFor({state:'detached'});
      releaseDetail();await mesh.getByRole('button',{name:'开始剖分（结果默认隐藏）',exact:true}).waitFor();
      await mesh.locator('li[data-state="cancelled"]').waitFor();
      assert.equal(cancels,1);assert.equal((await command('document.summary')).revision,before.revision);
      await page.screenshot({path:path.join(screenshots,'mesh-cancelled.png'),fullPage:true});
      await page.unroute('**/api/documents/default/mesh/jobs',jobsRoute);await page.unroute('**/api/mesh/jobs/'+jobId+'/cancel',cancelRoute);
      await page.unroute('**/api/mesh/jobs/'+template.jobId,detailRoute);
      await mesh.getByRole('button',{name:'刷新任务记录',exact:true}).click();await close();await page.getByRole('tab',{name:'建模',exact:true}).click();
    });
    await check('Pi keeps one mode and folds tool results and thinking with expandable details', async () => {
      // Keep the transport open: a fulfilled SSE response reaches EOF immediately
      // and now correctly cancels obsolete snapshots instead of pretending online.
      await page.evaluate(()=>{window.__foldEventSource=window.EventSource;window.EventSource=class{constructor(){this.listeners=new Map();this.closed=false;window.__emitPiFoldTest=event=>this.listeners.get('pi')?.({data:JSON.stringify(event)});setTimeout(()=>{if(!this.closed)this.onopen?.();},0);}addEventListener(name,listener){this.listeners.set(name,listener);}close(){this.closed=true;}};});
      const piHistory=[{role:'assistant',content:[{type:'thinking',thinking:'检查底面与高度的空间关系'},{type:'toolCall',id:'test-tool',name:'primitive__box',arguments:{parameters:{width:'boardWidth',depth:20,height:10}}}]},{role:'toolResult',toolCallId:'test-tool',toolName:'primitive__box',content:[{type:'text',text:'{"ok":true,"bodyId":"demo-body","revision":1}'}]},{role:'assistant',content:[{type:'text',text:'已创建长方体'}]}];
      const mockPi = async (route) => {
        const request = route.request(), url = request.url();
        if (url.includes('/events?')) return route.fulfill({ contentType:'text/event-stream', body:'event: pi\ndata: {"type":"runtime_ready"}\n\n' });
        const command = request.postDataJSON()?.command;
        const data = command?.type === 'get_messages' ? {messages:piHistory} : command?.type === 'get_available_models' ? {models:[]} : {};
        return route.fulfill({json: command ? {ok:true,response:{success:true,data}} : {ok:true,sessionId:'mock-pi',eventCursor:23}});
      };
      await page.route('**/api/pi/sessions**', mockPi);
      const before = await page.getByTestId('cad-viewport').boundingBox(); await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
      const panel = page.getByTestId('pi-agent-panel'); await panel.getByText('已创建长方体',{exact:true}).waitFor();
      const after = await page.getByTestId('cad-viewport').boundingBox();
      const assistantBounds = await page.getByRole('complementary',{name:'AI 建模助手',exact:true}).boundingBox();
      assert.ok(after.width > before.width * .75 && assistantBounds.width >= 280);
      assert.ok(after.x + after.width <= assistantBounds.x + 1);
      assert.equal(await panel.getByRole('button',{name:/^(Plan|Edit)$/}).count(),0);
      const thinking = panel.locator('details').filter({hasText:'检查底面与高度的空间关系'}), tool = panel.locator('details').filter({hasText:'demo-body'});
      assert.equal(await thinking.getAttribute('open'),null); assert.equal(await tool.getAttribute('open'),null);
      assert.equal(await panel.locator('.pi-agent-message.tool').count(),1,'Arguments and result must share one expandable tool row');
      assert.match(await tool.locator('summary').innerText(),/完成 · demo-body/);
      assert.equal(await tool.locator('.pi-agent-message-content').count(),0,'Collapsed native details must not allocate their payload in the DOM');
      await thinking.locator('summary').click(); await tool.locator('summary').click();
      await thinking.locator('.pi-agent-message-content').waitFor();await tool.locator('.pi-agent-message-content').waitFor();assert.match(await tool.locator('.pi-agent-message-content').innerText(),/boardWidth/);
      await page.evaluate(()=>{
        window.__emitPiFoldTest({type:'tool_execution_start',toolCallId:'live-fold',toolName:'query_model',args:{kind:'spatial'}});
        window.__emitPiFoldTest({type:'tool_execution_end',toolCallId:'live-fold',toolName:'query_model',result:{content:[{type:'text',text:'native-live-fold-result'}]}});
      });
      const liveTool=panel.locator('.pi-agent-message.tool').filter({hasText:'query_model'}).locator('details');await liveTool.locator('summary').click();await liveTool.getByText(/native-live-fold-result/).waitFor();
      piHistory.push({role:'assistant',timestamp:77,content:[{type:'toolCall',id:'live-fold',name:'query_model',arguments:{kind:'spatial'}}]},{role:'toolResult',toolCallId:'live-fold',toolName:'query_model',content:[{type:'text',text:'native-live-fold-result'}]},{role:'assistant',content:[{type:'text',text:'已同步原生工具历史'}]});
      const refreshedHistory=page.waitForResponse(response=>response.url().includes('/api/pi/sessions/')&&response.request().postData()?.includes('get_messages'));
      await page.evaluate(()=>window.__emitPiFoldTest({type:'agent_end'}));
      await refreshedHistory;await panel.getByText('已同步原生工具历史',{exact:true}).waitFor();
      assert.equal(await liveTool.getAttribute('open'),'','Native history refresh must preserve an expanded live tool');
      assert.equal(await liveTool.count(),1,'History reconciliation must not duplicate live tool rows');
      await page.screenshot({path:path.join(screenshots,'assistant-details.png'),fullPage:true});
      await page.getByRole('button', { name: '关闭 AI 助手', exact: true }).click(); await page.unroute('**/api/pi/sessions**',mockPi);
      await page.evaluate(()=>{window.EventSource=window.__foldEventSource;delete window.__foldEventSource;delete window.__emitPiFoldTest;});
    });
    await check('Pi streaming never pulls the reader away from history or expanded details', async () => {
      const prompts = [];
      await page.evaluate(() => {
        window.__scrollTestEventSource = window.EventSource;
        window.EventSource = class {
          constructor() { this.listeners = new Map(); window.__emitPiScrollTest = event => this.listeners.get('pi')?.({data: JSON.stringify(event)}); setTimeout(() => this.onopen?.(), 0); }
          addEventListener(name, callback) { this.listeners.set(name, callback); }
          close() { this.listeners.clear(); }
        };
      });
      const mockPi = async route => {
        const command = route.request().postDataJSON()?.command;
        if (command?.type === 'prompt') prompts.push(command);
        const data = command?.type === 'get_messages' ? {messages: Array.from({length: 35}, (_, index) => ({role:'assistant',content:[{type:'text',text:`历史记录 ${index + 1}\n几何参数和执行结果保留在原生 Pi 会话中。`}]}))} : {};
        return route.fulfill({json: command ? {ok:true,response:{success:true,data}} : {ok:true,sessionId:'scroll-test-pi',eventCursor:0}});
      };
      await page.route('**/api/pi/sessions**', mockPi);
      try {
        await page.getByRole('button',{name:'AI 助手',exact:true}).click();
        const panel = page.getByTestId('pi-agent-panel'), log = panel.locator('.pi-agent-messages');
        await panel.getByText(/^历史记录 35/).waitFor();
        const composer = panel.getByRole('textbox',{name:'发送给 Pi Agent',exact:true});
        await composer.fill('创建长方体');
        await composer.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true})));
        assert.equal(await composer.inputValue(),'创建长方体');
        assert.equal(prompts.length,0,'Confirming a Chinese IME candidate must not send a modeling command');
        await composer.press('Enter');
        await page.waitForFunction(() => document.querySelector('.pi-agent-composer textarea').value === '');
        await panel.getByRole('button',{name:'停止',exact:true}).waitFor();
        assert.equal(prompts.length,1,'A normal Enter must send the request exactly once');
        await log.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
        await page.evaluate(() => window.__emitPiScrollTest({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'新增消息：继续建模'}}));
        await panel.getByText('新增消息：继续建模',{exact:true}).waitFor({state:'attached'});
        assert.equal(await log.evaluate(node => node.scrollTop),0,'Streaming must preserve the history reading position');
        await panel.getByRole('button',{name:'有新消息 · 回到最新 ↓',exact:true}).click();
        await page.waitForFunction(() => { const node = document.querySelector('.pi-agent-messages'); return node.scrollHeight - node.clientHeight - node.scrollTop < 2; });
        await page.evaluate(() => {
          window.__emitPiScrollTest({type:'tool_execution_start',toolCallId:'scroll-tool',toolName:'query_model',args:{}});
          window.__emitPiScrollTest({type:'tool_execution_end',toolCallId:'scroll-tool',toolName:'query_model',result:{content:[{type:'text',text:'完整查询结果\n'.repeat(100)}]}});
        });
        const details = panel.locator('.pi-agent-message.tool').filter({hasText:'query_model'}).locator('details');
        await details.locator('summary').click();
        await details.getByText(/完整查询结果/).waitFor();
        await page.waitForTimeout(50);
        const position = await log.evaluate(node => node.scrollTop);
        await page.evaluate(() => window.__emitPiScrollTest({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'查询完成。'}}));
        await panel.getByRole('button',{name:'有新消息 · 回到最新 ↓',exact:true}).waitFor();
        assert.equal(await details.getAttribute('open'),'');
        assert.equal(await log.evaluate(node => node.scrollTop),position,'Expanded tool details must remain readable during streaming');
        await page.screenshot({path:path.join(screenshots,'assistant-history-reading.png'),fullPage:true});
      } finally {
        await page.getByRole('button',{name:'关闭 AI 助手',exact:true}).click();
        await page.unroute('**/api/pi/sessions**',mockPi);
        await page.evaluate(() => { window.EventSource = window.__scrollTestEventSource; delete window.__scrollTestEventSource; delete window.__emitPiScrollTest; });
      }
    });
    await check('Pi interrupted processes recover the saved session without replaying any prompt', async () => {
      let connections=0;const commands=[], lateSnapshots=[];
      // A fulfilled route closes SSE immediately, unlike the real keep-alive endpoint.
      // Model an open native event channel so transient fixture EOF cannot mark recovery offline.
      await page.evaluate(()=>{window.__nativeEventSource=window.EventSource;let sequence=0;window.EventSource=class{
        constructor(){this.listeners=new Map();this.closed=false;const first=++sequence===1;setTimeout(()=>{if(this.closed)return;this.onopen?.();this.listeners.get('pi')?.({data:JSON.stringify(first?{type:'runtime_exit',signal:'SIGTERM',error:'Pi 进程已退出（SIGTERM），重新连接可恢复会话，不会自动重发建模命令。'}:{type:'runtime_ready'})});if(first)setTimeout(()=>this.onopen?.(),40);},20);}
        addEventListener(name,listener){this.listeners.set(name,listener);}close(){this.closed=true;}
      };});
      const mockPi=async route=>{
        if(route.request().url().includes('/events?'))return route.fulfill({contentType:'text/event-stream',body:`event: pi\ndata: ${JSON.stringify(connections===1?{type:'runtime_exit',signal:'SIGTERM',error:'Pi 进程已退出（SIGTERM），重新连接可恢复会话，不会自动重发建模命令。'}:{type:'runtime_ready'})}\n\n`});
        const command=route.request().postDataJSON()?.command;
        if(!command){connections++;return route.fulfill({json:{ok:true,sessionId:'mock-recovery',eventCursor:0}});}
        if(connections===1){
          commands.push(command.type);
          lateSnapshots.push(()=>route.fulfill({json:{ok:true,response:{success:true,data:command.type==='get_messages'?{messages:[{role:'assistant',content:'过期的运行结果'}]}:{models:[],isStreaming:true}}}}));
          return;
        }
        commands.push(command.type);return route.fulfill({json:{ok:true,response:{success:true,data:command.type==='get_messages'?{messages:[{role:'user',content:'已有建模请求'}]}:{}}}});
      };
      await page.route('**/api/pi/sessions**',mockPi);await page.getByRole('button',{name:'AI 助手',exact:true}).click();
      const panel=page.getByTestId('pi-agent-panel');await panel.getByRole('alert').filter({hasText:'SIGTERM'}).waitFor();
      assert.equal(lateSnapshots.length,2,'Hold both initial HTTP snapshots until the process has exited');
      await Promise.all(lateSnapshots.map(reply=>reply()));
      await page.waitForTimeout(100);
      assert.equal(await panel.locator('.pi-agent-status.offline').count(),1,'A late SSE open must not resurrect an exited native process');
      assert.equal(await panel.getByText('过期的运行结果',{exact:true}).count(),0,'A late history snapshot must not overwrite the interrupted conversation');
      assert.equal(await panel.locator('.pi-agent-thinking').count(),0,'A late state snapshot must not restart the busy indicator');
      await panel.getByRole('alert').filter({hasText:'SIGTERM'}).waitFor();
      assert.equal(await panel.getByRole('textbox',{name:'发送给 Pi Agent'}).isDisabled(),true);
      await panel.getByRole('button',{name:'重新连接已有会话',exact:true}).click();
      await panel.getByText('已有建模请求',{exact:true}).waitFor();await panel.locator('.pi-agent-status.online').waitFor();
      assert.equal(connections,2);assert.equal(commands.includes('prompt'),false);assert.equal(await panel.getByRole('alert').count(),0);
      await page.screenshot({path:path.join(screenshots,'assistant-recovered.png'),fullPage:true});
      await page.getByRole('button',{name:'关闭 AI 助手',exact:true}).click();await page.unroute('**/api/pi/sessions**',mockPi);
      await page.evaluate(()=>{window.EventSource=window.__nativeEventSource;delete window.__nativeEventSource;});
    });
    await check('geometry and variable editors keep frozen baselines, retain drafts and require explicit reload',async()=>{
      const before=await command('document.summary');await page.locator('[data-command="primitive.box"]').click();
      const primitive=page.getByTestId('advanced-modeling-panel');await primitive.getByLabel('长度 X',{exact:true}).fill('73');
      await command('variable.set',{name:'externalWidth',type:'length',expression:'12 mm'});
      await primitive.getByRole('button',{name:'创建基础体',exact:true}).click();await page.getByLabel('工程编辑会话',{exact:true}).getByRole('alert').waitFor();
      assert.equal(await primitive.getByLabel('长度 X',{exact:true}).inputValue(),'73');assert.equal((await command('document.summary')).bodyCount,before.bodyCount);
      await page.screenshot({path:path.join(screenshots,'geometry-edit-conflict.png'),fullPage:true});
      await page.getByRole('button',{name:'重新载入（放弃草稿）',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="长度 X"]')?.value==='100');await close();
      await page.reload({waitUntil:'networkidle'});await project.locator('button.managed-record').filter({has:page.locator('strong',{hasText:/^externalWidth$/})}).dblclick();
      const variable=page.getByTestId('project-data-variables');await variable.getByRole('textbox').nth(1).fill('27 mm');
      await command('variable.set',{name:'externalWidth',type:'length',expression:'19 mm'});
      await variable.getByRole('button',{name:'保存变量',exact:true}).click();await page.getByLabel('工程编辑会话',{exact:true}).getByRole('alert').waitFor();assert.equal(await variable.getByRole('textbox').nth(1).inputValue(),'27 mm');
      assert.equal((await command('document.summary')).variables.find(v=>v.name==='externalWidth').expression,'19 mm');
      await page.getByRole('button',{name:'重新载入（放弃草稿）',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="project-data-variables"] input[placeholder="表达式"]')?.value==='19 mm' || [...document.querySelectorAll('[data-testid="project-data-variables"] input')].some(i=>i.value==='19 mm'));await close();
      await command('variable.delete',{}, {name:'externalWidth'});await page.reload({waitUntil:'networkidle'});
    });
    await check('a deleted feature never falls back to editing its neighbour and exposes an explicit reselect',async()=>{
      const translated=await command('transform.translate',{dx:1,dy:0,dz:0},{bodyId:cylinder.bodyId}),feature=translated.features.at(-1),primitive=translated.features.find(f=>f.type==='primitive.cylinder');await page.reload({waitUntil:'networkidle'});
      await geometry.locator('button.feature-tree-label').filter({hasText:feature.id}).dblclick();await page.getByLabel('可编辑特征',{exact:true}).waitFor();assert.equal(await page.getByLabel('可编辑特征',{exact:true}).inputValue(),feature.id);
      await page.getByLabel('特征参数 dx',{exact:true}).fill('23');await command('feature.delete',{}, {featureId:feature.id});
      await page.getByRole('button',{name:'修改参数并重算',exact:true}).click();await page.getByLabel('工程编辑会话',{exact:true}).getByRole('alert').waitFor();await page.getByRole('button',{name:'重新载入（放弃草稿）',exact:true}).click();
      await page.getByLabel('重新选择特征',{exact:true}).waitFor();assert.equal(await page.getByLabel('可编辑特征',{exact:true}).inputValue(),'');await page.getByLabel('可编辑特征',{exact:true}).selectOption(primitive.id);await page.getByLabel('特征参数 radius',{exact:true}).waitFor();await close();
    });
    await check('material editor saves all fields in one request and one undo restores the whole material',async()=>{
      const before=await command('document.summary'),original=before.materials.find(m=>m.name==='FR4');
      await project.locator('button.managed-record').filter({has:page.locator('strong',{hasText:/^FR4$/})}).dblclick();const material=page.getByTestId('project-data-materials');
      await material.getByLabel('相对介电常数 εr',{exact:true}).fill('6.2');await material.getByLabel('属性值',{exact:true}).fill('0.05');await material.getByRole('button',{name:'添加属性',exact:true}).click();
      await material.getByLabel('属性 Key',{exact:true}).nth(1).fill('thermal');await material.getByLabel('属性值',{exact:true}).nth(1).fill('18');
      const batch=page.waitForResponse(r=>r.url().endsWith('/command-batches') && r.request().method()==='POST');await material.getByRole('button',{name:'保存材料',exact:true}).click();const response=await batch;const payload=await response.json();assert.equal(payload.ok,true,JSON.stringify(payload));assert.equal(response.request().postDataJSON().steps.length,3);
      await material.getByText('材料 FR4 已保存。',{exact:true}).waitFor();await close();
      const undoMaterial=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.operation==='document.undo');await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal((await(await undoMaterial).json()).ok,true);
      const restored=await command('document.summary');assert.deepEqual(restored.materials.find(m=>m.name==='FR4'),original);await page.reload({waitUntil:'networkidle'});
    });
    await check('two real browser tabs reject stale instance edits, retain drafts and reload explicitly', async()=>{
      const other=await browser.newPage({viewport:{width:1440,height:960}});
      await routeGeometryApi(other,api);
      try{
        await project.getByRole('button',{name:/Port1 face/}).dblclick();
        const editor=page.getByTestId('property-schema-panel');await editor.getByLabel('频率',{exact:true}).waitFor();
        const original=await editor.getByLabel('频率',{exact:true}).inputValue();await editor.getByLabel('频率',{exact:true}).fill('44');
        await other.goto(process.env.WORKBENCH_URL || 'http://localhost:3000/',{waitUntil:'networkidle'});
        await other.getByTestId('project-tree').getByRole('button',{name:/Port1 face/}).dblclick();
        const second=other.getByTestId('property-schema-panel');await second.getByLabel('频率',{exact:true}).fill('55');await second.getByRole('button',{name:'保存实例',exact:true}).click();await second.getByText('实例已保存，工程树已同步。').waitFor();
        const staleSave=editor.getByRole('button',{name:'保存实例',exact:true});if(await staleSave.isEnabled())await staleSave.click();await editor.getByRole('alert').filter({hasText:'草稿已保留'}).waitFor();
        assert.equal(await editor.getByLabel('频率',{exact:true}).inputValue(),'44');assert.equal((await command('property.instance.list')).instances.find(i=>i.instanceId===port.instance.instanceId).value.frequency,55);
        await page.screenshot({path:path.join(screenshots,'property-edit-conflict.png'),fullPage:true});
        await editor.getByRole('button',{name:'重新载入最新实例（放弃草稿）',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="频率"]').value==='55');
        await editor.getByLabel('频率',{exact:true}).fill(original);await editor.getByRole('button',{name:'保存实例',exact:true}).click();await editor.getByText('实例已保存，工程树已同步。').waitFor();await close();
        await command('document.summary');
        const currentPort=(await command('property.instance.list')).instances.find(instance=>instance.instanceId===port.instance.instanceId);
        const disposable=await command('property.instance.create',{typeId:wave.type.typeId,name:'待删除草稿',value:{frequency:7},target:currentPort.target});
        await page.reload({waitUntil:'networkidle'});await project.getByRole('button',{name:/待删除草稿 face/}).dblclick();
        const deletedEditor=page.getByTestId('property-schema-panel');await deletedEditor.getByLabel('频率',{exact:true}).fill('99');
        await command('property.instance.delete',{}, {instanceId:disposable.instance.instanceId});
        const deletedSave=deletedEditor.getByRole('button',{name:'保存实例',exact:true});if(await deletedSave.isEnabled())await deletedSave.click();await deletedEditor.getByRole('alert').filter({hasText:'此实例已被删除'}).waitFor();
        assert.equal(await deletedEditor.getByLabel('频率',{exact:true}).inputValue(),'99','Deleting a record elsewhere must retain its visible draft');assert.equal(await deletedEditor.getByRole('button',{name:'创建实例',exact:true}).count(),0);assert.equal(await deletedEditor.getByRole('button',{name:'保存实例',exact:true}).isDisabled(),true);await close();
      }finally{await other.close();}
    });
    await check('six typed defaults preview real instance migrations, invalidate on edit and commit without changing existing values',async()=>{
      const fixture=await command('property.type.create',{key:'MigrationUi',name:'迁移验证',fields:[]});
      await command('property.instance.create',{typeId:fixture.type.typeId,name:'Migration 1',value:{}});await command('property.instance.create',{typeId:fixture.type.typeId,name:'Migration 2',value:{}});
      await page.reload({waitUntil:'networkidle'});await project.getByRole('button',{name:/迁移验证/}).filter({has:page.locator('strong')}).first().dblclick();
      const manager=page.getByTestId('property-type-manager');await manager.waitFor();await page.waitForFunction(()=>document.querySelector('[aria-label="属性类型 Key"]')?.value==='MigrationUi');assert.equal(await manager.getByLabel('属性类型 Key',{exact:true}).inputValue(),'MigrationUi','Double-clicking a scrolled type row must not collapse it and open its neighbour');
      const definitions=[['bool','enabled','启用',false],['int','exact','精确整数','9223372036854775807'],['double','frequency','频率',3.5],['expression','formula','公式','boardWidth / 2'],['enum','mode','模式','B'],['vector3','axis','方向','0, 0, 1']];
      for(let i=0;i<definitions.length;i++){
        const [type,key,label,value]=definitions[i],number=i+1;await manager.getByRole('button',{name:'＋ 添加属性',exact:true}).click();
        await manager.getByLabel(`字段 ${number} Key`,{exact:true}).fill(key);await manager.getByLabel(`字段 ${number} 名称`,{exact:true}).fill(label);await manager.getByLabel(`字段 ${number} 类型`,{exact:true}).selectOption(type);
        if(type==='enum')await manager.getByLabel(`字段 ${number} 枚举选项`,{exact:true}).fill('A,B');
        await manager.locator('.schema-field-row').nth(i).getByLabel('必填',{exact:true}).check();await manager.getByLabel(`字段 ${number} 使用默认值`,{exact:true}).check();
        const control=manager.getByLabel(`字段 ${number} 默认值`,{exact:true});if(type==='bool'||type==='enum')await control.selectOption(String(value));else await control.fill(String(value));
      }
      assert.equal(await manager.getByRole('button',{name:'保存类型',exact:true}).isDisabled(),true);
      const before=await command('property.type.list');await manager.getByLabel('字段 6 默认值',{exact:true}).fill('0,,1');await manager.getByRole('button',{name:'预览字段迁移',exact:true}).click();await manager.getByRole('alert').filter({hasText:'三个非空数值'}).waitFor();
      assert.equal((await command('property.type.list')).stateToken,before.stateToken);
      await manager.getByLabel('字段 6 默认值',{exact:true}).fill('0, 0, 1');await manager.getByRole('button',{name:'预览字段迁移',exact:true}).click();await manager.getByLabel('字段迁移预览',{exact:true}).waitFor();
      assert.equal((await command('property.type.list')).stateToken,before.stateToken);assert.equal(await manager.getByRole('button',{name:'保存类型',exact:true}).isDisabled(),false);
      await manager.getByLabel('字段 3 默认值',{exact:true}).fill('4.5');assert.equal(await manager.getByRole('button',{name:'保存类型',exact:true}).isDisabled(),true);
      await manager.getByRole('button',{name:'预览字段迁移',exact:true}).click();await manager.getByLabel('字段迁移预览',{exact:true}).getByText('4.5',{exact:true}).waitFor();
      await manager.getByLabel('字段迁移预览',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(screenshots,'property-defaults-migration.png'),fullPage:true});
      await manager.getByRole('button',{name:'保存类型',exact:true}).click();await manager.getByText('属性类型已保存，工程树已同步。').waitFor();
      const expected={enabled:false,exact:'9223372036854775807',frequency:4.5,formula:'boardWidth / 2',mode:'B',axis:[0,0,1]};
      const values=(await command('property.instance.list')).instances.filter(i=>i.typeId===fixture.type.typeId);assert.equal(values.length,2);values.forEach(instance=>assert.deepEqual(instance.value,expected));
      assert.equal(await manager.getByLabel('字段 1 Key',{exact:true}).isDisabled(),true);await close();
    });
    await check('property type files export and restore through the UI', async () => {
      await project.getByRole('button', { name: '属性类型操作', exact: true }).click(); await page.getByRole('menuitem', { name: '管理 / 导入 / 导出', exact: true }).click();
      const manager = page.getByTestId('property-type-manager'); const download = page.waitForEvent('download'); await manager.getByRole('button', { name: '导出类型文件', exact: true }).click();
      const exported = JSON.parse(fs.readFileSync(await (await download).path(), 'utf8')); assert.equal(exported.format, 'cad-property-types'); assert.ok(exported.types.some((type) => type.key === 'ThermalSetup')); assert.equal(exported.instances, undefined);
      const imported = { format: 'cad-property-types', schemaVersion: 1, types: [{ key: 'ImportedSetup', name: '导入设置', targetScope: 'project', association: 'none', fields: [{ key: 'frequency', label: '频点', type: 'double' }] }] };
      await manager.locator('input[type="file"]').setInputFiles({ name: 'types.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
      await project.getByRole('button', { name: '导入设置操作', exact: true }).waitFor(); await close();
    });
    await check('project records can be copied and deleted from context menus', async () => {
      await project.getByRole('button', { name: 'boardWidth操作', exact: true }).click(); await page.getByRole('menuitem', { name: '复制', exact: true }).click();
      const panel = page.getByTestId('project-data-variables'); assert.equal(await panel.getByRole('textbox').nth(0).inputValue(), 'boardWidth_copy');
      await panel.getByRole('button', { name: '保存变量', exact: true }).click(); await project.getByRole('button', { name: 'boardWidth_copy操作', exact: true }).waitFor(); await close();
      await project.getByRole('button', { name: 'boardWidth_copy操作', exact: true }).click(); await page.getByRole('menuitem', { name: '删除', exact: true }).click();
      await project.getByRole('button', { name: 'boardWidth_copy操作', exact: true }).waitFor({ state: 'detached' });
    });
    await check('direct surface, transform, Boolean and generated tools open correct forms', async () => {
      for (const kind of ['rectangle', 'disk', 'cylinder', 'cone', 'sphere']) { await page.getByRole('tab', { name: '建模', exact: true }).click(); await page.locator('[data-command="surface.' + kind + '"]').click(); const select = page.getByLabel('基础面类型', { exact: true }); assert.equal(await select.inputValue(), kind); assert.equal(await select.isVisible(), false); await close(); }
      await page.getByRole('tab', { name: '变换', exact: true }).click();
      for (const kind of ['translate', 'rotate', 'mirror', 'copy', 'coordinate', 'align', 'scale', 'scale_non_uniform']) { await page.locator('[data-command="transform.' + kind + '"]').click(); assert.equal(await page.getByLabel('变换类型', { exact: true }).inputValue(), kind); await close(); }
      await page.getByRole('tab', { name: '布尔', exact: true }).click();
      for (const kind of ['fuse', 'cut', 'common', 'section', 'split', 'partition', 'fragments', 'imprint']) { await page.locator('[data-command="boolean.' + kind + '"]').click(); assert.equal(await page.locator('.advanced-boolean select').first().inputValue(), kind); await close(); }
      await page.getByRole('tab', { name: '建模', exact: true }).click();
      for (const kind of ['sweep', 'pipe', 'loft']) { await page.locator('[data-command="feature.' + kind + '"]').click(); if(kind==='loft'){const panel=page.getByTestId('loft-modeling-panel');assert.ok(await panel.getByRole('heading',{name:'真实截面放样',exact:true}).isVisible());assert.equal(await panel.getByLabel('放样截面放置方式',{exact:true}).inputValue(),'actual');assert.equal(await panel.getByRole('button',{name:'创建放样',exact:true}).isDisabled(),true);}else assert.ok(await page.getByTestId('sweep-modeling-panel').isVisible()); await close(); }
    });
    await check('docked parameters preserve drafts when minimized and when switching to the assistant', async () => {
      await page.locator('[data-command="primitive.box"]').click(); const dialog = page.getByTestId('operation-window');
      const field = page.getByTestId('advanced-modeling-panel').locator('input').first(); await field.fill('boardWidth + 10 mm');
      const coordinateSelect = page.getByTestId('advanced-modeling-panel').locator('.single-field select').last(); assert.equal(await coordinateSelect.evaluate((node) => getComputedStyle(node).appearance), 'auto');
      await dialog.getByRole('button', { name: '最小化操作窗口', exact: true }).click(); assert.equal(await field.isVisible(), false);
      await dialog.getByRole('button', { name: '展开操作窗口', exact: true }).click(); assert.equal(await field.inputValue(), 'boardWidth + 10 mm');
      assert.equal(await dialog.getAttribute('aria-modal'), 'false');
      assert.ok(await dialog.evaluate(node => Boolean(node.closest('.studio-commands'))));
      await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
      assert.equal(await dialog.isVisible(), false);
      await page.getByRole('button', { name: '关闭 AI 助手', exact: true }).click();
      assert.equal(await field.inputValue(), 'boardWidth + 10 mm');
      await page.screenshot({ path: path.join(screenshots, 'dialog.png'), fullPage: true }); await close();
    });
    await check('project save, new and open actions reach the real geometry service', async () => {
      // Earlier window/layout checks open an actual local Pi process. Closing
      // its panel is not a proof that it is idle; stop only this fixture's
      // managed sessions and verify the real workspace guard before transfer.
      const fixtureDocument=await page.locator('main.cad-shell').getAttribute('data-document-id');
      const piActivity=await fetch(api+'/pi/documents/'+encodeURIComponent(fixtureDocument)+'/activity').then(r=>r.json());assert.equal(piActivity.ok,true);
      for(const session of piActivity.activity.sessions){const stopped=await fetch(api+'/pi/sessions/'+encodeURIComponent(session.sessionId),{method:'DELETE'}).then(r=>r.json());assert.equal(stopped.ok,true);}
      const idlePi=await fetch(api+'/pi/documents/'+encodeURIComponent(fixtureDocument)+'/activity').then(r=>r.json());assert.equal(idlePi.activity.status,'idle');assert.equal(idlePi.activity.guarded,false);
      await page.getByRole('tab', { name: '工程', exact: true }).click();
      await page.locator('[data-command="file.save"]').click();
      const naming = page.getByRole('dialog', {name:'保存工程',exact:true});
      await naming.getByLabel('工程名称',{exact:true}).waitFor();
      assert.equal(await naming.getByRole('button',{name:'命名并保存'}).isDisabled(),true);
      await naming.getByRole('button',{name:'取消',exact:true}).click();
      assert.equal((await (await fetch(api+'/projects/'+fixtureDocument)).json()).project.name,'未命名工程');
      await page.locator('[data-command="file.exchange"]').click();
      await page.getByTestId('step-exchange').getByRole('button',{name:'保存工程',exact:true}).click();
      await naming.getByLabel('工程名称',{exact:true}).fill('浏览器验证工程');
      const saved = page.waitForEvent('download');
      await naming.getByRole('button',{name:'命名并保存'}).click();
      const file = await saved; const savedPath = await file.path();
      const savedBytes = fs.readFileSync(savedPath);
      const backup = decodeProjectPackage(savedBytes);
      assert.equal(backup.legacy, false);
      assert.equal(backup.metadata.document.id, fixtureDocument);
      assert.equal(file.suggestedFilename(),'浏览器验证工程.cadproj');
      await page.locator('[data-command="file.new"]').click(); await geometry.getByText('暂无几何，使用上方创建工具添加。', { exact: true }).waitFor();
      assert.equal(await geometry.locator('[data-body-id]').count(), 0);
      await page.locator('input[accept^=".cadproj"]').setInputFiles({ name: 'ui-test-project.cadproj', mimeType: 'application/vnd.webcad.project', buffer: savedBytes });
      await geometry.locator('[data-body-id="' + box.bodyId + '"]').waitFor(); assert.equal(await geometry.locator('[data-body-id]').count(), 2);
      await project.getByRole('button',{name:'Thermal2操作',exact:true}).waitFor();
      await assertModelVisible();
      await page.getByRole('tab', { name: '建模', exact: true }).click();
    });
    await check('Body context menu activates and deletes without extra confirmation cards', async () => {
      await geometry.getByRole('button', { name: 'Substrate操作', exact: true }).click(); await page.getByRole('menuitem', { name: '设为当前 Body', exact: true }).click();
      const body = geometry.locator('[data-body-id="' + box.bodyId + '"]'); await body.getByText('当前', { exact: true }).waitFor();
      await page.getByTestId('selection-readout').getByText(`体拾取 · ${box.bodyId}`, {exact:true}).waitFor();
      await geometry.getByRole('button', { name: 'Substrate操作', exact: true }).click(); await page.getByRole('menuitem', { name: '删除 Body', exact: true }).click();
      await body.waitFor({ state: 'detached' }); assert.equal(await geometry.locator('[data-body-id]').count(), 1);
      assert.equal(await page.locator('.body-delete-confirm').count(), 0);
      await page.waitForFunction(() => !document.querySelector('[data-testid="selection-readout"]').textContent.includes('body-1'));
    });
    await check('reference-grid drag previews and creates a snapped solid in the active document', async () => {
      const before = await geometry.locator('[data-body-id]').count();
      await page.getByRole('button', { name: '拖拽建模', exact: true }).click();
      await page.getByLabel('拖拽建模类型', { exact: true }).selectOption('box');
      assert.equal(await page.getByLabel('拖拽建模类型', {exact:true}).locator('option').count(),14);
      await page.locator('[title="顶视图"]').click();
      const viewport = page.getByTestId('cad-viewport'); const bounds = await viewport.boundingBox(); assert.ok(bounds);
      await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(200);
      const cameraBefore = await viewport.evaluate(node => { node.dispatchEvent(new Event('cad:verify-frame')); return JSON.parse(node.dataset.cameraPose); });
      await page.mouse.move(bounds.x + bounds.width * 0.1, bounds.y + bounds.height * 0.1);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5, { steps: 8 });
      await page.locator('.drag-dimension-readout').waitFor();
      assert.match(await page.locator('.drag-modeling-steps [aria-current="step"]').innerText(), /底面/);
      assert.match(await page.locator('.drag-dimension-readout').innerText(), /底面 · \d+ × \d+ × \d+ mm/);
      await page.mouse.up();
      assert.match(await page.locator('.drag-modeling-steps [aria-current="step"]').innerText(), /高度/);
      assert.equal(await geometry.locator('[data-body-id]').count(), before, 'Confirming the footprint must not create the solid');
      await page.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .5 - 70, { steps: 6 });
      assert.match(await page.locator('.drag-dimension-readout').innerText(), /高度 ·/);
      assert.ok(Number((await page.locator('.drag-dimension-readout').innerText()).match(/× (\d+) mm/)[1]) > 1, 'Moving upward in top view must change height');
      await page.screenshot({ path: path.join(screenshots, 'drag-height.png'), fullPage: true });
      await page.mouse.click(bounds.x + bounds.width * .5, bounds.y + bounds.height * .5 - 70);
      await page.waitForFunction((count) => document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length === count + 1, before);
      assert.equal((await command('document.view')).bodyCount, before + 1);
      const cameraAfter = await viewport.evaluate(node => { node.dispatchEvent(new Event('cad:verify-frame')); return JSON.parse(node.dataset.cameraPose); });
      cameraBefore.forEach((value,index) => assert.ok(Math.abs(value-cameraAfter[index]) < 1e-5, 'Drag commit must preserve the camera and construction-plane placement'));
      await page.getByRole('button', { name: '参数建模', exact: true }).click();
    });
    await close();
    await check('a landing click with sub-four-pixel jitter never locks a footprint or creates a sphere',async()=>{
      const before=await command('document.view');
      await page.getByRole('button',{name:'拖拽建模',exact:true}).click();
      const viewport=page.getByTestId('cad-viewport'),bounds=await viewport.boundingBox();
      const x=bounds.x+bounds.width*.4,y=bounds.y+bounds.height*.55;
      for(const kind of ['box','sphere','surface-disk']){
        await page.getByLabel('拖拽建模类型',{exact:true}).selectOption(kind);
        await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+2,y-2);await page.mouse.up();
        assert.match(await page.locator('.viewport-hint').innerText(),/2\/[23]/,'A jittered landing click must leave footprint selection active');
        assert.equal((await command('document.summary')).revision,before.revision);
        await page.keyboard.press('Escape');
      }
      await page.getByRole('button',{name:'参数建模',exact:true}).click();await close();
    });
    await check('click-move-click locks footprint; shortcut preserves dimensions in the parameter form', async () => {
      const before = await command('document.view');
      await page.getByRole('button',{name:'拖拽建模',exact:true}).click();await page.getByLabel('拖拽建模类型',{exact:true}).selectOption('box');
      const bounds = await page.getByTestId('cad-viewport').boundingBox();
      const x=bounds.x+bounds.width*.25,y=bounds.y+bounds.height*.6;
      await page.mouse.click(x,y);await page.mouse.move(x+90,y-50,{steps:6});
      assert.match(await page.locator('.drag-dimension-readout').innerText(),/底面 .*× 0 mm/);
      const builds = await page.getByTestId('cad-viewport').evaluate(node => {
        const count = node.dataset.dragPreviewBuilds;
        const canvas = node.querySelector('canvas');
        const rect = node.getBoundingClientRect();
        for (let i = 0; i < 20; i++) canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.x+rect.width*.25+90,clientY:rect.y+rect.height*.6-50,bubbles:true}));
        return [count,node.dataset.dragPreviewBuilds];
      });
      assert.equal(builds[0],builds[1],'Repeated pointer events at the same snapped dimensions must reuse the preview');
      await page.mouse.move(x,y,{steps:4});assert.equal(await page.locator('.drag-dimension-readout').count(),0,'Degenerate footprint must remove the previous preview');
      await page.mouse.move(x+90,y-50,{steps:4});
      await page.mouse.click(x+90,y-50);await page.mouse.move(x+90,y-120,{steps:6});
      const dimensions = (await page.locator('.drag-dimension-readout').innerText()).match(/(\d+) × (\d+) × (\d+) mm/).slice(1).map(Number);
      await page.mouse.click(x+90,y-120,{button:'middle'});
      assert.equal((await command('document.view')).revision,before.revision,'Middle button must not commit geometry');
      await page.keyboard.press('Alt+m');
      const panel = page.getByTestId('advanced-modeling-panel');await panel.waitFor();
      assert.equal(Number(await panel.getByLabel('长度 X',{exact:true}).inputValue()),dimensions[0]);
      assert.equal(Number(await panel.getByLabel('深度 Y',{exact:true}).inputValue()),dimensions[1]);
      assert.equal(Number(await panel.getByLabel('高度 Z',{exact:true}).inputValue()),dimensions[2]);
      await panel.getByLabel('长度 X',{exact:true}).fill('boardWidth + 2 mm');
      // The shortcut must work while the edited expression input still owns focus.
      await page.keyboard.press('Alt+m');
      await panel.waitFor({state:'detached'});
      await page.getByRole('button',{name:'拖拽建模',exact:true}).click();
      await page.keyboard.press('Alt+m');
      await panel.waitFor();
      assert.equal(await panel.getByLabel('长度 X',{exact:true}).inputValue(),'boardWidth + 2 mm','A parameter/drag/parameter round trip must preserve expressions as well as numbers');
      assert.equal(Number(await panel.getByLabel('深度 Y',{exact:true}).inputValue()),dimensions[1]);
      assert.equal(Number(await panel.getByLabel('高度 Z',{exact:true}).inputValue()),dimensions[2]);
      assert.equal(await page.locator('.drag-dimension-readout').count(),0);
      await page.screenshot({path:path.join(screenshots,'drag-parameter-switch.png'),fullPage:true});
      assert.equal((await command('document.view')).revision,before.revision);await close();
    });
    await check('double-clicking a footprint or mouse jitter never creates an accidental thin solid',async()=>{
      await page.getByRole('button',{name:'拖拽建模',exact:true}).click();
      await page.getByLabel('拖拽建模类型',{exact:true}).selectOption('box');
      const before=await command('document.summary');
      const bounds=await page.getByTestId('cad-viewport').boundingBox(),x=bounds.x+bounds.width*.3,y=bounds.y+bounds.height*.6;
      await page.mouse.click(x,y);await page.mouse.move(x+65,y-45,{steps:4});
      await page.mouse.dblclick(x+65,y-45);
      await page.getByRole('button',{name:'重选底面',exact:true}).waitFor();
      assert.match(await page.locator('.drag-dimension-readout').innerText(),/高度 .*× 1 mm/);
      assert.equal((await command('document.summary')).stateToken,before.stateToken);
      await page.mouse.move(x+66,y-46);await page.mouse.click(x+66,y-46);
      assert.equal((await command('document.summary')).stateToken,before.stateToken,'Sub-threshold movement must not arm height confirmation');
      await page.mouse.move(x+115,y-45,{steps:4});await page.mouse.click(x+115,y-45);
      assert.equal((await command('document.summary')).stateToken,before.stateToken,'Sideways motion in top view must not commit a minimum-height solid');
      await page.mouse.move(x+65,y-20,{steps:4});await page.mouse.click(x+65,y-20);
      assert.equal((await command('document.summary')).stateToken,before.stateToken,'Motion below the base must not commit a clamped minimum-height solid');
      await page.mouse.move(x+65,y-85,{steps:4});
      const height=Number((await page.locator('.drag-dimension-readout').innerText()).match(/× (\d+) mm/)[1]);
      assert.ok(height>1,'Intentional motion should adjust the height normally');
      await page.keyboard.press('Alt+m');
      const panel=page.getByTestId('advanced-modeling-panel');
      assert.equal(Number(await panel.getByLabel('高度 Z',{exact:true}).inputValue()),height);
      await panel.getByLabel('高度 Z',{exact:true}).fill('boardWidth / 2');
      await page.keyboard.press('Alt+m');await panel.waitFor({state:'detached'});
      await page.getByRole('button',{name:'参数建模',exact:true}).click();
      assert.equal(await panel.getByLabel('高度 Z',{exact:true}).inputValue(),'boardWidth / 2');
      assert.equal((await command('document.summary')).stateToken,before.stateToken,'Mode switches preserve expressions without creating geometry');
      await close();
    });
    await check('draft releases cannot commit, right-click cancels, and the parameter form switches back without losing expressions',async()=>{
      await page.getByRole('button',{name:'拖拽建模',exact:true}).click();
      await page.getByLabel('拖拽建模类型',{exact:true}).selectOption('box');
      const before=await command('document.summary');
      const viewport=page.getByTestId('cad-viewport'),bounds=await viewport.boundingBox(),x=bounds.x+bounds.width*.3,y=bounds.y+bounds.height*.6;
      await page.mouse.click(x,y);await page.mouse.move(x+65,y-45,{steps:4});
      await viewport.locator('canvas').dispatchEvent('pointerup',{button:0,clientX:x+65,clientY:y-45});
      assert.match(await page.locator('.drag-dimension-readout').innerText(),/底面 .*× 0 mm/,'A detached release must not lock the footprint');
      await page.mouse.click(x+65,y-45,{button:'right'});
      assert.equal(await page.locator('.drag-modeling-feedback').count(),0);
      assert.equal(await page.locator('.viewport-context-menu').count(),0);
      await page.getByRole('button',{name:'参数建模',exact:true}).click();
      const panel=page.getByTestId('advanced-modeling-panel');
      await panel.getByLabel('长度 X',{exact:true}).fill('boardWidth + 7 mm');
      await panel.getByRole('button',{name:'切换拖拽建模',exact:true}).click();
      assert.equal(await panel.count(),0);
      await page.getByRole('button',{name:'参数建模',exact:true}).click();
      assert.equal(await panel.getByLabel('长度 X',{exact:true}).inputValue(),'boardWidth + 7 mm');
      assert.equal((await command('document.summary')).stateToken,before.stateToken,'Cancelling and switching methods must not write project data');
      await close();
    });
    await check('height can return to footprint without a commit, and Backspace never steals text editing',async()=>{
      await page.getByRole('button',{name:'拖拽建模',exact:true}).click();
      await page.getByLabel('拖拽建模类型',{exact:true}).selectOption('box');
      const before=await command('document.summary');
      const bounds=await page.getByTestId('cad-viewport').boundingBox(),x=bounds.x+bounds.width*.3,y=bounds.y+bounds.height*.6;
      await page.mouse.click(x,y);await page.mouse.move(x+65,y-45,{steps:4});await page.mouse.click(x+65,y-45);
      await page.mouse.move(x+65,y-100,{steps:4});
      await page.getByRole('button',{name:'重选底面',exact:true}).click();
      assert.match(await page.locator('.drag-dimension-readout').innerText(),/底面 .*× 0 mm/);
      await page.mouse.move(x+90,y-60,{steps:4});await page.mouse.click(x+90,y-60);
      await page.mouse.move(x+90,y-120,{steps:4});await page.keyboard.press('Backspace');
      assert.equal(await page.getByRole('button',{name:'重选底面',exact:true}).count(),0);
      assert.match(await page.locator('.drag-dimension-readout').innerText(),/底面 .*× 0 mm/);
      await page.mouse.move(x+90,y-60,{steps:4});await page.mouse.click(x+90,y-60);await page.mouse.move(x+90,y-120,{steps:4});
      await page.getByRole('button',{name:'参数输入',exact:true}).click();
      const input=page.getByTestId('advanced-modeling-panel').getByLabel('长度 X',{exact:true});
      await input.fill('123');await input.press('End');await input.press('Backspace');assert.equal(await input.inputValue(),'12');
      assert.equal((await command('document.summary')).revision,before.revision,'Returning to a stage or editing a draft must not commit');
      await close();
    });
    await check('all fourteen drag tools complete their footprint/height stages and Esc never creates geometry',async()=>{
      await page.getByRole('button',{name:'拖拽建模',exact:true}).click();
      for(const kind of ['box','cylinder','cone','sphere','torus','wedge','prism','pyramid','tube','surface-rectangle','surface-disk','surface-cylinder','surface-cone','surface-sphere']){
        await page.getByLabel('拖拽建模类型',{exact:true}).selectOption(kind);await page.locator('[title="顶视图"]').click();
        const bounds=await page.getByTestId('cad-viewport').boundingBox(),x=bounds.x+bounds.width*.35,y=bounds.y+bounds.height*.55;
        const before=await command('document.summary');
        const operation=kind.startsWith('surface-')?kind.replace('-','.'):'primitive.'+kind;
        const creation=page.waitForResponse(response=>response.url().endsWith('/commands') && response.request().postDataJSON()?.operation===operation,{timeout:30000}).then(async response=>{
          const parameters=response.request().postDataJSON()?.parameters;
          // A stale view matrix once turned a 65px footprint into an 8m radius.
          for(const key of ['radius','majorRadius','width','baseWidth'])if(parameters[key]!==undefined)assert.ok(parameters[key]<1000,`${kind}.${key} unexpectedly large: ${parameters[key]}`);
          return {result:await response.json(),parameters};
        });
        await page.mouse.click(x,y);await page.mouse.move(x+65,y-45,{steps:4});await page.locator('.drag-dimension-readout').waitFor();
        const height=!['sphere','surface-sphere','surface-disk','surface-rectangle'].includes(kind);
        await page.mouse.click(x+65,y-45);
        if(height){
          assert.equal((await command('document.summary')).bodyCount,before.bodyCount,kind+' must not commit the footprint');
          await page.mouse.move(x+65,y-100,{steps:4});await page.mouse.click(x+65,y-100);
        }
        const {result,parameters}=await creation;assert.equal(result.ok,true,JSON.stringify({kind,parameters,result}));
        await page.waitForFunction(count=>document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===count+1,before.bodyCount);
        const after=await command('document.summary');assert.equal(after.bodyCount,before.bodyCount+1,kind);
        assert.equal(after.features.at(-1).type,operation);
        assert.equal(await page.locator('.drag-dimension-readout').count(),0);
      }
      const before=await command('document.summary');await page.getByLabel('拖拽建模类型',{exact:true}).selectOption('box');
      const bounds=await page.getByTestId('cad-viewport').boundingBox(),x=bounds.x+bounds.width*.3,y=bounds.y+bounds.height*.5;
      await page.mouse.click(x,y);await page.mouse.move(x+65,y-45,{steps:4});await page.mouse.click(x+65,y-45);await page.mouse.move(x+65,y-100,{steps:4});
      await page.keyboard.press('Escape');assert.equal(await page.locator('.drag-dimension-readout').count(),0);assert.equal((await command('document.summary')).revision,before.revision);
      await page.mouse.click(x,y);await page.mouse.move(x+65,y-45,{steps:4});
      await page.getByRole('button',{name:'取消绘制',exact:true}).click();
      assert.equal(await page.locator('.drag-modeling-feedback').count(),0);
      assert.equal((await command('document.summary')).revision,before.revision,'Visible cancel must not create geometry');
      await page.mouse.click(x,y);await page.mouse.move(x+65,y-45,{steps:4});
      await page.getByRole('button',{name:'参数输入',exact:true}).click();
      await page.getByTestId('advanced-modeling-panel').waitFor();
      assert.equal(await page.locator('.drag-modeling-feedback').count(),0);
      assert.equal((await command('document.summary')).revision,before.revision,'Switching to precise parameters must not create geometry');
      await close();
      await page.getByRole('button',{name:'参数建模',exact:true}).click();await close();
    });
    await page.getByRole('button',{name:'参数建模',exact:true}).click();
    await close();
    await check('construction planes guide real drawing, preserve fractional dimensions and cancel safely when changed',async()=>{
      await command('coordinate.set',{id:'drag_rotated',name:'Rotated drawing',origin:[100,200,50],xAxis:[0,1,0],yAxis:[0,0,1]});
      await page.reload({waitUntil:'networkidle'});
      await page.getByRole('button',{name:'拖拽建模',exact:true}).click();
      await page.getByLabel('拖拽建模类型',{exact:true}).selectOption('box');
      const before=await command('document.summary');
      await page.getByLabel('构造坐标系',{exact:true}).selectOption('drag_rotated');
      await page.getByLabel('构造平面吸附步长',{exact:true}).selectOption('0.5');
      await page.getByRole('button',{name:'正视构造面',exact:true}).click();
      assert.equal((await command('document.summary')).revision,before.revision,'Plane, snap and camera changes must not modify the project');
      const bounds=await page.getByTestId('cad-viewport').boundingBox(),x=bounds.x+bounds.width*.4,y=bounds.y+bounds.height*.55;
      await page.mouse.click(x,y);await page.mouse.move(x+80,y-50,{steps:6});
      await page.locator('.drag-dimension-readout').waitFor();
      await page.mouse.click(x+80,y-50);
      assert.equal((await command('document.summary')).bodyCount,before.bodyCount,'A footprint is not a committed Body');
      await page.mouse.move(x+80,y-120,{steps:6});
      const creation=page.waitForResponse(response=>response.url().endsWith('/commands') && response.request().postDataJSON()?.operation==='primitive.box');
      await page.mouse.click(x+80,y-120);
      const response=await creation,request=response.request().postDataJSON(),result=await response.json();
      assert.equal(result.ok,true,JSON.stringify(result));assert.equal(request.parameters.coordinateSystemId,'drag_rotated');
      const xs=result.positions.filter((_,index)=>index%3===0);
      assert.ok(Math.abs(Math.min(...xs)-100)<1e-5,'The base must lie on the rotated construction plane');
      assert.ok(Math.abs(Math.max(...xs)-100-request.parameters.height)<1e-5,'Height must follow local Z, not global Z');
      assert.equal(request.parameters.height*2,Math.round(request.parameters.height*2));
      await page.waitForFunction(count=>document.querySelectorAll('[data-testid="feature-tree"] [data-body-id]').length===count+1,before.bodyCount);
      const saved=await command('document.summary');
      await page.mouse.click(x,y);await page.mouse.move(x+70,y-45,{steps:4});
      await page.getByLabel('构造平面吸附步长',{exact:true}).selectOption('0.1');
      assert.equal(await page.locator('.drag-modeling-feedback').count(),0,'Changing snap must cancel the old drawing');
      await page.mouse.move(x,y);
      const marker = page.locator('.construction-snap-marker[data-point]');
      await marker.waitFor();
      const snapped = (await marker.getAttribute('data-point')).split(',').map(Number);
      assert.ok(snapped.every(value => Math.abs(value * 10 - Math.round(value * 10)) < 1e-8));
      await page.mouse.click(x,y);await page.mouse.move(x+70,y-45,{steps:4});await page.mouse.click(x+70,y-45);await page.mouse.move(x+70,y-90,{steps:4});
      await page.keyboard.press('Alt+m');
      const editor=page.getByTestId('advanced-modeling-panel');await editor.waitFor();
      assert.equal(await editor.getByLabel('参考坐标系',{exact:true}).inputValue(),'drag_rotated');
      assert.equal((await command('document.summary')).revision,saved.revision,'Switching to parameters must not create geometry');
      await close();
      await page.getByLabel('构造坐标系',{exact:true}).selectOption('global');
      await page.getByLabel('构造平面吸附步长',{exact:true}).selectOption('1');
      await page.locator('[title="顶视图"]').click();
      await page.screenshot({path:path.join(screenshots,'construction-plane.png'),fullPage:true});
    });
    await check('missing-variable creation and its geometry commit are one transaction and one Undo',async()=>{
      await page.locator('[data-command="primitive.box"]').click();const editor=page.getByTestId('advanced-modeling-panel'),before=await command('document.summary');
      await editor.getByLabel('长度 X',{exact:true}).fill('sessionWidth');await editor.getByLabel('高度 Z',{exact:true}).fill('7');await editor.getByRole('button',{name:'创建基础体',exact:true}).click();await editor.getByRole('dialog',{name:'创建缺失变量',exact:true}).waitFor();
      const batch=page.waitForResponse(r=>r.url().endsWith('/command-batches') && r.request().method()==='POST');await editor.getByRole('button',{name:'创建并重试',exact:true}).click();const result=await (await batch).json();assert.equal(result.ok,true,JSON.stringify(result));
      await page.waitForFunction(count=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.attachedBodies)>count,before.bodyCount);const saved=await command('document.summary');assert.equal(saved.bodyCount,before.bodyCount+1);assert.equal(saved.variables.find(v=>v.name==='sessionWidth').value,10);await close();
      const undone=page.waitForResponse(r=>r.url().endsWith('/commands') && r.request().postDataJSON()?.operation==='document.undo');await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal((await (await undone).json()).ok,true);const restored=await command('document.summary');assert.equal(restored.bodyCount,before.bodyCount);assert.equal(restored.variables.some(v=>v.name==='sessionWidth'),false);
    });
    await check('a drawing keeps its start-state precondition and never commits across an external project change',async()=>{
      await page.getByRole('button',{name:'拖拽建模',exact:true}).click();await page.getByLabel('拖拽建模类型',{exact:true}).selectOption('box');await page.locator('[title="顶视图"]').click();
      const viewport=await page.getByTestId('cad-viewport').boundingBox(),x=viewport.x+viewport.width*.3,y=viewport.y+viewport.height*.55,before=await command('document.summary');
      await page.mouse.click(x,y);await page.mouse.move(x+70,y-40,{steps:4});await page.mouse.click(x+70,y-40);await page.mouse.move(x+70,y-100,{steps:4});await command('variable.set',{name:'duringDrawing',type:'dimensionless',expression:'1'});
      await page.mouse.click(x+70,y-100);await page.waitForFunction(()=>document.querySelector('.command-error')?.textContent.includes('工程已') || document.body.textContent.includes('草稿已保留'));
      assert.equal((await command('document.summary')).bodyCount,before.bodyCount);assert.equal(await page.locator('.drag-dimension-readout').count(),0);await command('variable.delete',{}, {name:'duringDrawing'});await page.reload({waitUntil:'networkidle'});
    });
    await page.getByRole('button',{name:'参数建模',exact:true}).click();
    await page.locator('[data-command="primitive.box"]').click();
    await check('command failures remain traceable in a resizable journal without modifying geometry', async () => {
      const panel=page.getByTestId('advanced-modeling-panel'); await panel.getByLabel('长度 X').fill('0');
      const before=(await command('document.view')).revision;
      await panel.getByRole('button',{name:'创建基础体',exact:true}).click();
      await panel.locator('.exchange-message').waitFor(); await close();
      await page.getByRole('button',{name:/^命令日志/}).click();
      const journal=page.getByTestId('command-journal'); await journal.locator('.command-journal-entry.error').first().waitFor();
      assert.match(await page.locator('.ready-state').innerText(),/操作未完成/);
      await journal.getByLabel('仅失败').check(); assert.equal(await journal.locator('.command-journal-entry.success').count(),0);
      const failure=journal.locator('.command-journal-entry.error').first(); await failure.locator('summary').click();
      assert.match(await failure.innerText(),/请求 ID/); assert.match(await failure.innerText(),/错误码/);
      const resizer=page.getByRole('separator',{name:'调整消息面板高度'});
      const height=Number(await resizer.getAttribute('aria-valuenow'));
      const limit=Number(await resizer.getAttribute('aria-valuemax'));
      await resizer.focus(); await resizer.press('ArrowUp');
      assert.equal(Number(await resizer.getAttribute('aria-valuenow')),Math.min(limit,height+20));
      await assertModelVisible();
      await page.screenshot({path:path.join(screenshots,'command-journal.png'),fullPage:true});
      assert.equal((await command('document.view')).revision,before);
      await journal.getByRole('button',{name:'清除已完成'}).click(); assert.equal(await journal.locator('details').count(),0);
      assert.match(await page.locator('.ready-state').innerText(),/^就绪$/);
    });
    await check('WebGL context recovery rebuilds cached bodies without modifying the CAD project',async()=>{
      const before=await command('document.view');await assertModelVisible();
      const oldCanvas=await page.getByTestId('cad-viewport').locator('canvas').elementHandle();
      await oldCanvas.evaluate(canvas=>{const extension=canvas.getContext('webgl2').getExtension('WEBGL_lose_context');if(!extension)throw new Error('WebGL context loss testing is unavailable');extension.loseContext();setTimeout(()=>extension.restoreContext(),200);});
      await page.waitForFunction(canvas=>!canvas.isConnected,oldCanvas,{timeout:15000});
      await assertModelVisible();assert.equal(await page.getByTestId('cad-viewport').locator('canvas').count(),1);
      const after=await command('document.view');assert.equal(after.revision,before.revision);assert.equal(after.bodyCount,before.bodyCount);
      await page.screenshot({path:path.join(screenshots,'viewport-recovery.png'),fullPage:true});
    });
    await check('named workspaces survive refresh and empty projects stay empty when reopened',async()=>{
      const sourceId=await page.locator('main.cad-shell').getAttribute('data-document-id'),before=await command('document.view');
      await page.getByRole('button',{name:'工程名称与恢复'}).click();
      const manager=page.getByTestId('workspace-manager');await manager.getByLabel('当前工程名称').fill('前处理验证工程');await manager.getByRole('button',{name:'保存工程名称',exact:true}).click();
      await page.locator('.workspace-identity strong').filter({hasText:/^前处理验证工程\*?$/}).waitFor();await project.getByText('前处理验证工程',{exact:true}).waitFor();await close();
      await page.getByRole('tab',{name:'工程',exact:true}).click();
      const download=page.waitForEvent('download');await page.locator('[data-command="file.save"]').click();const backup=await download;assert.equal(backup.suggestedFilename(),'前处理验证工程.cadproj');
      await page.locator('.workspace-identity small').filter({hasText:'备份包已生成'}).waitFor();
      await page.reload({waitUntil:'networkidle'});await page.waitForFunction(id=>document.querySelector('main.cad-shell').dataset.documentId===id,sourceId);await assertModelVisible();assert.equal((await command('document.view')).revision,before.revision);
      await page.getByRole('tab',{name:'工程',exact:true}).click();await page.locator('[data-command="file.new"]').click();await page.getByText('暂无几何，使用上方创建工具添加。',{exact:true}).waitFor();
      const emptyId=await page.locator('main.cad-shell').getAttribute('data-document-id');assert.notEqual(emptyId,sourceId);
      await page.reload({waitUntil:'networkidle'});await page.waitForFunction(id=>document.querySelector('main.cad-shell').dataset.documentId===id,emptyId);assert.equal((await command('document.view')).bodyCount,0);assert.equal((await command('document.view')).revision,0);
      await page.getByRole('button',{name:'拖拽建模',exact:true}).click();await page.getByLabel('拖拽建模类型',{exact:true}).selectOption('box');
      const emptyBounds=await page.getByTestId('cad-viewport').boundingBox();await page.mouse.click(emptyBounds.x+emptyBounds.width*.3,emptyBounds.y+emptyBounds.height*.35);await page.mouse.move(emptyBounds.x+emptyBounds.width*.55,emptyBounds.y+emptyBounds.height*.6,{steps:6});await page.locator('.drag-dimension-readout').waitFor();assert.equal((await command('document.view')).bodyCount,0);
      await page.getByRole('button',{name:'工程名称与恢复'}).click();const recovered=page.getByTestId('workspace-manager');await recovered.getByLabel('查找工程').fill('前处理验证工程');await recovered.getByRole('button',{name:'恢复',exact:true}).click();
      await page.waitForFunction(id=>document.querySelector('main.cad-shell').dataset.documentId===id,sourceId);await assertModelVisible();assert.equal((await command('document.view')).bodyCount,before.bodyCount);
      assert.equal(await page.locator('.drag-dimension-readout').count(),0,'Switching workspaces must cancel the old preview');
      await page.screenshot({path:path.join(screenshots,'workspace-recovered.png'),fullPage:true});
    });
    await check('ambiguous property references keep their values and require an explicit highlighted candidate',async()=>{
      await page.getByRole('tab',{name:'工程',exact:true}).click();await page.locator('[data-command="file.new"]').click();await geometry.getByText('暂无几何，使用上方创建工具添加。',{exact:true}).waitFor();await command('document.summary');
      const box=await command('primitive.box',{width:100,depth:100,height:20});let top;
      for(const selectionId of new Set(box.triangleFaceIds)){const face=await command('geometry.measure',{}, {bodyId:box.bodyId,selectionType:'face',selectionId});if(Math.abs(face.centroid[2]-20)<1e-6){top=selectionId;break;}}
      assert.ok(top);const type=await command('property.type.create',{key:'ReviewPort',name:'待复核端口',targetScope:'face',association:'required',fields:[{key:'frequency',label:'频率',type:'double'}]});
      const instance=await command('property.instance.create',{typeId:type.type.typeId,name:'SplitPort',value:{frequency:3},target:{kind:'face',bodyId:box.bodyId,topologyId:top}});
      await command('primitive.box',{width:20,depth:120,height:40,x:40,y:-10,z:-10});
      await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:'布尔',exact:true}).click();await page.locator('[data-command="boolean.cut"]').click();
      const boolean=page.getByTestId('advanced-boolean-panel');await boolean.getByLabel('结果拆分为多个 Body',{exact:true}).check();await boolean.getByRole('button',{name:'执行 Boolean cut',exact:true}).click();await boolean.getByRole('status').filter({hasText:/Boolean cut 完成/}).waitFor();
      const cut=await command('document.view');assert.equal(cut.bodyCount,2);await close();
      await page.reload({waitUntil:'networkidle'});await assertModelVisible();
      const row=project.locator('button.managed-record').filter({has:page.locator('strong',{hasText:/^SplitPort$/})});await row.waitFor();assert.match(await row.innerText(),/关联待复核/);await row.click();
      const panel=page.getByTestId('property-schema-panel'),review=panel.getByRole('status',{name:'属性关联待复核'});await review.waitFor();
      await panel.getByLabel('频率',{exact:true}).fill('6');await panel.getByRole('button',{name:'保存实例',exact:true}).click();await panel.getByText('实例已保存，工程树已同步。',{exact:true}).waitFor();
      const unresolved=(await command('property.instance.list')).instances.find(item=>item.instanceId===instance.instance.instanceId);assert.equal(unresolved.state,'needs-review');assert.equal(unresolved.value.frequency,6);assert.equal(unresolved.association.anchor.topologyId,top);
      await review.locator('summary').click();const candidate=unresolved.association.candidates[0];await review.getByRole('button',{name:`${candidate.bodyId} · ${candidate.topologyId} · 定位并选用`,exact:true}).click();
      await page.getByTestId('selection-readout').getByText(`面拾取 · ${candidate.topologyId}`,{exact:true}).waitFor();await page.screenshot({path:path.join(screenshots,'property-association-review.png'),fullPage:true});
      await panel.getByRole('button',{name:'保存实例',exact:true}).click();await review.waitFor({state:'detached'});
      const resolved=(await command('property.instance.list')).instances.find(item=>item.instanceId===instance.instance.instanceId);assert.equal(resolved.state,'active');assert.equal(resolved.target.topologyId,candidate.topologyId);assert.equal(resolved.target.bodyId,candidate.bodyId);
      assert.equal((await command('document.summary')).revision,cut.revision,'Property review must not modify CAD geometry');await close();
    });
    await check('editing an upstream primitive preserves the bound face and highlights its recomputed geometry',async()=>{
      const before=(await command('property.instance.list')).instances.find(item=>item.name==='SplitPort');assert.ok(before);
      const source=(await command('document.summary')).features.find(feature=>feature.type==='primitive.box');
      await geometry.locator(`button.feature-tree-label[title^="primitive.box · ${source.id} ·"]`).first().dblclick();
      const editor=page.getByTestId('feature-history-controls');await editor.getByLabel('特征参数 height',{exact:true}).fill('30');
      const response=page.waitForResponse(response=>response.url().endsWith('/api/commands') && response.request().postDataJSON()?.operation==='feature.update');await editor.getByRole('button',{name:'修改参数并重算',exact:true}).click();const updated=await (await response).json();assert.equal(updated.ok,true,JSON.stringify(updated));await close();
      const after=(await command('property.instance.list')).instances.find(item=>item.instanceId===before.instanceId);assert.equal(after.state,'active');assert.notEqual(after.target.topologyId,before.target.topologyId);
      const row=project.locator('button.managed-record').filter({has:page.locator('strong',{hasText:/^SplitPort$/})});await page.waitForFunction(()=>{const label=[...document.querySelectorAll('button.managed-record')].find(node=>node.querySelector('strong')?.textContent==='SplitPort');return label && !label.classList.contains('invalid');});
      await row.click();await page.getByTestId('selection-readout').getByText(`面拾取 · ${after.target.topologyId}`,{exact:true}).waitFor();
      const face=await command('geometry.measure',{}, {bodyId:after.target.bodyId,selectionType:'face',selectionId:after.target.topologyId});assert.ok(Math.abs(face.centroid[2]-30)<1e-6);assert.equal(face.revision,updated.revision);
      await assertModelVisible();await page.screenshot({path:path.join(screenshots,'property-after-recompute.png'),fullPage:true});
    });
    await check('Sheet Body uses one mesh toggle, restores it after Body hide/show, and cannot locate stale surface results',async()=>{
      await page.getByRole('tab',{name:'工程',exact:true}).click();await page.locator('[data-command="file.new"]').click();await geometry.getByText('暂无几何，使用上方创建工具添加。',{exact:true}).waitFor();await command('document.summary');
      const solid=await command('primitive.box',{width:20,depth:20,height:20,x:-10,y:-10,z:-10}),sheet=await command('surface.rectangle',{width:40,height:40});
      await page.reload({waitUntil:'networkidle'});await assertModelVisible();await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
      const mesh=page.getByTestId('mesh-workbench-panel');await mesh.getByRole('button',{name:'开始剖分（结果默认隐藏）',exact:true}).click();await mesh.locator('.mesh-job-card').waitFor({timeout:60000});
      const row=geometry.locator('[data-body-id="'+sheet.bodyId+'"]'),toggle=row.locator('.body-mesh-visibility-button'),viewport=page.getByTestId('cad-viewport');
      await toggle.waitFor();assert.equal(await toggle.count(),1);assert.equal(await toggle.getAttribute('aria-pressed'),'false');await toggle.click();await row.locator('.body-mesh-visibility-button[aria-pressed="true"]').waitFor();
      await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups)>0);
      await row.locator('.body-visibility-button').click();await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups)===0);
      await row.locator('.body-visibility-button').click();await row.locator('.body-visibility-button[aria-pressed="true"]').waitFor();await page.waitForFunction(()=>Number(document.querySelector('[data-testid="cad-viewport"]').dataset.renderedMeshGroups)>0);assert.equal(await toggle.getAttribute('aria-pressed'),'true');
      const boundary=mesh.locator('.mesh-boundary-panel');await boundary.locator(':scope > summary').click();await boundary.getByLabel('面来源 Body',{exact:true}).selectOption(sheet.bodyId);const locate=boundary.getByRole('button',{name:/^定位 CAD 面 /});await locate.waitFor();await locate.click();
      assert.ok(await viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-selection'));return Number(node.dataset.selectedFacePixels);})>10);await page.screenshot({path:path.join(screenshots,'sheet-mesh-provenance.png'),fullPage:true});
      await close();await command('document.summary');await command('feature.update',{height:24},{featureId:solid.features[0].id});await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();
      const stale=page.getByTestId('mesh-workbench-panel').locator('.mesh-boundary-panel');await stale.locator(':scope > summary').click();await stale.getByLabel('面来源 Body',{exact:true}).selectOption(sheet.bodyId);await stale.getByRole('table',{name:'CAD 面与网格面对应'}).waitFor();assert.equal(await stale.getByRole('button',{name:/^定位 CAD 面 /}).isDisabled(),true);assert.equal(await geometry.locator('.body-mesh-visibility-button').count(),0);await close();
    });
    await check('repair preview draws real pixels, disables CAD picking, survives context recovery and leaves the original document untouched',async()=>{
      const before=await command('document.summary');await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();const mesh=page.getByTestId('mesh-workbench-panel');
      const created=page.waitForResponse(response=>response.url().includes('/mesh/jobs')&&response.request().method()==='POST'&&response.request().postDataJSON()?.kind==='preparation');await mesh.getByRole('button',{name:'诊断并预览修复',exact:true}).click();const accepted=await (await created).json();assert.equal(accepted.meshJob.kind,'preparation');
      const report=mesh.getByRole('group',{name:'几何诊断与修复预览'});await report.getByRole('button',{name:'预览修复快照（只读）',exact:true}).waitFor({timeout:60000});
      const saved=await (await fetch(api+'/mesh/jobs/'+accepted.meshJob.jobId)).json();assert.equal(saved.preparation.diagnostics.status,'ready');assert.equal(saved.mesh,undefined);
      const viewport=page.getByTestId('cad-viewport');await report.getByRole('button',{name:'预览修复快照（只读）',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.preparationPreviewState==='visible');
      assert.ok(await viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-preparation'));return Number(node.dataset.preparationPreviewPixels);})>100,'Prepared geometry must actually draw');
      const selected=await page.getByTestId('selection-readout').innerText(),bounds=await viewport.boundingBox();await page.mouse.click(bounds.x+bounds.width*.25,bounds.y+bounds.height*.5);assert.equal(await page.getByTestId('selection-readout').innerText(),selected,'A diagnostic snapshot must not enter CAD picking');
      await page.screenshot({path:path.join(screenshots,'repair-preview.png'),fullPage:true});const oldCanvas=await viewport.locator('canvas').elementHandle();await oldCanvas.evaluate(canvas=>{const extension=canvas.getContext('webgl2').getExtension('WEBGL_lose_context');extension.loseContext();setTimeout(()=>extension.restoreContext(),200);});
      await page.waitForFunction(old=>!old.isConnected,oldCanvas);await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.contextState==='ready'&&document.querySelector('[data-testid="cad-viewport"]').dataset.preparationPreviewState==='visible');
      assert.ok(await viewport.evaluate(node=>{node.dispatchEvent(new Event('cad:verify-preparation'));return Number(node.dataset.preparationPreviewPixels);})>100);
      await page.getByRole('button',{name:'退出预览，返回工程',exact:true}).click();await assertModelVisible();const after=await command('document.summary');for(const key of ['revision','bodyCount','features','bodyMetadata','entityIdentities'])assert.deepEqual(after[key],before[key]);
      await report.getByRole('button',{name:'预览修复快照（只读）',exact:true}).click();await close();await page.waitForFunction(()=>document.querySelector('[data-testid="cad-viewport"]').dataset.preparationPreviewState==='hidden');await assertModelVisible();
    });
    await check('a restored preparation is hidden until requested and meshes the exact selected snapshot with a zero quality threshold',async()=>{
      await page.reload({waitUntil:'networkidle'});await assertModelVisible();await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();const mesh=page.getByTestId('mesh-workbench-panel');
      const report=mesh.getByRole('group',{name:'几何诊断与修复预览'});await report.getByRole('button',{name:'预览修复快照（只读）',exact:true}).waitFor();assert.notEqual(await page.getByTestId('cad-viewport').getAttribute('data-preparation-preview-state'),'visible');
      const list=await (await fetch(api+'/documents/'+await page.locator('main.cad-shell').getAttribute('data-document-id')+'/mesh/jobs')).json(),preview=list.jobs.find(job=>job.kind==='preparation'&&job.state==='complete');assert.ok(preview);
      await mesh.getByLabel('质量阈值',{exact:true}).fill('0');const created=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/mesh/jobs')&&response.request().postDataJSON()?.preparationJobId===preview.jobId);await report.getByRole('button',{name:'使用此快照剖分',exact:true}).click();const accepted=await (await created).json();await mesh.locator('.mesh-job-card[data-job-id="'+accepted.meshJob.jobId+'"]').waitFor({timeout:60000});
      const result=await (await fetch(api+'/mesh/jobs/'+accepted.meshJob.jobId)).json();assert.equal(result.meshJob.preparationJobId,preview.jobId);assert.equal(result.mesh.quality.threshold,0);assert.equal(result.meshJob.visible,false);
      await page.screenshot({path:path.join(screenshots,'repair-snapshot-meshed.png'),fullPage:true});await close();
    });
    await check('a blocked preparation exposes actionable diagnostics without claiming a mesh exists',async()=>{
      await page.getByRole('tab',{name:'工程',exact:true}).click();await page.locator('[data-command="file.new"]').click();await geometry.getByText('暂无几何，使用上方创建工具添加。',{exact:true}).waitFor();await command('document.summary');await command('surface.rectangle',{width:20,height:20});await page.reload({waitUntil:'networkidle'});
      const before=await command('document.summary');await page.getByRole('tab',{name:'网格',exact:true}).click();await page.locator('[data-command="analysis.mesh"]').click();const mesh=page.getByTestId('mesh-workbench-panel');await mesh.getByLabel('深入自交检查（预览时较慢）',{exact:true}).uncheck();await mesh.getByRole('button',{name:'诊断并预览修复',exact:true}).click();
      const report=mesh.getByRole('group',{name:'几何诊断与修复预览'});await report.getByRole('status').filter({hasText:'没有闭合实体'}).waitFor({timeout:60000});assert.equal(await report.getByRole('button',{name:'预览修复快照（只读）',exact:true}).count(),0);assert.equal(await report.getByRole('button',{name:'使用此快照剖分',exact:true}).isDisabled(),true);assert.equal(await mesh.locator('.mesh-job-card').count(),0);
      await report.getByRole('button',{name:'展开诊断明细',exact:true}).click();await report.getByText('开放边界',{exact:true}).first().waitFor();await report.getByRole('button',{name:'定位原几何',exact:true}).first().click();assert.match(await page.getByTestId('selection-readout').innerText(),/edge-/);assert.equal((await command('document.summary')).revision,before.revision);
      const row=geometry.locator('[data-body-id="'+before.bodyMetadata[0].bodyId+'"]'),locate=report.getByRole('button',{name:'定位原几何',exact:true});
      await row.locator('.body-visibility-button').click();await page.waitForFunction(()=>[...document.querySelectorAll('.mesh-diagnostic-issues button')].every(button=>button.disabled));assert.equal(await locate.first().getAttribute('title'),'请先在几何树显示此 Body');
      await row.locator('.body-visibility-button').click();await page.waitForFunction(()=>[...document.querySelectorAll('.mesh-diagnostic-issues button')].some(button=>!button.disabled));assert.equal(await locate.first().isEnabled(),true);
      await page.screenshot({path:path.join(screenshots,'repair-blocked-report.png'),fullPage:true});
    });
    await check('long diagnostic reports retain reachable window controls and a correctly sized native checkbox',async()=>{
      const dialog=page.getByTestId('operation-window'),body=dialog.locator('.operation-window-body');
      await body.evaluate(async node=>{node.scrollTop=node.scrollHeight;await new Promise(resolve=>requestAnimationFrame(resolve));});
      const header=await dialog.locator('.operation-window-header').boundingBox(),bounds=await dialog.boundingBox();assert.ok(header.y>=bounds.y&&header.y+header.height<=bounds.y+bounds.height,'Window title must stay inside the visible frame while its report scrolls');
      assert.equal(await dialog.getByRole('button',{name:'关闭操作窗口',exact:true}).evaluate(node=>{const rect=node.getBoundingClientRect();return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('button')===node;}),true,'Close must be clickable, not covered by report content');
      const checkbox=await dialog.getByRole('checkbox',{name:'深入自交检查（预览时较慢）',exact:true}).evaluate(node=>{const style=getComputedStyle(node),label=getComputedStyle(node.closest('label'));return {height:node.getBoundingClientRect().height,minHeight:parseFloat(style.minHeight),padding:style.padding,labelSize:parseFloat(label.fontSize),labelHeight:parseFloat(label.minHeight)};});
      assert.ok(checkbox.height<=18&&checkbox.minHeight<=18,JSON.stringify(checkbox));assert.equal(checkbox.padding,'0px');assert.ok(checkbox.labelSize>=12&&checkbox.labelHeight>=40);
      await page.screenshot({path:path.join(screenshots,'repair-report-controls.png'),fullPage:true});await close();
    });
    await check('narrow viewport stays within the page', async () => { await page.setViewportSize({ width: 640, height: 800 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)); await page.screenshot({ path: path.join(screenshots, 'narrow.png'), fullPage: true }); });
    await check('large assembly edges remain visible and pickable with shading enabled', async () => {
      await page.setViewportSize({width:1440,height:960});
      await page.getByRole('tab',{name:'工程',exact:true}).click();
      await page.locator('[data-command="file.new"]').click();
      await geometry.getByText('暂无几何，使用上方创建工具添加。',{exact:true}).waitFor();
      await command('document.summary');
      for (let i = 0; i < 9; i++) await command('primitive.box',{width:8,depth:8,height:8,x:12*(i%3),y:12*Math.floor(i/3)});
      await page.reload({waitUntil:'networkidle'});
      const viewport = page.getByTestId('cad-viewport');
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="cad-viewport"]').dataset.visibleBodies) === 9);
      await page.getByLabel('模型显示模式',{exact:true}).selectOption('shaded');
      await page.getByRole('button',{name:'边',exact:true}).click();
      await page.waitForFunction(() => {
        const canvas=document.querySelector('[data-testid="cad-viewport"]');
        canvas.dispatchEvent(new Event('cad:verify-frame'));
        return JSON.parse(canvas.dataset.edgeScreenPoints || '[]').filter(point => point.pickable).length > 9;
      });
      const point=await viewport.evaluate(node=>JSON.parse(node.dataset.edgeScreenPoints).find(point=>point.pickable&&point.x>100&&point.y>90));
      assert.ok(point);
      const bounds=await viewport.boundingBox();
      await page.mouse.click(bounds.x+point.x,bounds.y+point.y);
      await page.getByTestId('selection-readout').getByText(`边拾取 · ${point.edgeId}`,{exact:true}).waitFor();
    });
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ passed: passed.length, screenshots, browserErrors: errors }, null, 2) + '\n');
  } catch (error) { if (browser) { const pages = browser.contexts().flatMap((context) => context.pages()); if (pages[0]) { await pages[0].screenshot({ path: path.join(screenshots, 'failure.png'), fullPage: true }); process.stderr.write((await pages[0].locator('body').innerText()).slice(0, 12000) + '\n'); } } throw error; }
  finally { for (const context of browser?.contexts() || []) for (const page of context.pages()) await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {}); await browser?.close(); await stopTestChild(gateway); const resolved = path.resolve(data); if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('cad-workbench-ui-')) fs.rmSync(resolved, { recursive: true, force: true }); }
})().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
