import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { MeshArtifactPool } from '../gateway/mesh-artifact-pool.mjs';
import { MeshComputeGate } from '../gateway/mesh-compute-gate.mjs';
import { preparationPaths, readPreparationManifest, copyPreparationFile, stagePreparationFiles, PREPARATION_MANIFEST_BYTES } from '../gateway/mesh-preparation-files.mjs';
import { diagnosticSource, diagnosticFixture } from './helpers/mesh-preparation-fixture.mjs';
import { preparationSummary } from '../gateway/mesh-preparation-report.mjs';

const digest = bytes => ({ bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
async function fixture(run, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-preparation-files-'));
    const job = { documentId: diagnosticSource.documentId, jobId: 'mesh-' + crypto.randomUUID(), source: structuredClone(diagnosticSource), state: 'preparing', kind: 'preparation', options: { repairMode: 'conservative', deepCheck: false, qualityThreshold: 0.2 } };
    const pool = new MeshArtifactPool({ dataDir: root, ...options }), paths = preparationPaths(root, job, { create: true });
    fs.writeFileSync(paths.source, 'BREP source fixture');
    fs.writeFileSync(paths.sourceManifest, JSON.stringify({ revision: job.source.revision, bodies: job.source.bodies }));
    try { await run({ root, job, pool, paths }); }
    finally {
        await pool.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-preparation-files-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function completedPreview(f) {
    const captured = await f.pool.execute({ operation: 'capture-prepared', job: f.job });
    const preparation = diagnosticFixture(f.job.source), result = { ok: true, requestId: f.job.jobId, preparation };
    const sealed = await f.pool.execute({ operation: 'seal', job: f.job, result });
    Object.assign(f.job, { state: 'complete', artifact: { ...sealed.artifact, ...captured.artifact }, preparationSummary: preparationSummary(preparation.diagnostics) });
    return f.job;
}

test('native source manifests are bounded, strict UTF-8 and bound to the full body identities', async () => fixture(async f => {
    const manifest = await f.pool.execute({ operation: 'source-manifest', job: f.job });
    assert.deepEqual(manifest.bodies, f.job.source.bodies);
    const changed = structuredClone(manifest); changed.bodies[0].topologyIdentity = 'f'.repeat(32);
    fs.writeFileSync(f.paths.sourceManifest, JSON.stringify(changed));
    await assert.rejects(f.pool.execute({ operation: 'source-manifest', job: f.job }), { code: 'MESH_SOURCE_MANIFEST_INVALID' });
    fs.writeFileSync(f.paths.sourceManifest, Buffer.from([0xff]));
    assert.throws(() => readPreparationManifest(f.paths.sourceManifest, f.job.source), { code: 'MESH_SOURCE_MANIFEST_INVALID' });
    fs.writeFileSync(f.paths.sourceManifest, 'null');
    assert.throws(() => readPreparationManifest(f.paths.sourceManifest, f.job.source), { code: 'MESH_SOURCE_MANIFEST_INVALID' });
    const fd = fs.openSync(f.paths.sourceManifest, 'w'); fs.ftruncateSync(fd, PREPARATION_MANIFEST_BYTES + 1); fs.closeSync(fd);
    await assert.rejects(f.pool.execute({ operation: 'source-manifest', job: f.job }), { code: 'MESH_ARTIFACT_LIMIT' });
    assert.equal(fs.statSync(f.paths.sourceManifest).size, PREPARATION_MANIFEST_BYTES + 1);
}));

test('snapshot copy hashes exactly the bytes written and refuses an occupied destination', async () => fixture(async f => {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x41), target = path.join(f.paths.task, 'copy.tmp');
    fs.writeFileSync(f.paths.source, bytes);
    const copied = copyPreparationFile(f.paths.source, target, digest(bytes));
    assert.deepEqual(copied.proof, digest(fs.readFileSync(target)));
    assert.equal(copied.identity.size, BigInt(bytes.length));
    assert.throws(() => copyPreparationFile(f.paths.source, target), { code: 'MESH_PREPARATION_IO' });
    assert.throws(() => copyPreparationFile(f.paths.source, target + '.bad', digest(Buffer.from('changed'))), { code: 'MESH_ARTIFACT_INVALID' });
    assert.throws(() => copyPreparationFile(f.paths.source, target + '.limit', undefined, bytes.length - 1), { code: 'MESH_ARTIFACT_LIMIT' });
    assert.deepEqual(fs.readFileSync(f.paths.source), bytes);
}));

test('a same-length source mutation while copying cannot pass the certified content proof', async t => fixture(async f => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 0x41), target = path.join(f.paths.task, 'mutating.tmp');
    fs.writeFileSync(f.paths.source, bytes);
    const read = fs.readSync; let changed = false;
    t.mock.method(fs, 'readSync', (...args) => {
        const count = read(...args);
        if (!changed) { changed = true; const fd = fs.openSync(f.paths.source, 'r+'); fs.writeSync(fd, Buffer.from('B'), 0, 1, bytes.length - 1); fs.closeSync(fd); }
        return count;
    });
    try { assert.throws(() => copyPreparationFile(f.paths.source, target, digest(bytes)), { code: 'MESH_ARTIFACT_INVALID' }); }
    finally { t.mock.restoreAll(); }
    assert.equal(changed, true);
    assert.equal(fs.existsSync(f.paths.brep), false);
}));

test('a native source length change during first capture is rejected without relying on timestamp precision', async t => fixture(async f => {
    const read = fs.readSync; let changed = false;
    t.mock.method(fs, 'readSync', (...args) => { const count = read(...args); if (!changed) { changed = true; fs.appendFileSync(f.paths.source, 'late bytes'); } return count; });
    try { assert.throws(() => copyPreparationFile(f.paths.source, path.join(f.paths.task, 'growing.tmp')), { code: 'MESH_ARTIFACT_INVALID' }); }
    finally { t.mock.restoreAll(); }
    assert.equal(changed, true);
    assert.equal(fs.existsSync(f.paths.brep), false);
}));

test('destination disk failures are recoverable I/O errors, not corruption of the certified source', async t => fixture(async f => {
    const original=fs.readFileSync(f.paths.source);
    t.mock.method(fs,'writeSync',()=>{throw Object.assign(Error('disk full fixture'),{code:'ENOSPC'});});
    try { assert.throws(()=>copyPreparationFile(f.paths.source,path.join(f.paths.task,'full.tmp'),digest(original)),{code:'MESH_PREPARATION_IO'}); }
    finally { t.mock.restoreAll(); }
    assert.deepEqual(fs.readFileSync(f.paths.source),original);
    assert.equal(fs.existsSync(f.paths.brep),false);
}));

test('real artifact workers capture then reuse exact snapshots without returning full preview arrays', async () => fixture(async f => {
    const original = fs.readFileSync(f.paths.source), preview = await completedPreview(f);
    const targetJob = { ...preview, state: 'preparing', kind: 'mesh', jobId: 'mesh-' + crypto.randomUUID(), artifact: undefined, source: { ...preview.source, revision: preview.source.revision + 1 } };
    const target = preparationPaths(f.root, targetJob, { create: true });
    const reused = await f.pool.execute({ operation: 'reuse-prepared', job: preview, targetJob });
    assert.deepEqual(fs.readFileSync(target.source), original);
    assert.deepEqual(reused.artifact.preparedBrep, digest(original));
    assert.equal(reused.manifest.revision, preview.source.revision, 'metadata-only revisions do not rewrite certified geometry');
    assert.equal(reused.result, undefined); assert.equal(reused.preview, undefined); assert.equal(reused.brepPath, undefined);
    assert.equal(reused.diagnostics.status, 'ready');
    assert.deepEqual(fs.readFileSync(f.paths.brep), original);
    assert.deepEqual(fs.readdirSync(target.task), []);
    await assert.rejects(f.pool.execute({ operation: 'reuse-prepared', job: preview, targetJob }), { code: 'MESH_PREPARATION_IO' });
    assert.deepEqual(fs.readFileSync(target.source), original);
}));

test('corrupt prepared bytes, foreign projects and changed target topology never publish native inputs', async () => fixture(async f => {
    const preview = await completedPreview(f), targetJob = { ...preview, state: 'preparing', jobId: 'mesh-' + crypto.randomUUID(), artifact: undefined };
    const target = preparationPaths(f.root, targetJob, { create: true });
    await assert.rejects(f.pool.execute({ operation: 'reuse-prepared', job: preview, targetJob: { ...targetJob, documentId: 'foreign' } }), { code: 'MESH_ARTIFACT_REQUEST_INVALID' });
    const changed = structuredClone(targetJob); changed.source.bodies[0].topologyIdentity = 'f'.repeat(32);
    await assert.rejects(f.pool.execute({ operation: 'reuse-prepared', job: preview, targetJob: changed }), { code: 'MESH_SOURCE_MANIFEST_INVALID' });
    fs.appendFileSync(f.paths.brep, 'corruption');
    await assert.rejects(f.pool.execute({ operation: 'reuse-prepared', job: preview, targetJob }), { code: 'MESH_ARTIFACT_INVALID' });
    assert.equal(fs.existsSync(target.source), false); assert.equal(fs.existsSync(target.sourceManifest), false);
    assert.match(fs.readFileSync(f.paths.brep, 'utf8'), /corruption$/);
    assert.deepEqual(fs.readdirSync(target.task), []);
}));

test('linked sources and task directories are refused without touching their targets', async () => fixture(async f => {
    const hard = path.join(f.paths.task, 'source-link'); fs.linkSync(f.paths.source, hard);
    assert.throws(() => copyPreparationFile(f.paths.source, path.join(f.paths.task, 'linked.tmp')), { code: 'MESH_ARTIFACT_INVALID' });
    fs.unlinkSync(hard);
    const other = { ...f.job, jobId: 'mesh-' + crypto.randomUUID() }, directory = f.pool.store.directory(other);
    fs.symlinkSync(f.paths.task, directory, 'junction');
    assert.throws(() => preparationPaths(f.root, other), { code: 'MESH_PREPARATION_IO' });
    fs.unlinkSync(directory);
    assert.equal(fs.readFileSync(f.paths.source, 'utf8'), 'BREP source fixture');
    assert.throws(() => preparationPaths(f.root, { ...f.job, documentId: '../escape' }), { code: 'MESH_PREPARATION_IO' });
}));

test('a queued snapshot cancelled before a shared permit never starts or publishes files', async () => {
    const computeGate = new MeshComputeGate(), lease = await computeGate.acquire({ kind: 'quality' });
    try { await fixture(async f => {
        const pending = f.pool.execute({ operation: 'capture-prepared', job: f.job }), rejected = assert.rejects(pending, { code: 'MESH_ARTIFACT_CANCELLED' });
        await f.pool.cancelJob(f.job.jobId); await rejected;
        assert.equal(f.pool.metrics.workersStarted, 0);
        assert.equal(fs.existsSync(f.paths.brep), false);
        assert.equal(computeGate.status().active, 'quality');
    }, { computeGate }); } finally { lease.release(); computeGate.close(); }
});

test('staged snapshot files publish only after actual exit; cancellation and changed staging preserve prior files', async () => {
    const workers = [];
    await fixture(async f => {
        const request = f.pool.execute({ operation: 'capture-prepared', job: f.job }), worker = workers[0], staging = worker.settings.workerData.staging;
        const value = stagePreparationFiles({ dataDir: f.root, job: f.job, staging });
        worker.emit('message', { id: worker.settings.workerData.id, ok: true, value });
        assert.equal(fs.existsSync(f.paths.brep), false);
        const rejected = assert.rejects(request, { code: 'MESH_ARTIFACT_CANCELLED' }); let stopped = false;
        const cancel = f.pool.cancelJob(f.job.jobId).then(() => stopped = true);
        await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false); assert.equal(fs.existsSync(staging + '.brep'), true);
        worker.emit('exit', 1); await cancel; await rejected;
        assert.equal(fs.existsSync(f.paths.brep), false); assert.equal(fs.existsSync(staging + '.brep'), false);
        const again = f.pool.execute({ operation: 'capture-prepared', job: f.job }), next = workers[1], second = next.settings.workerData.staging;
        const proof = stagePreparationFiles({ dataDir: f.root, job: f.job, staging: second });
        next.emit('message', { id: next.settings.workerData.id, ok: true, value: proof }); fs.appendFileSync(second + '.manifest', 'changed');
        const invalid = assert.rejects(again, { code: 'MESH_ARTIFACT_INVALID' }); next.emit('exit', 0); await invalid;
        assert.equal(fs.existsSync(f.paths.brep), false); assert.equal(fs.existsSync(f.paths.manifest), false);
        assert.deepEqual(fs.readdirSync(f.paths.task), []);
    }, { workerFactory: (_url, settings) => { const worker = new EventEmitter(); Object.assign(worker, { settings, terminate: async () => 1 }); workers.push(worker); return worker; } });
});

