import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { MeshJobStore } from '../gateway/mesh-job-store.mjs';
import { createArtifactFixture } from '../tests/helpers/mesh-artifact-fixture.mjs';
import { stopTestChild } from '../tests/helpers/stop-test-child.mjs';
if (process.argv[2] === '--child') {
    const variant = process.argv[3], store = new MeshJobStore(process.argv[4]), job = store.load()[0];
    assert.ok(['reference', 'streamed'].includes(variant));
    assert.ok(job);
    global.gc?.();
    const before = process.memoryUsage(), started = performance.now(), result = store.readResult(job, { streamQuality: variant === 'streamed' }), elapsedMs = performance.now() - started;
    assert.equal(result.mesh.admission.status, 'accepted');
    const after = process.memoryUsage(), maxRSS = process.resourceUsage().maxRSS;
    global.gc?.();
    process.stdout.write(JSON.stringify({ variant, elapsedMs, maxRSS, before, after, afterGC: process.memoryUsage(), admission: result.mesh.admission }));
}
else {
    const root = path.resolve(import.meta.dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-quality-stream-bench-')), counts = (process.env.CAD_QUALITY_STREAM_COUNTS || '100000,500000,1000000').split(',').map(Number), cases = [];
    assert.ok(counts.length <= 8 && counts.every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000));
    const sample = async (variant, data) => {
        const child = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=1024', import.meta.filename, '--child', variant, data], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        try {
            return await new Promise((resolve, reject) => {
                let output = '', errors = '';
                const timer = setTimeout(() => reject(Error('Quality stream benchmark deadline')), 180000);
                child.on('error', error => { clearTimeout(timer); reject(error); });
                child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 16384)
                    reject(Error('Benchmark reply budget')); });
                child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-16384); });
                child.once('exit', code => { clearTimeout(timer); if (code !== 0)
                    reject(Error(`Benchmark child ${code}: ${errors}`));
                else
                    try {
                        resolve(JSON.parse(output));
                    }
                    catch (error) {
                        reject(error);
                    } });
            });
        }
        finally {
            await stopTestChild(child);
        }
    };
    try {
        for (const count of counts) {
            const data = path.join(scratch, String(count)), f = createArtifactFixture(data, count), samples = [];
            for (const variant of ['reference', 'streamed'])
                samples.push(await sample(variant, data));
            assert.deepEqual(samples[0].admission, samples[1].admission);
            cases.push({ cells: count, qualityBytes: f.job.artifact.quality.bytes, qualitySha256: f.job.artifact.quality.sha256, samples });
            console.log(JSON.stringify(cases.at(-1)));
        }
        const sources = Object.fromEntries(['gateway/mesh-quality-stream.mjs', 'gateway/mesh-quality-query.mjs', 'gateway/mesh-job-store.mjs', 'gateway/mesh-admission.mjs', 'shared/mesh-admission.mjs', 'scripts/benchmark-quality-stream.mjs', 'tests/helpers/mesh-artifact-fixture.mjs', 'tests/helpers/mesh-admission-fixture.mjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
        const output = path.join(root, '.artifacts/performance/quality-stream.json');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify({ node: process.version, environment: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length }, scope: 'Isolated process per sample; 1024 MiB old-generation cap; Node-reported maxRSS and snapshots, not total CAD/GPU/native memory. Repeated numeric unit-tetra fixture, not a physical valid mesh. Fixture generation in parent is excluded. Warm OS caches; reference runs first; non-exclusive CPU. Both parsers run synchronously in the child to isolate parser cost; online work runs in a worker thread.', sources, cases }, null, 2));
        console.log(output);
    }
    finally {
        assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
        assert.match(path.basename(scratch), /^cad-quality-stream-bench-/);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}
