import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cad-modeling-task-api-')); }
function cleanup(data) { assert.equal(path.dirname(path.resolve(data)), path.resolve(os.tmpdir())); assert.ok(path.basename(data).startsWith('cad-modeling-task-api-')); fs.rmSync(data, {recursive: true, force: true}); }
const command = (documentId = 'default', extra = {}) => ({documentId, requestId: randomUUID(), operation: 'primitive.box', parameters: {width: 3, depth: 4, height: 5, x: 40}, ...extra});
async function seeded(f) {
  const box = await f.cad('primitive.box', {width: 10, depth: 20, height: 30});
  const type = await f.cad('property.type.create', {key: 'TaskBoundary', targetScope: 'body', association: 'required', fields: [{key: 'enabled', type: 'bool'}]});
  await f.cad('property.instance.create', {typeId: type.type.typeId, value: {enabled: true}, target: {kind: 'body', bodyId: box.bodyId}});
  await f.cad('property.set', {key: 'taskMarker', type: 'int', value: 42}, {kind: 'body', bodyId: box.bodyId});
  return {model: await f.cad('document.summary'), raw: (await f.cad('property.list')).propertyRecords, typed: (await f.cad('property.instance.list')).instances};
}
async function restored(f, before, {sameToken = true} = {}) {
  const model = await f.cad('document.summary');
  for (const key of ['revision', 'features', 'bodyMetadata', 'entityIdentities', 'coordinateSystems', ...(sameToken ? ['stateToken'] : [])]) assert.deepEqual(model[key], before.model[key], key);
  assert.deepEqual((await f.cad('property.list')).propertyRecords, before.raw);
  assert.deepEqual((await f.cad('property.instance.list')).instances, before.typed);
}

test('a reserved command can be cancelled before submission and its old task ID cannot create geometry later', async () => {
  const data = scratch(); let f;
  try {
    f = await gatedGeometryGateway(data); const before = await seeded(f), input = command(), task = await f.reserve(input);
    const stopped = await f.cancel(task); assert.equal(stopped.status, 202); assert.equal(stopped.value.modelingTask.phase, 'cancelled');
    const result = await f.submit(input, task); assert.equal(result.status, 409); assert.equal(result.value.code, 'MODELING_TASK_ALREADY_SUBMITTED');
    await restored(f, before);
  } finally { if (f) { assert.equal(await f.stop(), 0); cleanup(data); } }
});

test('public queued cancellation proves no native execution and leaves both projects and history intact', async () => {
  const data = scratch(); let f;
  try {
    f = await gatedGeometryGateway(data); const before = await seeded(f); await f.cad('primitive.box', {width: 2, depth: 2, height: 2}, {}, 'other');
    f.tell('arm-geometry'); await f.event('geometry-armed');
    const active = f.post('/commands', command('other')); await f.event('geometry-held');
    const input = command(), task = await f.reserve(input), pending = f.submit(input, task);
    await f.until(async () => (await f.get('/health')).lifecycle.documentActions.queued === 1, 'Task did not queue');
    const offset = f.events.length; await f.cancel(task);
    const result = await pending; assert.equal(result.status, 409); assert.equal(result.value.code, 'DOCUMENT_ACTION_CANCELLED'); assert.equal(result.value.modelingTask.phase, 'cancelled'); assert.equal(result.value.modelingTask.execution, 'not-started');
    assert.equal(f.events.slice(offset).some(item => item.type === 'fixture.native-request' && item.documentId === 'default'), false);
    f.tell('release-geometry'); assert.equal((await active).value.ok, true); await restored(f, before);
  } finally { if (f) { assert.equal(await f.stop(), 0); cleanup(data); } }
});

test('public cancellation of an already executed native command waits for exact OS exit, full geometry and both property-system rollback', async () => {
  const data = scratch(); let f;
  try {
    f = await gatedGeometryGateway(data); const before = await seeded(f), input = command(), task = await f.reserve(input);
    f.tell('arm-geometry'); await f.event('geometry-armed'); f.tell('arm-geometry-exit'); await f.event('geometry-exit-armed');
    const pending = f.submit(input, task); const executed = await f.event('geometry-held'); assert.equal(executed.bodyCount, 2);
    assert.equal((await f.get('/documents/default/modeling-tasks/' + task.taskId)).modelingTask.phase, 'executing');
    const cancelled = await f.cancel(task); assert.equal(cancelled.status, 202); assert.equal(cancelled.value.modelingTask.phase, 'stopping');
    await f.event('geometry-exit-held');
    const stopping = await f.get('/documents/default/modeling-tasks/' + task.taskId); assert.equal(stopping.modelingTask.phase, 'stopping'); assert.equal(stopping.modelingTask.cancellable, false); assert.equal((await f.get('/health')).lifecycle.documentActions.active, 1);
    f.tell('release-geometry-exit'); const result = await pending;
    assert.equal(result.status, 409, JSON.stringify(result)); assert.equal(result.value.code, 'WORKER_CANCELLED'); assert.equal(result.value.projectRollback.confirmed, true); assert.equal(result.value.modelingTask.phase, 'cancelled');
    await restored(f, before); assert.equal(fs.readdirSync(path.join(data, 'document-transactions')).some(name => name.endsWith('.pending.json')), false);
    assert.equal((await f.cad('primitive.box', {width: 1, depth: 1, height: 1})).bodyCount, 2);
  } finally { if (f) { assert.equal(await f.stop(), 0); cleanup(data); } }
});

