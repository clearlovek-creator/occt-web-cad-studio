import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assessMeshAdmission } from '../gateway/mesh-admission.mjs';
import { withStreamedQualityIndex } from '../gateway/mesh-quality-stream.mjs';
import { admissionFixture } from './helpers/mesh-admission-fixture.mjs';
import {importTestTypeScript} from './helpers/import-typescript.mjs';
const {topologySampleProblem,topologySampleSelection}=await importTestTypeScript('../app/model/mesh-topology.ts',import.meta.url);
const {createMeshQualityHighlight}=await importTestTypeScript('../app/model/mesh-quality-render.ts',import.meta.url);
const {MeshTopologySamples}=await importTestTypeScript('../app/MeshTopologySamples.tsx',import.meta.url);
function fixture(face = false) {
    const f = admissionFixture(), first = f.index.cells[0];
    f.index.positions.push(0, 0, 2);
    f.index.cells.push({ ...first, elementId: '9007199254740993', corners: face ? [0, 1, 2, 4] : [1, 2, 0, 3], extra: 'never-copy-extra-cell-fields' });
    Object.assign(f.mesh.quality, { tetraCount: 2, finiteCount: 2 });
    f.mesh.nodeCount = 5;
    f.mesh.boundaryMapping.surfaces[0].elementCount = face ? 6 : 0;
    f.mesh.admission = assessMeshAdmission(f.mesh, f.index, f.source);
    const result = { meshJob: { jobId: 'sample-job', documentId: 'admission', source: f.source }, mesh: f.mesh };
    return { ...f, result, sample: f.mesh.admission.topology.samples[0] };
}
test('bounded admission samples carry exact certified coordinates, cell/owner identities and no arbitrary cell payload', () => {
    for (const face of [false, true]) {
        const f = fixture(face), sample = f.sample;
        assert.equal(sample.cell.elementId, '9007199254740993');
        assert.equal(sample.cell.quality, .8);
        assert.equal(sample.cell.invalid, false);
        assert.equal(sample.cell.locatable, true);
        assert.deepEqual(sample.cell.corners, sample.cellNodeIndexes.flatMap(node => f.index.positions.slice(node * 3, node * 3 + 3)));
        assert.equal(sample.cell.bodyIdentities['body-1'].bodyIdentity, f.source.bodies[0].bodyIdentity);
        assert.equal('rawCell' in sample, false);
        assert.equal(JSON.stringify(sample).includes('never-copy-extra'), false);
        assert.equal(topologySampleProblem(f.result, sample), '');
    }
});
test('streamed and whole-file sample coordinates remain identical and require the complete content proof', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-topology-samples-'));
    try {
        const f = fixture(true), file = path.join(root, 'quality.json'), bytes = Buffer.from(JSON.stringify(f.index)), proof = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        fs.writeFileSync(file, bytes);
        const job = { jobId: f.index.requestId, source: f.source, artifact: { quality: proof } };
        assert.deepEqual(withStreamedQualityIndex(file, job, index => assessMeshAdmission(f.mesh, index, f.source), { chunkBytes: 7 }).value, f.mesh.admission);
        fs.appendFileSync(file, ' ');
        assert.throws(() => withStreamedQualityIndex(file, job, index => assessMeshAdmission(f.mesh, index, f.source)), { code: 'MESH_ARTIFACT_INVALID' });
    }
    finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-topology-samples-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test('non-finite coordinates, unknown owners and truncated element IDs never produce a locatable sample', () => {
    for (const damage of [f => f.index.positions[0] = null, f => f.index.cells[1].bodyIds = ['missing'], f => f.index.cells[1].elementId = '9'.repeat(10000)]) {
        const f = fixture();
        damage(f);
        f.mesh.admission = assessMeshAdmission(f.mesh, f.index, f.source);
        const sample = f.mesh.admission.topology.samples[0];
        assert.ok(!sample.cell || !sample.cell.locatable);
        assert.ok(topologySampleProblem(f.result, sample));
        assert.equal(topologySampleSelection(f.result, sample, 0), null);
        assert.equal(JSON.stringify(sample).includes('9'.repeat(81)), false);
    }
});
test('frontend sample selection validates ownership, face membership and all coordinate fields before viewport use', () => {
    const f = fixture(true), selection = topologySampleSelection(f.result, f.sample, 0);
    assert.deepEqual(selection.topology.faceCornerSlots, [0, 1, 2]);
    assert.equal(selection.cell.elementId, f.sample.elementId);
    for (const damage of [s => s.kind = '__proto__', s => s.cell.corners[0] = Infinity, s => s.cell.corners[0]=1e200, s => s.cell.bodyIdentities['body-1'].topologyIdentity = '0'.repeat(32), s => s.nodeIndexes = [0, 1, 99], s => s.nodeIndexes = [0, 0, 1], s => s.cellNodeIndexes = [0, 1, 2, -1], s => s.cell.elementId = 'other', s => s.cell.bodyIds = []]) {
        const sample = structuredClone(f.sample);
        damage(sample);
        assert.ok(topologySampleProblem(f.result, sample));
        assert.equal(topologySampleSelection(f.result, sample, 0), null);
    }
    assert.equal(topologySampleSelection(f.result, f.sample, 8), null);
});
test('a face sample adds its real three-corner marker to the existing diagnostic layer without changing numeric quality flags', () => {
    const f = fixture(true), selection = topologySampleSelection(f.result, f.sample, 0), group = createMeshQualityHighlight(selection.cell, .2, selection.topology), face = group.getObjectByName('mesh-topology-common-face');
    assert.ok(face);
    assert.equal(face.geometry.getAttribute('position').count, 3);
    assert.equal(face.material.depthTest, false);
    assert.equal(group.children[0].material.color.getHex(), 0xff6b63);
    assert.equal(selection.cell.invalid, false);
    const normal = createMeshQualityHighlight(selection.cell, .2);
    assert.equal(normal.getObjectByName('mesh-topology-common-face'), undefined);
    assert.equal(normal.children[0].material.color.getHex(), 0x63d0f2);
    for (const root of [group, normal])
        root.traverse(node => { node.geometry?.dispose(); node.material?.dispose(); });
});
test('sample rows expose native accessible controls, disable stale/hidden data and never invent a boundary hotspot', () => {
    const f = fixture(true), props = { result: f.result, current: true, visibleBodyIds: ['body-1'], selection: null, onLocate() { } };
    const render = extra => renderToStaticMarkup(React.createElement(MeshTopologySamples, { ...props, ...extra }));
    assert.match(render(), /aria-label="定位连接样例 1"/);
    assert.doesNotMatch(render(), /disabled=""/);
    assert.match(render({ current: false }), /disabled=""/);
    assert.match(render({ visibleBodyIds: [] }), /所属 Body 已隐藏/);
    const broken = structuredClone(f.result);
    broken.mesh.admission.topology.samples = [{ ...f.sample, kind: '__proto__', cell: {} }];
    assert.match(render({ result: broken }), /未知连接异常/);
    const boundary = structuredClone(f.result);
    Object.assign(boundary.mesh.admission.topology, { samples: [], expectedBoundaryFaceCount: 99 });
    assert.match(render({ result: boundary }), /没有可靠的局部定位样例/);
    assert.doesNotMatch(render({ result: boundary }), /aria-label="定位连接样例/);
});
