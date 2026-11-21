import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMeshAdmission } from '../gateway/mesh-admission.mjs';
import { admissionFixture } from './helpers/mesh-admission-fixture.mjs';

function fixture(corners, positions, boundaryCount) {
  const f = admissionFixture();
  f.index.positions = positions;
  f.index.cells = corners.map((nodes, index) => ({ ...f.index.cells[0], corners: nodes, elementId: String(index + 1) }));
  f.mesh.nodeCount = positions.length / 3;
  f.mesh.elementCount = corners.length;
  Object.assign(f.mesh.quality, { tetraCount: corners.length, finiteCount: corners.length });
  f.mesh.boundaryMapping.surfaces[0].elementCount = boundaryCount;
  return f;
}
const points = [0,0,0, 1,0,0, 0,1,0, 0,0,1, 0,0,-1, 0,0,2];
const assess = f => assessMeshAdmission(f.mesh, f.index, f.source);

test('duplicate tetrahedra cannot pass with unique element IDs and perfectly consistent positive quality summaries', () => {
  const f = fixture([[0,1,2,3], [1,2,0,3]], points, 0), report = assess(f);
  assert.equal(report.usable, false);
  assert.ok(report.reasons.some(reason => reason.code === 'DUPLICATE_TETRAHEDRA'));
});

test('three tetrahedra incident to one face are blocked as non-manifold', () => {
  const report = assess(fixture([[0,1,2,3], [0,2,1,4], [0,1,2,5]], points, 9));
  assert.equal(report.usable, false);
  assert.ok(report.reasons.some(reason => reason.code === 'NON_MANIFOLD_TETRA_FACES'));
});

test('two positive tetrahedra on the same side of their common face cannot masquerade as a valid interior interface', () => {
  const report = assess(fixture([[0,1,2,3], [0,1,2,5]], points, 6));
  assert.equal(report.usable, false);
  assert.ok(report.reasons.some(reason => reason.code === 'INCONSISTENT_TETRA_FACE_ORIENTATION'));
});

test('a valid pair uses opposite shared-face orientations and counts six exterior triangles', () => {
  const report = assess(fixture([[0,1,2,3], [0,2,1,4]], points, 6));
  assert.equal(report.usable, true, JSON.stringify(report.reasons));
});

test('unshared coincident face nodes reveal a crack despite a successful quality and conformity report', () => {
  const report = assess(fixture([[0,1,2,3], [6,8,7,4]], [...points, 0,0,0, 1,0,0, 0,1,0], 6));
  assert.equal(report.usable, false);
  assert.ok(report.reasons.some(reason => reason.code === 'TETRA_BOUNDARY_COVERAGE_INCONSISTENT'));
});

test('repeated corner nodes invalidate higher-order tetrahedra as well as linear elements', () => {
  const f = admissionFixture();
  Object.assign(f.index.cells[0], { order: 2, elementType: 11, corners: [0,1,1,3] });
  const report = assess(f);
  assert.equal(report.usable, false);
  assert.equal(report.counts.invalidCount, 1);
});
