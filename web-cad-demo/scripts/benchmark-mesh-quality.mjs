/* Algorithm/IO pressure fixture, not physical meshing or industrial CAD proof. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { validateQualityIndex, queryMeshQuality } from '../gateway/mesh-quality-query.mjs';
const root = path.resolve(import.meta.dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-quality-bench-'));
const counts = (process.env.CAD_QUALITY_COUNTS || '10000,100000,500000').split(',').map(Number), variant = process.env.CAD_QUALITY_VARIANT || 'baseline';
assert.match(variant, /^[a-z0-9-]{1,40}$/);
assert.ok(counts.every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000));
const cases = [];
let engine;
try {
    if (variant !== 'baseline') {
        const { MeshQualityQueryPool } = await import('../gateway/mesh-quality-pool.mjs');
        engine = new MeshQualityQueryPool();
    }
    for (const count of counts) {
        const directory = path.join(scratch, String(count));
        fs.mkdirSync(directory);
        const filename = path.join(directory, 'quality.json'), job = { jobId: 'mesh-' + crypto.randomUUID(), source: { bodies: [{ bodyId: 'body-1', bodyIdentity: 'a'.repeat(32), topologyIdentity: 'b'.repeat(32) }] } };
        let fixture = { version: 1, requestId: job.jobId, qualityName: 'minSICN', threshold: .2, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], cells: Array.from({ length: count }, (_, i) => ({ elementId: String(9007199254740993n + BigInt(i)), elementType: 4, order: 1, volumeTag: 1, quality: (i % 1000) / 1000, minJacobian: i % 10000 === 0 ? -1 : 1, maxJacobian: 1, corners: [0, 1, 2, 3], bodyIds: ['body-1'] })) };
        fs.writeFileSync(filename, JSON.stringify(fixture));
        fixture = null;
        job.artifact = { quality: { bytes: fs.statSync(filename).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') } };
        const samples = [];
        for (let i = 0; i < 4; i++) {
            let largestGap = 0, last = performance.now();
            const timer = setInterval(() => { const now = performance.now(); largestGap = Math.max(largestGap, now - last); last = now; }, 5);
            await new Promise(resolve => setTimeout(resolve, 10));
            const start = performance.now(), input = { issue: 'all', offset: i * 100, limit: 10, threshold: .2 };
            let result;
            if (engine)
                result = await engine.query({ job, file: filename, input, onPrepared: proof => { job.artifact.qualityQuery = proof; } });
            else {
                const bytes = fs.readFileSync(filename);
                assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), job.artifact.quality.sha256);
                const index = validateQualityIndex(JSON.parse(bytes), job);
                result = queryMeshQuality(index, job, input);
            }
            const queryMs = performance.now() - start;
            await new Promise(resolve => setTimeout(resolve, 10));
            clearInterval(timer);
            assert.equal(result.total, count);
            assert.equal(result.cells.length, 10);
            assert.equal(result.quality.tetraCount, count);
            samples.push({ queryMs, maxMainThreadTimerGapMs: largestGap, heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, ...(engine ? { queryEngine: { ...engine.metrics } } : {}) });
        }
        cases.push({ cells: count, sourceBytes: job.artifact.quality.bytes, samples });
        console.log(JSON.stringify(cases.at(-1)));
    }
    const sources = Object.fromEntries(['gateway/mesh-quality-query.mjs', 'gateway/mesh-quality-pages.mjs', 'gateway/mesh-quality-pool.mjs', 'gateway/mesh-quality-thread.mjs', 'scripts/benchmark-mesh-quality.mjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
    const report = { format: 'web-cad-mesh-quality-benchmark', version: 1, variant, node: process.version, createdAt: new Date().toISOString(), environment: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, platform: process.platform }, sources, scope: 'synthetic numeric/IO pressure with repeated unit-tet corner coordinates; exact cell IDs beyond JS safe integer; main heap and process RSS snapshots, not peak total memory; OS caches not cleared and no exclusive CPU reservation; not physical mesh generation, non-overlap proof or CAD scalability certification', cases };
    const output = path.join(root, '.artifacts/performance', `mesh-quality-${variant}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, output }));
}
finally {
    await engine?.close();
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(scratch, { recursive: true, force: true });
}
