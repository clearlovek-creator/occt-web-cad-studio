import test from 'node:test';
import assert from 'node:assert/strict';
import { addQualityValue } from '../shared/mesh-statistics.mjs';
import { assessMeshAdmission } from '../gateway/mesh-admission.mjs';
import { queryMeshQuality } from '../gateway/mesh-quality-query.mjs';
import { admissionFixture } from './helpers/mesh-admission-fixture.mjs';
import { tetraStrip } from './helpers/tetra-strip.mjs';
test('compensated quality averages do not drift with one million decimal values or signed cancellation', () => {
    const sum = { sum: 0, compensation: 0 };
    for (let i = 0; i < 1000000; i++)
        addQualityValue(sum, .8);
    assert.equal((sum.sum + sum.compensation) / 1000000, .8);
    const cancellation = { sum: 0, compensation: 0 };
    for (const value of [1, 1e-20, -1])
        addQualityValue(cancellation, value);
    assert.equal(cancellation.sum + cancellation.compensation, 1e-20);
});
test('large correct summaries are accepted without tolerance widening; legacy naive reduction is explicit and new contradictions still fail', () => {
    const f = admissionFixture(), count = 100000;
    const strip = tetraStrip(count, f.index.cells[0]);
    Object.assign(f.index, { cells: strip.cells, positions: strip.positions });
    f.mesh.nodeCount = strip.positions.length / 3;
    f.mesh.boundaryMapping.surfaces[0].elementCount = strip.boundaryFaceCount;
    Object.assign(f.mesh.quality, { tetraCount: count, finiteCount: count });
    assert.equal(assessMeshAdmission(f.mesh, f.index, f.source).status, 'accepted');
    let legacy = 0;
    for (let i = 0; i < count; i++)
        legacy += .8;
    f.mesh.quality.averageQuality = legacy / count;
    assert.equal(assessMeshAdmission(f.mesh, f.index, f.source).status, 'accepted');
    f.mesh.quality.summation = 'neumaier-v1';
    assert.equal(assessMeshAdmission(f.mesh, f.index, f.source).status, 'blocked');
    f.mesh.quality.averageQuality = .8;
    assert.equal(assessMeshAdmission(f.mesh, f.index, f.source).status, 'accepted');
    f.mesh.quality.averageQuality = .800001;
    assert.equal(assessMeshAdmission(f.mesh, f.index, f.source).status, 'blocked');
    assert.equal(queryMeshQuality(f.index, { source: f.source }, { limit: 1 }).quality.averageQuality, .8);
});
