import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createArtifactFixture } from './helpers/mesh-artifact-fixture.mjs';
import { stopTestChild } from './helpers/stop-test-child.mjs';
test('configured task/cache caps reach the real API and do not start CAD work or delete artifacts on refusal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-capacity-api-')), f = createArtifactFixture(root, 10), before = fs.readFileSync(f.store.qualityOutput(f.job)), server = net.createServer();
    let child;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        await new Promise(resolve => server.close(resolve));
        const api = `http://127.0.0.1:${port}/api`;
        child = spawn(process.execPath, ['gateway/server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: root, GEOMETRY_MESH_MAX_JOBS: '2', GEOMETRY_MESH_MAX_JOBS_PER_DOCUMENT: '1', GEOMETRY_MESH_CACHE_BYTES: '204800', GEOMETRY_MESH_CACHE_JOB_BYTES: '102400' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Capacity Gateway startup timeout')), 15000); child.once('error', reject); child.stderr.on('data', () => { }); child.stdout.on('data', bytes => { if (String(bytes).includes('Geometry gateway ready')) {
            clearTimeout(timer);
            resolve();
        } }); });
        const request = async (route, method = 'GET', body) => { const response = await fetch(api + route, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) }); return { status: response.status, data: await response.json() }; };
        const health = (await request('/health')).data;
        assert.equal(health.runtime.meshTaskCapacity.max, 2);
        assert.equal(health.runtime.meshTaskCapacity.maxPerDocument, 1);
        assert.equal(health.runtime.meshQualityQueries.cacheBudget.maxBytes, 204800);
        assert.equal(health.runtime.meshQualityQueries.cacheBudget.maxJobBytes, 102400);
        assert.equal(health.runtime.meshCompute.maxActive, 1);
        const capped = await request('/documents/admission/mesh/jobs', 'POST', {});
        assert.equal(capped.status, 409);
        assert.equal(capped.data.code, 'MESH_TASK_CAPACITY');
        assert.equal((await request('/health')).data.loadedDocuments, health.loadedDocuments);
        assert.deepEqual(fs.readFileSync(f.store.qualityOutput(f.job)), before);
        const empty = await request('/documents/empty/mesh/jobs', 'POST', {});
        assert.notEqual(empty.data.code, 'MESH_TASK_CAPACITY');
        const occupied = (await request('/health')).data;
        assert.equal(occupied.runtime.meshTaskCapacity.stored, 2);
        const full = await request('/documents/third/mesh/jobs', 'POST', {});
        assert.equal(full.data.code, 'MESH_TASK_CAPACITY');
        assert.equal((await request('/health')).data.loadedDocuments, occupied.loadedDocuments);
        assert.equal((await request('/mesh/jobs/' + empty.data.meshJob.jobId, 'DELETE')).status, 200);
        const quality = await request('/mesh/jobs/' + f.job.jobId + '/quality?issue=all&limit=1');
        assert.equal(quality.status, 200);
        assert.equal(quality.data.total, 10);
        const report = (await request('/health')).data.runtime.meshQualityQueries.cacheCapacity;
        assert.ok(report.usedBytes > 0 && report.usedBytes <= 204800);
        assert.equal(JSON.stringify(report).includes(root), false);
        assert.deepEqual(fs.readFileSync(f.store.qualityOutput(f.job)), before);
    }
    finally {
        await stopTestChild(child);
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-capacity-api-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
