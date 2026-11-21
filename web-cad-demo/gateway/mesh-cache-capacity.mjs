import fs from 'node:fs';
import path from 'node:path';
const fault = message => Object.assign(Error(message), { code: 'MESH_QUALITY_CACHE_CAPACITY' });
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const doc = /^[A-Za-z0-9_-]{1,64}$/, job = /^mesh-[a-f0-9-]{36}$/, temporary = /^quality-pages-[a-f0-9-]{36}\.tmp$/;
export function meshCachePolicy(dataDir, { maxBytes = 4 * 1024 ** 3, maxJobBytes = Math.min(1024 ** 3, Math.floor(maxBytes / 2)), maxJobs = 10000, maxFiles = 200000, scanBytes = 128 * 1024 ** 2 } = {}) {
    if (![maxBytes, maxJobBytes, maxJobs, maxFiles, scanBytes].every(n => Number.isSafeInteger(n) && n > 0) || maxBytes > 64 * 1024 ** 3 || maxJobBytes > 1024 ** 3 || maxBytes < 2 * maxJobBytes || maxJobs > 100000 || maxFiles > 1000000 || scanBytes > 1024 ** 3)
        throw Error('Invalid mesh cache capacity settings');
    return { dataDir: path.resolve(dataDir), maxBytes, maxJobBytes, maxJobs, maxFiles, scanBytes };
}
function directory(file) {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw fault('缓存目录包含链接或非目录，未自动清理。');
    return stat;
}
function inside(root, file) {
    const target = path.resolve(file);
    if (!target.startsWith(root + path.sep))
        throw fault('缓存位置超出受管范围。');
    const actual = fs.realpathSync.native(path.dirname(target));
    if (actual !== root && !actual.startsWith(root + path.sep))
        throw fault('缓存父目录解析到受管范围之外。');
    return target;
}
function* names(file, scan) {
    const handle = fs.opendirSync(file);
    try {
        for (let entry; (entry = handle.readSync()) !== null;) {
            if (++scan.entries > scan.policy.maxFiles)
                throw fault('缓存清点条目数超过预算，未按不完整清单回收。');
            yield entry.name;
        }
    }
    finally {
        handle.closeSync();
    }
}
function json(file, scan) {
    let fd;
    try {
        const stat = fs.lstatSync(file, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 16n * 1024n * 1024n)
            return null;
        scan.readBytes += Number(stat.size);
        if (scan.readBytes > scan.policy.scanBytes)
            throw fault('缓存清点元数据超过读取预算，未按不完整清单回收。');
        fd = fs.openSync(file, 'r');
        if (!same(stat, fs.fstatSync(fd, { bigint: true })))
            return null;
        const bytes = fs.readFileSync(fd);
        if (!same(stat, fs.fstatSync(fd, { bigint: true })) || !same(stat, fs.lstatSync(file, { bigint: true })))
            return null;
        return { value: JSON.parse(bytes), stat };
    }
    catch (error) {
        if (error.code === 'MESH_QUALITY_CACHE_CAPACITY')
            throw error;
        return null;
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
function inventory(policy) {
    const data = fs.realpathSync.native(policy.dataDir), root = path.join(data, 'mesh-jobs'), scan = { policy, root, jobs: 0, files: 0, entries: 0, readBytes: 0, bytes: 0, caches: [] };
    if (!fs.existsSync(root))
        return scan;
    directory(root);
    for (const d of names(root, scan)) {
        if (!doc.test(d))
            continue;
        const document = path.join(root, d);
        directory(document);
        for (const id of names(document, scan)) {
            if (!job.test(id))
                continue;
            if (++scan.jobs > policy.maxJobs)
                throw fault('缓存清点任务数超过预算，未按不完整清单回收。');
            const base = path.join(document, id);
            directory(base);
            let metadata;
            for (const name of names(base, scan)) {
                if (name !== 'quality-pages' && !temporary.test(name))
                    continue;
                metadata ??= json(path.join(base, 'metadata.json'), scan);
                const record = metadata?.value, owned = record?.version === 1 && record.documentId === d && record.jobId === id && Number.isSafeInteger(record.artifact?.quality?.bytes) && record.artifact.quality.bytes >= 0 && record.artifact.quality.bytes <= 256 * 1024 ** 2 && /^[a-f0-9]{64}$/.test(record.artifact?.quality?.sha256 || '');
                const target = inside(root, path.join(base, name)), stat = directory(target), files = [];
                let size = 0, safe = Boolean(owned), lastUse = Number(stat.mtimeMs);
                for (const leaf of names(target, scan)) {
                    scan.files++;
                    const file = inside(root, path.join(target, leaf)), info = fs.lstatSync(file, { bigint: true });
                    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
                        throw fault('缓存中存在目录、链接或共享文件，未自动清理。');
                    size += Number(info.size);
                    if (!Number.isSafeInteger(size))
                        throw fault('缓存累计大小无效。');
                    if (leaf !== 'manifest.json' && !/^page-(0|[1-9]\d*)\.json$/.test(leaf) && !(temporary.test(name)&&/^sort-(0|[1-9]\d*)\.run$/.test(leaf)))
                        safe = false;
                    files.push({ file, stat: info });
                    if (leaf === 'manifest.json')
                        lastUse = Number(info.mtimeMs);
                }
                scan.bytes += size;
                scan.caches.push({ target, stat, files, bytes: size, safe, lastUse, metadataFile: path.join(base, 'metadata.json'), metadataStat: metadata?.stat });
            }
        }
    }
    return scan;
}
function removeEntry(scan, entry) {
    inside(scan.root, entry.target);
    if (!same(entry.stat, fs.lstatSync(entry.target, { bigint: true })))
        throw fault('缓存在回收前发生变化，已停止清理。');
    if (entry.metadataStat && !same(entry.metadataStat, fs.lstatSync(entry.metadataFile, { bigint: true })))
        throw fault('任务记录在缓存回收前发生变化。');
    // Only known disposable files, no recursive removal and no original artifacts.
    for (const item of entry.files) {
        inside(scan.root, item.file);
        const current = fs.lstatSync(item.file, { bigint: true });
        if (!same(item.stat, current) || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n)
            throw fault('缓存文件在回收前发生变化。');
    }
    for (const item of entry.files.filter(row => path.basename(row.file) !== 'manifest.json')) {
        inside(scan.root, item.file);
        if (!same(item.stat, fs.lstatSync(item.file, { bigint: true })))
            throw fault('缓存文件回收时发生变化。');
        fs.unlinkSync(item.file);
    }
    const manifest = entry.files.find(row => path.basename(row.file) === 'manifest.json');
    if (manifest) {
        inside(scan.root, manifest.file);
        if (!same(manifest.stat, fs.lstatSync(manifest.file, { bigint: true })))
            throw fault('缓存清单回收时发生变化。');
        fs.unlinkSync(manifest.file);
    }
    fs.rmdirSync(entry.target);
}
export function reserveMeshCache(policy, file, reserveBytes = 0) {
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0)
        throw fault('缓存预留大小不合法。');
    try {
        const scan = inventory(policy), actualFile = path.join(fs.realpathSync.native(path.dirname(path.resolve(file))), path.basename(file)), target = inside(scan.root, path.join(path.dirname(actualFile), 'quality-pages'));
        if (path.basename(actualFile) !== 'quality.json' || !job.test(path.basename(path.dirname(actualFile))) || !doc.test(path.basename(path.dirname(path.dirname(actualFile)))) || path.dirname(path.dirname(path.dirname(actualFile))) !== scan.root)
            throw fault('缓存查询不是受管网格任务。');
        if (scan.caches.some(entry => entry.bytes > policy.maxJobBytes && !entry.safe))
            throw fault('超过单任务预算的缓存含有未识别内容，未自动清理。');
        const candidates = scan.caches.filter(entry => (entry.target !== target || entry.bytes > policy.maxJobBytes) && entry.safe).sort((a, b) => Number(b.bytes > policy.maxJobBytes) - Number(a.bytes > policy.maxJobBytes) || a.lastUse - b.lastUse || a.target.localeCompare(b.target));
        let used = scan.bytes, evicted = 0, freedBytes = 0;
        // Refuse without deleting anything if even all safe candidates cannot fit.
        if (used - candidates.reduce((sum, row) => sum + row.bytes, 0) + reserveBytes > policy.maxBytes)
            throw fault('可回收缓存不足以满足预算；未删除原始网格或未知内容。');
        for (const entry of candidates) {
            if (used + reserveBytes <= policy.maxBytes && entry.bytes <= policy.maxJobBytes)
                break;
            removeEntry(scan, entry);
            used -= entry.bytes;
            freedBytes += entry.bytes;
            evicted++;
        }
        return { maxBytes: policy.maxBytes, maxJobBytes: policy.maxJobBytes, observedBytes: scan.bytes, usedBytes: used, reservedBytes: reserveBytes, evicted, freedBytes, retainedCaches: scan.caches.filter(row => !row.safe).length, scannedJobs: scan.jobs, scannedFiles: scan.files, scannedEntries: scan.entries, observedAt: new Date().toISOString() };
    }
    catch (error) {
        if (error.code === 'MESH_QUALITY_CACHE_CAPACITY')
            throw error;
        throw fault('缓存容量检查或回收未完成；原始网格保留。');
    }
}
export function touchMeshCache(file) {
    const manifest = path.join(path.dirname(file), 'quality-pages', 'manifest.json');
    try {
        const now = new Date();
        fs.utimesSync(manifest, now, now);
    }
    catch { /* Touch is an eviction hint, never an integrity proof. */ }
}
export function removeManagedMeshCache(policy, target) {
    const scan = inventory(policy), actual = fs.realpathSync.native(target), entry = scan.caches.find(row => row.target === actual);
    if (!entry || !entry.safe)
        throw fault('缓存包含未识别内容，未覆盖或删除。');
    removeEntry(scan, entry);
}
