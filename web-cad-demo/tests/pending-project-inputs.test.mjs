import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {PendingProjectInputs} from '../gateway/pending-project-inputs.mjs';
import {gatewayErrorStatus} from '../gateway/gateway-error-status.mjs';

function fixture(options = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-pending-input-'));
  const pool = new PendingProjectInputs(data, options);
  return {data, pool, clean() { const resolved = path.resolve(data); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('cad-pending-input-')); fs.rmSync(resolved, {recursive: true, force: true}); }};
}
const source = (...chunks) => Readable.from(chunks.map(value => Buffer.from(value)));

test('explicit unknown-outcome retention releases active ownership but preserves verified package bytes and quota across restart',async()=>{
  const f=fixture();try{const lease=await f.pool.receive(source('package bytes'),{maxBytes:100,declaredBytes:13});assert.deepEqual(Object.keys(lease).sort(),['bytes','read','release']);await lease.release({retain:true});assert.equal(f.pool.status().slots,0);assert.equal(f.pool.status().retainedSlots,1);const files=fs.readdirSync(f.pool.root);assert.equal(files.length,1);assert.equal(fs.readFileSync(path.join(f.pool.root,files[0]),'utf8'),'package bytes');await f.pool.close();const restarted=new PendingProjectInputs(f.data);assert.equal(restarted.status().retainedSlots,1);await restarted.close();}finally{f.clean();}
});

test('pending project input streams to a sealed private file and allocates full input only on explicit active read', async () => {
  const f = fixture();
  try {
    const input = await f.pool.receive(source('abc', 'def'), {maxBytes: 100, declaredBytes: 6});
    assert.deepEqual(Object.keys(input).sort(), ['bytes', 'read', 'release']);
    assert.equal(input.bytes, 6);
    assert.equal(f.pool.status().slots, 1);
    assert.equal(f.pool.status().reservedBytes, 6);
    assert.equal((await input.read()).toString(), 'abcdef');
    await input.release(); await input.release();
    assert.deepEqual(fs.readdirSync(f.pool.root), []);
    assert.equal(f.pool.status().slots, 0);
  } finally { f.clean(); }
});

test('upload slots and byte reservations include queued packages and survive restart as retained material', async () => {
  const f = fixture({maxBytes: 10, maxSlots: 2});
  try {
    const first = await f.pool.receive(source('1234567'), {maxBytes: 10, declaredBytes: 7});
    await assert.rejects(f.pool.receive(source('1234'), {maxBytes: 4, declaredBytes: 4}), {code: 'PROJECT_INPUT_CAPACITY'});
    const restarted = new PendingProjectInputs(f.data, {maxBytes: 10, maxSlots: 1});
    assert.equal(restarted.status().retainedBytes, 7);
    assert.equal(restarted.status().retainedSlots, 1);
    await assert.rejects(restarted.receive(source('x'), {maxBytes: 1}), {code: 'PROJECT_INPUT_CAPACITY'});
    await first.release();
    const next = await f.pool.receive(source('12'), {maxBytes: 2});
    await next.release();
  } finally { f.clean(); }
});

test('size, declaration, empty and interrupted uploads release only their own unreferenced temporary files', async () => {
  const f = fixture();
  try {
    for (const [stream, options] of [[source('1234'), {maxBytes: 3}], [source('123'), {maxBytes: 10, declaredBytes: 4}], [source(), {maxBytes: 10}], [source('1'), {maxBytes: 1, declaredBytes: 2}]]) {
      await assert.rejects(f.pool.receive(stream, options), {code: 'PROJECT_INPUT_SIZE'});
      assert.equal(f.pool.status().slots, 0);
      assert.deepEqual(fs.readdirSync(f.pool.root), []);
    }
    const broken = Readable.from((async function* () { yield Buffer.from('first'); throw Error('private transport details'); })());
    await assert.rejects(f.pool.receive(broken, {maxBytes: 20}), error => error.code === 'PROJECT_INPUT_WRITE_FAILED' && !error.message.includes('private transport'));
    assert.deepEqual(fs.readdirSync(f.pool.root), []);
  } finally { f.clean(); }
});

