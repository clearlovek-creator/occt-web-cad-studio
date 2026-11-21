import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MeshArtifactPool } from '../gateway/mesh-artifact-pool.mjs';
const job = { jobId: 'mesh-00000000-0000-0000-0000-000000000001', documentId: 'test', state: 'complete' };
async function fixture(run, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-artifact-pool-')), workers = [], pool = new MeshArtifactPool({ dataDir: root, ...options, workerFactory: (_url, settings) => { const worker = new EventEmitter(); Object.assign(worker, { settings, terminate: () => { worker.terminated = true; return Promise.resolve(1); }, reply: value => worker.emit('message', { id: settings.workerData.id, ok: true, value, replyBytes: 20 }) }); workers.push(worker); return worker; } });
    try {
        await run({ root, pool, workers, request: (extra = {}) => pool.execute({ operation: 'read', job, ...extra }) });
    }
    finally {
        for (const worker of workers)
            worker.emit('exit', 1);
        await pool.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-artifact-pool-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
test('concurrent reads share one heavy verifier; aborting one subscriber does not cancel the other', async () => fixture(async (f) => {
    const a = new AbortController(), first = f.request({ signal: a.signal }), failed = assert.rejects(first, { code: 'MESH_ARTIFACT_CANCELLED' }), second = f.request();
    assert.equal(f.workers.length, 1);
    assert.equal(f.pool.metrics.coalesced, 1);
    a.abort();
    await failed;
    assert.equal(f.workers[0].terminated, undefined);
    f.workers[0].reply({ ok: true });
    f.workers[0].emit('exit', 0);
    assert.deepEqual(await second, { ok: true });
    assert.equal(f.pool.active, null);
}));
test('last-subscriber cancellation and task deletion wait for actual exit before a queued writer can begin', async () => fixture(async (f) => {
    const a = new AbortController(), first = f.request({ signal: a.signal }), failed = assert.rejects(first, { code: 'MESH_ARTIFACT_CANCELLED' }), next = f.request({ job: { ...job, jobId: 'mesh-00000000-0000-0000-0000-000000000002' } });
    a.abort();
    let ended = false;
    const deletion = f.pool.cancelJob(job.jobId).then(() => ended = true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.workers[0].terminated, true);
    assert.equal(f.workers.length, 1);
    assert.equal(ended, false);
    f.workers[0].emit('exit', 1);
    await failed;
    await deletion;
    assert.equal(f.workers.length, 2);
    f.workers[1].reply({ ok: true });
    f.workers[1].emit('exit', 0);
    await next;
}));
test('project asset operation owns its context and cancellation waits for real worker exit before staging cleanup',async()=>fixture(async f=>{
    const source={documentId:'doc',folderName:'doc-abcdef'},controller=new AbortController(),work=f.pool.execute({operation:'project-package-open',result:source,ownerId:'project-open',signal:controller.signal}),rejected=assert.rejects(work,{code:'MESH_ARTIFACT_CANCELLED'});source.folderName='changed';assert.equal(f.workers[0].settings.workerData.result.folderName,'doc-abcdef');let done=false;controller.abort();const stopped=f.pool.cancelJob('project-open').then(()=>done=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);assert.equal(f.pool.active.operation,'project-package-open');f.workers[0].emit('exit',1);await rejected;await stopped;assert.equal(done,true);assert.equal(f.pool.active,null);
}));
test('a seal publishes only after a successful worker exit and cancelled staging never replaces the prior result', async () => fixture(async (f) => {
    const directory = f.pool.store.directory(job);
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'result.json');
    fs.writeFileSync(target, 'prior');
    const work = f.request({ operation: 'seal', result: { ok: true } }), settings = f.workers[0].settings.workerData;
    fs.writeFileSync(settings.staging, 'new');
    f.workers[0].reply({ artifact: {}, result: { ok: true }, identity: fs.lstatSync(settings.staging, { bigint: true }) });
    assert.equal(fs.readFileSync(target, 'utf8'), 'prior');
    f.workers[0].emit('exit', 0);
    await work;
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    const a = new AbortController(), cancelled = f.request({ operation: 'seal', result: { ok: true }, signal: a.signal }), failed = assert.rejects(cancelled, { code: 'MESH_ARTIFACT_CANCELLED' });
    const staged = f.workers[1].settings.workerData.staging;
    fs.writeFileSync(staged, 'uncommitted');
    a.abort();
    assert.equal(fs.existsSync(staged), true);
    f.workers[1].emit('exit', 1);
    await failed;
    assert.equal(fs.existsSync(staged), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
}));
test('queue deadlines include waiting time, capacity is bounded, and worker memory failures are recoverable', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        await fixture(async (f) => { const first = f.request(), firstFailed = assert.rejects(first, { code: 'MESH_ARTIFACT_TIMEOUT' }), queued = f.request({ job: { ...job, jobId: 'mesh-00000000-0000-0000-0000-000000000002' } }), queueFailed = assert.rejects(queued, { code: 'MESH_ARTIFACT_TIMEOUT' }); await assert.rejects(f.request({ job: { ...job, jobId: 'mesh-00000000-0000-0000-0000-000000000003' } }), { code: 'MESH_ARTIFACT_BUSY' }); t.mock.timers.tick(20); assert.equal(f.workers.length, 1); f.workers[0].emit('exit', 1); await Promise.all([firstFailed, queueFailed]); assert.equal(f.workers.length, 1); const next = f.request(), failed = assert.rejects(next, { code: 'MESH_ARTIFACT_LIMIT' }); f.workers[1].emit('error', Object.assign(Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })); f.workers[1].emit('exit', 1); await failed; assert.equal(f.pool.active, null); }, { maxQueue: 1, timeoutMs: 20 });
    }
    finally {
        t.mock.timers.reset();
    }
});
