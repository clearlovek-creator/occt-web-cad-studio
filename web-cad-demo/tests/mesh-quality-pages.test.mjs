import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MeshQualityQueryPool } from '../gateway/mesh-quality-pool.mjs';
import { qualityPagesPath } from '../gateway/mesh-quality-pages.mjs';
import { queryMeshQuality, validateQualityIndex } from '../gateway/mesh-quality-query.mjs';
function fixture(count = 2700) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-quality-pages-')), file = path.join(root, 'quality.json'), job = { jobId: 'mesh-' + crypto.randomUUID(), source: { bodies: ['one', 'two', 'empty'].map((bodyId, i) => ({ bodyId, bodyIdentity: String(i + 1).repeat(32), topologyIdentity: String(i + 4).repeat(32) })) } };
    const index = { version: 1, requestId: job.jobId, qualityName: 'minSICN', threshold: .2, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], cells: Array.from({ length: count }, (_, i) => ({ elementId: String(9007199254740993n + BigInt(i)), elementType: 4, order: i % 23 === 0 ? 2 : 1, volumeTag: 1, quality: i % 101 === 0 ? null : (i % 100) / 100, minJacobian: i % 31 === 0 ? -1 : i % 41 === 0 ? 0 : 1, maxJacobian: 1, corners: [0, 1, 2, 3], bodyIds: i % 3 === 0 ? ['one', 'two'] : ['one'] })) };
    validateQualityIndex(index, job);
    fs.writeFileSync(file, JSON.stringify(index));
    job.artifact = { quality: { bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } };
    const pool = new MeshQualityQueryPool(), query = input => pool.query({ file, job, input, onPrepared: proof => job.artifact.qualityQuery = proof });
    const close = async () => { await pool.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); };
    return { root, file, job, index, pool, query, close };
}
test('paged queries exactly match reference statistics, rank ordering, shared owners, large IDs, empty Bodies and thresholds', async () => {
    const f = fixture();
    try {
        for (const bodyId of ['', 'two', 'empty'])
            for (const issue of ['all', 'bad', 'inverted', 'invalid', 'degenerate'])
                for (const threshold of [0, .2, 1]) {
                    const input = { bodyId, issue, threshold, offset: 3, limit: 7 }, actual = await f.query(input), expected = queryMeshQuality(f.index, f.job, input);
                    assert.deepEqual(actual, expected, JSON.stringify(input));
                }
        assert.equal(f.pool.metrics.builds, 1);
        assert.equal(f.pool.metrics.parsedSourceBytes, f.job.artifact.quality.bytes);
    }
    finally {
        await f.close();
    }
});
test('an older uncompensated statistics cache is rebuilt from unchanged source data, not reused or marked corrupt',async()=>{
    const f=fixture(12000);try{for(const cell of f.index.cells){cell.quality=.8;cell.minJacobian=1;cell.maxJacobian=1;}
      const original=Buffer.from(JSON.stringify(f.index));fs.writeFileSync(f.file,original);f.job.artifact.quality={bytes:original.length,sha256:crypto.createHash('sha256').update(original).digest('hex')};assert.equal((await f.query({issue:'all',limit:1})).quality.averageQuality,.8);
      const file=path.join(qualityPagesPath(f.file),'manifest.json'),manifest=JSON.parse(fs.readFileSync(file));delete manifest.summation;for(const group of manifest.groups)delete group.summary.compensation;const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(file,bytes);f.job.artifact.qualityQuery.manifest={bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};assert.equal((await f.query({issue:'all',limit:1})).quality.averageQuality,.8);assert.equal(f.pool.metrics.builds,2);assert.deepEqual(fs.readFileSync(f.file),original);
    }finally{await f.close();}
});