test('a committed task returns its exact durable receipt, survives restart, and late cancellation never undoes it', async () => {
  const data = scratch(); let f;
  try {
    f = await gatedGeometryGateway(data); await seeded(f); const input = command(), task = await f.reserve(input), result = await f.submit(input, task);
    assert.equal(result.value.ok, true, JSON.stringify(result)); assert.equal(result.value.modelingTask.phase, 'succeeded');
    const expected = {...result.value}; delete expected.modelingTask;
    const receipt = await f.get('/documents/default/modeling-tasks/' + task.taskId + '/result'); assert.deepEqual(receipt.result, expected);
    const cancelled = await f.cancel(task); assert.equal(cancelled.value.modelingTask.phase, 'succeeded');
    const current = await f.cad('document.summary'); assert.equal(current.bodyCount, 2); assert.equal(current.revision, result.value.revision);
    assert.equal(await f.stop(), 0); f = await gatedGeometryGateway(data);
    assert.equal((await f.get('/documents/default/modeling-tasks/' + task.taskId)).modelingTask.phase, 'succeeded');
    assert.deepEqual((await f.get('/documents/default/modeling-tasks/' + task.taskId + '/result')).result, expected);
    assert.equal((await f.submit(input, task)).value.code, 'MODELING_TASK_ALREADY_SUBMITTED');
    assert.equal((await f.cad('document.summary')).bodyCount, 2);
  } finally { if (f) { assert.equal(await f.stop(), 0); cleanup(data); } }
});

test('duplicate active submission and different command payload never execute a second native mutation', async () => {
  const data = scratch(); let f;
  try {
    f = await gatedGeometryGateway(data); await seeded(f); const input = command(), task = await f.reserve(input);
    f.tell('arm-geometry'); await f.event('geometry-armed'); const pending = f.submit(input, task); await f.event('geometry-held');
    assert.equal((await f.submit(input, task)).value.code, 'MODELING_TASK_ALREADY_SUBMITTED');
    assert.equal((await f.submit({...input, parameters: {width: 99, depth: 99, height: 99}}, task)).value.code, 'MODELING_TASK_CONFLICT');
    f.tell('release-geometry'); assert.equal((await pending).value.ok, true); assert.equal((await f.cad('document.summary')).bodyCount, 2);
  } finally { if (f) { assert.equal(await f.stop(), 0); cleanup(data); } }
});

test('task control rejects foreign origins, cross-project identities, query/preview operations and nonempty cancellation arguments', async () => {
  const data = scratch(); let f;
  try {
    f = await gatedGeometryGateway(data); await seeded(f); const input = command(), task = await f.reserve(input);
    const forbidden = await f.post('/documents/default/modeling-tasks/' + task.taskId + '/cancel', {}, {origin: 'https://untrusted.invalid'}); assert.equal(forbidden.status, 403);
    const cross = await f.post('/documents/other/modeling-tasks', {command: input}); assert.equal(cross.status, 409);
    const read = await f.post('/documents/default/modeling-tasks', {command: {...input, operation: 'document.summary'}}); assert.equal(read.status, 400);
    const preview = await f.post('/documents/default/modeling-tasks', {command: {...input, options: {preview: true}}}); assert.equal(preview.status, 400);
    const nonempty = await f.post('/documents/default/modeling-tasks/' + task.taskId + '/cancel', {operation: 'body.delete'}); assert.equal(nonempty.status, 400);
    const oversized = await f.post('/documents/default/modeling-tasks/' + task.taskId + '/cancel', {ignored: 'x'.repeat(2048)}); assert.equal(oversized.status, 413);
    assert.equal((await f.get('/documents/default/modeling-tasks/' + task.taskId)).modelingTask.phase, 'reserved');
  } finally { if (f) { assert.equal(await f.stop(), 0); cleanup(data); } }
});

