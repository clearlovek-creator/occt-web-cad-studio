import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectMeshService } from '../gateway/project-mesh-service.mjs';
import { createArtifactFixture } from './helpers/mesh-artifact-fixture.mjs';
test('explicit task deletion cannot race a cross-job cache reader holding the shared permit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-task-delete-gate-')), f = createArtifactFixture(root, 1), service = new ProjectMeshService({ dataDir: root, serializeDocument: async (_id, action) => action(), command: async () => ({ ok: true }) }), lease = await service.computeGate.acquire({ kind: 'quality' });
    try {
        const deleting = service.handle('DELETE', `/api/mesh/jobs/${f.job.jobId}`);
        const end = Date.now() + 3000;
        while (!service.computeGate.status().waiting) {
            assert.ok(Date.now() < end);
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.ok(fs.existsSync(f.store.output(f.job)));
        assert.ok(service.jobs.has(f.job.jobId));
        lease.release();
        assert.equal((await deleting).status, 200);
        assert.equal(fs.existsSync(f.store.output(f.job)), false);
        assert.equal(service.jobs.has(f.job.jobId), false);
    }
    finally {
        lease.release();
        await service.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-task-delete-gate-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test('stored task caps reject new work without CAD calls or automatic result deletion; explicit deletion frees capacity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-task-capacity-')), a = createArtifactFixture(root, 1), b = createArtifactFixture(root, 1);
    let calls = 0;
    const service = new ProjectMeshService({ dataDir: root, maxStoredJobs: 2, maxJobsPerDocument: 1, serializeDocument: async (_id, action) => action(), command: async () => { calls++; return { ok: true, bodyCount: 0 }; } });
    try {
        const before = fs.readFileSync(a.store.output(a.job));
        assert.equal((await service.create('admission', {})).payload.code, 'MESH_TASK_CAPACITY');
        assert.equal(calls, 0);
        assert.deepEqual(fs.readFileSync(a.store.output(a.job)), before);
        assert.equal((await service.handle('DELETE', `/api/mesh/jobs/${b.job.jobId}`)).status, 200);
        assert.equal((await service.create('admission', {})).payload.code, 'MESH_TASK_CAPACITY');
        assert.equal(calls, 0);
        assert.equal((await service.handle('DELETE', `/api/mesh/jobs/${a.job.jobId}`)).status, 200);
        const admitted = await service.create('admission', {});
        assert.notEqual(admitted.payload.code, 'MESH_TASK_CAPACITY');
        assert.equal(calls, 1);
        assert.equal(service.jobs.size, 1);
    }
    finally {
        await service.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-task-capacity-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
