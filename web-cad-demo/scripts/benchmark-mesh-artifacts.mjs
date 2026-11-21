import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MeshArtifactPool } from '../gateway/mesh-artifact-pool.mjs';
import { createArtifactFixture } from '../tests/helpers/mesh-artifact-fixture.mjs';
const root = path.resolve(import.meta.dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-artifact-bench-')), variant = process.env.CAD_ARTIFACT_VARIANT || 'threaded', counts = (process.env.CAD_ARTIFACT_COUNTS || '10000,100000,500000,1000000').split(',').map(Number), cases = [];
const reportKind=process.env.CAD_ARTIFACT_REPORT_KIND||'connectivity';
const sourceFiles=['gateway/mesh-job-store.mjs','gateway/mesh-quality-stream.mjs','gateway/mesh-quality-query.mjs','shared/mesh-admission.mjs','gateway/mesh-artifact-pool.mjs','gateway/mesh-artifact-thread.mjs','gateway/mesh-admission.mjs','gateway/mesh-connectivity.mjs','gateway/mesh-spatial.mjs','scripts/benchmark-mesh-artifacts.mjs','tests/helpers/mesh-artifact-fixture.mjs','tests/helpers/tetra-strip.mjs'];
const sourceSnapshot=()=>Object.fromEntries(sourceFiles.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
const beforeSources=sourceSnapshot();
assert.ok(['baseline', 'threaded'].includes(variant));
assert.ok(['connectivity','spatial','spatial-pair'].includes(reportKind));
assert.ok(counts.every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000));
let pool;
try {
    for (const count of counts) {
        const data = path.join(scratch, String(count)), { store, job, result } = createArtifactFixture(data, count);
        pool = new MeshArtifactPool({ dataDir: data });
        const samples = [];
        for (const operation of ['read', 'seal']) {
            let gap = 0, last = performance.now();
            const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 5);
            await new Promise(resolve => setTimeout(resolve, 10));
            const start = performance.now();
            let response,elapsedMs;
            try {
                response = variant === 'baseline' ? (operation === 'read' ? store.readResult(job,{streamQuality:false}) : { artifact: store.writeResult(job, result,{streamQuality:false}), result }) : await pool.execute({ operation, job, result });
            }
            finally {
                elapsedMs=performance.now()-start;
                await new Promise(resolve => setTimeout(resolve, 10));
                clearInterval(timer);
            }
            assert.equal((operation === 'read' ? response : response.result).mesh.admission.status, 'accepted');
            samples.push({ operation, elapsedMs, maxMainThreadTimerGapMs: gap, rssSnapshot: process.memoryUsage().rss, heapUsedSnapshot: process.memoryUsage().heapUsed });
            if (operation === 'seal')
                job.artifact = response.artifact;
        }
        if (variant === 'threaded') {
            const before = pool.metrics.workersStarted;
            await Promise.all([pool.execute({ operation: 'read', job }), pool.execute({ operation: 'read', job })]);
            assert.equal(pool.metrics.workersStarted, before + 1);
        }
        cases.push({ cells: count, qualityBytes: job.artifact.quality.bytes, replyBytes: job.artifact.result.bytes, samples, metrics: pool.status().metrics });
        console.log(JSON.stringify(cases.at(-1)));
        await pool.close();
        pool = null;
    }
    const sources=sourceSnapshot(),output = path.join(root, '.artifacts/performance', `mesh-artifacts-${reportKind}-${variant}.json`);
    assert.deepEqual(sources,beforeSources,'Benchmark inputs changed during execution; do not certify mixed-source performance evidence');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ variant, fixture:'tetra-strip-connectivity-v1', node: process.version, environment: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length }, scope: 'conforming tetra-strip numeric/connectivity/linear-spatial/IO admission and seal pressure with synthetic quality, CAD inventory and MSH payload; not CAD mesher throughput, arbitrary curved overlap proof or peak RSS; OS caches not cleared; CPU not exclusive', sources, cases }, null, 2));
    console.log(output);
}
finally {
    await pool?.close();
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    assert.match(path.basename(scratch), /^cad-artifact-bench-/);
    fs.rmSync(scratch, { recursive: true, force: true });
}
