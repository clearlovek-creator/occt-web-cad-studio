/* Native serialization pressure, not CAD repair/meshing or GPU certification. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { sealMeshRender, readMeshRenderChunk, validateMeshRender } from '../gateway/mesh-render-store.mjs';
const root = path.resolve(import.meta.dirname, '..'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-wire-scale-')), helper = path.resolve(process.env.MESH_WIRE_BENCHMARK || path.join(root, 'mesh-worker/build-streamed/mesh_wire_benchmark.exe'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), reports = [];
try {
    for (const subdivisions of [12, 26, 44, 55]) {
        const file = path.join(directory, `wire-${subdivisions}.bin`), child = spawn(helper, [String(subdivisions), file], { windowsHide: true, env: { ...process.env, Path: path.dirname(helper) + ';C:/msys64/ucrt64/bin;' + (process.env.Path || process.env.PATH || '') }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', diagnostic = '';
        child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 1024 * 1024)
            child.kill(); });
        child.stderr.on('data', chunk => diagnostic += chunk);
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.equal(code, 0, diagnostic);
        const result = JSON.parse(output), { render } = result;
        assert.equal(result.cells, 6 * subdivisions ** 3);
        assert.equal(render.wires.length, 1);
        assert.equal(render.wires[0].scalars, result.cells * 36);
        assert.equal(render.storage.bytes, result.cells * 288);
        const start = performance.now();
        sealMeshRender(render, file);
        const sealMs = performance.now() - start;
        validateMeshRender(render);
        const chunkTimes = [];
        for (const index of [...new Set([0, Math.floor(render.wires[0].chunks.length / 2), render.wires[0].chunks.length - 1])]) {
            const begin = performance.now(), bytes = readMeshRenderChunk(file, render, render.wires[0].key, index);
            chunkTimes.push(performance.now() - begin);
            assert.ok(bytes.length <= 1024 * 1024);
            for (let offset = 0; offset < bytes.length; offset += 8) {
                const value = bytes.readDoubleLE(offset);
                assert.ok(Number.isInteger(value) && value >= 0 && value <= subdivisions);
            }
        }
        reports.push({ subdivisions, cells: result.cells, nodes: result.nodes, binaryBytes: render.storage.bytes, manifestBytes: Buffer.byteLength(JSON.stringify(render)), chunks: render.wires[0].chunks.length, nativeWriteMs: result.elapsedMs, sealMs, chunkTimesMs: chunkTimes, wireSha256: render.storage.sha256 });
        fs.rmSync(file);
        console.log(JSON.stringify(reports.at(-1)));
    }
    const report = { scope: 'structured nonoverlapping discrete tetrahedral grid inside real Gmsh; actual MeshWireStore native writer and Gateway block sealing/read; not CAD mesher throughput, full admission load, browser/GPU million-cell rendering or peak-RSS proof', node: process.version, platform: process.platform, helperSha256: hash(helper), sources: Object.fromEntries(['mesh-worker/src/MeshWireStore.cxx', 'mesh-worker/tests/MeshWireBenchmark.cxx', 'gateway/mesh-render-store.mjs'].map(name => [name, hash(path.join(root, name))])), reports };
    const output = path.join(root, '.artifacts/performance/mesh-wire.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log('Certified native wire serialization report: ' + output);
}
finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^cad-wire-scale-/);
    fs.rmSync(directory, { recursive: true, force: true });
}
