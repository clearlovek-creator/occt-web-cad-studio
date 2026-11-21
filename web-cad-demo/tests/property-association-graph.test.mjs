import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePropertySchema } from '../gateway/property-associations.mjs';
import { queryMeshBoundary } from '../gateway/mesh-boundary-query.mjs';

const bodyIdentity = 'a'.repeat(32);
const anchor = (revision, index = 1) => ({ kind: 'face', bodyId: 'body-1', topologyId: `face-${revision}-${index}`, topologyRevision: revision, bodyIdentity, topologyIdentity: revision.toString(16).padStart(32, '0') });
const lineage = (source, destinations) => ({ computedRevision: 9, topologyLineage: { version: 1, basis: 'occt-history', state: 'current', resultRevision: 9, entries: [{ sourceBodyId: source.bodyId, sourceTopologyId: source.topologyId, sourceBodyIdentity: source.bodyIdentity, sourceTopologyIdentity: source.topologyIdentity, inputPreserved: false, destinations }] } });
const geometry = features => ({ revision: 9, bodyMetadata: [{ bodyId: 'body-1', bodyIdentity, topologyIdentity: anchor(9).topologyIdentity, topologyRevision: 9, faceCount: 6, edgeCount: 12 }], features });
const schema = (multiple = false) => ({ types: multiple ? [{ typeId: 'set', targetMode: 'multiple', splitPolicy: 'all-descendants' }] : [], instances: [{ instanceId: 'boundary', typeId: 'set', state: 'active', ...(multiple ? { target: null, targets: [anchor(1)] } : { target: anchor(1) }), value: { frequency: '3 GHz' } }] });

test('a reachable lineage cycle never silently drops a branch and declares a face association active', () => {
    for (const multiple of [false, true]) for (const selfLoop of [false, true]) {
        const stored = schema(multiple), before = structuredClone(stored);
        const resolved = resolvePropertySchema(stored, geometry([lineage(anchor(1), [anchor(selfLoop ? 1 : 2), anchor(9)]), ...(!selfLoop ? [lineage(anchor(2), [anchor(1)])] : [])])).instances[0];
        assert.equal(resolved.state, 'needs-review');
        assert.match(resolved.stateReason + ' ' + (resolved.association.members?.[0]?.reason || ''), /循环/);
        assert.equal(resolved.association.candidates.length, 1, 'A proven current candidate remains available for explicit repair.');
        assert.deepEqual(stored, before, 'A diagnostic read must never rewrite stored anchors or values.');
    }
});

test('an unresolved branch remains unresolved even beside several verified current candidates', () => {
    const result = resolvePropertySchema(schema(), geometry([lineage(anchor(1), [anchor(2), anchor(9), anchor(9, 2)]), lineage(anchor(2), [anchor(1)])])).instances[0];
    assert.equal(result.state, 'needs-review');
    assert.equal(result.association.status, 'unresolved');
    assert.equal(result.association.candidates.length, 2);
});

test('convergent diamond lineage is not a cycle and preserves the one proven current face', () => {
    const result = resolvePropertySchema(schema(), geometry([lineage(anchor(1), [anchor(2), anchor(3)]), lineage(anchor(2), [anchor(4)]), lineage(anchor(3), [anchor(4)]), lineage(anchor(4), [anchor(9)])])).instances[0];
    assert.equal(result.state, 'active');
    assert.equal(result.target.topologyId, 'face-9-1');
    assert.equal(result.association.candidates.length, 1);
});

test('a cycle disconnected from an association cannot invalidate its independently verified path', () => {
    const result = resolvePropertySchema(schema(), geometry([lineage(anchor(1), [anchor(9)]), lineage(anchor(2), [anchor(3)]), lineage(anchor(3), [anchor(2)])])).instances[0];
    assert.equal(result.state, 'active');
});

