import fs from 'node:fs';
import crypto from 'node:crypto';
export const MESH_RENDER_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024 * 1024, chunkBytes: 1024 * 1024, manifestBytes: 16 * 1024 * 1024 });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const error = message => Object.assign(Error('网格显示数据无效：' + message), { code: 'MESH_ARTIFACT_INVALID' });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function open(file, bytes) {
    const entry = fs.lstatSync(file, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== BigInt(bytes))
        throw error('文件类型或长度不匹配。');
    const fd = fs.openSync(file, 'r'), before = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== entry.dev || before.ino !== entry.ino) {
        fs.closeSync(fd);
        throw error('打开时文件身份变化。');
    }
    return { fd, before };
}
export function validateMeshRender(render, { sealed = true } = {}) {
    const storage = render?.storage;
    if (!storage)
        return false;
    if (storage.version !== 1 || storage.format !== 'float64-le' || !integer(storage.bytes) || storage.bytes > MESH_RENDER_LIMITS.fileBytes || sealed && !/^[a-f0-9]{64}$/.test(storage.sha256 || '') || render.kind !== 'wire' || render.dimension !== 3 || !Array.isArray(render.wires) || !Array.isArray(render.groups) || render.positions?.length || render.wirePositions?.length)
        throw error('不支持的分块存储契约。');
    const keys = new Map(), ranges = [];
    for (const wire of render.wires) {
        if (!/^wire-[23]-[1-9]\d*$/.test(wire.key) || keys.has(wire.key) || !integer(wire.scalars) || wire.scalars % 6 || !Array.isArray(wire.chunks))
            throw error('网格线清单无效。');
        keys.set(wire.key, wire);
        let bytes = 0;
        for (const chunk of wire.chunks) {
            if (!integer(chunk.offset) || !integer(chunk.bytes) || !chunk.bytes || chunk.bytes > MESH_RENDER_LIMITS.chunkBytes || chunk.bytes % 48 || chunk.offset + chunk.bytes > storage.bytes || sealed && !/^[a-f0-9]{64}$/.test(chunk.sha256 || ''))
                throw error('数据块范围或凭据无效。');
            bytes += chunk.bytes;
            ranges.push(chunk);
        }
        if (bytes !== wire.scalars * 8)
            throw error('网格线数量与块长度不一致。');
    }
    ranges.sort((a, b) => a.offset - b.offset);
    let offset = 0;
    for (const chunk of ranges) {
        if (chunk.offset !== offset)
            throw error('数据块重复、交叠或存在缺口。');
        offset += chunk.bytes;
    }
    if (offset !== storage.bytes)
        throw error('数据块没有覆盖整个显示文件。');
    const used = new Set(), visit = groups => { for (const group of groups) {
        const wire = keys.get(group.wireKey);
        if (!wire || group.wirePositions?.length)
            throw error('分组缺少唯一显示来源。');
        const tag = group.kind === 'solid' ? /^solid-([1-9]\d*)$/.exec(group.solidId || '') : /^(?:mesh-)?face-([1-9]\d*)$/.exec(group.meshFaceId || group.faceId || '');
        if (!tag || group.wireKey !== `wire-${group.kind === 'solid' ? 3 : 2}-${tag[1]}`)
            throw error('显示来源与体/面编号不一致。');
        used.add(group.wireKey);
        if (group.faces)
            visit(group.faces);
    } };
    visit(render.groups);
    if (used.size !== keys.size)
        throw error('存在未归属的显示数据。');
    return { keys, ranges };
}
export function sealMeshRender(render, file) {
    const { ranges } = validateMeshRender(render, { sealed: false }), { fd, before } = open(file, render.storage.bytes), whole = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(MESH_RENDER_LIMITS.chunkBytes);
    try {
        for (const chunk of ranges) {
            const bytes = buffer.subarray(0, chunk.bytes);
            if (fs.readSync(fd, bytes, 0, bytes.length, chunk.offset) !== bytes.length)
                throw error('数据块不完整。');
            for (let i = 0; i < bytes.length; i += 8)
                if (!Number.isFinite(bytes.readDoubleLE(i)))
                    throw error('存在非有限坐标。');
            chunk.sha256 = sha(bytes);
            whole.update(bytes);
        }
        if (!same(before, fs.fstatSync(fd, { bigint: true })))
            throw error('封存时文件发生变化。');
        const digest = { bytes: render.storage.bytes, sha256: whole.digest('hex') };
        render.storage.sha256 = digest.sha256;
        return digest;
    }
    finally {
        fs.closeSync(fd);
    }
}
export function readRenderManifest(file, expected, jobId) {
    if (!integer(expected?.bytes) || expected.bytes > MESH_RENDER_LIMITS.manifestBytes)
        throw error('显示清单超出读取预算。');
    const { fd, before } = open(file, expected.bytes);
    try {
        const bytes = Buffer.allocUnsafe(expected.bytes);
        if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || sha(bytes) !== expected.sha256 || !same(before, fs.fstatSync(fd, { bigint: true })))
            throw error('显示清单校验失败。');
        const result = JSON.parse(bytes);
        if (!result.ok || result.requestId !== jobId)
            throw error('显示清单任务身份不匹配。');
        validateMeshRender(result.mesh?.render);
        return result.mesh.render;
    }
    finally {
        fs.closeSync(fd);
    }
}
export function readMeshRenderChunk(file, render, wireKey, index) {
    const wire = render.wires.find(row => row.key === wireKey), chunk = wire?.chunks[index];
    if (!chunk)
        throw Object.assign(Error('显示分组或数据块不存在。'), { code: 'MESH_RENDER_QUERY_INVALID' });
    const { fd, before } = open(file, render.storage.bytes);
    try {
        const bytes = Buffer.allocUnsafe(chunk.bytes);
        if (fs.readSync(fd, bytes, 0, bytes.length, chunk.offset) !== bytes.length || sha(bytes) !== chunk.sha256 || !same(before, fs.fstatSync(fd, { bigint: true })))
            throw error('显示数据块校验失败。');
        return bytes;
    }
    finally {
        fs.closeSync(fd);
    }
}
