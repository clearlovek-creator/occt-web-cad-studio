import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {DocumentActionQueue, documentActionLimits} from '../gateway/document-action-queue.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const turn = () => new Promise(resolve => setImmediate(resolve));

test('shared-worker action queue validates bounded policy before admitting any work', () => {
  assert.deepEqual(documentActionLimits({}), {maxQueued: 64, maxQueuedPerDocument: 16, waitMs: 120000, maxQueuedInputBytes: 64 * 1024 * 1024});
  assert.deepEqual(documentActionLimits({GEOMETRY_ACTION_QUEUE_LIMIT: '2'}), {maxQueued: 2, maxQueuedPerDocument: 2, waitMs: 120000, maxQueuedInputBytes: 64 * 1024 * 1024});
  for (const value of ['', '0', '-1', '1.5', '1e2', ' 2', '257', '9999999999']) {
    assert.throws(() => documentActionLimits({GEOMETRY_ACTION_QUEUE_LIMIT: value}), {code: 'DOCUMENT_ACTION_CONFIG_INVALID'});
  }
  assert.throws(() => documentActionLimits({GEOMETRY_ACTION_QUEUE_LIMIT: '2', GEOMETRY_ACTION_DOCUMENT_QUEUE_LIMIT: '3'}), {code: 'DOCUMENT_ACTION_CONFIG_INVALID'});
  assert.throws(() => new DocumentActionQueue({waitMs: 0}), {code: 'DOCUMENT_ACTION_CONFIG_INVALID'});
  assert.throws(() => new DocumentActionQueue({maxQueued: Infinity}), {code: 'DOCUMENT_ACTION_CONFIG_INVALID'});
  assert.deepEqual(documentActionLimits({GEOMETRY_ACTION_QUEUE_LIMIT: '256', GEOMETRY_ACTION_DOCUMENT_QUEUE_LIMIT: '64', GEOMETRY_ACTION_QUEUE_TIMEOUT_MS: '600000'}), {maxQueued: 256, maxQueuedPerDocument: 64, waitMs: 600000, maxQueuedInputBytes: 64 * 1024 * 1024});
});

test('all documents share FIFO admission and retain the only slot until full action and rollback settlement', async () => {
  const queue = new DocumentActionQueue(), rollback = deferred(), calls = [];
  const first = queue.run('a', async () => { calls.push('a:start'); await rollback.promise; calls.push('a:rollback'); throw Error('original failure after rollback'); });
  const failed = assert.rejects(first, /original failure after rollback/);
  const second = queue.run('b', () => { calls.push('b'); return 2; });
  const third = queue.run('a', () => { calls.push('a:next'); return 3; });
  assert.equal(queue.status().active, 1);
  assert.equal(queue.status().queued, 2);
  assert.equal(queue.status().queuedDocuments, 2);
  await turn();
  assert.deepEqual(calls, ['a:start']);
  rollback.resolve();
  await failed;
  assert.deepEqual(await Promise.all([second, third]), [2, 3]);
  assert.deepEqual(calls, ['a:start', 'a:rollback', 'b', 'a:next']);
  await queue.whenIdle();
  assert.equal(queue.status().active, 0);
  assert.equal(queue.status().failed, 1);
});

test('per-document and global queue limits refuse before any side effect and release counts exactly once', async () => {
  const queue = new DocumentActionQueue({maxQueued: 2, maxQueuedPerDocument: 1}), hold = deferred();
  const first = queue.run('a', () => hold.promise);
  const second = queue.run('a', () => 'same document');
  await assert.rejects(queue.run('a', () => assert.fail('per-document overflow executed')), {code: 'DOCUMENT_ACTION_QUEUE_LIMIT'});
  const third = queue.run('b', () => 'other document');
  await assert.rejects(queue.run('c', () => assert.fail('global overflow executed')), {code: 'DOCUMENT_ACTION_QUEUE_LIMIT'});
  assert.equal(queue.status().queued, 2);
  assert.equal(queue.status().rejected, 2);
  hold.resolve();
  await Promise.all([first, second, third]);
  assert.equal(queue.status().queued, 0);
  assert.equal(queue.status().completed, 3);
});

