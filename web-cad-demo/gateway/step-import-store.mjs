import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { STEP_IMPORT_PHASES, activeStepImport, stepImportReport } from '../shared/step-import-status.mjs';
const DOCUMENT = /^[A-Za-z0-9_-]{1,64}$/, REQUEST = /^[A-Za-z0-9._:-]{1,160}$/;
export class StepImportError extends Error {
    constructor(code, message) { super(message); this.name = 'StepImportError'; this.code = code; }
}
const fail = (code, message) => new StepImportError(code, message);
const date = () => new Date().toISOString();
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const safeFileName = value => String(value).replaceAll('\\', '/').split('/').at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) || 'import.step';
const validInteger = value => Number.isSafeInteger(value) && value >= 0;
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function atomicJson(file, value) { const temporary = file + '.' + randomUUID() + '.tmp'; let fd; try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
}
finally {
    if (fd !== undefined)
        fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
} }
/** Small phase ledger only. Geometry truth and accepted outcomes remain in the project transaction. */
export class StepImportStore {
    constructor(dataDir, { ownerInstanceId, resolveOutcome = () => null, limit = 100, maxActive = 4, onWarning = console.warn } = {}) { this.root = path.join(dataDir, 'step-imports'); this.dataDir = path.resolve(dataDir); this.ownerInstanceId = ownerInstanceId || randomUUID(); this.resolveOutcome = resolveOutcome; this.limit = limit; this.maxActive = maxActive; this.onWarning = onWarning; this.active = new Map(); this.lastCreatedAt = new Map(); fs.mkdirSync(this.root, { recursive: true }); this.checkDirectory(this.root); }
    checkDirectory(directory) { const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink())
        throw fail('STEP_IMPORT_REPORT_UNAVAILABLE', 'STEP 导入报告目录类型异常。'); }
    validate(id, requestId) { if (!DOCUMENT.test(id) || !REQUEST.test(requestId))
        throw fail('INVALID_STEP_IMPORT_ID', 'STEP 导入工程或请求标识无效。'); }
    key(id, requestId) { this.validate(id, requestId); return id + '\0' + requestId; }
    directory(id, create = false) { if (!DOCUMENT.test(id))
        throw fail('INVALID_STEP_IMPORT_ID', 'STEP 导入工程标识无效。'); this.checkDirectory(this.root); const directory = path.join(this.root, id); if (create)
        fs.mkdirSync(directory, { recursive: true }); if (fs.existsSync(directory))
        this.checkDirectory(directory); return directory; }
    file(id, requestId) { this.validate(id, requestId); return path.join(this.directory(id), createHash('sha256').update(requestId).digest('hex') + '.json'); }
    persist(record) { this.directory(record.documentId, true); atomicJson(this.file(record.documentId, record.requestId), record); }
    begin(id, requestId, fileName = 'import.step', transfer) {
        const key = this.key(id, requestId);
        if (this.active.has(key) || [...this.active.values()].some(item => item.documentId === id))
            throw fail('STEP_IMPORT_BUSY', '当前工程已有 STEP 导入正在处理，请等待并核对原请求，不要重复上传。');
        if (this.active.size >= this.maxActive)
            throw fail('STEP_IMPORT_BUSY', '同时处理的 STEP 导入已达上限，请稍后再试。');
        if (fs.existsSync(this.file(id, requestId)))
            throw fail('STEP_IMPORT_REQUEST_EXISTS', '此 STEP 导入请求已有记录，请查询原记录，不要重新上传。');
        const previousTime = (this.lastCreatedAt.get(id) ?? Date.parse(this.records(id)[0]?.createdAt || '')) || 0;
        const createdTime = Math.max(Date.now(), previousTime + 1), now = new Date(createdTime).toISOString();
        if (transfer)
            this.validateTransfer(id, transfer);
        const record = { version: 1, ownerInstanceId: this.ownerInstanceId, documentId: id, requestId, fileName: safeFileName(fileName), phase: 'receiving', sequence: 1, createdAt: now, updatedAt: now, ...(transfer ? { transfer } : {}) };
        try {
            this.persist(record);
        }
        catch {
            throw fail('STEP_IMPORT_REPORT_UNAVAILABLE', '导入任务记录无法保存，未开始新的 STEP 导入。');
        }
        this.lastCreatedAt.set(id, createdTime);
        this.active.set(key, record);
        return this.publicRecord(record);
    }
    validateTransfer(id, value) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['taskId', 'sourceName', 'expectedBytes', 'outcomeFingerprint', 'baseRevision', 'baseStateToken'].includes(key)) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.taskId) || typeof value.sourceName !== 'string' || !value.sourceName.startsWith(id + '-') || !/^[-A-Za-z0-9_]{1,64}-\d+-\d+-\d+\.step$/.test(value.sourceName) || !Number.isSafeInteger(value.expectedBytes) || value.expectedBytes < 1 || value.expectedBytes > 1024 ** 3 || !validToken(value.outcomeFingerprint) || value.baseRevision !== undefined && !validInteger(value.baseRevision) || value.baseStateToken !== undefined && !validToken(value.baseStateToken))
            throw fail('STEP_IMPORT_REPORT_UNAVAILABLE', 'STEP 任务材料结构无效，原记录已保留。');
    }
    advance(id, requestId, phase, patch = {}) {
        const key = this.key(id, requestId), previous = this.active.get(key);
        if (!previous)
            return null;
        if (!STEP_IMPORT_PHASES.includes(phase) || activeStepImport(phase) && STEP_IMPORT_PHASES.indexOf(phase) < STEP_IMPORT_PHASES.indexOf(previous.phase))
            throw fail('INVALID_STEP_IMPORT_PHASE', 'STEP 导入阶段不能倒退。');
        const next = { ...previous, phase, sequence: previous.sequence + 1, updatedAt: date() };
        if (Number.isSafeInteger(patch.bytes) && patch.bytes >= 0)
            next.bytes = patch.bytes;
        if (Number.isSafeInteger(patch.revision) && patch.revision >= 0)
            next.revision = patch.revision;
        if (typeof patch.stateToken === 'string' && /^[a-f0-9]{64}$/.test(patch.stateToken))
            next.stateToken = patch.stateToken;
        if (patch.report)
            next.report = stepImportReport(patch.report);
        if (typeof patch.code === 'string')
            next.code = patch.code.slice(0, 100);
        if (typeof patch.error === 'string')
            next.error = patch.error.replaceAll(this.dataDir, '[工程数据]').slice(0, 1000);
        if (typeof patch.unchanged === 'boolean')
            next.unchanged = patch.unchanged;
        this.active.set(key, next);
        try {
            this.persist(next);
        }
        catch {
            if (activeStepImport(phase))
                throw fail('STEP_IMPORT_REPORT_UNAVAILABLE', '导入阶段记录保存失败，后续阶段未继续；请核对原请求和当前工程。');
            next.reportDurable = false;
            this.onWarning('[step] Import result report could not be persisted; query the project outcome.');
        }
        if (!activeStepImport(phase)) {
            this.active.delete(key);
            try {
                this.cleanup(id);
            }
            catch {
                this.onWarning('[step] Import report retention cleanup deferred.');
            }
        }
        return this.publicRecord(next);
    }
    read(file) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
            throw fail('STEP_IMPORT_REPORT_UNAVAILABLE', 'STEP 导入报告类型或大小异常。');
        let record;
        try {
            record = JSON.parse(fs.readFileSync(file, 'utf8'));
        }
        catch {
            throw fail('STEP_IMPORT_REPORT_UNAVAILABLE', 'STEP 导入报告损坏，原始记录已保留。');
        }
        const invalid = record?.version !== 1 || !DOCUMENT.test(record.documentId) || !REQUEST.test(record.requestId) || !STEP_IMPORT_PHASES.includes(record.phase)
            || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || typeof record.ownerInstanceId !== 'string' || !record.ownerInstanceId || record.ownerInstanceId.length > 128
            || typeof record.fileName !== 'string' || record.fileName !== safeFileName(record.fileName) || !validDate(record.createdAt) || !validDate(record.updatedAt)
            || ['bytes', 'revision'].some(key => record[key] !== undefined && !validInteger(record[key])) || record.stateToken !== undefined && !validToken(record.stateToken)
            || ['code', 'error'].some(key => record[key] !== undefined && (typeof record[key] !== 'string' || record[key].length > (key === 'code' ? 100 : 1000)))
            || ['unchanged', 'reportDurable'].some(key => record[key] !== undefined && typeof record[key] !== 'boolean');
        if (invalid)
            throw fail('STEP_IMPORT_REPORT_UNAVAILABLE', 'STEP 导入报告结构无效，原始记录已保留。');
        if (record.transfer)
            this.validateTransfer(record.documentId, record.transfer);
        return record;
    }
    publicRecord(record) {
        const { ownerInstanceId } = record, result = { version: 1 };
        for (const key of ['documentId', 'requestId', 'fileName', 'phase', 'sequence', 'createdAt', 'updatedAt'])
            result[key] = record[key];
        for (const key of ['bytes', 'revision'])
            if (Number.isSafeInteger(record[key]) && record[key] >= 0)
                result[key] = record[key];
        if (typeof record.stateToken === 'string' && /^[a-f0-9]{64}$/.test(record.stateToken))
            result.stateToken = record.stateToken;
        for (const key of ['code', 'error'])
            if (typeof record[key] === 'string')
                result[key] = record[key].slice(0, key === 'code' ? 100 : 1000);
        for (const key of ['unchanged', 'reportDurable'])
            if (typeof record[key] === 'boolean')
                result[key] = record[key];
        result.report = stepImportReport(record.report);
        if (record.transfer)
            result.taskId = record.transfer.taskId;
        if ((activeStepImport(record.phase) && (ownerInstanceId !== this.ownerInstanceId || !this.active.has(this.key(record.documentId, record.requestId)))) || ['interrupted', 'unknown'].includes(record.phase)) {
            let outcome;
            try {
                outcome = this.resolveOutcome(record.documentId, record.requestId, record);
            }
            catch { /* A damaged accepted outcome is not completion evidence. */ }
            if (outcome?.ok === true && outcome.documentId === record.documentId && validInteger(outcome.revision) && validToken(outcome.stateToken))
                return { ...result, phase: 'complete', recovered: true, revision: outcome.revision, stateToken: outcome.stateToken, report: stepImportReport(outcome.stepImport), code: undefined, error: undefined, ...(record.transfer ? { reportDurable: false } : {}) };
            if (record.phase === 'unknown')
                return result;
            return { ...result, phase: 'interrupted', recovered: true, code: 'STEP_IMPORT_INTERRUPTED', error: '上一次后台未记录完整导入结果；没有重新上传或重放命令，请核对工程。' };
        }
        return result;
    }
    getRecord(id, requestId) { const active = this.active.get(this.key(id, requestId)); if (active)
        return active; const file = this.file(id, requestId); if (!fs.existsSync(file))
        return null; const record = this.read(file); if (record.documentId !== id || record.requestId !== requestId)
        throw fail('STEP_IMPORT_REPORT_UNAVAILABLE', 'STEP 导入报告身份不匹配。'); return record; }
    get(id, requestId) { const record = this.getRecord(id, requestId); return record ? this.publicRecord(record) : null; }
    latest(id) { const records = this.records(id); if (!records.length)
        return null; return this.publicRecord(records[0]); }
    records(id) { const directory = this.directory(id); if (!fs.existsSync(directory))
        return []; const records = []; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name))
            continue;
        const record = this.read(path.join(directory, entry.name));
        if (record.documentId !== id || path.basename(this.file(id, record.requestId)) !== entry.name)
            throw fail('STEP_IMPORT_REPORT_UNAVAILABLE', 'STEP 导入报告身份不匹配。');
        records.push(record);
    } return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sequence - a.sequence); }
    cleanup(id) { const records = this.records(id); for (const record of records.slice(this.limit))
        if (!this.active.has(this.key(id, record.requestId)))
            fs.rmSync(this.file(id, record.requestId)); }
    interruptActive() { for (const record of [...this.active.values()])
        this.advance(record.documentId, record.requestId, 'interrupted', { code: 'SERVICE_STOPPING', error: '后台停止时导入结果尚未确认；不会自动重放，请恢复后核对工程。' }); }
}