test('commit-stage cancellation is rejected while the real checkpoint reply is held and cannot overwrite the eventual commit', async () => {
  const data = scratch(); let f;
  try {
    f = await gatedGeometryGateway(data); await seeded(f); const input = command(), task = await f.reserve(input);
    f.tell('arm-task-commit'); await f.event('task-commit-armed'); const pending = f.submit(input, task); await f.event('task-commit-held');
    const status = await f.get('/documents/default/modeling-tasks/' + task.taskId); assert.equal(status.modelingTask.phase, 'committing'); assert.equal(status.modelingTask.cancellable, false);
    const refused = await f.cancel(task); assert.equal(refused.status, 409); assert.equal(refused.value.code, 'MODELING_TASK_NOT_CANCELLABLE');
    assert.equal(f.events.filter(item => item.type === 'fixture.geometry-start').length, 1);
    f.tell('release-geometry'); const result = await pending; assert.equal(result.value.ok, true); assert.equal(result.value.modelingTask.cancelRequested, false);
    assert.equal((await f.cad('document.summary')).bodyCount, 2);
  } finally { if (f) { assert.equal(await f.stop(), 0); cleanup(data); } }
});

test('unconfirmed exit keeps cancellation unknown and preserves journal evidence for restart instead of claiming completion', async () => {
  const data = scratch(); let f;
  try {
    f = await gatedGeometryGateway(data, {GEOMETRY_WORKER_STOP_TIMEOUT_MS: '40'}); const before = await seeded(f), input = command(), task = await f.reserve(input);
    f.tell('arm-geometry'); await f.event('geometry-armed'); f.tell('arm-geometry-exit'); await f.event('geometry-exit-armed');
    const pending = f.submit(input, task); await f.event('geometry-held'); await f.cancel(task); await f.event('geometry-exit-held');
    const result = await pending; assert.equal(result.value.code, 'PROJECT_ROLLBACK_FAILED'); assert.equal(result.value.modelingTask.phase, 'unknown'); assert.equal(result.value.projectRollback, undefined);
    assert.equal((await f.get('/health')).runtime.workerChannel.state, 'blocked');
    assert.equal(f.events.filter(item => item.type === 'fixture.geometry-start').length, 1);
    assert.ok(fs.readdirSync(path.join(data, 'document-transactions')).some(name => name.endsWith('.pending.json')));
    f.tell('release-geometry-exit'); await f.event('geometry-exit'); await f.stop(); f = await gatedGeometryGateway(data);
    await restored(f, before, {sameToken: false});
    assert.equal((await f.get('/documents/default/modeling-tasks/' + task.taskId)).modelingTask.phase, 'unknown');
    assert.equal(fs.readdirSync(path.join(data, 'document-transactions')).some(name => name.endsWith('.pending.json')), false);
  } finally { if (f) { assert.equal(await f.stop(), 0); cleanup(data); } }
});

test('Undo is a tracked task with the same commit boundary and original durable result recovery', async () => {
  const data = scratch(); let f;
  try {
    f = await gatedGeometryGateway(data); await seeded(f); await f.cad('primitive.box', {width: 1, depth: 1, height: 1});
    const input = command('default', {operation: 'document.undo', parameters: {}}), task = await f.reserve(input), result = await f.submit(input, task);
    assert.equal(result.value.ok, true, JSON.stringify(result)); assert.equal(result.value.bodyCount, 1); assert.equal(result.value.modelingTask.phase, 'succeeded');
    const expected = {...result.value}; delete expected.modelingTask;
    assert.deepEqual((await f.get('/documents/default/modeling-tasks/' + task.taskId + '/result')).result, expected);
  } finally { if (f) { assert.equal(await f.stop(), 0); cleanup(data); } }
});

test('public abandon rejects a claimed task without stopping execution, while an unsubmitted reservation becomes not-started', async () => {
  const data = scratch(); let f;
  try {
    f = await gatedGeometryGateway(data); await seeded(f);
    const unused = await f.reserve(command());
    const abandoned = await f.post('/documents/default/modeling-tasks/' + unused.taskId + '/abandon', {});
    assert.equal(abandoned.status, 200); assert.equal(abandoned.value.modelingTask.phase, 'failed');
    assert.equal(abandoned.value.modelingTask.execution, 'not-started');
    const input = command(), task = await f.reserve(input), at = f.events.length;
    f.tell('arm-geometry'); await f.event('geometry-armed', at);
    const pending = f.submit(input, task); await f.event('geometry-held', at);
    const refused = await f.post('/documents/default/modeling-tasks/' + task.taskId + '/abandon', {});
    assert.equal(refused.status, 409); assert.equal(refused.value.code, 'MODELING_TASK_ALREADY_SUBMITTED');
    assert.equal((await f.get('/documents/default/modeling-tasks/' + task.taskId)).modelingTask.cancelRequested, false);
    f.tell('release-geometry'); const result = await pending;
    assert.equal(result.value.ok, true); assert.equal(result.value.modelingTask.phase, 'succeeded');
    assert.equal((await f.cad('document.summary')).bodyCount, 2);
  } finally { if (f) { assert.equal(await f.stop(), 0); cleanup(data); } }
});
