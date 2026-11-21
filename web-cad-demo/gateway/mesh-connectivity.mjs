/** Exact corner connectivity, not a geometric intersection or curved-node test.
 * Packed keys avoid retaining four string-keyed face objects per tetrahedron. */
export const MESH_CONNECTIVITY_LIMITS = Object.freeze({ initialCapacity: 1024, tetraCapacity: 1 << 22, faceCapacity: 1 << 24, maxProbes: 1024, samples: 8 });
const limited = message => Object.assign(Error('网格连接检查超限：' + message), { code: 'MESH_ARTIFACT_LIMIT' });
function allocate(capacity, width) {
  try { return new Uint32Array(capacity * width); }
  catch { throw limited('无法分配受管连接索引，原始材料保留。'); }
}
const powerOfTwo = value => Number.isSafeInteger(value) && value >= 8 && value <= 1 << 24 && (value & (value - 1)) === 0;
export function connectivityHash(key) {
  let hash = 2166136261;
  for (const value of key) hash = Math.imul(hash ^ value, 16777619);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** Zero is an empty sentinel; each node index is stored plus one. Every hash
 * match compares the full tuple, so collisions never equate different faces. */
export class PackedConnectivityIndex {
  constructor(keySize, { initialCapacity = MESH_CONNECTIVITY_LIMITS.initialCapacity, maxCapacity = MESH_CONNECTIVITY_LIMITS.faceCapacity, maxProbes = MESH_CONNECTIVITY_LIMITS.maxProbes } = {}) {
    if (![3, 4].includes(keySize) || !powerOfTwo(initialCapacity) || !powerOfTwo(maxCapacity) || initialCapacity > maxCapacity || !Number.isSafeInteger(maxProbes) || maxProbes < 1 || maxProbes > 65536) throw limited('索引预算配置不合法。');
    Object.assign(this, { keySize, width: keySize + 1, capacity: initialCapacity, maxCapacity, maxProbes, size: 0, peakBytes: 0 });
    this.slots = allocate(initialCapacity, this.width);
    this.peakBytes = this.slots.byteLength;
  }
  find(key) {
    let slot = connectivityHash(key) & (this.capacity - 1);
    for (let probe = 0; probe < Math.min(this.capacity, this.maxProbes); probe++) {
      const offset = slot * this.width;
      if (this.slots[offset] === 0) return ~offset;
      let equal = true;
      for (let i = 0; i < this.keySize; i++) if (this.slots[offset + i] !== key[i] + 1) { equal = false; break; }
      if (equal) return offset;
      slot = (slot + 1) & (this.capacity - 1);
    }
    throw limited('哈希探测超过预算，未将未检查连接判为有效。');
  }
  grow() {
    if (this.capacity === this.maxCapacity) throw limited('连接数量超过受管索引容量。');
    const old = this.slots, oldCapacity = this.capacity, nextCapacity = this.capacity * 2, next = allocate(nextCapacity, this.width);
    this.capacity = nextCapacity;
    this.slots = next;
    this.peakBytes = Math.max(this.peakBytes, old.byteLength + this.slots.byteLength);
    try {
      for (let offset = 0; offset < old.length; offset += this.width) if (old[offset]) {
        const key = Array.from({ length: this.keySize }, (_, i) => old[offset + i] - 1), target = ~this.find(key);
        for (let i = 0; i < this.width; i++) this.slots[target + i] = old[offset + i];
      }
    } catch (error) {
      this.capacity = oldCapacity; this.slots = old; throw error;
    }
  }
  /** Negative return: complemented offset of a new key. Nonnegative: existing. */
  track(key, value = 1) {
    if (key.length !== this.keySize || key.some(node => !Number.isSafeInteger(node) || node < 0 || node > 0xfffffffe)) throw limited('节点编号超出精确打包范围。');
    let offset = this.find(key);
    if (offset >= 0) return offset;
    if ((this.size + 1) * 10 > this.capacity * 7) { this.grow(); offset = this.find(key); }
    const target = ~offset;
    for (let i = 0; i < this.keySize; i++) this.slots[target + i] = key[i] + 1;
    this.slots[target + this.keySize] = value;
    this.size++;
    return offset;
  }
}

export class TetraConnectivity {
  constructor(options = {}) {
    this.tetra = new PackedConnectivityIndex(4, { maxCapacity: MESH_CONNECTIVITY_LIMITS.tetraCapacity, ...options.tetra });
    this.faces = new PackedConnectivityIndex(3, { maxCapacity: MESH_CONNECTIVITY_LIMITS.faceCapacity, ...options.faces });
    this.counts = { checkedTetraCount: 0, duplicateTetraCount: 0, boundaryFaceCount: 0, interiorFaceCount: 0, nonManifoldFaceCount: 0, inconsistentOrientationFaceCount: 0 };
    this.samples = [];
  }
  sample(kind, nodes, cell) {
    if (this.samples.length >= MESH_CONNECTIVITY_LIMITS.samples) return;
    const id=String(cell.elementId),truncated=id.length>80;
    this.samples.push({ kind, nodeIndexes: [...nodes], elementId: id.slice(0,80), ...(truncated?{elementIdTruncated:true}:{}), cellNodeIndexes:[...cell.corners],
      rawCell:truncated?null:{elementId:id,elementType:cell.elementType,order:cell.order,volumeTag:cell.volumeTag,quality:cell.quality,minJacobian:cell.minJacobian,maxJacobian:cell.maxJacobian,corners:[...cell.corners],bodyIds:[...(cell.bodyIds||[])]} });
  }
  add(cell) {
    const key = [...cell.corners].sort((a, b) => a - b);
    // Invalid cells are classified by numerical admission; do not construct
    // fictitious faces from a collapsed or out-of-range simplex.
    if (key.length !== 4 || key.some((node, i) => !Number.isSafeInteger(node) || node < 0 || (i && node === key[i - 1]))) return;
    this.counts.checkedTetraCount++;
    if (this.tetra.track(key) >= 0) { this.counts.duplicateTetraCount++; this.sample('duplicate-tetra', key, cell); }
    const n = cell.corners;
    for (const face of [[n[1], n[2], n[3]], [n[0], n[3], n[2]], [n[0], n[1], n[3]], [n[0], n[2], n[1]]]) {
      const parity = ((face[0] > face[1]) + (face[0] > face[2]) + (face[1] > face[2])) % 2;
      face.sort((a, b) => a - b);
      const offset = this.faces.track(face, 1 | (parity << 2));
      if (offset < 0) { this.counts.boundaryFaceCount++; continue; }
      const position = offset + 3, state = this.faces.slots[position], count = state & 3;
      if (count === 1) {
        this.counts.boundaryFaceCount--; this.counts.interiorFaceCount++;
        if ((state >> 2 & 1) === parity) { this.counts.inconsistentOrientationFaceCount++; this.sample('face-orientation', face, cell); }
      } else if (count === 2) {
        this.counts.interiorFaceCount--; this.counts.nonManifoldFaceCount++; this.sample('non-manifold-face', face, cell);
      }
      this.faces.slots[position] = (state & ~3) | Math.min(3, count + 1);
    }
  }
  finish() {
    return { version: 1, basis: 'tetra-corner-connectivity-v1', ...this.counts, samples: this.samples,
      resources: { packedBytes: this.tetra.slots.byteLength + this.faces.slots.byteLength, maxSingleIndexResizeBytes: Math.max(this.tetra.peakBytes, this.faces.peakBytes), tetraCapacity: this.tetra.capacity, faceCapacity: this.faces.capacity } };
  }
}
