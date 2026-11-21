import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateMeshRender, sealMeshRender, readRenderManifest, readMeshRenderChunk } from '../gateway/mesh-render-store.mjs';
function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-wire-store-')), file = path.join(root, 'render.bin');
    const bytes = Buffer.alloc(96);
    for (let i = 0; i < 12; i++)
        bytes.writeDoubleLE(i / 8, i * 8);
    fs.writeFileSync(file, bytes);
    const render = { dimension: 3, kind: 'wire', positions: [], wirePositions: [], storage: { version: 1, format: 'float64-le', bytes: 96 }, wires: [{ key: 'wire-3-1', scalars: 12, chunks: [{ offset: 0, bytes: 48 }, { offset: 48, bytes: 48 }] }], groups: [{ kind: 'solid', solidId: 'solid-1', wireKey: 'wire-3-1', wirePositions: [] }] };
    try {
        return run({ root, file, bytes, render });
    }
    finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-wire-store-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
test('sealed wire blocks retain exact binary64 positions and shared owners use one physical range', () => fixture(({ file, bytes, render }) => {
    render.groups.push({ ...render.groups[0], bodyId: 'body-2' });
    const proof = sealMeshRender(render, file);
    assert.equal(proof.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(validateMeshRender(render).keys.size, 1);
    assert.deepEqual(readMeshRenderChunk(file, render, 'wire-3-1', 1), bytes.subarray(48));
    assert.throws(() => readMeshRenderChunk(file, render, 'wire-3-2', 0), { code: 'MESH_RENDER_QUERY_INVALID' });
}));
test('malformed or unowned wire ranges are rejected before any file access', () => fixture(({ render }) => {
    for (const mutate of [r => r.wires[0].chunks[1].offset = 0, r => r.wires[0].chunks[1].offset = 49, r => r.wires[0].scalars = 6, r => r.wires[0].chunks[0].bytes = 1024 * 1024 + 48, r => r.groups[0].solidId = 'solid-2', r => r.groups = [], r => r.wirePositions = [1], r => r.storage.bytes = 2 ** 31 + 1, r => r.wires.push(structuredClone(r.wires[0]))]) {
        const bad = structuredClone(render);
        mutate(bad);
        assert.throws(() => validateMeshRender(bad, { sealed: false }), { code: 'MESH_ARTIFACT_INVALID' });
    }
}));
test('same-size mutation, truncation and non-finite coordinates cannot be served or sealed', () => fixture(({ file, bytes, render }) => {
    sealMeshRender(render, file);
    const changed = Buffer.from(bytes);
    changed[3] ^= 1;
    fs.writeFileSync(file, changed);
    assert.throws(() => readMeshRenderChunk(file, render, 'wire-3-1', 0), { code: 'MESH_ARTIFACT_INVALID' });
    fs.writeFileSync(file, bytes.subarray(0, 48));
    assert.throws(() => readMeshRenderChunk(file, render, 'wire-3-1', 0), { code: 'MESH_ARTIFACT_INVALID' });
    const nan = Buffer.from(bytes);
    nan.writeDoubleLE(NaN, 0);
    fs.writeFileSync(file, nan);
    assert.throws(() => sealMeshRender(render, file), { code: 'MESH_ARTIFACT_INVALID' });
}));
test('the checked small manifest binds job identity and exact sealed contents', () => fixture(({ root, file, render }) => {
    sealMeshRender(render, file);
    const manifest = path.join(root, 'result.json'), bytes = Buffer.from(JSON.stringify({ ok: true, requestId: 'mesh-test', mesh: { render } }));
    fs.writeFileSync(manifest, bytes);
    const proof = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    assert.deepEqual(readRenderManifest(manifest, proof, 'mesh-test'), render);
    assert.throws(() => readRenderManifest(manifest, proof, 'another-job'), { code: 'MESH_ARTIFACT_INVALID' });
    const changed = Buffer.from(bytes);
    changed[0] = 32;
    fs.writeFileSync(manifest, changed);
    assert.throws(() => readRenderManifest(manifest, proof, 'mesh-test'), { code: 'MESH_ARTIFACT_INVALID' });
}));