test('cancelling an actual worker inside its copy loop waits for exit and removes only its own staged files',async()=>{
    const barrier=new SharedArrayBuffer(8),control=new Int32Array(barrier),workers=[];
    await fixture(async f=>{
        const original=Buffer.alloc(2*1024*1024,0x41);fs.writeFileSync(f.paths.source,original);
        const pending=f.pool.execute({operation:'capture-prepared',job:f.job}),rejected=assert.rejects(pending,{code:'MESH_ARTIFACT_CANCELLED'});
        const end=Date.now()+5000;while(Atomics.load(control,0)!==1){assert.ok(Date.now()<end,'actual copy did not reach the test barrier');await new Promise(resolve=>setImmediate(resolve));}
        const staging=f.pool.active.staging;
        assert.equal(fs.existsSync(staging+'.brep'),true);assert.equal(fs.existsSync(f.paths.brep),false);
        let exited=false;workers[0].once('exit',()=>exited=true);
        await f.pool.cancelJob(f.job.jobId);await rejected;
        assert.equal(exited,true);assert.equal(fs.existsSync(staging+'.brep'),false);assert.equal(fs.existsSync(f.paths.brep),false);
        assert.deepEqual(fs.readFileSync(f.paths.source),original);assert.deepEqual(fs.readdirSync(f.paths.task),[]);
    },{workerFactory:(url,settings)=>{const worker=new Worker(new URL('./fixtures/mesh-preparation-gated-thread.mjs',import.meta.url),{...settings,workerData:{...settings.workerData,moduleUrl:url.href,copyBarrier:barrier}});workers.push(worker);return worker;}});
});
