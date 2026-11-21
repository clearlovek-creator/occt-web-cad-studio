import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assessMeshSource } from '../shared/mesh-source.mjs';

const fail = (code, message) => Object.assign(Error(message), { code });
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const digestSame = (a, b) => a.bytes === b?.bytes && a.sha256 === b.sha256;
export const PREPARATION_MANIFEST_BYTES = 16 * 1024 * 1024;

/** Derive every path from validated task identities, never from model/provider input. */
export function preparationPaths(dataDir, job, { create = false } = {}) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(job.documentId) || !/^mesh-[a-f0-9-]{36}$/.test(job.jobId))
        throw fail('MESH_PREPARATION_IO', '修复快照任务身份不合法。');
    const root = fs.realpathSync(dataDir);
    const directory = parts => {
        let current = root;
        for (const part of parts) {
            current = path.join(current, part);
            if (create) try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw fail('MESH_PREPARATION_IO', '无法准备修复快照目录：' + error.message); }
            const stat = fs.lstatSync(current);
            if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(root, fs.realpathSync(current)) !== path.relative(root, current))
                throw fail('MESH_PREPARATION_IO', '修复快照目录不是受管的普通目录。');
        }
        return current;
    };
    const sources = directory(['mesh-sources']), task = directory(['mesh-jobs', job.documentId, job.jobId]);
    const source = path.join(sources, `${job.documentId}-${job.jobId}.brep`);
    return { task, source, sourceManifest: source + '.manifest.json', brep: path.join(task, 'prepared.brep'), manifest: path.join(task, 'prepared-manifest.json') };
}

function checked(file, maxBytes, action) {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
        throw fail('MESH_ARTIFACT_INVALID', '修复快照文件必须为非链接的普通文件。');
    if (before.size > BigInt(maxBytes)) throw fail('MESH_ARTIFACT_LIMIT', '修复快照超过读取预算，原文件保留。');
    const fd = fs.openSync(file, 'r');
    try {
        if (!same(before, fs.fstatSync(fd, { bigint: true }))) throw fail('MESH_ARTIFACT_INVALID', '修复快照打开时发生变化。');
        const result = action(fd, Number(before.size));
        if (!same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, fs.lstatSync(file, { bigint: true })))
            throw fail('MESH_ARTIFACT_INVALID', '修复快照读取时发生变化。');
        return result;
    } finally { fs.closeSync(fd); }
}

export function readPreparationManifest(file, source, expected) {
    return checked(file, PREPARATION_MANIFEST_BYTES, (fd, size) => {
        const bytes = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
            const count = fs.readSync(fd, bytes, offset, Math.min(1024 * 1024, size - offset), null);
            if (!count) throw fail('MESH_ARTIFACT_INVALID', '修复来源清单不完整。');
            offset += count;
        }
        const proof = { bytes: size, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        if (expected && !digestSame(proof, expected)) throw fail('MESH_ARTIFACT_INVALID', '修复来源清单内容凭据不匹配。');
        let manifest;
        try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw fail('MESH_SOURCE_MANIFEST_INVALID', '修复来源清单不是有效的 UTF-8 JSON。'); }
        if (!source || !manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.revision !== source.revision || assessMeshSource(source, { ...manifest, bodyMetadata: manifest.bodies }, source.documentId).status !== 'current')
            throw fail('MESH_SOURCE_MANIFEST_INVALID', 'BREP 清单与工程身份不一致，未执行剖分。');
        return { manifest, proof };
    });
}

/** Hash the exact bytes copied from one checked FD. Fixed 1 MiB buffer, exclusive staging. */
export function copyPreparationFile(file, target, expected, maxBytes = 2 * 1024 ** 3) {
    return checked(file, maxBytes, (input, size) => {
        const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
        let output;
        try { output = fs.openSync(target, 'wx'); }
        catch (error) { throw fail('MESH_PREPARATION_IO', '无法创建修复快照暂存文件：' + error.message); }
        try {
            let total = 0;
            while (total < size) {
                const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, size - total), null);
                if (!count) throw fail('MESH_ARTIFACT_INVALID', '修复快照复制时意外截断。');
                hash.update(buffer.subarray(0, count));
                let offset = 0;
                while (offset < count) {
                    let written;
                    try { written = fs.writeSync(output, buffer, offset, count - offset); }
                    catch (error) { throw fail('MESH_PREPARATION_IO', '无法写入修复快照：' + error.message); }
                    if (!written) throw fail('MESH_PREPARATION_IO', '修复快照写入未取得进展。');
                    offset += written;
                }
                total += count;
            }
            const proof = { bytes: total, sha256: hash.digest('hex') };
            if (expected && !digestSame(proof, expected)) throw fail('MESH_ARTIFACT_INVALID', '复制的修复快照与已验证内容不一致。');
            try { fs.fsyncSync(output); }
            catch (error) { throw fail('MESH_PREPARATION_IO', '无法封存修复快照：' + error.message); }
            return { proof, identity: fs.fstatSync(output, { bigint: true }) };
        } finally { fs.closeSync(output); }
    });
}

export function stagePreparationFiles({ dataDir, job, targetJob = job, staging, reuse = false }) {
    if (job.documentId !== targetJob.documentId || targetJob.state !== 'preparing')
        throw fail('MESH_PREPARATION_IO', '修复快照不能跨工程或写入已完成任务。');
    const input = preparationPaths(dataDir, job, { create: true }), output = preparationPaths(dataDir, targetJob, { create: true });
    if (path.relative(output.task, path.dirname(staging)) !== '' || !/^artifact-[a-f0-9-]{36}\.result\.tmp$/.test(path.basename(staging)))
        throw fail('MESH_PREPARATION_IO', '修复快照暂存位置不合法。');
    const brep = reuse ? input.brep : input.source, manifest = reuse ? input.manifest : input.sourceManifest;
    if (reuse && (!job.artifact?.preparedBrep || !job.artifact?.preparedManifest))
        throw fail('MESH_ARTIFACT_INVALID', '修复预览缺少快照内容凭据。');
    if (reuse && assessMeshSource(job.source, { bodyMetadata: targetJob.source?.bodies }, targetJob.documentId).status !== 'current')
        throw fail('MESH_SOURCE_MANIFEST_INVALID', '修复预览与当前任务的几何身份不一致。');
    const read = readPreparationManifest(manifest, reuse ? job.source : targetJob.source, reuse ? job.artifact.preparedManifest : undefined);
    const brepCopy = copyPreparationFile(brep, staging + '.brep', reuse ? job.artifact.preparedBrep : undefined);
    const manifestCopy = copyPreparationFile(manifest, staging + '.manifest', read.proof, PREPARATION_MANIFEST_BYTES);
    return { manifest: read.manifest, artifact: { preparedBrep: brepCopy.proof, preparedManifest: manifestCopy.proof }, files: [
        { suffix: '.brep', identity: brepCopy.identity }, { suffix: '.manifest', identity: manifestCopy.identity },
    ] };
}
