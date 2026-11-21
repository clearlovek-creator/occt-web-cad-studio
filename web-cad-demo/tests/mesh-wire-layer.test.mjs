import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {importTestTypeScript} from './helpers/import-typescript.mjs';
const {MeshWireLayer}=await importTestTypeScript('../app/model/mesh-wire-layer.ts',import.meta.url);
const until = async (predicate) => {
    const end = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < end, 'Wire layer did not settle');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};
function fixture({ hold = false, maxBytes, corrupt = false, oversized = false, coordinate, wrongKey = false, errorBytes = 0 } = {}) {
    const bodies = new Map(), requests = [], errors = [], gates = [];
    const make = (key, x) => { const bytes = Buffer.alloc(48); [coordinate ?? x, 0, 0, x + 1, 1, 1].forEach((value, i) => bytes.writeDoubleLE(value, i * 8)); const sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); bodies.set(key, bytes); return { key, scalars: 6, chunks: [{ offset: x ? 48 : 0, bytes: 48, sha256 }] }; };
    const render = { dimension: 3, kind: 'wire', positions: [], groups: [], storage: { version: 1, format: 'float64-le', bytes: 96, sha256: 'a'.repeat(64) }, wires: [make('wire-3-1', 0), make('wire-3-2', 2)] };
    const context = { jobId: 'mesh-test', documentId: 'doc', render, visibleKeys: [] };
    const layer = new MeshWireLayer({ apiRoot: '/api', maxBytes, concurrency: 2, onError: error => errors.push(error), fetchImpl: async (url, options) => {
            const parsed = new URL(url, 'http://test'), key = parsed.searchParams.get('wireKey'), index = parsed.searchParams.get('chunk');
            requests.push({ key, signal: options.signal });
            if (hold)
                await new Promise((resolve, reject) => { gates.push(resolve); options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }); });
            const bytes = Buffer.from(bodies.get(key));
            if (corrupt)
                bytes[0] ^= 1;
            const data = oversized ? Buffer.concat([bytes, Buffer.from([1])]) : bytes;
            if (errorBytes)
                return new Response('x'.repeat(errorBytes), { status: 503 });
            return new Response(data, { headers: { 'X-CAD-Mesh-Format': 'float64-le', 'X-CAD-Mesh-Wire': wrongKey ? 'wire-3-99' : key, 'X-CAD-Mesh-Chunk': index, ...(!oversized ? { 'Content-Length': String(bytes.length) } : {}) } });
        } });
    return { layer, context, requests, errors, gates };
}
test('hidden mesh creates no requests or geometry; shared keys allocate once, stream exact positions and retain hide/show intent', async () => {
    const f = fixture();
    try {
        f.layer.update(f.context);
        assert.equal(f.requests.length, 0);
        assert.equal(f.layer.group.children.length, 0);
        f.layer.update({ ...f.context, visibleKeys: ['wire-3-1', 'wire-3-1'] });
        await until(() => f.layer.status().loadedChunks === 1);
        assert.equal(f.requests.length, 1);
        assert.deepEqual(Array.from(f.layer.group.children[0].geometry.getAttribute('position').array), [0, 0, 0, 1, 1, 1]);
        assert.equal(f.layer.status().residentBytes, 24);
        const geometry = f.layer.group.children[0].geometry;
        f.layer.update(f.context);
        assert.equal(f.layer.status().visibleChunks, 0);
        f.layer.update({ ...f.context, visibleKeys: ['wire-3-1'] });
        assert.equal(f.layer.status().visibleChunks, 1);
        assert.equal(f.requests.length, 1);
        assert.equal(f.layer.group.children[0].geometry, geometry, 'Show/hide must not recreate geometry');
        let disposed = 0;
        geometry.addEventListener('dispose', () => disposed++);
        f.layer.dispose();
        assert.equal(disposed, 1);
        assert.equal(f.layer.group.children.length, 0);
    }
    finally {
        f.layer.dispose();
    }
});
test('hiding an in-flight Body aborts its read and late data cannot appear; switching jobs drops the old viewport cache', async () => {
    const f = fixture({ hold: true });
    try {
        f.layer.update({ ...f.context, visibleKeys: ['wire-3-1'] });
        assert.equal(f.requests.length, 1);
        f.layer.update(f.context);
        assert.equal(f.requests[0].signal.aborted, true);
        await until(() => f.layer.status().pending === 0);
        f.gates[0]();
        assert.equal(f.layer.group.children.length, 0);
        f.layer.update({ ...f.context, jobId: 'new-job', visibleKeys: ['wire-3-2'] });
        f.gates.at(-1)();
        await until(() => f.layer.status().loadedChunks === 1);
        assert.equal(f.layer.group.children.length, 1);
        assert.equal(f.layer.group.children[0].userData.meshWireKey, 'wire-3-2');
    }
    finally {
        f.layer.dispose();
    }
});
test('memory admission happens before fetch and evicts hidden buffers rather than silently exceeding the viewport budget', async () => {
    const f = fixture({ maxBytes: 24 });
    try {
        f.layer.update({ ...f.context, visibleKeys: ['wire-3-1'] });
        await until(() => f.layer.status().loadedChunks === 1);
        let disposed = 0;
        f.layer.group.children[0].geometry.addEventListener('dispose', () => disposed++);
        f.layer.update({ ...f.context, visibleKeys: ['wire-3-2'] });
        await until(() => f.layer.status().loadedChunks === 1 && f.requests.length === 2);
        assert.equal(disposed, 1);
        assert.equal(f.layer.status().residentBytes, 24);
        f.layer.update({ ...f.context, visibleKeys: ['wire-3-1', 'wire-3-2'] });
        assert.equal(f.errors.length, 1);
        assert.equal(f.layer.status().visibleChunks, 0);
        assert.equal(f.requests.length, 2);
    }
    finally {
        f.layer.dispose();
    }
});
test('corrupt and oversized replies never create GPU geometry or automatically repeat a failed request', async () => {
    for (const options of [{ corrupt: true }, { oversized: true }]) {
        const f = fixture(options);
        try {
            const context = { ...f.context, visibleKeys: ['wire-3-1'] };
            f.layer.update(context);
            await until(() => f.errors.length > 0);
            assert.equal(f.layer.group.children.length, 0);
            const count = f.requests.length;
            f.layer.update(context);
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(f.requests.length, count);
        }
        finally {
            f.layer.dispose();
        }
    }
});
test('wrong group headers, non-finite/Float32-overflow positions and oversized diagnostics are bounded failures', async () => {
    for (const options of [{ wrongKey: true }, { coordinate: NaN }, { coordinate: 1e100 }, { errorBytes: 9000 }]) {
        const f = fixture(options);
        try {
            f.layer.update({ ...f.context, visibleKeys: ['wire-3-1'] });
            await until(() => f.errors.length > 0);
            assert.equal(f.layer.group.children.length, 0);
            assert.equal(f.layer.status().residentBytes, 0);
            if (options.errorBytes)
                assert.match(f.errors[0], /HTTP 503/);
        }
        finally {
            f.layer.dispose();
        }
    }
});
test('a timed-out chunk is aborted, releases its slot and waits for an explicit display-intent change', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ hold: true });
    try {
        const context = { ...f.context, visibleKeys: ['wire-3-1'] };
        f.layer.update(context);
        t.mock.timers.tick(15000);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.requests[0].signal.aborted, true);
        assert.match(f.errors[0], /超时/);
        assert.equal(f.layer.status().pending, 0);
        f.layer.update(context);
        assert.equal(f.requests.length, 1);
        f.layer.update(f.context);
        f.layer.update(context);
        assert.equal(f.requests.length, 2);
    }
    finally {
        f.layer.dispose();
        t.mock.timers.reset();
    }
});
