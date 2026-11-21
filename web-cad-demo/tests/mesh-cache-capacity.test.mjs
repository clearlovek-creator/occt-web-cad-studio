import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MeshQualityQueryPool } from '../gateway/mesh-quality-pool.mjs';
import { MeshComputeGate } from '../gateway/mesh-compute-gate.mjs';
import { meshCachePolicy, reserveMeshCache, touchMeshCache } from '../gateway/mesh-cache-capacity.mjs';
import { createArtifactFixture } from './helpers/mesh-artifact-fixture.mjs';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-cache-capacity-')), gate = new MeshComputeGate(), policy = meshCachePolicy(root, { maxBytes: 200 * 1024, maxJobBytes: 100 * 1024 }), pool = new MeshQualityQueryPool({ computeGate: gate, cachePolicy: policy }), jobs = Array.from({ length: 4 }, () => createArtifactFixture(root, 100));
    const sourceHashes = jobs.map(f => [f.store.output(f.job), f.store.qualityOutput(f.job)].map(file => [file, hash(file)]));
    const query = f => pool.query({ file: f.store.qualityOutput(f.job), job: f.job, input: { issue: 'all', limit: 2 }, onPrepared: proof => { f.job.artifact.qualityQuery = proof; f.store.save(f.job); } }), cache = f => path.join(f.store.directory(f.job), 'quality-pages');
    try {
        await run({ root, gate, policy, pool, jobs, query, cache });
        for (const rows of sourceHashes)
            for (const [file, digest] of rows)
                assert.equal(hash(file), digest, 'Authoritative artifacts must never be evicted or changed');
    }
    finally {
        await pool.close();
        gate.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-cache-capacity-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
test('bounded cross-job cache eviction is LRU, preserves original files and transparently rebuilds evicted queries', async () => fixture(async (f) => {
    for (const job of f.jobs)
        assert.equal((await f.query(job)).total, 100);
    assert.ok(f.pool.status().cacheCapacity.usedBytes <= f.policy.maxBytes);
    const missing = f.jobs.find(job => !fs.existsSync(f.cache(job)));
    assert.ok(missing, 'A tight reserve must evict at least one older cache');
    const builds = f.pool.metrics.builds;
    assert.equal((await f.query(missing)).total, 100);
    assert.equal(f.pool.metrics.builds, builds + 1);
    assert.ok(fs.existsSync(f.cache(missing)));
    assert.ok(f.pool.status().cacheCapacity.usedBytes <= f.policy.maxBytes);
}));
test('cache touch affects LRU ordering without changing content proofs or making the current cache evictable', async () => fixture(async (f) => {
    const roomy = meshCachePolicy(f.root, { maxBytes: 512 * 1024, maxJobBytes: 100 * 1024 });
    f.pool.cachePolicy = roomy;
    for (const job of f.jobs.slice(0, 3))
        await f.query(job);
    const existing = f.jobs.slice(0, 3).filter(job => fs.existsSync(f.cache(job)));
    assert.equal(existing.length, 3);
    const current = existing[2], recent = existing[0];
    for (const [i, job] of existing.entries())
        fs.utimesSync(path.join(f.cache(job), 'manifest.json'), new Date(1000 + i), new Date(1000 + i));
    touchMeshCache(recent.store.qualityOutput(recent.job));
    const total = reserveMeshCache(roomy, current.store.qualityOutput(current.job)).usedBytes, lower = meshCachePolicy(f.root, { maxBytes: Math.max(200 * 1024, total + 1), maxJobBytes: 100 * 1024 });
    reserveMeshCache(lower, current.store.qualityOutput(current.job), lower.maxBytes - total + 1);
    assert.ok(fs.existsSync(f.cache(recent)));
    assert.ok(fs.existsSync(f.cache(current)));
    assert.equal(fs.existsSync(f.cache(existing[1])), false);
}));
test('a known cache exceeding a lowered per-job limit is discarded and rebuilt without altering its source', async () => fixture(async (f) => {
    const job = f.jobs[0];
    await f.query(job);
    fs.writeFileSync(path.join(f.cache(job), 'page-999.json'), Buffer.alloc(110 * 1024));
    const result = await f.query(job);
    assert.equal(result.total, 100);
    assert.equal(fs.existsSync(path.join(f.cache(job), 'page-999.json')), false);
    assert.ok(f.pool.status().cacheCapacity.usedBytes <= f.policy.maxJobBytes);
}));
test('unknown cache contents are retained and cannot be removed by quota enforcement or a corrupt-cache rebuild', async () => fixture(async (f) => {
    const job = f.jobs[0];
    await f.query(job);
    const notes = path.join(f.cache(job), 'notes.txt');
    fs.writeFileSync(notes, 'user content must remain');
    const manifest = JSON.parse(fs.readFileSync(path.join(f.cache(job), 'manifest.json'))), page = path.join(f.cache(job), manifest.groups[0].pages[0].file), bytes = fs.readFileSync(page);
    bytes[10] ^= 1;
    fs.writeFileSync(page, bytes);
    await assert.rejects(f.query(job), { code: 'MESH_QUALITY_CACHE_CAPACITY' });
    assert.equal(fs.readFileSync(notes, 'utf8'), 'user content must remain');
    assert.deepEqual(fs.readFileSync(page), bytes);
    assert.equal(job.job.state, 'complete');
}));
test('cache scan budgets and directory/hard links stop cleanup without touching their targets', async () => fixture(async (f) => {
    await f.query(f.jobs[0]);
    const source = f.jobs[0].store.qualityOutput(f.jobs[0].job), manifest = path.join(f.cache(f.jobs[0]), 'manifest.json'), before = hash(manifest);
    for (const override of [{ maxJobs: 1 }, { maxFiles: 1 }, { scanBytes: 1 }])
        assert.throws(() => reserveMeshCache(meshCachePolicy(f.root, { ...f.policy, ...override }), source, 100), { code: 'MESH_QUALITY_CACHE_CAPACITY' });
    assert.equal(hash(manifest), before);
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const link = path.join(f.cache(f.jobs[0]), 'redirect');
    fs.symlinkSync(outside, link, 'junction');
    assert.throws(() => reserveMeshCache(f.policy, source), { code: 'MESH_QUALITY_CACHE_CAPACITY' });
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
    fs.unlinkSync(link);
    fs.linkSync(source, path.join(f.cache(f.jobs[0]), 'page-999.json'));
    assert.throws(() => reserveMeshCache(f.policy, source), { code: 'MESH_QUALITY_CACHE_CAPACITY' });
}));
