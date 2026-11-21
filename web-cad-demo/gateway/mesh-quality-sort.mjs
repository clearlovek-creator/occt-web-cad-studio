import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BoundedJsonLines } from './bounded-json-lines.mjs';
export const QUALITY_SORT_LIMITS = Object.freeze({ runBytes: 8 * 1024 * 1024, runRecords: 8192, fanIn: 16, readBytes: 64 * 1024, rowBytes: 512 * 1024, pageBufferBytes: 8 * 1024 * 1024 });
const fail = (code, message) => Object.assign(Error(message), { code });
const invalid = message => fail('MESH_QUALITY_CACHE_INVALID', '质量排序暂存无效：' + message);
const limited = message => fail('MESH_QUALITY_QUERY_LIMIT', message);
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const rank = row => row.invalid ? 0 : row.inverted ? 1 : row.degenerate ? 2 : 3;
export const compareQualityRows = (a, b) => rank(a) - rank(b) || (a.quality ?? 0) - (b.quality ?? 0) || a.elementId.length - b.elementId.length || (a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0);
/** Logical bytes for every live run, page and manifest in one reserved staging. */
export class QualityStageBudget {
    constructor(directory, maxBytes) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
            throw limited('排序缓存预算不合法。');
        this.directory = path.resolve(directory);
        this.maxBytes = maxBytes;
        this.used = 0;
        this.peak = 0;
        this.written = 0;
    }
    target(name) {
        if (!/^(sort-(0|[1-9]\d*)\.run|page-(0|[1-9]\d*)\.json|manifest\.json)$/.test(name))
            throw invalid('暂存文件名不合法。');
        let stat;
        try {
            stat = fs.lstatSync(this.directory);
        }
        catch (error) {
            throw invalid('无法访问暂存目录：' + error.message);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw invalid('暂存不是普通目录。');
        return path.join(this.directory, name);
    }
    reserve(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || this.used + bytes > this.maxBytes)
            throw limited('排序暂存、分页和清单累计超过单任务缓存预算。');
        this.used += bytes;
        this.written += bytes;
        this.peak = Math.max(this.peak, this.used);
    }
    write(name, bytes) {
        const file = this.target(name);
        this.reserve(bytes.length);
        try {
            fs.writeFileSync(file, bytes, { flag: 'wx' });
        }
        catch (error) {
            throw fail('MESH_QUALITY_QUERY_IO', '无法写入质量缓存：' + error.message);
        }
        return file;
    }
    remove(proof) {
        const file = this.target(proof.name), stat = fs.lstatSync(file, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !same(stat, proof.identity))
            throw invalid('删除排序段前文件身份变化。');
        try {
            fs.unlinkSync(file);
        }
        catch (error) {
            throw fail('MESH_QUALITY_QUERY_IO', '无法回收质量排序段：' + error.message);
        }
        this.used -= proof.bytes;
    }
}
class RunReader {
    constructor(budget, proof) {
        this.budget = budget;
        this.proof = proof;
        this.file = budget.target(proof.name);
        this.queue = [];
        this.offset = 0;
        this.hash = crypto.createHash('sha256');
        this.frames = new BoundedJsonLines(QUALITY_SORT_LIMITS.rowBytes);
        this.count = 0;
        this.done = false;
        const stat = fs.lstatSync(this.file, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !same(stat, proof.identity))
            throw invalid('打开排序段前文件变化。');
        this.fd = fs.openSync(this.file, 'r');
        if (!same(stat, fs.fstatSync(this.fd, { bigint: true }))) {
            this.close();
            throw invalid('排序段打开时身份变化。');
        }
    }
    line(text) {
        try {
            const row = JSON.parse(text);
            this.queue.push({ row, text });
            this.count++;
        }
        catch {
            throw invalid('排序段不是有效 JSON。');
        }
    }
    next() {
        try {
            while (!this.queue.length && !this.done) {
                const buffer = Buffer.allocUnsafe(Math.min(QUALITY_SORT_LIMITS.readBytes, this.proof.bytes - this.offset));
                if (!buffer.length) {
                    this.frames.finish(text => this.line(text));
                    const actual = fs.fstatSync(this.fd, { bigint: true });
                    if (this.count !== this.proof.count || this.hash.digest('hex') !== this.proof.sha256 || !same(actual, this.proof.identity) || !same(actual, fs.lstatSync(this.file, { bigint: true })))
                        throw invalid('排序段内容或身份校验失败。');
                    this.close();
                    this.done = true;
                    this.budget.remove(this.proof);
                    break;
                }
                const n = fs.readSync(this.fd, buffer, 0, buffer.length, null);
                if (!n)
                    throw invalid('排序段意外截断。');
                this.offset += n;
                const bytes = buffer.subarray(0, n);
                this.hash.update(bytes);
                this.frames.push(bytes, text => this.line(text));
            }
            return this.queue.shift() || null;
        }
        catch (error) {
            if (String(error.code).startsWith('MESH_QUALITY_'))
                throw error;
            throw invalid('排序段读取失败：' + error.message);
        }
    }
    close() {
        if (this.fd !== undefined) {
            fs.closeSync(this.fd);
            this.fd = undefined;
        }
    }
}
function push(heap, value) {
    heap.push(value);
    let n = heap.length - 1;
    while (n) {
        const parent = (n - 1) >> 1;
        if (compareQualityRows(heap[parent].row, value.row) <= 0)
            break;
        heap[n] = heap[parent];
        n = parent;
    }
    heap[n] = value;
}
function pop(heap) {
    const first = heap[0], last = heap.pop();
    if (heap.length) {
        let n = 0;
        for (;;) {
            let child = n * 2 + 1;
            if (child >= heap.length)
                break;
            if (child + 1 < heap.length && compareQualityRows(heap[child + 1].row, heap[child].row) < 0)
                child++;
            if (compareQualityRows(last.row, heap[child].row) <= 0)
                break;
            heap[n] = heap[child];
            n = child;
        }
        heap[n] = last;
    }
    return first;
}
/** Bounded sorted runs and bounded fan-in; no complete sorted-cell array. */
export class QualityExternalSort {
    constructor(budget, { runBytes = QUALITY_SORT_LIMITS.runBytes, runRecords = QUALITY_SORT_LIMITS.runRecords, fanIn = QUALITY_SORT_LIMITS.fanIn } = {}) {
        if (!Number.isSafeInteger(runBytes) || runBytes < 1024 || runBytes > QUALITY_SORT_LIMITS.runBytes || !Number.isSafeInteger(runRecords) || runRecords < 1 || runRecords > QUALITY_SORT_LIMITS.runRecords || !Number.isSafeInteger(fanIn) || fanIn < 2 || fanIn > QUALITY_SORT_LIMITS.fanIn)
            throw limited('排序分批预算不合法。');
        Object.assign(this, { budget, runBytes, runRecords, fanIn });
        this.batch = [];
        this.batchBytes = 0;
        this.runs = [];
        this.sequence = 0;
        this.metrics = { initialRuns: 0, mergePasses: 0, maxBatchBytes: 0, maxBatchRecords: 0, maxOpenRuns: 0 };
    }
    add(row) {
        const text = JSON.stringify(row), bytes = Buffer.byteLength(text) + 1;
        if (bytes > QUALITY_SORT_LIMITS.rowBytes)
            throw limited('单元详情超过排序/分页字节预算。');
        if (this.batch.length && (this.batch.length >= this.runRecords || this.batchBytes + bytes > this.runBytes))
            this.flush();
        this.batch.push({ row, text });
        this.batchBytes += bytes;
        this.metrics.maxBatchBytes = Math.max(this.metrics.maxBatchBytes, this.batchBytes);
        this.metrics.maxBatchRecords = Math.max(this.metrics.maxBatchRecords, this.batch.length);
    }
    writer() {
        const name = `sort-${this.sequence++}.run`, file = this.budget.target(name), hash = crypto.createHash('sha256');
        let fd;
        try {
            fd = fs.openSync(file, 'wx');
        }
        catch (error) {
            throw fail('MESH_QUALITY_QUERY_IO', '无法创建质量排序段：' + error.message);
        }
        let bytes = 0, count = 0, closed = false, parts = [], buffered = 0;
        const write = data => {
            let offset = 0;
            while (offset < data.length) {
                let n;
                try {
                    n = fs.writeSync(fd, data, offset, data.length - offset);
                }
                catch (error) {
                    throw fail('MESH_QUALITY_QUERY_IO', '无法写入质量排序段：' + error.message);
                }
                if (!n)
                    throw fail('MESH_QUALITY_QUERY_IO', '质量排序段写入无进展。');
                offset += n;
            }
        };
        const flush = () => {
            if (buffered) {
                write(parts.length === 1 ? parts[0] : Buffer.concat(parts, buffered));
                parts = [];
                buffered = 0;
            }
        };
        const close = () => { if (!closed) {
            closed = true;
            try {
                fs.closeSync(fd);
            }
            catch (error) {
                throw fail('MESH_QUALITY_QUERY_IO', '无法关闭质量排序段：' + error.message);
            }
        } };
        return { add: text => {
                const data = Buffer.from(text + '\n');
                this.budget.reserve(data.length);
                if (buffered + data.length > QUALITY_SORT_LIMITS.readBytes)
                    flush();
                if (data.length > QUALITY_SORT_LIMITS.readBytes)
                    write(data);
                else {
                    parts.push(data);
                    buffered += data.length;
                }
                hash.update(data);
                bytes += data.length;
                count++;
            }, finish: () => { flush(); close(); let identity; try {
                identity = fs.lstatSync(file, { bigint: true });
            }
            catch (error) {
                throw invalid('无法核验封存排序段：' + error.message);
            } return { name, bytes, count, sha256: hash.digest('hex'), identity }; }, close };
    }
    flush() {
        if (!this.batch.length)
            return;
        this.batch.sort((a, b) => compareQualityRows(a.row, b.row));
        const writer = this.writer();
        try {
            for (const record of this.batch)
                writer.add(record.text);
            this.runs.push(writer.finish());
            this.metrics.initialRuns++;
        }
        finally {
            writer.close();
        }
        this.batch = [];
        this.batchBytes = 0;
    }
    merge(runs, emit) {
        const readers = [], heap = [];
        try {
            for (const proof of runs) {
                const reader = new RunReader(this.budget, proof);
                readers.push(reader);
                const entry = reader.next();
                if (entry)
                    push(heap, { ...entry, reader });
            }
            this.metrics.maxOpenRuns = Math.max(this.metrics.maxOpenRuns, readers.length);
            let previous;
            while (heap.length) {
                const entry = pop(heap);
                if (previous && compareQualityRows(previous, entry.row) > 0)
                    throw invalid('排序段未按质量顺序排列。');
                emit(entry.row, entry.text);
                previous = entry.row;
                const next = entry.reader.next();
                if (next)
                    push(heap, { ...next, reader: entry.reader });
            }
        }
        finally {
            for (const reader of readers)
                reader.close();
        }
    }
    finish(emit) {
        this.flush();
        while (this.runs.length > this.fanIn) {
            const next = [];
            for (let start = 0; start < this.runs.length; start += this.fanIn) {
                const group = this.runs.slice(start, start + this.fanIn);
                if (group.length === 1) {
                    next.push(group[0]);
                    continue;
                }
                const writer = this.writer();
                try {
                    this.merge(group, (_row, text) => writer.add(text));
                    next.push(writer.finish());
                }
                finally {
                    writer.close();
                }
            }
            this.runs = next;
            this.metrics.mergePasses++;
        }
        if (this.runs.length) {
            this.merge(this.runs, emit);
            this.metrics.mergePasses++;
        }
        this.runs = [];
        return { ...this.metrics, diskPeakBytes: this.budget.peak, diskWrittenBytes: this.budget.written };
    }
}
