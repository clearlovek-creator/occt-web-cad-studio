import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { MeshJobStore } from '../gateway/mesh-job-store.mjs';
import { stopTestChild } from './helpers/stop-test-child.mjs';
import { admissionFixture } from './helpers/mesh-admission-fixture.mjs';
test('large HTTP quality queries keep health and CAD responsive, cancel on disconnect and reuse their sealed index after Gateway restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-quality-http-')), store = new MeshJobStore(root), f = admissionFixture(), job = { jobId: 'mesh-' + crypto.randomUUID(), documentId: f.source.documentId, source: f.source, state: 'complete', createdAt: new Date().toISOString(), options: { repairMode: 'strict', qualityThreshold: .2 } };
    f.index.requestId = job.jobId;
    f.index.cells = Array.from({ length: 100000 }, (_, i) => ({ ...f.index.cells[0], elementId: String(9007199254740993n + BigInt(i)), quality: (i % 1000) / 1000 }));
    const directory = store.directory(job);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(store.qualityOutput(job), JSON.stringify(f.index));
    const indexBytes = fs.readFileSync(store.qualityOutput(job)), result = Buffer.from(JSON.stringify({ ok: true, requestId: job.jobId, mesh: {} }));
    fs.writeFileSync(path.join(directory, 'result.json'), result);
    const digest = bytes => ({ bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    job.artifact = { quality: digest(indexBytes), result: digest(result) };
    store.save(job);
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const api = `http://127.0.0.1:${port}/api`;
    let gateway;
    const start = async () => { gateway = spawn(process.execPath, ['gateway/server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { let diagnostic = ''; const timer = setTimeout(() => reject(Error('Quality HTTP startup ' + diagnostic)), 15000); gateway.once('error', reject); gateway.stderr.on('data', chunk => diagnostic += chunk); gateway.stdout.on('data', chunk => { if (String(chunk).includes('Geometry gateway ready')) {
        clearTimeout(timer);
        resolve();
    } }); }); };
    const stop = async () => { await stopTestChild(gateway); gateway = null; }, health = async () => { const response = await fetch(api + '/health', { signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 200); return response.json(); };
    const wait = async (predicate) => { const end = Date.now() + 10000; for (;;) {
        const value = await health();
        if (predicate(value.runtime.meshQualityQueries))
            return value;
        assert.ok(Date.now() < end, 'Quality state did not settle');
        await new Promise(resolve => setTimeout(resolve, 5));
    } };
    try {
        await start();
        const controller = new AbortController();
        let settled = false;
        const pending = fetch(api + `/mesh/jobs/${job.jobId}/quality?issue=all&limit=10`, { signal: controller.signal }).finally(() => settled = true), rejected = assert.rejects(pending, error => error.name === 'AbortError');
        const active = await wait(state => state.active);
        assert.equal(active.runtime.meshQualityQueries.active, true);
        assert.equal(settled, false, 'Health must reply while the heavy query is still running');
        const cad = await fetch(api + '/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId: 'default', operation: 'document.summary' }), signal: AbortSignal.timeout(3000) });
        assert.equal((await cad.json()).ok, true);
        controller.abort();
        await rejected;
        await wait(state => !state.active && state.queued === 0);
        assert.deepEqual(fs.readFileSync(store.qualityOutput(job)), indexBytes);
        assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
        const query = async () => { const response = await fetch(api + `/mesh/jobs/${job.jobId}/quality?issue=all&limit=10`, { signal: AbortSignal.timeout(15000) }), payload = await response.json(); assert.equal(response.status, 200, JSON.stringify(payload)); assert.equal(payload.total, 100000); assert.equal(payload.cells.length, 10); return payload; };
        const first = await query();
        assert.ok(JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json'))).artifact.qualityQuery);
        await stop();
        await start();
        const recovered = await query();
        assert.deepEqual(recovered.cells, first.cells);
        assert.deepEqual(recovered.quality, first.quality);
        const status = (await health()).runtime.meshQualityQueries;
        assert.equal(status.metrics.builds, 0);
        assert.equal(status.metrics.parsedSourceBytes, 0);
        assert.equal(status.metrics.requests, 1);
        assert.deepEqual(fs.readFileSync(store.qualityOutput(job)), indexBytes);
        await stop();
        const record = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json')));
        record.artifact.qualityQuery.manifest.sha256 = 'damaged-derived-proof';
        store.save(record);
        await start();
        assert.deepEqual((await query()).cells, first.cells);
        assert.equal((await health()).runtime.meshQualityQueries.metrics.builds, 1, 'A damaged optional cache proof is rebuilt, not a failed original mesh');
        const removed = await fetch(api + `/mesh/jobs/${job.jobId}`, { method: 'DELETE' });
        assert.equal(removed.status, 200);
        assert.equal(fs.existsSync(directory), false);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(fs.existsSync(directory), false, 'No late cache publisher may resurrect a deleted task');
    }
    finally {
        await stop();
        assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