test('resolved graph integrity gates the actual mesh-boundary property join, not just a display label', () => {
    const view = geometry([]), source = { ...view.bodyMetadata[0], cadFaceId: 'face-9-1' };
    const mapping = { version: 1, backend: 'occt-history', complete: true, sourceFaces: [{ source, state: 'mapped', surfaceTags: [1] }], surfaces: [{ surfaceTag: 1, meshFaceId: 'mesh-face-1', area: 1, elementCount: 1, adjacentSolidIds: ['solid-1'], sources: [source] }] };
    const job = { source: { bodies: view.bodyMetadata } };
    view.features = [lineage(anchor(1), [anchor(9)])];
    const verified = queryMeshBoundary(mapping, job, {}, resolvePropertySchema(schema(), view), true);
    assert.equal(verified.sourceFaces[0].properties[0].value.frequency, '3 GHz');
    view.features = [lineage(anchor(1), [anchor(2), anchor(9)]), lineage(anchor(2), [anchor(1)])];
    const unresolved = queryMeshBoundary(mapping, job, {}, resolvePropertySchema(schema(), view), true);
    assert.deepEqual(unresolved.sourceFaces[0].properties, []);
    assert.equal(unresolved.unresolvedProperties[0].instanceId, 'boundary');
    assert.match(unresolved.unresolvedProperties[0].reason, /循环/);
});

test('a malformed lineage branch is unresolved, never treated as a proven deletion beside a valid candidate', () => {
    const badTargets = [null, {}, { ...anchor(9), kind: 'edge' }, { ...anchor(9), topologyId: 'edge-9-1' }, { ...anchor(9), topologyId: 'face-09-1' }, { ...anchor(9), topologyRevision: 8 }, { ...anchor(9), bodyIdentity: 1 }];
    for (const target of badTargets) {
        const result = resolvePropertySchema(schema(), geometry([lineage(anchor(1), [anchor(9), target])])).instances[0];
        assert.equal(result.state, 'needs-review', JSON.stringify(target));
        assert.match(result.stateReason, /不完整|无效/);
        assert.equal(result.association.candidates.length, 1);
    }
    for (const destinations of [undefined, {}, 'not-a-list']) {
        const result = resolvePropertySchema(schema(), geometry([lineage(anchor(1), destinations)])).instances[0];
        assert.equal(result.state, 'needs-review');
    }
});

test('an oversized successor list is bounded before the full branch can be enqueued', () => {
    let observed = 0;
    const destinations = new Proxy(Array.from({ length: 100000 }, (_, index) => anchor(2, index + 1)), { get(target, key, receiver) { if (/^\d+$/.test(String(key))) observed++; return Reflect.get(target, key, receiver); } });
    const stored = schema(), result = resolvePropertySchema(stored, geometry([lineage(anchor(1), destinations)])).instances[0];
    assert.equal(result.state, 'needs-review');
    assert.ok(observed <= 10001, `Expanded ${observed} successors before enforcing the branch limit.`);
    assert.deepEqual(result.target, stored.instances[0].target);
});

test('many empty or preserved lineage records cannot bypass the per-anchor work budget', () => {
    for (const preserved of [false, true]) {
        let observed = 0;
        const feature = lineage(anchor(1), []), entry = feature.topologyLineage.entries[0];
        Object.defineProperty(entry, 'inputPreserved', { get() { observed++; return preserved; } });
        feature.topologyLineage.entries = Array(100000).fill(entry);
        const result = resolvePropertySchema(schema(), geometry([feature])).instances[0];
        assert.equal(result.state, 'needs-review');
        assert.ok(observed <= 10001, `Inspected ${observed} records before the work budget.`);
    }
});

test('long acyclic lineage resolves without recursive stack growth', () => {
    const finalRevision=3001;
    const features = Array.from({ length: 3000 }, (_, index) => {
        const feature=lineage(anchor(index + 1), [anchor(index + 2)]);
        feature.computedRevision=index+2;feature.topologyLineage.resultRevision=index+2;
        return feature;
    });
    // Keep a genuinely forward, 3000-operation history. The former fixture
    // claimed R9 output while containing future R3000 destinations.
    const current=geometry(features);current.revision=finalRevision;current.bodyMetadata[0].topologyRevision=finalRevision;current.bodyMetadata[0].topologyIdentity=anchor(finalRevision).topologyIdentity;
    const result = resolvePropertySchema(schema(), current).instances[0];
    assert.equal(result.state, 'active');
    assert.equal(result.target.topologyId, 'face-3001-1');
});
