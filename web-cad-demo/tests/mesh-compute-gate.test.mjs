import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createArtifactFixture } from './helpers/mesh-artifact-fixture.mjs';
test('the operation deadline includes waiting for the shared permit and never starts an expired worker', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-compute-deadline-')), gate = new MeshComputeGate(), lease = await gate.acquire({ kind: 'catalog' });
    let starts = 0;
    const artifact = new MeshArtifactPool({ dataDir: root, computeGate: gate, timeoutMs: 10, workerFactory: () => { starts++; throw Error('Expired worker started'); } }), quality = new MeshQualityQueryPool({ computeGate: gate, timeoutMs: 10, workerFactory: () => { starts++; throw Error('Expired worker started'); } }), job = { jobId: 'mesh-00000000-0000-0000-0000-000000000001', documentId: 'test', source: { bodies: [] }, artifact: { quality: { bytes: 1, sha256: 'a'.repeat(64) } } };
    try {
        const a = assert.rejects(artifact.execute({ operation: 'read', job }), { code: 'MESH_ARTIFACT_TIMEOUT' }), q = assert.rejects(quality.query({ file: path.join(root, 'quality.json'), job }), { code: 'MESH_QUALITY_QUERY_TIMEOUT' });
        t.mock.timers.tick(10);
        await Promise.all([a, q]);
        assert.equal(starts, 0);
        assert.equal(gate.status().waiting, 0);
        assert.equal(gate.status().active, 'catalog');
    }
    finally {
        lease.release();
        await Promise.all([artifact.close(), quality.close()]);
        gate.close();
        t.mock.timers.reset();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-compute-deadline-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
import { MeshComputeGate } from '../gateway/mesh-compute-gate.mjs';
import { MeshArtifactPool } from '../gateway/mesh-artifact-pool.mjs';
import { MeshQualityQueryPool } from '../gateway/mesh-quality-pool.mjs';
const until = async (predicate) => {
    const end = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < end);
        await new Promise(resolve => setImmediate(resolve));
    }
};
test('actual artifact and quality workers share one permit while health state remains observable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-compute-real-')), fixture = createArtifactFixture(root, 1000), gate = new MeshComputeGate(), workers = [], artifact = new MeshArtifactPool({ dataDir: root, computeGate: gate, workerFactory: (url, options) => { const worker = new Worker(new URL('./fixtures/mesh-gated-thread.mjs', import.meta.url), { ...options, workerData: { ...options.workerData, moduleUrl: url.href } }); workers.push(worker); return worker; } }), quality = new MeshQualityQueryPool({ computeGate: gate });
    try {
        const reading = artifact.execute({ operation: 'read', job: fixture.job });
        await until(() => workers.length === 1);
        await new Promise(resolve => workers[0].once('online', resolve));
        const querying = quality.query({ file: fixture.store.qualityOutput(fixture.job), job: fixture.job, input: { issue: 'all', limit: 2 } });
        await until(() => gate.status().waiting === 1);
        assert.equal(quality.metrics.workersStarted, 0);
        assert.equal(gate.status().active, 'artifact');
        workers[0].postMessage('start');
        assert.equal((await reading).mesh.admission.status, 'accepted');
        assert.equal((await querying).total, 1000);
        assert.equal(quality.metrics.workersStarted, 1);
        assert.equal(gate.status().active, null);
    }
    finally {
        for (const worker of workers)
            worker.postMessage('start');
        await Promise.all([artifact.close(), quality.close()]);
        gate.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-compute-real-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test('shared FIFO permits keep quality and artifact threads exclusive until actual exit, including cancellation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-compute-gate-')), gate = new MeshComputeGate(), workers = [], factory = (_url, options) => { const worker = new EventEmitter(); worker.options = options; worker.terminate = () => { worker.terminated = true; return Promise.resolve(1); }; workers.push(worker); return worker; }, artifact = new MeshArtifactPool({ dataDir: root, computeGate: gate, workerFactory: factory }), quality = new MeshQualityQueryPool({ computeGate: gate, workerFactory: factory }), job = { jobId: 'mesh-00000000-0000-0000-0000-000000000001', documentId: 'test', state: 'complete', source: { bodies: [] }, artifact: { quality: { bytes: 1, sha256: 'a'.repeat(64) } } };
    try {
        const a = new AbortController(), reading = artifact.execute({ operation: 'read', job, signal: a.signal }), failed = assert.rejects(reading, { code: 'MESH_ARTIFACT_CANCELLED' });
        await until(() => workers.length === 1);
        const querying = quality.query({ file: path.join(root, 'quality.json'), job });
        await until(() => gate.status().waiting === 1);
        a.abort();
        assert.equal(workers[0].terminated, true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(workers.length, 1);
        assert.equal(gate.status().active, 'artifact');
        workers[0].emit('exit', 1);
        await failed;
        await until(() => workers.length === 2);
        assert.equal(gate.status().active, 'quality');
        workers[1].emit('message', { ok: true, result: { ok: true } });
        workers[1].emit('exit', 0);
        await querying;
        assert.equal(gate.status().active, null);
        assert.equal(gate.status().grants, 2);
    }
    finally {
        for (const worker of workers)
            worker.emit('exit', 1);
        await Promise.all([artifact.close(), quality.close()]);
        gate.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test('a cancelled shared-permit waiter never starts a worker or releases another operation permit', async () => {
    const gate = new MeshComputeGate(), lease = await gate.acquire({ kind: 'catalog' }), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-compute-wait-'));
    let starts = 0;
    const pool = new MeshArtifactPool({ dataDir: root, computeGate: gate, workerFactory: () => { starts++; throw Error('Must not start'); } }), controller = new AbortController();
    try {
        const work = pool.execute({ operation: 'read', job: { jobId: 'mesh-00000000-0000-0000-0000-000000000001', documentId: 'test' }, signal: controller.signal }), failed = assert.rejects(work, { code: 'MESH_ARTIFACT_CANCELLED' });
        controller.abort();
        await failed;
        assert.equal(starts, 0);
        assert.equal(gate.status().active, 'catalog');
        assert.equal(gate.status().waiting, 0);
    }
    finally {
        lease.release();
        await pool.close();
        gate.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test('shared permit order is FIFO, release is idempotent and closing only rejects unstarted work', async () => {
    const gate = new MeshComputeGate(), a = await gate.acquire({ kind: 'quality' }), b = gate.acquire({ kind: 'artifact' }), c = gate.acquire({ kind: 'catalog' }), closed = assert.rejects(c, { code: 'MESH_COMPUTE_CLOSED' });
    a.release();
    a.release();
    const second = await b;
    assert.equal(gate.status().active, 'artifact');
    gate.close();
    await closed;
    assert.equal(gate.status().active, 'artifact');
    second.release();
    assert.equal(gate.status().active, null);
});
