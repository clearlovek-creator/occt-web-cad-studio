import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { QualityExternalSort, QualityStageBudget, compareQualityRows } from '../gateway/mesh-quality-sort.mjs';
import { stageQualityPages } from '../gateway/mesh-quality-page-builder.mjs';
import { QUALITY_PAGE_LIMITS, runPagedQualityQuery, buildQualityPagesReference } from '../gateway/mesh-quality-pages.mjs';
import { queryMeshQuality } from '../gateway/mesh-quality-query.mjs';
import { MeshQualityQueryPool } from '../gateway/mesh-quality-pool.mjs';
import { meshCachePolicy, reserveMeshCache } from '../gateway/mesh-cache-capacity.mjs';
import { createArtifactFixture } from './helpers/mesh-artifact-fixture.mjs';
async function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-quality-sort-')), stage = path.join(root, 'stage');
    fs.mkdirSync(stage);
    try {
        await run({ root, stage });
    }
    finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-quality-sort-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
const rows = count => Array.from({ length: count }, (_, i) => ({ elementId: String(BigInt(count - i) + 9007199254740993n), quality: i % 13 === 0 ? null : (i % 17) / 17, invalid: i % 13 === 0, inverted: i % 19 === 0, degenerate: i % 23 === 0, bodyIds: ['body-1'], corners: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }));
test('multi-pass bounded merge preserves total quality order and removes every derived run', async () => fixture(async (f) => {
    const budget = new QualityStageBudget(f.stage, 2 * 1024 * 1024), sort = new QualityExternalSort(budget, { runRecords: 7, runBytes: 1024, fanIn: 3 }), input = rows(401), actual = [];
    for (const row of input)
        sort.add(row);
    const metrics = sort.finish(row => actual.push(row));
    assert.deepEqual(actual, input.toSorted(compareQualityRows));
    assert.ok(metrics.initialRuns > 9);
    assert.ok(metrics.mergePasses >= 3);
    assert.ok(metrics.maxOpenRuns <= 3);
    assert.ok(metrics.maxBatchRecords <= 7);
    assert.ok(metrics.maxBatchBytes <= 1024);
    assert.equal(budget.used, 0);
    assert.ok(budget.peak <= budget.maxBytes);
    assert.deepEqual(fs.readdirSync(f.stage), []);
}));
test('empty sorting and exactly equal numeric quality retain canonical large IDs without numeric coercion', async () => fixture(async (f) => {
    const empty = new QualityExternalSort(new QualityStageBudget(f.stage, 1024));
    assert.equal(empty.finish(() => assert.fail('empty sort emitted a row')).initialRuns, 0);
    const sort = new QualityExternalSort(new QualityStageBudget(f.stage, 8192), { runRecords: 1, runBytes: 1024, fanIn: 2 }), actual = [];
    for (const elementId of ['9007199254740993', '3', '100000000000000000000000000000000', '12'])
        sort.add({ elementId, quality: .5, invalid: false, inverted: false, degenerate: false });
    sort.finish(row => actual.push(row.elementId));
    assert.deepEqual(actual, ['3', '12', '9007199254740993', '100000000000000000000000000000000']);
}));
test('a changed same-length run and a linked run fail without modifying authoritative files', async () => fixture(async (f) => {
    const original = path.join(f.root, 'original.msh');
    fs.writeFileSync(original, 'must stay');
    for (const linked of [false, true]) {
        const sort = new QualityExternalSort(new QualityStageBudget(f.stage, 65536), { runRecords: 2, runBytes: 1024, fanIn: 2 });
        for (const row of rows(9))
            sort.add(row);
        sort.flush();
        const file = path.join(f.stage, sort.runs[0].name);
        if (linked)
            fs.linkSync(file, path.join(f.root, 'shared-run'));
        else {
            const bytes = fs.readFileSync(file);
            bytes[bytes.indexOf('quality')] = 88;
            fs.writeFileSync(file, bytes);
        }
        assert.throws(() => sort.finish(() => { }), { code: 'MESH_QUALITY_CACHE_INVALID' });
        assert.equal(fs.readFileSync(original, 'utf8'), 'must stay');
        if (linked)
            fs.unlinkSync(path.join(f.root, 'shared-run'));
        for (const leaf of fs.readdirSync(f.stage))
            fs.unlinkSync(path.join(f.stage, leaf));
    }
}));
test('run workspace capacity and write failures are cache errors, never original-artifact corruption', async (t) => fixture(async (f) => {
    const sort = new QualityExternalSort(new QualityStageBudget(f.stage, 512), { runRecords: 2, runBytes: 1024, fanIn: 2 });
    assert.throws(() => {
        for (const row of rows(20))
            sort.add(row);
        sort.finish(() => { });
    }, { code: 'MESH_QUALITY_QUERY_LIMIT' });
    for (const leaf of fs.readdirSync(f.stage))
        fs.unlinkSync(path.join(f.stage, leaf));
    const failed = new QualityExternalSort(new QualityStageBudget(f.stage, 65536), { runRecords: 2, runBytes: 1024, fanIn: 2 });
    t.mock.method(fs, 'writeSync', () => { throw Object.assign(Error('fixture disk full'), { code: 'ENOSPC' }); });
    try {
        assert.throws(() => {
            for (const row of rows(3))
                failed.add(row);
            failed.finish(() => { });
        }, { code: 'MESH_QUALITY_QUERY_IO' });
    }
    finally {
        t.mock.restoreAll();
    }
    for (const leaf of fs.readdirSync(f.stage))
        fs.unlinkSync(path.join(f.stage, leaf));
    const saved = createArtifactFixture(f.root, 100), file = saved.store.qualityOutput(saved.job), before = fs.readFileSync(file), open = fs.openSync, close = fs.closeSync;
    let runFd, unclosed;
    t.mock.method(fs, 'openSync', (name, ...args) => { const fd = open(name, ...args); if (/sort-\d+\.run$/.test(String(name)) && args[0] === 'wx')
        runFd = fd; return fd; });
    t.mock.method(fs, 'closeSync', fd => { if (fd === runFd && unclosed === undefined) {
        unclosed = fd;
        throw Object.assign(Error('fixture close IO failure'), { code: 'EIO' });
    } return close(fd); });
    try {
        assert.throws(() => stageQualityPages({ file, job: saved.job, staging: f.stage, limits: QUALITY_PAGE_LIMITS, buildLimit: 65536, sortLimits: { runRecords: 1, runBytes: 1024, fanIn: 2 } }), { code: 'MESH_QUALITY_QUERY_IO' });
    }
    finally {
        t.mock.restoreAll();
        if (unclosed !== undefined)
            close(unclosed);
    }
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(path.join(f.stage, 'manifest.json')), false);
}));
test('streamed page construction matches the frozen in-memory builder and bounds all Body buffers', async () => fixture(async (f) => {
    const saved = createArtifactFixture(f.root, 4000), file = saved.store.qualityOutput(saved.job), index = JSON.parse(fs.readFileSync(file));
    saved.job.source.bodies = Array.from({ length: 40 }, (_, i) => ({ ...saved.job.source.bodies[0], bodyId: 'owner-' + i }));
    for (const [i, cell] of index.cells.entries()) {
        cell.bodyIds = ['owner-' + i % 40, 'owner-' + (i + 1) % 40];
        cell.quality = (i % 101) / 100;
        cell.minJacobian = i % 41 === 0 ? -1 : 1;
    }
    fs.writeFileSync(file, JSON.stringify(index));
    const bytes = fs.readFileSync(file);
    saved.job.artifact.quality = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const prepared = stageQualityPages({ file, job: saved.job, staging: f.stage, limits: QUALITY_PAGE_LIMITS, buildLimit: 16 * 1024 * 1024, sortLimits: { runRecords: 31, runBytes: 16384, fanIn: 3 }, pageBufferBytes: QUALITY_PAGE_LIMITS.pageBytes });
    assert.ok(prepared.metrics.sort.mergePasses > 1);
    assert.ok(prepared.metrics.sort.maxOpenRuns <= 3);
    assert.ok(prepared.metrics.sort.maxPageBufferBytes <= QUALITY_PAGE_LIMITS.pageBytes);
    assert.equal(fs.readdirSync(f.stage).some(name => name.endsWith('.run')), false);
    const target = path.join(path.dirname(file), 'quality-pages');
    fs.renameSync(f.stage, target);
    saved.job.artifact.qualityQuery = prepared.proof;
    for (const bodyId of ['', 'owner-0', 'owner-39'])
        for (const issue of ['all', 'bad', 'inverted', 'invalid', 'degenerate']) {
            const input = { bodyId, issue, threshold: .41, offset: 3, limit: 9 }, actual = runPagedQualityQuery({ file, job: saved.job, input, staging: path.join(path.dirname(file), 'quality-pages-' + crypto.randomUUID() + '.tmp') }).result;
            assert.deepEqual(actual, queryMeshQuality(index, saved.job, input));
        }
    const ref = buildQualityPagesReference(file, saved.job, path.join(path.dirname(file), 'quality-pages-' + crypto.randomUUID() + '.tmp'));
    assert.deepEqual(prepared.manifest.groups.map(g => [g.bodyId, g.summary]), ref.manifest.groups.map(g => [g.bodyId, g.summary]));
    assert.deepEqual(fs.readFileSync(file), bytes);
}));
test('late source corruption and sort-budget errors never publish a complete cache or change the source', async () => fixture(async (f) => {
    const saved = createArtifactFixture(f.root, 100), file = saved.store.qualityOutput(saved.job), bytes = fs.readFileSync(file);
    assert.throws(() => stageQualityPages({ file, job: saved.job, staging: f.stage, limits: QUALITY_PAGE_LIMITS, buildLimit: 512, sortLimits: { runRecords: 1, runBytes: 1024, fanIn: 2 } }), { code: 'MESH_QUALITY_QUERY_LIMIT' });
    assert.equal(fs.existsSync(path.join(f.stage, 'manifest.json')), false);
    assert.deepEqual(fs.readFileSync(file), bytes);
    for (const leaf of fs.readdirSync(f.stage))
        fs.unlinkSync(path.join(f.stage, leaf));
    const bad = JSON.parse(bytes);
    bad.cells.at(-1).corners = [0, 1, 2, 99];
    fs.writeFileSync(file, JSON.stringify(bad));
    const changed = fs.readFileSync(file);
    saved.job.artifact.quality = { bytes: changed.length, sha256: crypto.createHash('sha256').update(changed).digest('hex') };
    assert.throws(() => stageQualityPages({ file, job: saved.job, staging: f.stage, limits: QUALITY_PAGE_LIMITS, buildLimit: 1024 * 1024, sortLimits: { runRecords: 1, runBytes: 1024, fanIn: 2 } }), { code: 'MESH_ARTIFACT_INVALID' });
    assert.equal(fs.existsSync(path.join(f.stage, 'manifest.json')), false);
    assert.deepEqual(fs.readFileSync(file), changed);
}));
test('only canonical sort files inside owned UUID temporaries are disposable cache data', async () => fixture(async (f) => {
    const saved = createArtifactFixture(f.root, 1), policy = meshCachePolicy(f.root, { maxBytes: 128 * 1024, maxJobBytes: 64 * 1024 }), directory = saved.store.directory(saved.job);
    const temp = path.join(directory, 'quality-pages-' + crypto.randomUUID() + '.tmp');
    fs.mkdirSync(temp);
    fs.writeFileSync(path.join(temp, 'sort-0.run'), Buffer.alloc(70000));
    const report = reserveMeshCache(policy, saved.store.qualityOutput(saved.job));
    assert.equal(report.evicted, 1);
    assert.equal(fs.existsSync(temp), false);
    const cache = path.join(directory, 'quality-pages');
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(cache, 'sort-0.run'), Buffer.alloc(70000));
    assert.throws(() => reserveMeshCache(policy, saved.store.qualityOutput(saved.job)), { code: 'MESH_QUALITY_CACHE_CAPACITY' });
    assert.equal(fs.existsSync(path.join(cache, 'sort-0.run')), true);
}));
test('a certified pre-external-sort cache stays reusable without forcing a rebuild', async () => fixture(async (f) => {
    const saved = createArtifactFixture(f.root, 300), file = saved.store.qualityOutput(saved.job), staging = () => path.join(path.dirname(file), 'quality-pages-' + crypto.randomUUID() + '.tmp'), input = { issue: 'all', offset: 10, limit: 7 };
    const reference = runPagedQualityQuery({ file, job: saved.job, input, staging: staging(), referenceBuild: true });
    assert.equal(reference.metrics.built, true);
    assert.equal(reference.proof.version, 1);
    saved.job.artifact.qualityQuery = reference.proof;
    const actual = runPagedQualityQuery({ file, job: saved.job, input, staging: staging() });
    assert.deepEqual(actual.result, reference.result);
    assert.equal(actual.metrics.built, false);
    assert.equal(actual.metrics.parsedSourceBytes, 0);
}));
test('actual run-writing and merge cancellation wait for exit, keep the old cache and remove private runs', async () => {
    for (const merging of [false, true])
        await fixture(async (f) => {
            const saved = createArtifactFixture(f.root, 100), file = saved.store.qualityOutput(saved.job), initial = new MeshQualityQueryPool();
            try {
                await initial.query({ file, job: saved.job, input: { issue: 'all', limit: 1 }, onPrepared: proof => saved.job.artifact.qualityQuery = proof });
                assert.equal(initial.status().lastBuild.mode, 'external-sort-v1');
            }
            finally {
                await initial.close();
            }
            const cache = path.join(path.dirname(file), 'quality-pages'), before = fs.readdirSync(cache).map(name => [name, fs.readFileSync(path.join(cache, name))]), original = fs.readFileSync(file), barrier = new SharedArrayBuffer(8), control = new Int32Array(barrier), workers = [];
            saved.job.artifact.qualityQuery.manifest.sha256 = '0'.repeat(64);
            const pool = new MeshQualityQueryPool({ workerFactory: (url, settings) => { const worker = new Worker(new URL('./fixtures/quality-sort-gated-thread.mjs', import.meta.url), { ...settings, workerData: { ...settings.workerData, moduleUrl: url.href, sortBarrier: barrier, merging } }); workers.push(worker); return worker; } });
            try {
                const pending = pool.query({ file, job: saved.job, input: { issue: 'all' } }), rejected = assert.rejects(pending, { code: 'MESH_QUALITY_QUERY_CANCELLED' }), end = Date.now() + 5000;
                while (Atomics.load(control, 0) !== 1) {
                    assert.ok(Date.now() < end, 'sort did not enter its real write barrier');
                    await new Promise(resolve => setImmediate(resolve));
                }
                const staging = pool.active.staging;
                assert.equal(fs.readdirSync(staging).some(name => name.endsWith('.run')), true);
                let exited = false;
                workers[0].once('exit', () => exited = true);
                await pool.cancelJob(saved.job.jobId);
                await rejected;
                assert.equal(exited, true);
                assert.equal(fs.existsSync(staging), false);
                assert.deepEqual(fs.readdirSync(cache).map(name => [name, fs.readFileSync(path.join(cache, name))]), before);
                assert.deepEqual(fs.readFileSync(file), original);
            }
            finally {
                await pool.close();
            }
        });
});