test('upload deadline interrupts an unfinished stream without publishing a package or leaking its reservation', async () => {
  const f = fixture({timeoutMs: 15});
  try {
    const stream = new Readable({read() {}});
    await assert.rejects(f.pool.receive(stream, {maxBytes: 10}), {code: 'PROJECT_INPUT_TIMEOUT'});
    assert.equal(stream.destroyed, true);
    assert.equal(f.pool.status().slots, 0);
    assert.deepEqual(fs.readdirSync(f.pool.root), []);
  } finally { f.clean(); }
});

test('same-length modification and file replacement cannot become a valid queued package or be silently deleted', async () => {
  const f = fixture();
  try {
    const input = await f.pool.receive(source('original'), {maxBytes: 20});
    const file = path.join(f.pool.root, fs.readdirSync(f.pool.root)[0]);
    fs.writeFileSync(file, 'modified');
    await assert.rejects(input.read(), {code: 'PROJECT_INPUT_CHANGED'});
    await input.release();
    assert.equal(fs.readFileSync(file, 'utf8'), 'modified');
    assert.equal(f.pool.status().retainedSlots, 1);
    assert.equal(f.pool.status().lastError, 'PROJECT_INPUT_CHANGED');
  } finally { f.clean(); }
  const replaced = fixture();
  try {
    const input = await replaced.pool.receive(source('original'), {maxBytes: 20});
    const file = path.join(replaced.pool.root, fs.readdirSync(replaced.pool.root)[0]);
    fs.renameSync(file, path.join(replaced.data, 'original-preserved'));
    fs.writeFileSync(file, 'replaced');
    await assert.rejects(input.read(), {code: 'PROJECT_INPUT_CHANGED'});
    await input.release();
    assert.equal(fs.readFileSync(file, 'utf8'), 'replaced');
  } finally { replaced.clean(); }
});

test('unknown entries and shared hard links stop admission without deleting their evidence', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.pool.root, 'unknown'), 'keep');
    await assert.rejects(f.pool.receive(source('new'), {maxBytes: 10}), {code: 'PROJECT_INPUT_UNAVAILABLE'});
    assert.equal(fs.readFileSync(path.join(f.pool.root, 'unknown'), 'utf8'), 'keep');
  } finally { f.clean(); }
  const shared = fixture();
  try {
    const input = await shared.pool.receive(source('content'), {maxBytes: 10});
    const file = path.join(shared.pool.root, fs.readdirSync(shared.pool.root)[0]);
    fs.linkSync(file, path.join(shared.data, 'shared-link'));
    await assert.rejects(input.read(), {code: 'PROJECT_INPUT_UNAVAILABLE'});
    await input.release();
    assert.equal(fs.readFileSync(file, 'utf8'), 'content');
  } finally { shared.clean(); }
});

test('shutdown rejects new inputs, interrupts uploads and waits for queued or active package ownership to release', async () => {
  const f = fixture();
  try {
    const input = await f.pool.receive(source('content'), {maxBytes: 10});
    const pending = f.pool.receive(new Readable({read() {}}), {maxBytes: 10});
    const interrupted = assert.rejects(pending, {code: 'SERVICE_STOPPING'});
    let closed = false;
    const closing = f.pool.close().then(() => { closed = true; });
    await interrupted;
    assert.equal(closed, false);
    await assert.rejects(f.pool.receive(source('new'), {maxBytes: 10}), {code: 'SERVICE_STOPPING'});
    await input.release(); await closing;
    assert.equal(f.pool.status().slots, 0);
  } finally { f.clean(); }
});

test('gateway error status preserves native/control classifications and accepts only valid internal overrides', () => {
  for (const [code, expected] of [['DOCUMENT_ACTION_INPUT_LIMIT', 429], ['WORKER_TIMEOUT', 504], ['WORKER_MEMORY_LIMIT', 503], ['PI_RPC_PROTOCOL_ERROR', 502], ['WORKER_RESPONSE_TOO_LARGE', 502], ['SELECTION_STATE_REQUIRED', 428], ['PROJECT_STATE_CONFLICT', 409], ['WORKSPACE_NOT_FOUND', 400]]) assert.equal(gatewayErrorStatus(code), expected);
  assert.equal(gatewayErrorStatus('PROJECT_INPUT_TIMEOUT', 408), 408);
  assert.equal(gatewayErrorStatus('WORKER_TIMEOUT', 200), 504);
  assert.equal(gatewayErrorStatus('WORKER_TIMEOUT', '409'), 504);
});
