import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {stopTestChild} from './helpers/stop-test-child.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(data, environment = {}) {
  const child = spawn(process.execPath, ['tests/fixtures/gateway-shutdown.mjs'], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {...process.env, GEOMETRY_DATA_DIR: data, GEOMETRY_PORT: String(await freePort()), GEOMETRY_WORKER_TIMEOUT_MS: '5000', GEOMETRY_WORKER_STARTUP_TIMEOUT_MS: '5000', GEOMETRY_WORKER_STOP_TIMEOUT_MS: '2000', CAD_TEST_NATIVE_REQUEST_EVENTS: '1', ...environment},
  });
  const events = [];
  let buffer = '', diagnostics = '', address;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const match = line.match(/Geometry gateway ready at 127\.0\.0\.1:(\d+)/);
      if (match) address = 'http://127.0.0.1:' + match[1] + '/api';
      try { events.push(JSON.parse(line)); } catch { /* Human startup line. */ }
    }
  });
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-32768); });
  async function until(predicate, message) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      assert.equal(child.exitCode, null, diagnostics);
      assert.ok(Date.now() < deadline, message + '\n' + diagnostics);
      await tick();
    }
  }
  try { await until(() => address, 'Private action-queue Gateway not ready'); }
  catch (error) { await stopTestChild(child); throw error; }
  const get = async route => fetch(address + route).then(response => response.json());
  const tell = type => child.stdin.write(JSON.stringify({type}) + '\n');
  const event = (type, offset = 0) => until(() => events.slice(offset).find(item => item.type === 'fixture.' + type), 'Missing event: ' + type);
  const post = async (documentId, parameters, extra = {}) => {
    const response = await fetch(address + '/commands', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({documentId, operation: 'primitive.box', parameters, ...extra}),
    });
    return {status: response.status, value: await response.json()};
  };
  async function seed(id) {
    const result = await post(id, {width: 10, depth: 20, height: 30});
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return get('/documents/' + id);
  }
  async function stop() {
    if (child.exitCode == null && child.signalCode == null) {
      tell('release-geometry'); tell('release-geometry-exit');
      const control = JSON.parse(fs.readFileSync(path.join(data, '.gateway-control.json'), 'utf8'));
      let timer;
      const closed = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('Action-queue fixture shutdown unconfirmed; preserve its data and inspect the same child')), 15000);
        child.once('close', resolve);
      });
      try {
        await fetch(address + '/runtime/shutdown', {method: 'POST', headers: {'x-cad-shutdown-token': control.token}});
        await closed;
      } finally { clearTimeout(timer); }
      assert.equal(child.exitCode, 0, diagnostics);
    }
    await stopTestChild(child, {timeoutMs: 15000});
  }
  return {child, events, get, tell, event, post, seed, stop, until};
}
function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cad-document-actions-')); }
function cleanup(data) {
  const resolved = path.resolve(data), parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), parent);
  assert.ok(path.basename(resolved).startsWith('cad-document-actions-'));
  fs.rmSync(resolved, {recursive: true, force: true});
}
const box = {width: 3, depth: 4, height: 5, x: 40};

test('real shared native admission bounds per-document/global queues, stays observable, and preserves FIFO across projects', async () => {
  const data = scratch(); let f;
  try {
    f = await fixture(data, {GEOMETRY_ACTION_QUEUE_LIMIT: '2', GEOMETRY_ACTION_DOCUMENT_QUEUE_LIMIT: '1'});
    const a = await f.seed('a'), b = await f.seed('b');
    f.tell('arm-geometry'); await f.event('geometry-armed');
    const first = f.post('a', box, {baseRevision: a.revision, baseStateToken: a.stateToken});
    const held = await f.event('geometry-held'), offset = f.events.length;
    const queuedA = f.get('/documents/a');
    await f.until(async () => (await f.get('/health')).lifecycle.documentActions.queued === 1, 'A did not queue');
    const perDocument = await f.post('a', box);
    assert.equal(perDocument.status, 429);
    assert.equal(perDocument.value.code, 'DOCUMENT_ACTION_QUEUE_LIMIT');
    assert.equal(perDocument.value.execution, 'not-started');
    assert.equal(perDocument.value.retryableByModel, false);
    const queuedB = f.post('b', box, {baseRevision: b.revision, baseStateToken: b.stateToken});
    await f.until(async () => (await f.get('/health')).lifecycle.documentActions.queued === 2, 'B did not queue');
    const global = await f.post('c', box);
    assert.equal(global.status, 429);
    assert.equal(global.value.code, 'DOCUMENT_ACTION_QUEUE_LIMIT');
    const health = await f.get('/health');
    assert.equal(health.ok, true);
    assert.equal(health.lifecycle.activeDocuments, 1);
    assert.equal(health.lifecycle.documentActions.maxActive, 1);
    assert.equal(health.lifecycle.documentActions.rejected, 2);
    assert.equal(f.events.slice(offset).some(item => item.type === 'fixture.native-request' && ['b', 'c'].includes(item.documentId)), false);
    f.tell('release-geometry');
    const [resultA, readA, resultB] = await Promise.all([first, queuedA, queuedB]);
    assert.equal(resultA.value.ok, true);
    assert.equal(readA.revision, held.revision);
    assert.equal(resultB.value.ok, true);
    assert.equal(resultB.value.bodyCount, 2);
    const requests = f.events.slice(offset).filter(item => item.type === 'fixture.native-request');
    const firstB = requests.findIndex(item => item.documentId === 'b');
    assert.ok(firstB > 0);
    assert.ok(requests.slice(0, firstB).some(item => item.documentId === 'a' && item.operation === 'document.snapshot'));
    assert.equal(requests.some(item => item.documentId === 'c'), false);
  } finally { if (f) { await f.stop(); cleanup(data); } }
});

