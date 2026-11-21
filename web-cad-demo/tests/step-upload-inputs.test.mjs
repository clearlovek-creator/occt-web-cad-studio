import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable, PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { PendingProjectInputs } from '../gateway/pending-project-inputs.mjs';
const source = bytes => Readable.from([bytes]);
function fixture() { const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-step-upload-input-')), pool = new PendingProjectInputs(data, { directoryName: 'pending-step-inputs', maxBytes: 8 * 1024 ** 2, maxSlots: 2, timeoutMs: 1000 }), target = path.join(data, 'imports/default-1-2-3.step'); return { data, pool, target, clean() { assert.equal(path.dirname(data), path.resolve(os.tmpdir())); assert.ok(path.basename(data).startsWith('cad-step-upload-input-')); fs.rmSync(data, { recursive: true, force: true }); } }; }
test('explicit upload cancellation before admission and during reception removes only the unreferenced private input', async () => {
    const f = fixture();
    try {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(f.pool.receive(source(Buffer.from('abc')), { maxBytes: 10, signal: controller.signal }), { code: 'PROJECT_INPUT_CANCELLED' });
        assert.equal(f.pool.status().slots, 0);
        const active = new AbortController(), stream = new PassThrough(), pending = f.pool.receive(stream, { maxBytes: 10, declaredBytes: 6, signal: active.signal }), rejected = assert.rejects(pending, { code: 'PROJECT_INPUT_CANCELLED' });
        stream.write('abc');
        await new Promise(resolve => setImmediate(resolve));
        active.abort();
        await rejected;
        assert.equal(f.pool.status().slots, 0);
        assert.deepEqual(fs.readdirSync(f.pool.root), []);
    }
    finally {
        f.clean();
    }
});
test('STEP sources are copied and read-back verified in bounded chunks without full package allocation, retained only on explicit accepted outcome', async () => {
    const f = fixture();
    try {
        const bytes = Buffer.alloc(3 * 1024 ** 2 + 17, 31), upload = await f.pool.receive(source(bytes), { maxBytes: bytes.length, declaredBytes: bytes.length });
        upload.read = () => { throw Error('Full input read is forbidden'); };
        const installed = await upload.copyTo(f.target);
        assert.equal(installed.bytes, bytes.length);
        assert.equal(installed.sha256, createHash('sha256').update(bytes).digest('hex'));
        assert.deepEqual(fs.readFileSync(f.target), bytes);
        assert.equal(f.pool.status().slots, 1);
        await assert.rejects(upload.copyTo(path.join(f.data, 'imports/default-2-3-4.step')), { code: 'PROJECT_INPUT_UNAVAILABLE' });
        await installed.dispose({ retain: true });
        await upload.release();
        assert.equal(f.pool.status().slots, 0);
        assert.deepEqual(fs.readFileSync(f.target), bytes);
        assert.deepEqual(fs.readdirSync(f.pool.root), []);
    }
    finally {
        f.clean();
    }
});
test('source preparation refuses escaping, shared or changed material, never overwrites a destination, and preserves changed installed bytes', async () => {
    const f = fixture(), open = fsp.open;
    try {
        const first = await f.pool.receive(source(Buffer.from('abcdef')), { maxBytes: 6 });
        await assert.rejects(first.copyTo(path.join(f.data, 'outside.step')), { code: 'PROJECT_INPUT_UNAVAILABLE' });
        fs.mkdirSync(path.dirname(f.target), { recursive: true });
        fs.writeFileSync(f.target, 'existing');
        await assert.rejects(first.copyTo(f.target), { code: 'PROJECT_INPUT_WRITE_FAILED' });
        assert.equal(fs.readFileSync(f.target, 'utf8'), 'existing');
        await first.release();
        const target = path.join(f.data, 'imports/default-4-5-6.step'), upload = await f.pool.receive(source(Buffer.from('abcdef')), { maxBytes: 6 });
        fsp.open = async function (file, ...args) { const handle = await open.call(this, file, ...args); if (file === target) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => { await sync(); fs.writeFileSync(target, 'ABCDEF'); };
        } return handle; };
        await assert.rejects(upload.copyTo(target), { code: 'PROJECT_INPUT_CHANGED' });
        assert.equal(fs.readFileSync(target, 'utf8'), 'ABCDEF');
        assert.equal(f.pool.status().lastError, 'PROJECT_INPUT_CHANGED');
        await upload.release();
    }
    finally {
        fsp.open = open;
        f.clean();
    }
});
test('cancellation of source preparation never publishes a source and ordinary unused source cleanup preserves a later replacement', async () => {
    const f = fixture();
    try {
        const upload = await f.pool.receive(source(Buffer.from('abcdef')), { maxBytes: 6 }), controller = new AbortController();
        controller.abort();
        await assert.rejects(upload.copyTo(f.target, { signal: controller.signal }), { code: 'PROJECT_INPUT_CANCELLED' });
        assert.equal(fs.existsSync(f.target), false);
        await upload.release();
        const next = await f.pool.receive(source(Buffer.from('abcdef')), { maxBytes: 6 }), installed = await next.copyTo(f.target);
        fs.writeFileSync(f.target, 'ABCDEF');
        await installed.dispose();
        assert.equal(fs.readFileSync(f.target, 'utf8'), 'ABCDEF');
        await next.release();
    }
    finally {
        f.clean();
    }
});
test('staging release also verifies bytes and never deletes a same-size changed upload without a preceding read', async () => {
    const f = fixture();
    try {
        const upload = await f.pool.receive(source(Buffer.from('abcdef')), { maxBytes: 6 }), file = path.join(f.pool.root, fs.readdirSync(f.pool.root)[0]);
        fs.writeFileSync(file, 'ABCDEF');
        await upload.release();
        assert.equal(fs.readFileSync(file, 'utf8'), 'ABCDEF');
        assert.equal(f.pool.status().retainedSlots, 1);
        assert.equal(f.pool.status().lastError, 'PROJECT_INPUT_CHANGED');
    }
    finally {
        f.clean();
    }
});
