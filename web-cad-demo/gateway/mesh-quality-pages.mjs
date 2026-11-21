import fs from 'node:fs';
import { addQualityValue } from '../shared/mesh-statistics.mjs';
import { reserveMeshCache, touchMeshCache, removeManagedMeshCache } from './mesh-cache-capacity.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateQualityIndex, normalizeMeshQualityQuery } from './mesh-quality-query.mjs';
import { qualityCellState } from '../shared/mesh-admission.mjs';
import { stageQualityPages } from './mesh-quality-page-builder.mjs';
export const QUALITY_PAGE_LIMITS = Object.freeze({ sourceBytes: 256 * 1024 * 1024, manifestBytes: 16 * 1024 * 1024, pageBytes: 512 * 1024, pageCells: 1024, cacheBytes: 1024 * 1024 * 1024, queryBytes: 16 * 1024 * 1024 });
const fail = (code, message) => Object.assign(new Error(message), { code });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceKey = job => sha(JSON.stringify(job.source));
const rank = cell => cell.invalid ? 0 : cell.inverted ? 1 : cell.degenerate ? 2 : 3;
const hard = cell => cell.invalid || cell.inverted || cell.degenerate;
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
export const qualityPagesPath = file => path.join(path.dirname(file), 'quality-pages');
export function removeQualityStaging(file, staging) {
    const base = path.dirname(path.resolve(file)), target = path.resolve(staging);
    if (path.dirname(target) !== base || !/^quality-pages-[a-f0-9-]{36}\.tmp$/.test(path.basename(target)))
        throw fail('MESH_QUALITY_CACHE_PATH', '拒绝清理受管范围外的查询缓存。');
    if (fs.existsSync(target)) {
        if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())
            throw fail('MESH_QUALITY_CACHE_PATH', '查询缓存目录类型无效。');
        fs.rmSync(target, { recursive: true, force: true });
    }
}
export async function removeQualityStagingAsync(file, staging) {
    const base = path.dirname(path.resolve(file)), target = path.resolve(staging);
    if (path.dirname(target) !== base || !/^quality-pages-[a-f0-9-]{36}\.tmp$/.test(path.basename(target)))
        throw fail('MESH_QUALITY_CACHE_PATH', '拒绝清理受管范围外的查询缓存。');
    let stat;
    try {
        stat = await fs.promises.lstat(target);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw fail('MESH_QUALITY_CACHE_PATH', '查询暂存目录类型无效。');
    const actualBase = await fs.promises.realpath(base), actual = await fs.promises.realpath(target);
    if (path.dirname(actual) !== actualBase)
        throw fail('MESH_QUALITY_CACHE_PATH', '查询暂存目录解析到受管范围之外。');
    await fs.promises.rm(target, { recursive: true, force: true });
}
/** Hash the exact bytes of one regular open file. Collected bytes are the same
 * bytes parsed, never a second path read after verification. */
function checked(file, expected, maxBytes, collect = false, code = 'MESH_QUALITY_CACHE_INVALID') {
    let fd;
    try {
        const entry = fs.lstatSync(file, { bigint: true });
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size > BigInt(maxBytes))
            throw Error('文件类型或大小不合法');
        fd = fs.openSync(file, 'r');
        const before = fs.fstatSync(fd, { bigint: true });
        if (before.dev !== entry.dev || before.ino !== entry.ino)
            throw Error('文件身份已变化');
        const hash = crypto.createHash('sha256'), collected = collect ? Buffer.allocUnsafe(Number(before.size)) : null, buffer = Buffer.allocUnsafe(1024 * 1024);
        let bytes = 0, n;
        while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            bytes += n;
            if (bytes > maxBytes || collect && bytes > collected.length)
                throw Error('文件超出字节限制');
            const part = buffer.subarray(0, n);
            hash.update(part);
            if (collect)
                part.copy(collected, bytes - n);
        }
        const after = fs.fstatSync(fd, { bigint: true }), digest = { bytes, sha256: hash.digest('hex') };
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || expected && (digest.bytes !== expected.bytes || digest.sha256 !== expected.sha256))
            throw Error('内容校验失败');
        return { digest, buffer: collect ? collected.subarray(0, bytes) : null };
    }
    catch (error) {
        throw fail(code, `${code === 'MESH_ARTIFACT_INVALID' ? '网格质量原始索引' : '查询缓存'}缺失、损坏或在读取中变化：${error.message}`);
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
function freshSummary() { return { tetraCount: 0, finiteCount: 0, nonFiniteQualityCount: 0, hardBadCount: 0, badCount: 0, invertedCount: 0, degenerateCount: 0, invalidCount: 0, minQuality: null, maxQuality: null, sum: 0, compensation: 0, outOfRangeCount: 0, histogram: Array.from({ length: 11 }, (_, i) => ({ lower: i === 0 ? -1 : (i - 1) / 10, upper: i === 0 ? 0 : i / 10, includeUpper: i === 10, count: 0 })) }; }
function add(summary, cell) {
    summary.tetraCount++;
    if (hard(cell))
        summary.hardBadCount++;
    for (const type of ['invalid', 'inverted', 'degenerate'])
        if (cell[type])
            summary[type + 'Count']++;
    if (cell.quality === null)
        summary.nonFiniteQualityCount++;
    else {
        const q = cell.quality;
        summary.finiteCount++;
        addQualityValue(summary, q);
        summary.minQuality = summary.minQuality === null ? q : Math.min(summary.minQuality, q);
        summary.maxQuality = summary.maxQuality === null ? q : Math.max(summary.maxQuality, q);
        const bin = summary.histogram.find(bin => q >= bin.lower && (q < bin.upper || bin.includeUpper && q <= bin.upper));
        if (bin)
            bin.count++;
        else
            summary.outOfRangeCount++;
    }
}
function presented(cell, index) {
    const points = cell.corners.flatMap(n => index.positions.slice(n * 3, n * 3 + 3)), locatable = points.every(value => value !== null);
    return { elementId: cell.elementId, elementType: cell.elementType, order: cell.order, volumeTag: cell.volumeTag, quality: cell.quality, minJacobian: cell.minJacobian, maxJacobian: cell.maxJacobian, invalid: cell.invalid, inverted: cell.inverted, degenerate: cell.degenerate, corners: locatable ? points : null, locatable, bodyIds: cell.bodyIds };
}
// Frozen in-memory reference for local differential/pressure checks only.
// Online project queries always call the external-sort builder below.
export function buildQualityPagesReference(file, job, staging, cachePolicy) {
    const raw = checked(file, job.artifact.quality, QUALITY_PAGE_LIMITS.sourceBytes, true, 'MESH_ARTIFACT_INVALID');
    let index;
    try {
        index = validateQualityIndex(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.buffer)), job);
    }
    catch (error) {
        throw fail('MESH_ARTIFACT_INVALID', error.message);
    }
    raw.buffer = null;
    const buildLimit = Math.min(QUALITY_PAGE_LIMITS.cacheBytes, cachePolicy?.maxJobBytes ?? QUALITY_PAGE_LIMITS.cacheBytes), capacity = cachePolicy ? reserveMeshCache(cachePolicy, file, buildLimit) : null;
    const scopes = new Map([['', { cells: index.cells, summary: freshSummary() }]]);
    for (const body of job.source.bodies)
        scopes.set(body.bodyId, { cells: [], summary: freshSummary() });
    for (const cell of index.cells) {
        Object.assign(cell, qualityCellState(cell, index));
        add(scopes.get('').summary, cell);
        for (const id of cell.bodyIds)
            add(scopes.get(id).summary, cell);
    }
    index.cells.sort((a, b) => rank(a) - rank(b) || (a.quality ?? 0) - (b.quality ?? 0) || a.elementId.length - b.elementId.length || (a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0));
    for (const cell of index.cells)
        for (const id of cell.bodyIds)
            scopes.get(id).cells.push(cell);
    removeQualityStaging(file, staging);
    fs.mkdirSync(staging);
    const groups = [];
    let pageNumber = 0, cacheBytes = 0;
    for (const [bodyId, { cells, summary }] of scopes) {
        const pages = [];
        let records = [], serialized = [], size = 2;
        const flush = () => {
            if (!records.length)
                return;
            const data = Buffer.from('[' + serialized.join(',') + ']'), name = `page-${pageNumber++}.json`, pageSummary = freshSummary();
            let minValidQuality = null, maxValidQuality = null;
            for (const row of records) {
                add(pageSummary, row);
                if (!hard(row)) {
                    minValidQuality = minValidQuality === null ? row.quality : Math.min(minValidQuality, row.quality);
                    maxValidQuality = maxValidQuality === null ? row.quality : Math.max(maxValidQuality, row.quality);
                }
            }
            cacheBytes += data.length;
            if (cacheBytes > buildLimit)
                throw fail('MESH_QUALITY_QUERY_LIMIT', '派生分页索引超过单任务缓存预算。');
            fs.writeFileSync(path.join(staging, name), data, { flag: 'wx' });
            pages.push({ file: name, bytes: data.length, sha256: sha(data), count: records.length, hardBadCount: pageSummary.hardBadCount, invalidCount: pageSummary.invalidCount, invertedCount: pageSummary.invertedCount, degenerateCount: pageSummary.degenerateCount, validCount: records.length - pageSummary.hardBadCount, minValidQuality, maxValidQuality });
            records = [];
            serialized = [];
            size = 2;
        };
        for (const cell of cells) {
            const row = presented(cell, index), text = JSON.stringify(row), bytes = Buffer.byteLength(text) + 1;
            if (bytes > QUALITY_PAGE_LIMITS.pageBytes - 2)
                throw fail('MESH_QUALITY_QUERY_LIMIT', '单元详情超过分页字节预算。');
            if (records.length && (records.length >= QUALITY_PAGE_LIMITS.pageCells || size + bytes > QUALITY_PAGE_LIMITS.pageBytes))
                flush();
            records.push(row);
            serialized.push(text);
            size += bytes;
        }
        flush();
        groups.push({ bodyId, summary, pages });
    }
    const manifest = { version: 1, summation: 'neumaier-v1', jobId: job.jobId, sourceKey: sourceKey(job), source: raw.digest, qualityName: index.qualityName, threshold: index.threshold, groups }, bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > QUALITY_PAGE_LIMITS.manifestBytes)
        throw fail('MESH_QUALITY_QUERY_LIMIT', '分页索引清单超过 16 MiB 限制。');
    if (cacheBytes + bytes.length > buildLimit)
        throw fail('MESH_QUALITY_QUERY_LIMIT', '分页及清单累计超过单任务缓存预算。');
    fs.writeFileSync(path.join(staging, 'manifest.json'), bytes, { flag: 'wx' });
    const target = qualityPagesPath(file);
    if (path.dirname(target) !== path.dirname(path.resolve(file)) || path.basename(target) !== 'quality-pages')
        throw fail('MESH_QUALITY_CACHE_PATH', '分页目录不合法。');
    if (fs.existsSync(target)) {
        if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())
            throw fail('MESH_QUALITY_CACHE_PATH', '分页目录不合法。');
        if (cachePolicy)
            removeManagedMeshCache(cachePolicy, target);
        else
            fs.rmSync(target, { recursive: true, force: true });
    }
    fs.renameSync(staging, target);
    return { manifest, proof: { version: 1, source: raw.digest, sourceKey: manifest.sourceKey, manifest: { bytes: bytes.length, sha256: sha(bytes) } }, metrics: { built: true, pages: pageNumber, cacheBytes: cacheBytes + bytes.length, parsedSourceBytes: raw.digest.bytes, ...(capacity ? { cacheCapacity: capacity } : {}) } };
}
function build(file, job, staging, cachePolicy) {
    const buildLimit = Math.min(QUALITY_PAGE_LIMITS.cacheBytes, cachePolicy?.maxJobBytes ?? QUALITY_PAGE_LIMITS.cacheBytes), capacity = cachePolicy ? reserveMeshCache(cachePolicy, file, buildLimit) : null;
    removeQualityStaging(file, staging);
    fs.mkdirSync(staging);
    const prepared = stageQualityPages({ file, job, staging, limits: QUALITY_PAGE_LIMITS, buildLimit }), target = qualityPagesPath(file);
    if (path.dirname(target) !== path.dirname(path.resolve(file)) || path.basename(target) !== 'quality-pages')
        throw fail('MESH_QUALITY_CACHE_PATH', '分页目录不合法。');
    if (fs.existsSync(target)) {
        if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())
            throw fail('MESH_QUALITY_CACHE_PATH', '分页目录不合法。');
        if (cachePolicy)
            removeManagedMeshCache(cachePolicy, target);
        else
            fs.rmSync(target, { recursive: true, force: true });
    }
    fs.renameSync(staging, target);
    return { ...prepared, metrics: { ...prepared.metrics, ...(capacity ? { cacheCapacity: capacity } : {}) } };
}
function validateManifest(manifest, job, proof) {
    if (manifest?.version !== 1 || manifest.summation !== 'neumaier-v1' || manifest.jobId !== job.jobId || manifest.sourceKey !== sourceKey(job) || manifest.sourceKey !== proof.sourceKey || manifest.source?.sha256 !== job.artifact.quality.sha256 || manifest.source.bytes !== job.artifact.quality.bytes || manifest.qualityName !== 'minSICN' || !Array.isArray(manifest.groups))
        throw fail('MESH_QUALITY_CACHE_INVALID', '分页清单来源不匹配。');
    const seen = new Set();
    for (const group of manifest.groups) {
        if (typeof group.bodyId !== 'string' || seen.has(group.bodyId) || !Array.isArray(group.pages) || !safeCount(group.summary?.tetraCount))
            throw fail('MESH_QUALITY_CACHE_INVALID', '分页分组无效。');
        seen.add(group.bodyId);
        let count = 0;
        for (const page of group.pages) {
            if (!/^page-\d+\.json$/.test(page.file) || !safeCount(page.bytes) || page.bytes > QUALITY_PAGE_LIMITS.pageBytes || !/^[a-f0-9]{64}$/.test(page.sha256) || !safeCount(page.count) || page.count > QUALITY_PAGE_LIMITS.pageCells || !['hardBadCount', 'invalidCount', 'invertedCount', 'degenerateCount', 'validCount'].every(key => safeCount(page[key]) && page[key] <= page.count))
                throw fail('MESH_QUALITY_CACHE_INVALID', '分页块凭据无效。');
            count += page.count;
        }
        if (count !== group.summary.tetraCount)
            throw fail('MESH_QUALITY_CACHE_INVALID', '分页数量不一致。');
    }
    if (!seen.has(''))
        throw fail('MESH_QUALITY_CACHE_INVALID', '分页索引缺少全局分组。');
    return manifest;
}
function query(manifest, file, job, input, metrics) {
    const { threshold, offset, limit, issue, bodyId } = normalizeMeshQualityQuery(manifest, job, input), group = manifest.groups.find(row => row.bodyId === bodyId);
    if (!group)
        throw fail('MESH_QUALITY_CACHE_INVALID', '分页分组缺失。');
    let lastPage, lastRows, readBytes = 0;
    const load = page => {
        if (lastPage === page)
            return lastRows;
        readBytes += page.bytes;
        if (readBytes > QUALITY_PAGE_LIMITS.queryBytes)
            throw fail('MESH_QUALITY_QUERY_LIMIT', '本页读取超过 16 MiB 预算，请减小每页数量或选择 Body。');
        const raw = checked(path.join(qualityPagesPath(file), page.file), page, QUALITY_PAGE_LIMITS.pageBytes, true);
        const rows = JSON.parse(raw.buffer);
        if (!Array.isArray(rows) || rows.length !== page.count)
            throw fail('MESH_QUALITY_CACHE_INVALID', '分页块数量无效。');
        metrics.pagesRead++;
        metrics.pageBytesRead += raw.digest.bytes;
        lastPage = page;
        return lastRows = rows;
    };
    const lowCount = page => {
        if (!page.validCount || threshold <= page.minValidQuality)
            return 0;
        if (threshold > page.maxValidQuality)
            return page.validCount;
        return load(page).filter(row => !hard(row) && row.quality !== null && row.quality < threshold).length;
    };
    let badCount = 0, total = 0, remainingOffset = offset;
    const cells = [];
    for (const page of group.pages) {
        const bad = page.hardBadCount + lowCount(page);
        badCount += bad;
        const count = issue === 'all' ? page.count : issue === 'bad' ? bad : page[issue + 'Count'];
        total += count;
        if (remainingOffset >= count) {
            remainingOffset -= count;
            continue;
        }
        if (cells.length >= limit)
            continue;
        const rows = load(page).filter(row => issue === 'all' || issue === 'bad' && (hard(row) || row.quality !== null && row.quality < threshold) || row[issue]);
        cells.push(...rows.slice(remainingOffset, remainingOffset + limit - cells.length));
        remainingOffset = 0;
    }
    const { sum, compensation, hardBadCount, ...base } = group.summary;
    void hardBadCount;
    const quality = { qualityName: manifest.qualityName, threshold, ...base, badCount, averageQuality: base.finiteCount ? (sum + compensation) / base.finiteCount : null };
    const identities = Object.fromEntries(job.source.bodies.map(body => [body.bodyId, { bodyIdentity: body.bodyIdentity, topologyIdentity: body.topologyIdentity }]));
    return { quality, total, offset, limit, cells: cells.map(cell => ({ ...cell, bodyIdentities: Object.fromEntries(cell.bodyIds.map(id => [id, identities[id]])) })), bodyId, issue };
}
export function runPagedQualityQuery({ file, job, input, staging, cachePolicy, referenceBuild = false }) {
    let prepared, manifest;
    const metrics = { built: false, parsedSourceBytes: 0, pagesRead: 0, pageBytesRead: 0 };
    if (cachePolicy)
        metrics.cacheCapacity = reserveMeshCache(cachePolicy, file);
    const proof = job.artifact.qualityQuery;
    if (proof?.version === 1 && proof.sourceKey === sourceKey(job) && proof.source?.sha256 === job.artifact.quality.sha256 && proof.source.bytes === job.artifact.quality.bytes) {
        checked(file, job.artifact.quality, QUALITY_PAGE_LIMITS.sourceBytes, false, 'MESH_ARTIFACT_INVALID');
        try {
            manifest = validateManifest(JSON.parse(checked(path.join(qualityPagesPath(file), 'manifest.json'), proof.manifest, QUALITY_PAGE_LIMITS.manifestBytes, true).buffer), job, proof);
            const result = query(manifest, file, job, input, metrics);
            if (cachePolicy)
                touchMeshCache(file);
            return { result, metrics };
        }
        catch (error) {
            if (error.code !== 'MESH_QUALITY_CACHE_INVALID')
                throw error;
        }
    }
    prepared = referenceBuild ? buildQualityPagesReference(file, job, staging, cachePolicy) : build(file, job, staging, cachePolicy);
    const initialCapacity = metrics.cacheCapacity;
    Object.assign(metrics, prepared.metrics);
    if (metrics.cacheCapacity && initialCapacity) {
        metrics.cacheCapacity.evicted += initialCapacity.evicted;
        metrics.cacheCapacity.freedBytes += initialCapacity.freedBytes;
    }
    manifest = validateManifest(prepared.manifest, job, prepared.proof);
    const result = query(manifest, file, job, input, metrics);
    if (cachePolicy) {
        const previous = metrics.cacheCapacity, final = reserveMeshCache(cachePolicy, file);
        metrics.cacheCapacity = { ...final, evicted: (previous?.evicted || 0) + final.evicted, freedBytes: (previous?.freedBytes || 0) + final.freedBytes, buildReservedBytes: cachePolicy.maxJobBytes };
        touchMeshCache(file);
    }
    return { result, proof: prepared.proof, metrics };
}
