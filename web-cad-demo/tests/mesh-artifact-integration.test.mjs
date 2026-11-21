import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { MeshArtifactPool } from '../gateway/mesh-artifact-pool.mjs';
import { createArtifactFixture } from './helpers/mesh-artifact-fixture.mjs';
import { stopTestChild } from './helpers/stop-test-child.mjs';
const until = async (predicate) => { const end = Date.now() + 15000; while (!await predicate()) {
    assert.ok(Date.now() < end, 'Artifact operation did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
} };
test('real artifact workers preserve exact results and source bytes, support cancellation and reject same-size corruption', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-artifact-real-')), f = createArtifactFixture(root, 100000), pool = new MeshArtifactPool({ dataDir: root }), before = fs.readFileSync(f.store.qualityOutput(f.job));
    try {
        const actual = await pool.execute({ operation: 'read', job: f.job });
        assert.deepEqual(actual, f.store.readResult(f.job));
        const a = new AbortController(), reading = pool.execute({ operation: 'read', job: f.job, signal: a.signal }), failed = assert.rejects(reading, { code: 'MESH_ARTIFACT_CANCELLED' });
        a.abort();
        await failed;
        assert.equal(pool.active, null);
        assert.deepEqual(fs.readFileSync(f.store.qualityOutput(f.job)), before);
        const sealed = await pool.execute({ operation: 'seal', job: f.job, result: f.result });
        assert.deepEqual(sealed.result.mesh.admission, f.result.mesh.admission);
        f.job.artifact = sealed.artifact;
        assert.deepEqual(await pool.execute({ operation: 'read', job: f.job }), f.store.readResult(f.job));
        const damaged = Buffer.from(before);
        damaged[25] ^= 1;
        fs.writeFileSync(f.store.qualityOutput(f.job), damaged);
        await assert.rejects(pool.execute({ operation: 'read', job: f.job }), { code: 'MESH_ARTIFACT_INVALID' });
        assert.deepEqual(fs.readFileSync(f.store.qualityOutput(f.job)), damaged);
    }
    finally {
        await pool.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-artifact-real-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test('HTTP verification coalesces responsive reads, cancels disconnects and survives corruption during a checked download', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-artifact-http-')), f = createArtifactFixture(root, 100000), server = net.createServer();
    let child;
    try {
        const output=f.store.output(f.job),block=Buffer.alloc(1024*1024,36),hash=crypto.createHash('sha256'),file=fs.openSync(output,'w');try{for(let i=0;i<64;i++){fs.writeSync(file,block);hash.update(block);}}finally{fs.closeSync(file);}f.job.artifact.mesh={bytes:64*1024*1024,sha256:hash.digest('hex')};f.store.save(f.job);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        await new Promise(resolve => server.close(resolve));
        const api = `http://127.0.0.1:${port}/api`;
        child = spawn(process.execPath, ['gateway/server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Artifact Gateway startup')), 15000); child.once('error', reject); child.stdout.on('data', bytes => { if (String(bytes).includes('Geometry gateway ready')) {
            clearTimeout(timer);
            resolve();
        } }); child.stderr.on('data', () => { }); });
        const json = route => fetch(api + route).then(response => response.json()), endpoint = '/mesh/jobs/' + f.job.jobId;
        // Gateway readiness and catalog recovery are separate. Otherwise this
        // test can mistake the catalog worker for the checked result reader.
        await until(async()=>(await json('/mesh/catalog')).meshCatalog.state==='ready');
        const first=json(endpoint),second=json(endpoint);first.catch(()=>{});second.catch(()=>{});
        await until(async () => (await json('/health')).runtime.meshArtifacts.active);
        const during = await json('/health');
        assert.equal(during.worker, true);
        assert.ok(during.runtime.meshArtifacts.metrics.coalesced >= 1);
        const summary = await fetch(api + '/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'document.summary', documentId: 'observer' }) }).then(response => response.json());
        assert.equal(summary.ok, true);
        assert.equal((await first).mesh.admission.status, 'accepted');
        assert.equal((await second).mesh.admission.status, 'accepted');
        const controller = new AbortController(), reading = fetch(api + endpoint, { signal: controller.signal }), failed = assert.rejects(reading);
        await until(async () => (await json('/health')).runtime.meshArtifacts.active);
        controller.abort();
        await failed;
        await until(async () => !(await json('/health')).runtime.meshArtifacts.active);
        assert.equal((await json(endpoint)).meshJob.state, 'complete');
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.store.directory(f.job), 'metadata.json'))).state, 'complete');
        const download=await fetch(api+'/mesh/outputs/'+path.basename(output));assert.equal(download.status,200);assert.equal(download.headers.get('X-Content-SHA256'),f.job.artifact.mesh.sha256);const fd=fs.openSync(output,'r+');try{fs.writeSync(fd,Buffer.from([255]),0,1,f.job.artifact.mesh.bytes-1);}finally{fs.closeSync(fd);}await assert.rejects(download.arrayBuffer());assert.equal((await json('/health')).worker,true,'A partial-stream error must not send a second response or stop the Gateway');
    }
    finally {
        await stopTestChild(child);
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-artifact-http-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
