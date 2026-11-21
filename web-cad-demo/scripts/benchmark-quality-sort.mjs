import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runPagedQualityQuery } from '../gateway/mesh-quality-pages.mjs';
import { stopTestChild } from '../tests/helpers/stop-test-child.mjs';
import { admissionFixture } from '../tests/helpers/mesh-admission-fixture.mjs';
if (process.argv[2] === '--child') {
    const variant = process.argv[3], directory = process.argv[4], job = JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8'));
    assert.ok(['reference', 'external'].includes(variant));
    global.gc?.();
    const before = process.memoryUsage(), start = performance.now(), result = runPagedQualityQuery({ file: path.join(directory, 'quality.json'), job, input: { issue: 'all', offset: 100, limit: 20 }, staging: path.join(directory, 'quality-pages-' + crypto.randomUUID() + '.tmp'), referenceBuild: variant === 'reference' }), elapsedMs = performance.now() - start;
    const after = process.memoryUsage(), maxRSS = process.resourceUsage().maxRSS;
    global.gc?.();
    process.stdout.write(JSON.stringify({ variant, elapsedMs, maxRSS, before, after, afterGC: process.memoryUsage(), metrics: result.metrics, result: result.result }));
}
else {
    const root = path.resolve(import.meta.dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-quality-sort-bench-')), counts = (process.env.CAD_QUALITY_SORT_COUNTS || '100000,500000,1000000').split(',').map(Number), cases = [];
    assert.ok(counts.length <= 8 && counts.every(n => Number.isSafeInteger(n) && n >= 200 && n <= 1000000));
    const sample = async (variant, directory) => {
        const child = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=1024', import.meta.filename, '--child', variant, directory], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        try {
            return await new Promise((resolve, reject) => {
                let output = '', errors = '';
                const timer = setTimeout(() => reject(Error('Sort benchmark deadline')), 180000);
                child.on('error', error => { clearTimeout(timer); reject(error); });
                child.stdout.on('data', bytes => {
                    output += bytes;
                    if (Buffer.byteLength(output) > 65536)
                        reject(Error('Sort benchmark reply budget'));
                });
                child.stderr.on('data', bytes => errors = (errors + bytes).slice(-16384));
                child.once('exit', code => {
                    clearTimeout(timer);
                    if (code !== 0)
                        reject(Error(`Sort benchmark child ${code}: ${errors}`));
                    else
                        try {
                            resolve(JSON.parse(output));
                        }
                        catch (error) {
                            reject(error);
                        }
                });
            });
        }
        finally {
            await stopTestChild(child);
        }
    };
    try {
        for (const count of counts) {
            const directory = path.join(scratch, String(count));
            fs.mkdirSync(directory);
            const f = admissionFixture(), job = { jobId: 'mesh-' + crypto.randomUUID(), source: f.source }, hash = crypto.createHash('sha256'), file = path.join(directory, 'quality.json'), fd = fs.openSync(file, 'wx');
            let total = 0, parts = [], pending = 0;
            const write = text => { const bytes = Buffer.from(text); hash.update(bytes); total += bytes.length; fs.writeSync(fd, bytes); };
            try {
                write(JSON.stringify({ ...f.index, requestId: job.jobId, cells: undefined }).slice(0, -1) + ',"cells":[');
                for (let i = 0; i < count; i++) {
                    const text = (i ? ',' : '') + JSON.stringify({ ...f.index.cells[0], elementId: String(9007199254740993n + BigInt(i)), quality: (i % 1000) / 1000, minJacobian: i % 10000 === 0 ? -1 : 1 });
                    parts.push(text);
                    pending += text.length;
                    if (pending >= 1024 * 1024) {
                        write(parts.join(''));
                        parts = [];
                        pending = 0;
                    }
                }
                if (parts.length)
                    write(parts.join(''));
                write(']}');
            }
            finally {
                fs.closeSync(fd);
            }
            job.artifact = { quality: { bytes: total, sha256: hash.digest('hex') } };
            fs.writeFileSync(path.join(directory, 'job.json'), JSON.stringify(job));
            const samples = [];
            for (const variant of ['reference', 'external']) {
                const cache = path.join(directory, 'quality-pages');
                if (fs.existsSync(cache)) {
                    assert.equal(path.dirname(cache), path.resolve(directory));
                    assert.ok(path.resolve(directory).startsWith(scratch + path.sep));
                    assert.equal(fs.lstatSync(cache).isSymbolicLink(), false);
                    fs.rmSync(cache, { recursive: true, force: true });
                }
                samples.push(await sample(variant, directory));
            }
            assert.deepEqual(samples[0].result, samples[1].result);
            cases.push({ cells: count, quality: job.artifact.quality, samples });
            console.log(JSON.stringify({ cells: count, samples: samples.map(({ result, ...sample }) => ({ ...sample, resultCount: result.total })) }));
        }
        const sources = Object.fromEntries(['gateway/mesh-quality-pages.mjs', 'gateway/mesh-quality-page-builder.mjs', 'gateway/mesh-quality-sort.mjs', 'gateway/mesh-quality-stream.mjs', 'gateway/mesh-quality-query.mjs', 'shared/mesh-admission.mjs', 'scripts/benchmark-quality-sort.mjs', 'tests/helpers/mesh-admission-fixture.mjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
        const report = { node: process.version, environment: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length }, scope: 'Independent child per variant with 1024 MiB old-generation cap, Node-reported maxRSS and snapshots. Varied quality/interleaved sorting over repeated unit-tet numerical coordinates, not a physical CAD mesh or GPU/native memory certification. Parent generates the source without a full cell array. Cold derived caches; warm OS cache, reference first, non-exclusive CPU. Both variants synchronously construct and query one page to isolate algorithm/IO cost; online execution is in a worker.', sources, cases }, output = path.join(root, '.artifacts/performance/quality-sort.json');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(report, null, 2));
        console.log(output);
    }
    finally {
        assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
        assert.match(path.basename(scratch), /^cad-quality-sort-bench-/);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}
