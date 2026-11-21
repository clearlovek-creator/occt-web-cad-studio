import test from 'node:test';
import assert from 'node:assert/strict';
import { PackedConnectivityIndex, TetraConnectivity, connectivityHash } from '../gateway/mesh-connectivity.mjs';
import { tetraStrip } from './helpers/tetra-strip.mjs';

function collidingKeys() {
  const buckets = new Map();
  for (let n = 0; n < 1000; n++) {
    const key = [n,n+1,n+2,n+3], bucket = connectivityHash(key) & 7;
    if (buckets.has(bucket)) return [buckets.get(bucket), key];
    buckets.set(bucket, key);
  }
  throw Error('No deterministic fixture collision');
}

test('packed tuples compare every node after a hash collision and never overwrite stored payloads', () => {
  const table = new PackedConnectivityIndex(4, { initialCapacity: 8, maxCapacity: 8 }), [a,b] = collidingKeys();
  assert.ok(table.track(a, 71) < 0); assert.ok(table.track(b, 29) < 0);
  assert.notEqual(table.track(a), table.track(b));
  assert.equal(table.slots[table.track(a) + 4], 71);
  assert.equal(table.slots[table.track(b) + 4], 29);
  assert.equal(table.size, 2);
});

test('resizing retains exact three/four-node tuples, payloads and the live-buffer accounting', () => {
  for (const width of [3,4]) {
    const table = new PackedConnectivityIndex(width, { initialCapacity: 8, maxCapacity: 512 });
    const keys = Array.from({length:150}, (_,i) => Array.from({length:width}, (_,j) => i*10+j));
    keys.forEach((key,i) => assert.ok(table.track(key, i+1) < 0));
    keys.forEach((key,i) => assert.equal(table.slots[table.track([...key]) + width], i+1));
    assert.equal(table.size, 150);
    assert.ok(table.peakBytes <= table.slots.byteLength * 1.5);
  }
});

test('capacity and probe exhaustion are explicit resource failures, not geometric corruption or partial success', () => {
  const table = new PackedConnectivityIndex(4, { initialCapacity: 8, maxCapacity: 8 });
  for (let n=0;n<5;n++) table.track([n*4,n*4+1,n*4+2,n*4+3]);
  assert.throws(() => table.track([40,41,42,43]), {code:'MESH_ARTIFACT_LIMIT'});
  assert.ok(table.track([0,1,2,3]) >= 0, 'An existing key needs no larger table.');
  const narrow = new PackedConnectivityIndex(4, { initialCapacity: 8, maxCapacity: 8, maxProbes: 1 }), [a,b] = collidingKeys();
  narrow.track(a);
  assert.throws(() => narrow.track(b), {code:'MESH_ARTIFACT_LIMIT'});
});

test('node zero and the largest supported node remain distinct without Uint32 wrapping', () => {
  const table = new PackedConnectivityIndex(4);
  const key = [0,1,2,0xfffffffe];
  assert.ok(table.track(key) < 0); assert.ok(table.track(key) >= 0);
  for (const bad of [-1,0xffffffff,2**40,NaN,.5]) assert.throws(() => table.track([0,1,2,bad]), {code:'MESH_ARTIFACT_LIMIT'});
});

test('allocation failure is a resource error and cannot replace the last complete table', () => {
  const table = new PackedConnectivityIndex(4, { initialCapacity: 8, maxCapacity: 16 });
  for (let n=0;n<5;n++) table.track([n*4,n*4+1,n*4+2,n*4+3]);
  const original = globalThis.Uint32Array, before = table.slots;
  globalThis.Uint32Array = class extends original { constructor() { throw new RangeError('test-only allocation failure'); } };
  try { assert.throws(() => table.track([40,41,42,43]), {code:'MESH_ARTIFACT_LIMIT'}); }
  finally { globalThis.Uint32Array = original; }
  assert.equal(table.slots, before); assert.equal(table.capacity, 8); assert.equal(table.size, 5);
  assert.ok(table.track([0,1,2,3])>=0);
});

test('a conforming 1200-cell strip has exact exterior coverage without face orientation or manifold errors', () => {
  const strip = tetraStrip(1200, {elementId:'1'}), collector = new TetraConnectivity();
  for (const cell of strip.cells) collector.add(cell);
  const result = collector.finish();
  assert.equal(result.checkedTetraCount, 1200);
  assert.equal(result.boundaryFaceCount, 8*200+4);
  assert.equal(result.boundaryFaceCount, strip.boundaryFaceCount);
  assert.equal(result.duplicateTetraCount, 0); assert.equal(result.nonManifoldFaceCount, 0); assert.equal(result.inconsistentOrientationFaceCount, 0);
  assert.deepEqual(result.samples, []);
});

test('diagnostic samples and very large element IDs remain bounded without changing exact counts', () => {
  const collector = new TetraConnectivity(), cell = {corners:[0,1,2,3],elementId:'9'.repeat(10000)};
  for (let n=0;n<30;n++) collector.add(cell);
  const result=collector.finish();
  assert.equal(result.duplicateTetraCount, 29);
  assert.equal(result.nonManifoldFaceCount, 4);
  assert.ok(result.samples.length<=8); assert.ok(result.samples.every(sample=>sample.elementId.length<=80));
});