test('another project cannot enter the native worker before actual exit and complete rollback of the interrupted owner', async () => {
  const data = scratch(); let f;
  try {
    f = await fixture(data, {GEOMETRY_WORKER_TIMEOUT_MS: '500', GEOMETRY_WORKER_STOP_TIMEOUT_MS: '2000'});
    const beforeA = await f.seed('a'), beforeB = await f.seed('b');
    f.tell('arm-geometry'); await f.event('geometry-armed');
    f.tell('arm-geometry-exit'); await f.event('geometry-exit-armed');
    const first = f.post('a', box); await f.event('geometry-held');
    const offset = f.events.length;
    const second = f.post('b', box, {baseStateToken: beforeB.stateToken});
    await f.event('geometry-exit-held');
    const health = await f.get('/health');
    assert.equal(health.lifecycle.documentActions.active, 1);
    assert.equal(health.lifecycle.documentActions.queued, 1);
    assert.equal(f.events.slice(offset).some(item => item.type === 'fixture.native-request' && item.documentId === 'b'), false);
    f.tell('release-geometry-exit');
    const [failed, resultB] = await Promise.all([first, second]);
    assert.equal(failed.value.code, 'WORKER_TIMEOUT');
    assert.equal(failed.value.projectRollback.confirmed, true);
    assert.equal(resultB.value.ok, true, JSON.stringify(resultB));
    assert.equal(resultB.value.bodyCount, 2);
    const restoredA = await f.get('/documents/a');
    assert.equal(restoredA.stateToken, beforeA.stateToken);
    assert.equal(restoredA.bodyCount, 1);
    const requests = f.events.slice(offset).filter(item => item.type === 'fixture.native-request');
    const restoreA = requests.findIndex(item => item.documentId === 'a' && item.operation === 'document.restore');
    const firstB = requests.findIndex(item => item.documentId === 'b');
    assert.ok(restoreA !== -1 && firstB > restoreA);
    assert.equal(fs.readdirSync(path.join(data, 'document-transactions')).some(file => file.endsWith('.pending.json')), false);
  } finally { if (f) { await f.stop(); cleanup(data); } }
});

test('real queued command deadline is a not-started outcome with no native execution or project history change', async () => {
  const data = scratch(); let f;
  try {
    f = await fixture(data, {GEOMETRY_ACTION_QUEUE_TIMEOUT_MS: '80'});
    const before = await f.seed('b'); await f.seed('a');
    f.tell('arm-geometry'); await f.event('geometry-armed');
    const first = f.post('a', box); await f.event('geometry-held');
    const offset = f.events.length;
    const result = await f.post('b', box);
    assert.equal(result.status, 504);
    assert.equal(result.value.code, 'DOCUMENT_ACTION_QUEUE_TIMEOUT');
    assert.equal(result.value.execution, 'not-started');
    assert.equal(result.value.retryableByModel, false);
    assert.equal(f.events.slice(offset).some(item => item.type === 'fixture.native-request' && item.documentId === 'b'), false);
    assert.equal((await f.get('/health')).lifecycle.documentActions.expired, 1);
    f.tell('release-geometry'); assert.equal((await first).value.ok, true);
    const after = await f.get('/documents/b');
    assert.equal(after.stateToken, before.stateToken);
    assert.equal(after.revision, before.revision);
    assert.equal(after.bodyCount, before.bodyCount);
  } finally { if (f) { await f.stop(); cleanup(data); } }
});

test('invalid action admission policy refuses startup before data directory ownership and persistent stores', async () => {
  const data = scratch(); let child;
  try {
    child = spawn(process.execPath, ['gateway/server.mjs'], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, GEOMETRY_DATA_DIR: data, GEOMETRY_ACTION_QUEUE_LIMIT: '0'}});
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Invalid-policy startup did not exit')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    assert.notEqual(child.exitCode, 0);
    assert.match(output, /DOCUMENT_ACTION_CONFIG_INVALID/);
    assert.deepEqual(fs.readdirSync(data), []);
  } finally { await stopTestChild(child); cleanup(data); }
});
