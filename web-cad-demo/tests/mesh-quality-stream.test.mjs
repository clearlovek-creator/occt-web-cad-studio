import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { withStreamedQualityIndex, QUALITY_STREAM_LIMITS } from '../gateway/mesh-quality-stream.mjs';
import { validateQualityIndex } from '../gateway/mesh-quality-query.mjs';
import { assessMeshAdmission } from '../gateway/mesh-admission.mjs';
import { admissionFixture } from './helpers/mesh-admission-fixture.mjs';
import { createArtifactFixture } from './helpers/mesh-artifact-fixture.mjs';
const digest = bytes => ({ bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
async function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-quality-stream-')), f = admissionFixture(), file = path.join(root, 'quality.json'), job = { jobId: f.index.requestId, source: f.source };
    const write = value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); fs.writeFileSync(file, bytes); job.artifact = { quality: digest(bytes) }; };
    write(f.index);
    try {
        await run({ ...f, root, file, job, write });
    }
    finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-quality-stream-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
const admission = f => withStreamedQualityIndex(f.file, f.job, index => assessMeshAdmission(f.mesh, index, f.source));
test('only a leading UTF-8 BOM is accepted, never a BOM hidden before a scalar or cell', async () => fixture(async (f) => {
    const text = JSON.stringify(f.index), expected = assessMeshAdmission(f.mesh, f.index, f.source);
    f.write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text + '\r\n\t ')]));
    assert.deepEqual(withStreamedQualityIndex(f.file, f.job, index => assessMeshAdmission(f.mesh, index, f.source), { chunkBytes: 1 }).value, expected);
    for (const value of [text.replace('"threshold":0.2', '"threshold":\ufeff0.2'), text.replace('"cells":[{', '"cells":[\ufeff{'), text.replace('"positions":[0', '"positions":[\ufeff0')]) {
        f.write(value);
        assert.throws(() => admission(f), { code: 'MESH_ARTIFACT_INVALID' });
    }
}));
test('every byte boundary, UTF-8, escaped strings and root-field order preserve exact admission', async () => fixture(async (f) => {
    const index = { extra: '中文 🌍 \\"\n\t braces } ],', cells: f.index.cells, positions: f.index.positions, threshold: f.index.threshold, qualityName: f.index.qualityName, requestId: f.index.requestId, version: 1 };
    f.write(index);
    const expected = assessMeshAdmission(f.mesh, f.index, f.source);
    for (const chunkBytes of [1, 2, 3, 7, 31, 127, 1024, 65536]) {
        const actual = withStreamedQualityIndex(f.file, f.job, index => assessMeshAdmission(f.mesh, index, f.source), { chunkBytes });
        assert.deepEqual(actual.value, expected);
        assert.deepEqual(actual.proof, f.job.artifact.quality);
        assert.equal(actual.metrics.retainedCellObjects, 0);
    }
}));
test('null, tiny coordinates, negative zero and non-finite quality retain old classification', async () => fixture(async (f) => {
    for (const modify of [x => x.positions[0] = null, x => x.positions = x.positions.map(v => v * 1e-200), x => x.positions[0] = -0, x => x.cells[0].quality = null, x => x.cells[0].minJacobian = -1, x => x.cells[0].maxJacobian = 0, x => x.cells[0].corners = [0, 2, 1, 3], x => x.cells[0].minJacobian = 2]) {
        const index = structuredClone(f.index);
        modify(index);
        f.write(index);
        const expected = assessMeshAdmission(f.mesh, validateQualityIndex(index, f.job), f.source);
        assert.deepEqual(admission(f).value, expected);
    }
}));
test('packed coordinate block boundaries preserve exact corner access and null markers', async () => fixture(async (f) => {
    f.index.positions = Array(16395).fill(0);
    f.index.positions.splice(16383, 12, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1);
    f.index.cells[0].corners = [5461, 5462, 5463, 5464];
    f.mesh.nodeCount = f.index.positions.length / 3;
    for (const value of [0, null, 1e-200]) {
        f.index.positions[16384] = value;
        f.write(f.index);
        const result = admission(f);
        assert.deepEqual(result.value, assessMeshAdmission(f.mesh, f.index, f.source));
        assert.equal(result.metrics.coordinateBytes, 2 * QUALITY_STREAM_LIMITS.coordinateBlock * 8);
    }
}));
test('shared owners and IDs beyond safe integers are exact and duplicate IDs are rejected late', async () => fixture(async (f) => {
    f.source.bodies.push({ ...f.source.bodies[0], bodyId: 'body-2' });
    f.index.cells = Array.from({ length: 20 }, (_, i) => ({ ...f.index.cells[0], elementId: String(9007199254740993n + BigInt(i)), bodyIds: ['body-1', 'body-2'] }));
    f.write(f.index);
    let ids = [];
    const actual = withStreamedQualityIndex(f.file, f.job, index => { assert.equal(index.cells.length, 20); ids = [...index.cells].map(cell => cell.elementId); return ids.length; }, { chunkBytes: 17 });
    assert.equal(actual.value, 20);
    assert.equal(ids.at(-1), '9007199254741012');
    f.index.cells.at(-1).elementId = f.index.cells[0].elementId;
    f.write(f.index);
    assert.throws(() => admission(f), { code: 'MESH_ARTIFACT_INVALID' });
}));
test('malformed JSON, duplicate root keys, trailing bytes and invalid encodings never pass', async () => fixture(async (f) => {
    const text = JSON.stringify(f.index);
    const samples = [text.slice(0, -1), text + ' false', text.replace('"version":1', '"version":1,"version":1'), text.replace('"positions":[', '"positions":[,'), text.replace('"cells":[{', '"cells":[{,'), text.replace('"elementId":"1"', '"elementId":"\\q"'), text.replace('"bodyIds":["body-1"]', '"bodyIds":["body-1",]'), text.replace('"cells":[{', '"cells":[['), text.replace('"threshold":0.2', '"threshold":01'), text.replace('"positions":[0', '"positions":[1e309')];
    for (const value of samples) {
        f.write(value);
        assert.throws(() => admission(f), { code: 'MESH_ARTIFACT_INVALID' });
    }
    const invalid = Buffer.from(text);
    invalid[invalid.indexOf('body-1')] = 0xff;
    f.write(invalid);
    assert.throws(() => admission(f), { code: 'MESH_ARTIFACT_INVALID' });
}));
test('all cell validation still runs when the consumer does not inspect any cell', async () => fixture(async (f) => {
    f.index.cells[0].corners = [0, 1, 2, 99];
    f.write(f.index);
    assert.throws(() => withStreamedQualityIndex(f.file, f.job, () => ({ status: 'unverified' })), { code: 'MESH_ARTIFACT_INVALID' });
    f.index.cells[0].corners = [0, 1, 2, 3];
    f.write(f.index);
    assert.equal(withStreamedQualityIndex(f.file, f.job, () => null).value, null);
    assert.throws(() => withStreamedQualityIndex(f.file, f.job, index => {
        for (const cell of index.cells) {
            void cell;
            break;
        }
        return true;
    }), { code: 'MESH_ARTIFACT_INVALID' });
    assert.throws(() => withStreamedQualityIndex(f.file, f.job, async () => true), { code: 'MESH_ARTIFACT_INVALID' });
}));
test('both complete passes bind consumed cells and coordinates to the same content proof', async () => fixture(async (f) => {
    let consumed = false;
    assert.throws(() => withStreamedQualityIndex(f.file, f.job, index => {
        consumed = true;
        const bytes = fs.readFileSync(f.file);
        bytes[bytes.indexOf('0.8') + 2] = 57;
        fs.writeFileSync(f.file, bytes);
        return assessMeshAdmission(f.mesh, index, f.source);
    }), { code: 'MESH_ARTIFACT_INVALID' });
    assert.equal(consumed, true);
    const bytes = fs.readFileSync(f.file);
    assert.equal(bytes.includes('0.9'), true);
    assert.throws(() => admission(f), { code: 'MESH_ARTIFACT_INVALID' });
}));
test('an identical-byte path replacement is either refused by the OS or rejected by admission', async () => fixture(async (f) => {
    let replaced = false, denied;
    assert.throws(() => withStreamedQualityIndex(f.file, f.job, index => {
        const other = f.file + '.replacement';
        fs.writeFileSync(other, fs.readFileSync(f.file));
        try {
            fs.renameSync(other, f.file);
            replaced = true;
        }
        catch (error) {
            denied = error.code;
            throw error;
        }
        return assessMeshAdmission(f.mesh, index, f.source);
    }), { code: 'MESH_ARTIFACT_INVALID' });
    assert.ok(replaced || ['EPERM', 'EACCES', 'EBUSY'].includes(denied));
    assert.deepEqual(digest(fs.readFileSync(f.file)), f.job.artifact.quality);
}));
test('a late path identity mismatch is rejected even when all bytes and open-FD metadata still match', async (t) => fixture(async (f) => {
    const lstat = fs.lstatSync;
    let changed = false, observed = false;
    t.mock.method(fs, 'lstatSync', (file, ...args) => {
        const stat = lstat(file, ...args);
        if (file === f.file && changed) {
            observed = true;
            return { ...stat, ino: stat.ino + 1n };
        }
        return stat;
    });
    try {
        assert.throws(() => withStreamedQualityIndex(f.file, f.job, index => { const report = assessMeshAdmission(f.mesh, index, f.source); changed = true; return report; }), { code: 'MESH_ARTIFACT_INVALID' });
    }
    finally {
        t.mock.restoreAll();
    }
    assert.equal(observed, true);
    assert.deepEqual(digest(fs.readFileSync(f.file)), f.job.artifact.quality);
}));
test('value, depth and source budgets are resource errors that preserve originals', async () => fixture(async (f) => {
    for (const extra of ['x'.repeat(QUALITY_STREAM_LIMITS.valueBytes + 1), Array.from({ length: 70 }, () => 0).reduce(value => [value], 0)]) {
        f.write({ ...f.index, extra });
        const before = fs.readFileSync(f.file);
        assert.throws(() => admission(f), { code: 'MESH_ARTIFACT_LIMIT' });
        assert.deepEqual(fs.readFileSync(f.file), before);
    }
    const fd = fs.openSync(f.file, 'w');
    fs.ftruncateSync(fd, QUALITY_STREAM_LIMITS.sourceBytes + 1);
    fs.closeSync(fd);
    assert.throws(() => admission(f), { code: 'MESH_ARTIFACT_LIMIT' });
    assert.equal(fs.statSync(f.file).size, QUALITY_STREAM_LIMITS.sourceBytes + 1);
}));
test('deterministic varied numeric indexes match the old validator and reducer without tolerance changes', async () => fixture(async (f) => {
    let state = 15389;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
    for (let run = 0; run < 40; run++) {
        const index = structuredClone(f.index);
        index.cells = Array.from({ length: 1 + Math.floor(random() * 30) }, (_, i) => ({ ...index.cells[0], elementId: String(BigInt(i) + 9007199254740993n), quality: random() < .1 ? null : random() * 2 - 1, minJacobian: random() < .2 ? -random() : random(), maxJacobian: random(), extra: { name: '引号 " 和括号 ] }', values: [true, false, null, random()] } }));
        if (random() < .2)
            index.positions[0] = null;
        f.write(index);
        assert.deepEqual(admission(f).value, assessMeshAdmission(f.mesh, validateQualityIndex(index, f.job), f.source));
    }
}));
test('the online store seals and reloads by streaming while the offline reference stays equivalent', async () => fixture(async (f) => {
    const saved = createArtifactFixture(f.root, 10000), original = fs.readFileSync(saved.store.qualityOutput(saved.job));
    assert.deepEqual(saved.store.readResult(saved.job), saved.store.readResult(saved.job, { streamQuality: false }));
    const result = structuredClone(saved.result), artifact = saved.store.writeResult(saved.job, result);
    assert.deepEqual(result.mesh.admission, saved.result.mesh.admission);
    assert.deepEqual(artifact.quality, saved.job.artifact.quality);
    assert.deepEqual(fs.readFileSync(saved.store.qualityOutput(saved.job)), original);
}));
