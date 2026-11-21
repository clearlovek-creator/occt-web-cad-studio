import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectMeshService } from '../gateway/project-mesh-service.mjs';
async function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-wire-publication-')), job = { jobId: 'mesh-00000000-0000-0000-0000-000000000001', documentId: 'test', state: 'complete', source: { version: 1, documentId: 'test', revision: 1, bodies: [{ bodyId: 'body-1', kind: 'solid', bodyIdentity: 'a'.repeat(32), topologyIdentity: 'b'.repeat(32), topologyRevision: 1 }] }, artifact: { render: { bytes: 48, sha256: 'c'.repeat(64) } }, meshSummary: { admission: { usable: true, status: 'accepted' } } };
    let resolve, arrive;
    const observed = new Promise(done => arrive = done), view = { ok: true, documentId: 'test', revision: 1, bodyMetadata: job.source.bodies };
    let checks = 0, reads = 0, usable = true;
    const service = new ProjectMeshService({ dataDir: root, serializeDocument: async (_id, action) => action(), command: () => { arrive(); return new Promise(done => resolve = () => done(view)); }, worker: {} });
    await service.ready;
    service.jobs.set(job.jobId, job);
    // Controlled admission reader: tests here concern publication after the
    // asynchronous CAD observation. Real admission and binary integrity use
    // mesh-wire-integration / mesh-admission tests, not this fixture.
    service.artifacts.execute = async () => { checks++; return { mesh: { admission: { version: 1, usable, status: usable ? 'accepted' : 'blocked' } } }; };
    service.store.readRender = () => { reads++; throw Error('Unexpected access to binary data'); };
    const get = (signal) => service.handle('GET', `/api/mesh/jobs/${job.jobId}/render`, { wireKey: 'wire-3-1', chunk: 0 }, { signal });
    try {
        await run({ service, job, view, observed, release: () => resolve(), get, counts: () => ({ checks, reads }), setUsable: value => usable = value });
    }
    finally {
        await service.qualityQueries.close();
        await service.artifacts.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-wire-publication-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
test('render chunks reject deletion, failed state, changed source and cancellation after a queued CAD observation', async () => {
    for (const kind of ['deleted', 'failed', 'changed', 'cancelled'])
        await fixture(async (f) => {
            const controller = new AbortController(), pending = f.get(controller.signal);
            await f.observed;
            if (kind === 'deleted')
                f.service.jobs.delete(f.job.jobId);
            if (kind === 'failed')
                f.job.state = 'failed';
            if (kind === 'changed')
                f.view.bodyMetadata = [{ ...f.job.source.bodies[0], topologyIdentity: 'd'.repeat(32) }];
            if (kind === 'cancelled')
                controller.abort();
            f.release();
            const result = await pending;
            assert.equal(result.payload.code, { deleted: 'MESH_JOB_NOT_FOUND', failed: 'MESH_RENDER_NOT_READY', changed: 'MESH_SOURCE_STALE', cancelled: 'MESH_RENDER_CANCELLED' }[kind]);
            assert.equal(f.counts().reads, 0);
        });
});
test('persisted accepted hints cannot authorize rendering and expired admission leases are independently rechecked', async () => fixture(async (f) => {
    f.setUsable(false);
    const denied = await f.get();
    assert.equal(denied.payload.code, 'MESH_ADMISSION_REQUIRED');
    assert.equal(f.counts().checks, 1);
    assert.equal(f.counts().reads, 0);
    f.service.renderProofs.set(f.job.jobId, { stamp: f.service.renderStamp(f.job), usable: true, verifiedAt: performance.now() - 30001 });
    const expired = await f.get();
    assert.equal(expired.payload.code, 'MESH_ADMISSION_REQUIRED');
    assert.equal(f.counts().checks, 2);
    f.service.renderProofs.set(f.job.jobId,{stamp:f.service.renderStamp(f.job),usable:true,verifiedAt:performance.now()+1000});
    assert.equal((await f.get()).payload.code,'MESH_ADMISSION_REQUIRED');assert.equal(f.counts().checks,3);
}));
test('invalid chunk requests and legacy inline results are refused without poisoning the original task', async () => fixture(async (f) => {
    const invalid = await f.service.handle('GET', `/api/mesh/jobs/${f.job.jobId}/render`, { wireKey: 'wire-3-1', chunk: '00' });
    assert.equal(invalid.status, 400);
    assert.equal(f.job.state, 'complete');
    delete f.job.artifact.render;
    const legacy = await f.get();
    assert.equal(legacy.payload.code, 'MESH_RENDER_INLINE');
    assert.equal(f.job.state, 'complete');
    assert.equal(f.counts().checks, 0);
}));
