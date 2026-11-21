import fs from 'node:fs';
import crypto from 'node:crypto';
import { createQualityCellValidator, validateQualityHeader } from './mesh-quality-query.mjs';
export const QUALITY_STREAM_LIMITS = Object.freeze({ sourceBytes: 256 * 1024 * 1024, chunkBytes: 64 * 1024, valueBytes: 1024 * 1024, depth: 64, rootKeys: 64, coordinateBlock: 16384, coordinateBytes: 256 * 1024 * 1024 });
const fault = (code, message) => Object.assign(Error(message), { code });
const invalid = message => fault('MESH_ARTIFACT_INVALID', '网格质量索引无效：' + message);
const limited = message => fault('MESH_ARTIFACT_LIMIT', '网格质量流式读取超限：' + message);
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const whitespace = n => n === 32 || n === 9 || n === 10 || n === 13;
const delimiter = n => n < 0 || whitespace(n) || n === 44 || n === 93 || n === 125;
/** One forward pass on the same FD. Hash every loaded byte; never retain source JSON. */
class Reader {
    constructor(fd, size, chunkBytes) { Object.assign(this, { fd, size, chunkBytes }); this.loaded = 0; this.cursor = 0; this.buffer = Buffer.alloc(0); this.hash = crypto.createHash('sha256'); this.capture = null; }
    peek() {
        if (this.cursor === this.buffer.length) {
            if (this.capture && this.cursor > this.capture.start) {
                this.capture.parts.push(this.buffer.subarray(this.capture.start));
                this.capture.start = this.cursor;
            }
            if (this.loaded === this.size)
                return -1;
            const block = Buffer.allocUnsafe(Math.min(this.chunkBytes, this.size - this.loaded)), n = fs.readSync(this.fd, block, 0, block.length, this.loaded);
            if (!n)
                throw invalid('文件意外截断。');
            this.buffer = block.subarray(0, n);
            this.loaded += n;
            this.cursor = 0;
            if (this.capture)
                this.capture.start = 0;
            this.hash.update(this.buffer);
        }
        return this.buffer[this.cursor];
    }
    offset() { return this.loaded - this.buffer.length + this.cursor; }
    take() {
        const n = this.peek();
        if (n < 0)
            throw invalid('JSON 意外结束。');
        this.cursor++;
        return n;
    }
    space() {
        while (whitespace(this.peek()))
            this.cursor++;
    }
    expect(byte) {
        this.space();
        if (this.take() !== byte)
            throw invalid('JSON 分隔符不合法。');
    }
    raw({ collect = true, maxBytes = QUALITY_STREAM_LIMITS.valueBytes } = {}) {
        this.space();
        const start = this.offset();
        if (collect)
            this.capture = { parts: [], start: this.cursor };
        const stack = [];
        let string = false, escaped = false, started = false;
        while (true) {
            const n = this.peek();
            if (!started) {
                if (delimiter(n) || n === 58)
                    throw invalid('缺少 JSON 值。');
                started = true;
            }
            if (!string && !stack.length && this.offset() > start && delimiter(n))
                break;
            if (n < 0) {
                if (string || stack.length)
                    throw invalid('JSON 字符串或容器未结束。');
                break;
            }
            this.take();
            if (this.offset() - start > maxBytes)
                throw limited('单个 JSON 值超过字节预算。');
            if (string) {
                if (escaped)
                    escaped = false;
                else if (n === 92)
                    escaped = true;
                else if (n === 34) {
                    string = false;
                    if (!stack.length)
                        break;
                }
                else if (n < 32)
                    throw invalid('字符串包含控制字符。');
            }
            else if (n === 34)
                string = true;
            else if (n === 123 || n === 91) {
                stack.push(n);
                if (stack.length > QUALITY_STREAM_LIMITS.depth)
                    throw limited('JSON 嵌套过深。');
            }
            else if (n === 125 || n === 93) {
                if (stack.pop() !== (n === 125 ? 123 : 91))
                    throw invalid('JSON 容器不匹配。');
                if (!stack.length)
                    break;
            }
        }
        if (!collect)
            return;
        const capture = this.capture;
        this.capture = null;
        this.decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        if (this.cursor > capture.start)
            capture.parts.push(this.buffer.subarray(capture.start, this.cursor));
        return capture.parts.length === 1 ? capture.parts[0] : Buffer.concat(capture.parts);
    }
    json(maxBytes) {
        const bytes = this.raw({ maxBytes });
        try {
            return JSON.parse(this.decoder.decode(bytes));
        }
        catch {
            throw invalid('不是有效 UTF-8 JSON。');
        }
    }
    array(each) {
        this.expect(91);
        this.space();
        if (this.peek() === 93) {
            this.take();
            return;
        }
        while (true) {
            each();
            this.space();
            const n = this.take();
            if (n === 93)
                return;
            if (n !== 44)
                throw invalid('数组分隔符不合法。');
        }
    }
    finish(expected) {
        this.space();
        if (this.peek() !== -1)
            throw invalid('JSON 之后存在额外数据。');
        const proof = { bytes: this.loaded, sha256: this.hash.digest('hex') };
        if (expected && (proof.bytes !== expected.bytes || proof.sha256 !== expected.sha256))
            throw invalid('内容长度或 SHA256 不匹配。');
        return proof;
    }
}
function coordinates() {
    const chunks = [];
    let length = 0;
    return { push(value) {
            if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
                throw invalid('坐标必须为有限数值或 null。');
            if (length % QUALITY_STREAM_LIMITS.coordinateBlock === 0) {
                if ((chunks.length + 1) * QUALITY_STREAM_LIMITS.coordinateBlock * 8 > QUALITY_STREAM_LIMITS.coordinateBytes)
                    throw limited('坐标存储超过 256 MiB。');
                chunks.push(new Float64Array(QUALITY_STREAM_LIMITS.coordinateBlock));
            }
            chunks.at(-1)[length++ % QUALITY_STREAM_LIMITS.coordinateBlock] = value === null ? NaN : value;
        }, get length() { return length; }, get bytes() { return chunks.length * QUALITY_STREAM_LIMITS.coordinateBlock * 8; }, at(n) { const value = chunks[Math.floor(n / QUALITY_STREAM_LIMITS.coordinateBlock)][n % QUALITY_STREAM_LIMITS.coordinateBlock]; return Number.isNaN(value) ? null : value; } };
}
function* root(reader, index, { first, points, validate }) {
    const seen = new Set();
    let count = 0;
    // Match the former whole-file UTF-8 decoder: allow only the leading BOM,
    // never silently strip a BOM at the start of an individual JSON value.
    if (reader.peek() === 0xef) {
        if (reader.take() !== 0xef || reader.take() !== 0xbb || reader.take() !== 0xbf)
            throw invalid('UTF-8 文件头不合法。');
    }
    reader.expect(123);
    reader.space();
    if (reader.peek() === 125)
        throw invalid('缺少质量索引字段。');
    while (true) {
        reader.space();
        if (reader.peek() !== 34)
            throw invalid('根字段名必须为字符串。');
        const key = reader.json();
        if (seen.has(key))
            throw invalid('根字段重复。');
        seen.add(key);
        if (seen.size > QUALITY_STREAM_LIMITS.rootKeys)
            throw limited('根字段过多。');
        reader.expect(58);
        if (key === 'positions') {
            if (first)
                reader.array(() => points.push(reader.json(128)));
            else
                reader.raw({ collect: false, maxBytes: QUALITY_STREAM_LIMITS.sourceBytes });
        }
        else if (key === 'cells') {
            reader.expect(91);
            reader.space();
            if (reader.peek() === 93)
                reader.take();
            else
                while (true) {
                    if (first)
                        reader.raw({ collect: false });
                    else
                        yield validate(reader.json());
                    count++;
                    reader.space();
                    const n = reader.take();
                    if (n === 93)
                        break;
                    if (n !== 44)
                        throw invalid('单元数组分隔符不合法。');
                }
        }
        else {
            const value = reader.json();
            if (['version', 'requestId', 'qualityName', 'threshold'].includes(key))
                index[key] = value;
        }
        reader.space();
        const n = reader.take();
        if (n === 125)
            break;
        if (n !== 44)
            throw invalid('根对象分隔符不合法。');
    }
    if (!['version', 'requestId', 'qualityName', 'threshold', 'positions', 'cells'].every(key => seen.has(key)))
        throw invalid('缺少质量索引字段。');
    if (first)
        index.cellCount = count;
    else if (count !== index.cellCount)
        throw invalid('两次读取的单元数量不一致。');
}
/** Full admission consumes each cell once, with packed coordinates plus exact ID
 * uniqueness state. This is not constant-memory: node coordinates and IDs remain.
 * Both complete passes must match the same digest before any result is returned. */
