import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';

const route = '/documents/default/command-journal';
const box = (extra = {}) => ({
  documentId: 'default', requestId: randomUUID(), operation: 'primitive.box',
  parameters: {width: 3, depth: 4, height: 5}, ...extra,
});
const read = async (fixture, requestId) => {
  const result = await fixture.get(route + '?requestId=' + encodeURIComponent(requestId));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.entries[0];
};

test('project journal retains original requests and reconciles only from committed evidence after restart', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-command-journal-'));
  let fixture;
  try {
    fixture = await gatedGeometryGateway(data);
    const original = box({idempotencyKey: randomUUID()});
    const committed = await fixture.post('/commands', original);
    assert.equal(committed.value.ok, true);
    const rejected = box({parameters: {width: 'invalid', depth: 4, height: 5}});
    const failure = await fixture.post('/commands', rejected);
    assert.equal(failure.value.ok, false);
    const cancelled = box({idempotencyKey: randomUUID()});
    const task = await fixture.reserve(cancelled);
    assert.equal((await read(fixture, cancelled.requestId)).status, 'running');
    assert.equal((await fixture.cancel(task)).value.modelingTask.phase, 'cancelled');
    const interrupted = box();
    await fixture.reserve(interrupted);
    const foreign = box({documentId: 'other'});
    assert.equal((await fixture.post('/commands', foreign)).value.ok, true);
    assert.deepEqual((await fixture.get('/documents/other/command-journal')).entries.map(entry => entry.requestId), [foreign.requestId]);
    assert.equal(await fixture.stop(), 0);

    // Recreate the journal state immediately before the final report was written.
    // The project checkpoint and receipt remain exactly as the Gateway produced them.
    const file = path.join(data, 'command-journal', 'default.json');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = before.entries.find(entry => entry.requestId === original.requestId);
    assert.equal(row.status, 'success');
    row.status = 'running';
    delete row.revision;
    fs.writeFileSync(file, JSON.stringify(before));

    fixture = await gatedGeometryGateway(data);
    const model = await fixture.cad('document.summary');
    const nativeCount = fixture.events.filter(item => item.type === 'fixture.native-request').length;
    const persisted = await read(fixture, original.requestId);
    assert.equal(persisted.status, 'success');
    assert.equal(persisted.revision, committed.value.revision);
    assert.deepEqual(await read(fixture, original.requestId), persisted);
    for (const key of ['parameters', 'inputs', 'fingerprint', 'receiptKey', 'stateToken', 'error']) assert.equal(Object.hasOwn(persisted, key), false);
    const failed = await read(fixture, rejected.requestId);
    assert.equal(failed.status, 'error');
    assert.equal(failed.code, failure.value.code);
    const stopped = await read(fixture, cancelled.requestId);
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.taskId, task.taskId);
    assert.equal((await read(fixture, interrupted.requestId)).status, 'unknown');
    assert.equal(fixture.events.filter(item => item.type === 'fixture.native-request').length, nativeCount);

    const unauthorized = await fetch(fixture.api + route, {method: 'DELETE', headers: {origin: 'https://untrusted.invalid'}});
    assert.equal(unauthorized.status, 403);
    const cleared = await fetch(fixture.api + route, {method: 'DELETE'}).then(response => response.json());
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.entries.map(entry => entry.requestId), [interrupted.requestId]);
    assert.equal((await fixture.get('/documents/other/command-journal')).entries.length, 1);
    assert.equal((await fixture.cad('document.summary')).revision, model.revision);
    assert.equal((await fixture.cad('document.undo')).bodyCount, 0);
  } finally {
    if (fixture) await fixture.stop();
    assert.equal(path.dirname(data), os.tmpdir());
    assert.ok(path.basename(data).startsWith('cad-command-journal-'));
    fs.rmSync(data, {recursive: true, force: true});
  }
});