test('queued cancellation removes its closure and listener immediately without waiting for the active action', async () => {
  const queue = new DocumentActionQueue(), hold = deferred(), controller = new AbortController();
  const first = queue.run('a', () => hold.promise);
  const second = queue.run('b', () => assert.fail('cancelled action executed'), {signal: controller.signal});
  const cancelled = assert.rejects(second, {code: 'DOCUMENT_ACTION_CANCELLED'});
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await cancelled;
  assert.equal(queue.status().queued, 0);
  assert.equal(queue.status().active, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(queue.run('c', () => assert.fail('pre-aborted action executed'), {signal: controller.signal}), {code: 'DOCUMENT_ACTION_CANCELLED'});
  hold.resolve();
  await first;
});

test('an active AbortSignal cannot release admission until the executing action finishes its own stop and recovery', async () => {
  const queue = new DocumentActionQueue(), rollback = deferred(), controller = new AbortController();
  let nextStarted = false, observedSignal;
  const first = queue.run('a', async ({signal}) => { observedSignal = signal; await rollback.promise; throw Error('recovery confirmed'); }, {signal: controller.signal});
  const failed = assert.rejects(first, /recovery confirmed/);
  const second = queue.run('b', () => { nextStarted = true; });
  controller.abort();
  await turn();
  assert.equal(observedSignal.aborted, true);
  assert.equal(nextStarted, false);
  assert.equal(queue.status().active, 1);
  rollback.resolve();
  await failed;
  await second;
  assert.equal(nextStarted, true);
  assert.equal(queue.status().cancelledBeforeStart, 0);
});

test('queue-only deadline removes waiting work but does not time out or stop the active engineering action', async () => {
  const queue = new DocumentActionQueue({waitMs: 15}), hold = deferred();
  const first = queue.run('a', () => hold.promise);
  await assert.rejects(queue.run('b', () => assert.fail('expired action executed')), {code: 'DOCUMENT_ACTION_QUEUE_TIMEOUT'});
  assert.equal(queue.status().expired, 1);
  assert.equal(queue.status().active, 1);
  assert.equal(queue.status().queued, 0);
  const next = queue.run('c', () => 'explicit later action');
  hold.resolve();
  assert.deepEqual(await Promise.all([first, next]), [undefined, 'explicit later action']);
});

test('close rejects every queued action immediately and idle waits for the actual active action', async () => {
  const queue = new DocumentActionQueue(), hold = deferred();
  const active = queue.run('a', () => hold.promise);
  const waiting = queue.run('b', () => assert.fail('shutdown queue ran'));
  const rejected = assert.rejects(waiting, {code: 'SERVICE_STOPPING'});
  let idle = false;
  const draining = queue.close().then(() => { idle = true; });
  await rejected;
  await assert.rejects(queue.run('c', () => assert.fail('closed queue ran')), {code: 'SERVICE_STOPPING'});
  await turn();
  assert.equal(idle, false);
  assert.equal(queue.status().state, 'draining');
  assert.equal(queue.status().queued, 0);
  hold.resolve();
  await Promise.all([active, draining]);
  await queue.close();
  assert.equal(queue.status().cancelledBeforeStart, 1);
});

test('synchronous failure, invalid input and reentrant calls cannot leak a slot or deadlock the queue', async () => {
  const queue = new DocumentActionQueue();
  await assert.rejects(queue.run('../invalid', () => undefined), {code: 'DOCUMENT_ACTION_INVALID'});
  await assert.rejects(queue.run('a', null), {code: 'DOCUMENT_ACTION_INVALID'});
  await assert.rejects(queue.run('a', () => { throw Error('sync'); }), /sync/);
  await queue.run('a', async () => {
    await Promise.resolve();
    await assert.rejects(queue.run('b', () => assert.fail('nested action ran')), {code: 'DOCUMENT_ACTION_REENTRANT'});
  });
  assert.equal(await queue.run('b', () => 7), 7);
  await queue.whenIdle();
  assert.equal(queue.status().active, 0);
});

test('status contains only aggregate admission metrics, never project IDs, request input or active closures', async () => {
  const queue = new DocumentActionQueue(), hold = deferred();
  const active = queue.run('private_project', () => hold.promise);
  const waiting = queue.run('other_private', () => 'secret-payload');
  assert.doesNotMatch(JSON.stringify(queue.status()), /private|payload|action|signal/);
  hold.resolve();
  await Promise.all([active, waiting]);
});

test('aggregate waiting input charges reject before admission and release exactly on cancellation, expiry or start', async () => {
  const queue = new DocumentActionQueue({maxQueuedInputBytes: 10}), hold = deferred(), controller = new AbortController();
  const active = queue.run('a', () => hold.promise, {inputBytes: 1000});
  const waiting = queue.run('b', () => assert.fail('cancelled input ran'), {inputBytes: 7, signal: controller.signal});
  const cancelled = assert.rejects(waiting, {code: 'DOCUMENT_ACTION_CANCELLED'});
  await assert.rejects(queue.run('c', () => assert.fail('oversized aggregate ran'), {inputBytes: 4}), {code: 'DOCUMENT_ACTION_INPUT_LIMIT'});
  assert.equal(queue.status().queuedInputBytes, 7);
  controller.abort(); await cancelled;
  assert.equal(queue.status().queuedInputBytes, 0);
  const next = queue.run('c', () => 3, {inputBytes: 10});
  hold.resolve(); await active; assert.equal(await next, 3);
  assert.equal(queue.status().queuedInputBytes, 0);
  await assert.rejects(queue.run('d', () => undefined, {inputBytes: -1}), {code: 'DOCUMENT_ACTION_INVALID'});
  await assert.rejects(queue.run('d', () => undefined, {inputBytes: Infinity}), {code: 'DOCUMENT_ACTION_INVALID'});
  assert.throws(() => documentActionLimits({GEOMETRY_ACTION_QUEUE_BYTES: '0'}), {code: 'DOCUMENT_ACTION_CONFIG_INVALID'});
});
