import { addQualityValue } from '../shared/mesh-statistics.mjs';
import { qualityCellState } from '../shared/mesh-admission.mjs';
import { withStreamedQualityIndex } from './mesh-quality-stream.mjs';
import { QualityStageBudget, QualityExternalSort, QUALITY_SORT_LIMITS } from './mesh-quality-sort.mjs';
import crypto from 'node:crypto';
const fail = (code, message) => Object.assign(Error(message), { code });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hard = cell => cell.invalid || cell.inverted || cell.degenerate;
function summary() { return { tetraCount: 0, finiteCount: 0, nonFiniteQualityCount: 0, hardBadCount: 0, badCount: 0, invertedCount: 0, degenerateCount: 0, invalidCount: 0, minQuality: null, maxQuality: null, sum: 0, compensation: 0, outOfRangeCount: 0, histogram: Array.from({ length: 11 }, (_, i) => ({ lower: i === 0 ? -1 : (i - 1) / 10, upper: i === 0 ? 0 : i / 10, includeUpper: i === 10, count: 0 })) }; }
function add(total, cell) {
    total.tetraCount++;
    if (hard(cell))
        total.hardBadCount++;
    for (const key of ['invalid', 'inverted', 'degenerate'])
        if (cell[key])
            total[key + 'Count']++;
    if (cell.quality === null)
        total.nonFiniteQualityCount++;
    else {
        const q = cell.quality;
        total.finiteCount++;
        addQualityValue(total, q);
        total.minQuality = total.minQuality === null ? q : Math.min(total.minQuality, q);
        total.maxQuality = total.maxQuality === null ? q : Math.max(total.maxQuality, q);
        const bin = total.histogram.find(bin => q >= bin.lower && (q < bin.upper || bin.includeUpper && q <= bin.upper));
        if (bin)
            bin.count++;
        else
            total.outOfRangeCount++;
    }
}
function presented(cell, index) { const at = index.positionAt || ((n) => index.positions[n]), points = cell.corners.flatMap(n => [at(n * 3), at(n * 3 + 1), at(n * 3 + 2)]), locatable = points.every(value => value !== null); return { elementId: cell.elementId, elementType: cell.elementType, order: cell.order, volumeTag: cell.volumeTag, quality: cell.quality, minJacobian: cell.minJacobian, maxJacobian: cell.maxJacobian, invalid: cell.invalid, inverted: cell.inverted, degenerate: cell.degenerate, corners: locatable ? points : null, locatable, bodyIds: cell.bodyIds }; }
/** Writes only a private staging. Publication remains the caller's responsibility. */
export function stageQualityPages({ file, job, staging, limits, buildLimit, sortLimits, pageBufferBytes = QUALITY_SORT_LIMITS.pageBufferBytes }) {
    if (!Number.isSafeInteger(pageBufferBytes) || pageBufferBytes < limits.pageBytes || pageBufferBytes > QUALITY_SORT_LIMITS.pageBufferBytes)
        throw fail('MESH_QUALITY_QUERY_LIMIT', '分页缓冲预算不合法。');
    const budget = new QualityStageBudget(staging, buildLimit), sort = new QualityExternalSort(budget, sortLimits), scopes = new Map([['', summary()]]);
    let estimated = 1024;
    for (const body of job.source.bodies) {
        if (typeof body.bodyId !== 'string' || !body.bodyId || scopes.has(body.bodyId))
            throw fail('MESH_ARTIFACT_INVALID', '质量来源 Body 编号重复或不合法。');
        const total = summary();
        estimated += Buffer.byteLength(JSON.stringify({ bodyId: body.bodyId, summary: total, pages: [] })) + 256;
        if (estimated > limits.manifestBytes)
            throw fail('MESH_QUALITY_QUERY_LIMIT', 'Body 分组元数据超过清单预算。');
        scopes.set(body.bodyId, total);
    }
    let header;
    const source = withStreamedQualityIndex(file, job, index => {
        header = { qualityName: index.qualityName, threshold: index.threshold };
        for (const cell of index.cells) {
            Object.assign(cell, qualityCellState(cell, index));
            add(scopes.get(''), cell);
            for (const id of cell.bodyIds)
                add(scopes.get(id), cell);
            sort.add(presented(cell, index));
        }
    });
    const groups = [...scopes].map(([bodyId, total]) => ({ bodyId, summary: total, pages: [] })), writers = new Map(), pending = new Map();
    let pageNumber = 0, buffered = 0, maxBuffered = 0, pageBytes = 0, metadataBytes = Buffer.byteLength(JSON.stringify(groups)) + 1024;
    if (metadataBytes > limits.manifestBytes)
        throw fail('MESH_QUALITY_QUERY_LIMIT', 'Body 分组元数据超过清单预算。');
    const flush = writer => {
        if (!writer.rows.length)
            return;
        const data = Buffer.from('[' + writer.texts.join(',') + ']'), name = `page-${pageNumber++}.json`, total = summary();
        let minValidQuality = null, maxValidQuality = null;
        for (const row of writer.rows) {
            add(total, row);
            if (!hard(row)) {
                minValidQuality = minValidQuality === null ? row.quality : Math.min(minValidQuality, row.quality);
                maxValidQuality = maxValidQuality === null ? row.quality : Math.max(maxValidQuality, row.quality);
            }
        }
        const page = { file: name, bytes: data.length, sha256: sha(data), count: writer.rows.length, hardBadCount: total.hardBadCount, invalidCount: total.invalidCount, invertedCount: total.invertedCount, degenerateCount: total.degenerateCount, validCount: writer.rows.length - total.hardBadCount, minValidQuality, maxValidQuality };
        metadataBytes += Buffer.byteLength(JSON.stringify(page)) + 1;
        if (metadataBytes > limits.manifestBytes)
            throw fail('MESH_QUALITY_QUERY_LIMIT', '分页元数据超过清单预算。');
        budget.write(name, data);
        writer.group.pages.push(page);
        pageBytes += data.length;
        buffered -= writer.size - 2;
        pending.delete(writer);
        writer.rows = [];
        writer.texts = [];
        writer.size = 2;
    };
    for (const group of groups)
        writers.set(group.bodyId, { group, rows: [], texts: [], size: 2 });
    const append = (writer, row, text, bytes) => {
        if (!writer)
            throw fail('MESH_QUALITY_CACHE_INVALID', '排序段包含未知 Body。');
        if (writer.rows.length && (writer.rows.length >= limits.pageCells || writer.size + bytes > limits.pageBytes))
            flush(writer);
        while (buffered + bytes > pageBufferBytes && pending.size)
            flush(pending.keys().next().value);
        writer.rows.push(row);
        writer.texts.push(text);
        writer.size += bytes;
        buffered += bytes;
        pending.delete(writer);
        pending.set(writer, true);
        maxBuffered = Math.max(maxBuffered, buffered);
    };
    const sorting = sort.finish((row, text) => {
        const bytes = Buffer.byteLength(text) + 1;
        if (bytes > limits.pageBytes - 2)
            throw fail('MESH_QUALITY_QUERY_LIMIT', '单元详情超过分页字节预算。');
        append(writers.get(''), row, text, bytes);
        for (const id of row.bodyIds)
            append(writers.get(id), row, text, bytes);
    });
    for (const writer of writers.values())
        flush(writer);
    for (const group of groups)
        for (const [summaryKey, pageKey] of [['tetraCount', 'count'], ['hardBadCount', 'hardBadCount'], ['invalidCount', 'invalidCount'], ['invertedCount', 'invertedCount'], ['degenerateCount', 'degenerateCount']])
            if (group.pages.reduce((sum, page) => sum + page[pageKey], 0) !== group.summary[summaryKey])
                throw fail('MESH_QUALITY_CACHE_INVALID', '排序分页与来源统计不一致，未发布缓存。');
    const manifest = { version: 1, summation: 'neumaier-v1', construction: 'external-sort-v1', jobId: job.jobId, sourceKey: sha(JSON.stringify(job.source)), source: source.proof, ...header, groups }, bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > limits.manifestBytes)
        throw fail('MESH_QUALITY_QUERY_LIMIT', '分页索引清单超过 16 MiB 限制。');
    budget.write('manifest.json', bytes);
    if (budget.used !== pageBytes + bytes.length)
        throw fail('MESH_QUALITY_CACHE_INVALID', '排序结束后仍有未核销的暂存字节。');
    return { manifest, proof: { version: 1, source: source.proof, sourceKey: manifest.sourceKey, manifest: { bytes: bytes.length, sha256: sha(bytes) } }, metrics: { built: true, pages: pageNumber, cacheBytes: pageBytes + bytes.length, parsedSourceBytes: source.proof.bytes, sourcePasses: source.metrics.passes, coordinateBytes: source.metrics.coordinateBytes, sort: { ...sorting, diskPeakBytes: budget.peak, diskWrittenBytes: budget.written, maxPageBufferBytes: maxBuffered, pageBufferBytes } } };
}
