import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ObservedCommandClient } from './helpers/observed-command-client.mjs';
import { stopTestChild } from './helpers/stop-test-child.mjs';
import { validateMeshRender } from '../gateway/mesh-render-store.mjs';
test('real conformal mesh publishes metadata only, serves exact certified Body/Face wire chunks, survives restart and refuses stale or corrupt data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-mesh-wire-中文-')), server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const api = `http://127.0.0.1:${port}/api`, observed = new ObservedCommandClient();
    let gateway;
    const start = async () => { gateway = spawn(process.execPath, ['gateway/server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { let diagnostic = ''; const timer = setTimeout(() => reject(Error('Mesh stream Gateway startup ' + diagnostic)), 15000); gateway.once('error', reject); gateway.stderr.on('data', chunk => diagnostic += chunk); gateway.stdout.on('data', chunk => { if (String(chunk).includes('Geometry gateway ready')) {
        clearTimeout(timer);
        resolve();
    } }); }); };
    const stop = async () => { await stopTestChild(gateway); gateway = null; };
    const request = async (route, input) => { const response = await fetch(api + route, { ...(input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(20000) }), data = await response.json(); assert.ok(response.ok && data.ok, JSON.stringify(data)); return data; };
    let revision;
    const cad = async (operation, parameters = {}, inputs = {}) => { const result = observed.observe(await request('/commands', observed.prepare({ documentId: 'test', operation, parameters, inputs, ...(revision === undefined ? {} : { baseRevision: revision }) })), 'test'); if (Number.isSafeInteger(result.revision))
        revision = result.revision; return result; };
    try {
        await start();
        const box = await cad('primitive.box', { width: 10, depth: 8, height: 6 });
        await cad('primitive.box', { width: 5, depth: 5, height: 6, x: 4 });
        await cad('surface.rectangle', { width: 6, height: 5, x: 5, y: 4, z: 3 });
        const before = await cad('document.summary');
        const response = await fetch(api + '/documents/test/mesh/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ qualityThreshold: 0 }) }), text = await response.text(), result = JSON.parse(text);
        assert.equal(result.ok, true, text);
        assert.equal(result.mesh.admission.status, 'accepted');
        const render = result.mesh.render, { keys } = validateMeshRender(render);
        assert.equal(render.positions.length, 0);
        assert.equal(render.wirePositions.length, 0);
        assert.ok(keys.size > 0);
        assert.equal(result.meshJob.visible, false);
        assert.ok(Buffer.byteLength(text) < render.storage.bytes, 'The reply must contain source/ownership metadata, not all wire coordinates');
        const jobId = result.meshJob.jobId, record = path.join(root, 'mesh-jobs/test', jobId), index = JSON.parse(fs.readFileSync(path.join(record, 'quality.json'))), groups = render.groups.flatMap(group => [group, ...(group.faces || [])]);
        assert.ok(groups.every(group => group.wirePositions.length === 0 && keys.has(group.wireKey)));
        const chunk = async (wireKey, n = 0) => { const response = await fetch(api + `/mesh/jobs/${jobId}/render?wireKey=${wireKey}&chunk=${n}`); assert.equal(response.status, 200); assert.equal(response.headers.get('X-CAD-Mesh-Format'), 'float64-le'); assert.equal(response.headers.get('X-CAD-Mesh-Wire'), wireKey); const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length <= 1024 * 1024); assert.equal(bytes.length, keys.get(wireKey).chunks[n].bytes); return bytes; };
        const edges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]], seen = new Set();
        for (const group of render.groups.filter(row => row.kind === 'solid')) {
            if (seen.has(group.wireKey))
                continue;
            seen.add(group.wireKey);
            const volume = Number(group.solidId.slice(6)), cells = index.cells.filter(cell => cell.volumeTag === volume), wire = keys.get(group.wireKey);
            assert.equal(wire.scalars, cells.length * 36);
            const actual = Buffer.concat(await Promise.all(wire.chunks.map((_, n) => chunk(wire.key, n))));
            let offset = 0;
            for (const cell of cells)
                for (const edge of edges)
                    for (const endpoint of edge)
                        for (let axis = 0; axis < 3; axis++) {
                            assert.equal(actual.readDoubleLE(offset), index.positions[cell.corners[endpoint] * 3 + axis]);
                            offset += 8;
                        }
            assert.equal(offset, actual.length);
        }
        const points = new Set();
        for (let i = 0; i < index.positions.length; i += 3)
            points.add(index.positions.slice(i, i + 3).join(','));
        for (const group of groups.filter(row => row.kind === 'face')) {
            if (seen.has(group.wireKey))
                continue;
            seen.add(group.wireKey);
            const bytes = await chunk(group.wireKey);
            for (let i = 0; i < bytes.length; i += 24)
                assert.ok(points.has([bytes.readDoubleLE(i), bytes.readDoubleLE(i + 8), bytes.readDoubleLE(i + 16)].join(',')), 'Face lines must reference actual mesh nodes');
        }
        assert.equal((await cad('document.summary')).stateToken, before.stateToken);
        assert.ok(render.groups.some(group => group.sourceBodySurface));
        await stop();
        await start();
        const recovered = await request('/mesh/jobs/' + jobId);
        assert.equal(recovered.meshJob.recovered, true);
        assert.equal(recovered.meshJob.visible, false);
        assert.deepEqual(recovered.mesh.render, render);
        const wire = render.groups.find(row => row.kind === 'solid').wireKey;
        await chunk(wire);
        await cad('feature.update', { height: 7 }, { featureId: box.features[0].id });
        const stale = await fetch(api + `/mesh/jobs/${jobId}/render?wireKey=${wire}&chunk=0`);
        assert.equal(stale.status, 409);
        assert.equal((await stale.json()).code, 'MESH_SOURCE_STALE');
        await cad('document.undo');
        await chunk(wire);
        const file = path.join(record, 'render.bin'), fd = fs.openSync(file, 'r+'), first = keys.get(wire).chunks[0], bytes = Buffer.alloc(1);
        fs.readSync(fd, bytes, 0, 1, first.offset);
        bytes[0] ^= 1;
        fs.writeSync(fd, bytes, 0, 1, first.offset);
        fs.closeSync(fd);
        const corrupt = await fetch(api + `/mesh/jobs/${jobId}/render?wireKey=${wire}&chunk=0`);
        assert.equal(corrupt.status, 409);
        assert.equal((await corrupt.json()).code, 'MESH_ARTIFACT_INVALID');
        assert.ok(fs.existsSync(file));
        const failed = await fetch(api + '/mesh/jobs/' + jobId);
        assert.equal(failed.status, 409);
        assert.equal((await failed.json()).meshJob.state, 'failed');
    }
    finally {
        await stop();
        assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
