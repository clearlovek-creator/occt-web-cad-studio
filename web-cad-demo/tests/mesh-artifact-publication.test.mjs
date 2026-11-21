import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectMeshService } from '../gateway/project-mesh-service.mjs';
const jobId = 'mesh-00000000-0000-0000-0000-000000000001';
test('concurrent show requests share the same global intent instead of cancelling each other',async()=>fixture(async f=>{const first=f.service.handle('POST',`/api/mesh/jobs/${jobId}/visibility`,{visible:true});await f.entered;const second=f.service.handle('POST',`/api/mesh/jobs/${jobId}/visibility`,{visible:true});await new Promise(resolve=>setImmediate(resolve));f.release();const replies=await Promise.all([first,second]);assert.ok(replies.every(reply=>reply.payload.meshJob.visible&&!reply.payload.superseded));}));
async function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-artifact-publication-'));
    const source = { version: 1, documentId: 'test', revision: 1, bodies: [{ bodyId: 'body-1', kind: 'solid', bodyIdentity: 'a'.repeat(32), topologyIdentity: 'b'.repeat(32), topologyRevision: 1 }] };
    const view = { ok: true, documentId: 'test', revision: 1, bodyMetadata: structuredClone(source.bodies) };
    const job = { jobId, documentId: 'test', source, state: 'complete', createdAt: new Date().toISOString(), visible: false, artifact: { result: { bytes: 2, sha256: 'c'.repeat(64) } } };
    let arrive, release;
    const entered = new Promise(resolve => arrive = resolve), gate = new Promise(resolve => release = resolve);
    const artifactPool = {
        async execute({operation}) {
            if(operation==='recover-catalog')return {jobs:[],stats:{records:0}};
            arrive();await gate;return {ok:true,mesh:{admission:{version:1,status:'accepted',usable:true}}};
        },
        async cancelJob() {},async close() {release();}
    };
    const service=new ProjectMeshService({dataDir:root,artifactPool,serializeDocument:async(_id,action)=>action(),command:async()=>structuredClone(view)});
    await service.ready;service.jobs.set(jobId,job);
    try {
    await run({ root, job, view, service, entered, release });
}
finally {
    release();
    await service.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^cad-artifact-publication-/);
    fs.rmSync(root, { recursive: true, force: true });
} }
test('an older show request cannot undo a newer hide while verification is running', async () => fixture(async (f) => { const showing = f.service.handle('POST', `/api/mesh/jobs/${jobId}/visibility`, { visible: true }); await f.entered; assert.equal((await f.service.handle('POST', `/api/mesh/jobs/${jobId}/visibility`, { visible: false })).payload.meshJob.visible, false); f.release(); const old = await showing; assert.equal(old.payload.superseded, true); assert.equal(old.payload.meshJob.visible, false); assert.equal(f.job.visible, false); }));
test('geometry changed during full verification cannot be shown using the old pre-verification snapshot', async () => fixture(async (f) => { const showing = f.service.handle('POST', `/api/mesh/jobs/${jobId}/visibility`, { visible: true }); await f.entered; f.view.bodyMetadata[0].topologyIdentity = 'd'.repeat(32); f.release(); const response = await showing; assert.equal(response.payload.code, 'MESH_SOURCE_STALE'); assert.equal(f.job.visible, false); }));
test('a deleted task cannot be republished by an old successful full-result reader', async () => fixture(async (f) => { const reading = f.service.handle('GET', `/api/mesh/jobs/${jobId}`); await f.entered; await f.service.handle('DELETE', `/api/mesh/jobs/${jobId}`); f.release(); const response = await reading; assert.equal(response.status, 404); assert.equal(fs.existsSync(f.service.store.directory(f.job)), false); }));
test('material queue, resource, timeout and cancellation errors do not turn valid mesh files into corrupt artifacts', async () => fixture(async (f) => { for (const code of ['MESH_ARTIFACT_LIMIT', 'MESH_ARTIFACT_BUSY', 'MESH_ARTIFACT_TIMEOUT', 'MESH_ARTIFACT_CLOSED', 'MESH_ARTIFACT_CANCELLED']) {
    f.service.artifacts.execute = async () => { throw Object.assign(Error('Controlled read failure'), { code }); };
    const response = await f.service.handle('GET', `/api/mesh/jobs/${jobId}`);
    assert.equal(response.status, code === 'MESH_ARTIFACT_CANCELLED' ? 499 : 503);
    assert.equal(response.payload.code, code);
    assert.equal(f.job.state, 'complete');
    assert.equal(f.job.error, undefined);
} }));