export function withStreamedQualityIndex(file, job, consume, { expected = job.artifact?.quality, chunkBytes = QUALITY_STREAM_LIMITS.chunkBytes } = {}) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024)
        throw limited('读取块大小不合法。');
    let fd;
    try {
        const entry = fs.lstatSync(file, { bigint: true });
        if (!entry.isFile() || entry.isSymbolicLink())
            throw invalid('来源不是普通文件。');
        if (entry.size > BigInt(QUALITY_STREAM_LIMITS.sourceBytes))
            throw limited('来源超过 256 MiB。');
        fd = fs.openSync(file, 'r');
        if (!same(entry, fs.fstatSync(fd, { bigint: true })))
            throw invalid('打开时文件身份变化。');
        const points = coordinates(), index = {}, first = new Reader(fd, Number(entry.size), chunkBytes);
        for (const ignored of root(first, index, { first: true, points })) {
            void ignored;
        }
        const proof = first.finish(expected);
        validateQualityHeader(index, job);
        if (points.length % 3)
            throw invalid('坐标数量不是三的倍数。');
        if (!same(entry, fs.fstatSync(fd, { bigint: true })) || !same(entry, fs.lstatSync(file, { bigint: true })))
            throw invalid('首遍读取时文件发生变化。');
        const second = new Reader(fd, Number(entry.size), chunkBytes), validate = createQualityCellValidator(job, points.length), iterator = root(second, index, { first: false, validate });
        Object.assign(index, { positions: { length: points.length }, positionAt: n => points.at(n), cells: { length: index.cellCount, [Symbol.iterator]: () => iterator } });
        const value = consume(index);
        if (value && typeof value.then === 'function')
            throw invalid('流式验收必须在文件观察范围内同步完成。');
        for (const ignored of iterator) {
            void ignored;
        }
        second.finish(proof);
        if (!same(entry, fs.fstatSync(fd, { bigint: true })) || !same(entry, fs.lstatSync(file, { bigint: true })))
            throw invalid('验收期间文件发生变化。');
        return { value, proof, metrics: { sourceBytes: proof.bytes, passes: 2, coordinateBytes: points.bytes, coordinateCount: points.length, cellCount: index.cellCount, chunkBytes, maxValueBytes: QUALITY_STREAM_LIMITS.valueBytes, retainedCellObjects: 0 } };
    }
    catch (error) {
        if (['MESH_ARTIFACT_INVALID', 'MESH_ARTIFACT_LIMIT'].includes(error.code) || String(error.code).startsWith('MESH_QUALITY_'))
            throw error;
        throw invalid(error.message);
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