test('repeat pages and process reconstruction reuse sealed blocks without parsing or sorting the original JSON again', async () => {
    const f = fixture(12000);
    try {
        const before = fs.readFileSync(f.file);
        await f.query({ issue: 'all', limit: 10 });
        const parsed = f.pool.metrics.parsedSourceBytes;
        await f.query({ issue: 'all', offset: 4000, limit: 10 });
        assert.equal(f.pool.metrics.parsedSourceBytes, parsed);
        assert.ok(f.pool.metrics.pageBytesRead < f.job.artifact.quality.bytes);
        const restored = new MeshQualityQueryPool();
        try {
            assert.deepEqual(await restored.query({ file: f.file, job: f.job, input: { issue: 'all', offset: 100, limit: 10 } }), queryMeshQuality(f.index, f.job, { issue: 'all', offset: 100, limit: 10 }));
            assert.equal(restored.metrics.builds, 0);
            assert.equal(restored.metrics.parsedSourceBytes, 0);
        }
        finally {
            await restored.close();
        }
        assert.deepEqual(fs.readFileSync(f.file), before);
    }
    finally {
        await f.close();
    }
});

test('first-page building uses the same strict UTF-8 and leading-BOM policy as full admission',async()=>{
    const f=fixture(10);try{
      const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify({...f.index,note:'中文'}))]);fs.writeFileSync(f.file,bytes);f.job.artifact.quality={bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
      assert.deepEqual(await f.query({issue:'all'}),queryMeshQuality(f.index,f.job,{issue:'all'}));
      const damaged=Buffer.from(bytes);damaged[damaged.indexOf(Buffer.from('中文'))]=0xff;fs.writeFileSync(f.file,damaged);f.job.artifact.quality={bytes:damaged.length,sha256:crypto.createHash('sha256').update(damaged).digest('hex')};delete f.job.artifact.qualityQuery;
      await assert.rejects(f.query({issue:'all'}),{code:'MESH_ARTIFACT_INVALID'});assert.deepEqual(fs.readFileSync(f.file),damaged);
    }finally{await f.close();}
});
test('a damaged selected block is rebuilt from checked original data, while same-size source corruption fails closed', async () => {
    const f = fixture();
    try {
        const first = await f.query({ issue: 'all' }), directory = qualityPagesPath(f.file), manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'))), block = path.join(directory, manifest.groups[0].pages[0].file), bytes = fs.readFileSync(block);
        bytes[10] ^= 1;
        fs.writeFileSync(block, bytes);
        assert.deepEqual(await f.query({ issue: 'all' }), first);
        assert.equal(f.pool.metrics.builds, 2);
        const original = fs.readFileSync(f.file), changed = Buffer.from(original), stat = fs.statSync(f.file);
        changed[30] ^= 1;
        fs.writeFileSync(f.file, changed);
        fs.utimesSync(f.file, stat.atime, stat.mtime);
        await assert.rejects(f.query({ issue: 'all' }), { code: 'MESH_ARTIFACT_INVALID' });
        assert.deepEqual(fs.readFileSync(f.file), changed, 'A read-only query must not repair original bytes');
        fs.writeFileSync(f.file, original);
        assert.deepEqual(await f.query({ issue: 'all' }), first);
    }
    finally {
        await f.close();
    }
});
test('cache provenance binds every Body identity and never borrows another job or revision', async () => {
    const f = fixture();
    try {
        await f.query({});
        f.job.source.bodies[0].topologyIdentity = 'f'.repeat(32);
        const result = await f.query({});
        assert.equal(f.pool.metrics.builds, 2);
        assert.equal(result.cells[0].bodyIdentities.one.topologyIdentity, 'f'.repeat(32));
        const foreign = { ...f.job, jobId: 'mesh-' + crypto.randomUUID() };
        await assert.rejects(f.pool.query({ file: f.file, job: foreign }), { code: 'MESH_ARTIFACT_INVALID' });
    }
    finally {
        await f.close();
    }
});
test('invalid filters and pre-cancelled reads never start a worker or build a cache', async () => {
    const f = fixture();
    try {
        for (const input of [{ threshold: 2 }, { limit: 101 }, { offset: 1.5 }, { issue: 'guess' }, { bodyId: 'foreign' }, { arbitrary: 1 }])
            await assert.rejects(f.query(input), { code: 'MESH_QUALITY_QUERY_INVALID' });
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(f.pool.query({ file: f.file, job: f.job, signal: controller.signal }), { code: 'MESH_QUALITY_QUERY_CANCELLED' });
        assert.equal(f.pool.metrics.workersStarted, 0);
        assert.equal(fs.existsSync(qualityPagesPath(f.file)), false);
    }
    finally {
        await f.close();
    }
});
function fakePool() { const workers = []; const pool = new MeshQualityQueryPool({ maxQueue: 1, workerFactory: (_url, options) => { const worker = new EventEmitter(); worker.options = options; worker.terminations = 0; worker.terminate = () => { worker.terminations++; return Promise.resolve(1); }; workers.push(worker); return worker; } }); const job = { jobId: 'mesh-' + crypto.randomUUID(), source: { bodies: [] }, artifact: { quality: { bytes: 1, sha256: 'a'.repeat(64) } } }; return { pool, workers, job, file: path.join(os.tmpdir(), 'quality.json') }; }
test('active cancellation waits for the exact thread exit before starting a queued query or deleting cache state', async () => {
    const f = fakePool(), controller = new AbortController();
    const first = f.pool.query({ ...f, signal: controller.signal }), rejected = assert.rejects(first, { code: 'MESH_QUALITY_QUERY_CANCELLED' }), second = f.pool.query(f), secondRejected = assert.rejects(second, { code: 'MESH_QUALITY_QUERY_CLOSED' });
    await assert.rejects(f.pool.query(f), { code: 'MESH_QUALITY_QUERY_BUSY' });
    controller.abort();
    assert.equal(f.workers[0].terminations, 1);
    assert.equal(f.workers.length, 1);
    let closed = false;
    const closing = f.pool.close().then(() => closed = true);
    assert.equal(closed, false);
    f.workers[0].emit('message', { ok: true, result: { shouldNotPublish: true } });
    f.workers[0].emit('exit', 1);
    await Promise.all([rejected, secondRejected, closing]);
    assert.equal(closed, true);
    assert.equal(f.workers.length, 1);
    await assert.rejects(f.pool.query(f), { code: 'MESH_QUALITY_QUERY_CLOSED' });
});
test('an actual thread abort leaves original data unchanged and releases the pool for a later read', async () => {
    const f = fixture(12000), controller = new AbortController();
    try {
        const before = fs.readFileSync(f.file), reading = f.pool.query({ file: f.file, job: f.job, signal: controller.signal });
        controller.abort();
        await assert.rejects(reading, { code: 'MESH_QUALITY_QUERY_CANCELLED' });
        assert.deepEqual(fs.readFileSync(f.file), before);
        const result = await f.query({ issue: 'all' });
        assert.equal(result.total, 12000);
        assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')), false);
    }
    finally {
        await f.close();
    }
});
test('query deadline stops only its owned thread and does not call the next request before exit', async (t) => {
    const f = fakePool();
    f.pool.timeoutMs = 25;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const reading = f.pool.query(f), rejected = assert.rejects(reading, { code: 'MESH_QUALITY_QUERY_TIMEOUT' });
    t.mock.timers.tick(26);
    assert.equal(f.workers[0].terminations, 1);
    assert.equal(f.pool.status().active, true);
    f.workers[0].emit('exit', 1);
    await rejected;
    assert.equal(f.pool.status().active, false);
    await f.pool.close();
});
test('thread resource failure is a recoverable query error rather than evidence of a corrupt CAD or mesh artifact', async () => {
    const f = fakePool(), reading = f.pool.query(f), rejected = assert.rejects(reading, { code: 'MESH_QUALITY_QUERY_LIMIT' });
    f.workers[0].emit('error', Object.assign(Error('budget'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
    f.workers[0].emit('exit', 1);
    await rejected;
    assert.equal(f.pool.status().active, false);
    await f.pool.close();
});
test('the request deadline includes queue time and expired queued reads never start a replacement thread', async t => {
    const f = fakePool(); f.pool.timeoutMs = 50; t.mock.timers.enable({ apis: ['setTimeout'] });
    const first = f.pool.query(f), firstRejected = assert.rejects(first, { code: 'MESH_QUALITY_QUERY_TIMEOUT' });
    t.mock.timers.tick(25); const second = f.pool.query(f), secondRejected = assert.rejects(second, { code: 'MESH_QUALITY_QUERY_TIMEOUT' });
    t.mock.timers.tick(51); await secondRejected; assert.equal(f.workers.length, 1); assert.equal(f.pool.status().queued, 0); assert.equal(f.pool.status().active, true);
    f.workers[0].emit('exit', 1); await firstRejected; await f.pool.close();
});
