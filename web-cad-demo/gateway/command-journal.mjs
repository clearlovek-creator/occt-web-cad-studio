import fs from 'node:fs';
import path from 'node:path';
import {writeAtomicRecord} from './atomic-record-file.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const TERMINAL = new Set(['success', 'error', 'cancelled']);
const TASK_STATUS = {succeeded: 'success', failed: 'error', cancelled: 'cancelled', unknown: 'unknown'};
const UNCERTAIN_CODES = new Set(['PROJECT_ROLLBACK_FAILED', 'STEP_IMPORT_RESULT_UNKNOWN', 'MODELING_TASK_RESULT_UNKNOWN']);
const keyOf = ({operation, requestId}) => JSON.stringify([operation, requestId]);
const allowedCode = code => typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code) ? code : undefined;
const validRequest = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[\x00-\x1f\x7f]/.test(value);

export class CommandJournal {
    constructor(dataDir, {resolveOutcome, taskStatus, onWarning = console.warn}) {
        this.directory = path.join(dataDir, 'command-journal');
        Object.assign(this, {resolveOutcome, taskStatus, onWarning});
        this.active = new Set();
    }

    file(documentId) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(documentId)) throw Error('Invalid journal document ID');
        try {
            const directory = fs.lstatSync(this.directory);
            if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Invalid command journal directory');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        return path.join(this.directory, documentId + '.json');
    }

    read(file, documentId) {
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw Error('Invalid command journal file');
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (record.version !== 1 || record.documentId !== documentId || !Array.isArray(record.entries)) throw Error('Invalid command journal record');
        return record.entries;
    }

    write(file, documentId, entries) {
        let remaining = 200;
        const retained = entries.filter(entry => !TERMINAL.has(entry.status) || remaining-- > 0);
        fs.mkdirSync(this.directory, {recursive: true});
        writeAtomicRecord(file, {version: 1, documentId, entries: retained}, {maxBytes: MAX_BYTES});
    }

    start({documentId, operation, requestId, taskId, startedAt = Date.now(), receiptKey, fingerprint, eventId, rejectedCode}) {
        if (!validRequest(requestId) || !/^[a-z][a-z0-9_.]{0,99}$/.test(operation)) return null;
        const entry = {documentId, operation, requestId, taskId, startedAt, updatedAt: startedAt, receiptKey, fingerprint, eventId,
            status: rejectedCode ? 'error' : 'running', code: allowedCode(rejectedCode), rejectedBeforeExecution: rejectedCode ? true : undefined};
        try {
            const file = this.file(documentId);
            const entries = this.read(file, documentId);
            const previous = entries.find(row => keyOf(row) === keyOf(entry));
            if (previous && (!previous.rejectedBeforeExecution || rejectedCode)) return null;
            this.write(file, documentId, [entry, ...entries.filter(row => row !== previous)]);
            return entry;
        } catch {
            this.onWarning('[command-journal] Could not retain command identity.');
            return null;
        }
    }

    update(entry, status, code, revision, updatedAt = Date.now()) {
        if (!entry) return;
        const {documentId} = entry;
        try {
            const file = this.file(documentId);
            const entries = this.read(file, documentId);
            const current = entries.find(row => keyOf(row) === keyOf(entry));
            if (!current || TERMINAL.has(current.status) || current.taskId !== entry.taskId) return;
            const result = {...current, status, code: allowedCode(code), revision: Number.isSafeInteger(revision) ? revision : undefined, updatedAt};
            this.write(file, documentId, [result, ...entries.filter(row => row !== current)]);
        } catch {
            this.onWarning('[command-journal] Could not retain command outcome.');
        }
    }

    observeTask(record) {
        const source = record.projectCreateInput?.sourceDocumentId ?? record.projectOpenInput?.sourceDocumentId;
        for (const documentId of source ? [record.documentId, source] : [record.documentId]) {
            const entry = {documentId, operation: record.operation, requestId: record.journalRequestId ?? record.requestKey, taskId: record.taskId};
            if (record.phase === 'reserved') {
                this.start({...entry, startedAt: Date.parse(record.createdAt)});
            } else if (TASK_STATUS[record.phase]) {
                this.update(entry, TASK_STATUS[record.phase], record.code, record.revision, Date.parse(record.updatedAt));
            }
        }
    }

    track(entry, execute, selectResult = value => value) {
        const record = this.start(entry);
        if (!record) return execute();
        this.active.add(JSON.stringify([entry.documentId, keyOf(entry)]));
        return (async () => {
            try {
                const value = await execute(), result = selectResult(value);
                this.update(record, result?.ok ? 'success' : 'error', result?.code, result?.revision);
                return value;
            } catch (error) {
                const status = error.code === 'DOCUMENT_ACTION_CANCELLED' ? 'cancelled'
                    : UNCERTAIN_CODES.has(error.code) ? 'unknown' : 'error';
                this.update(record, status, error.code);
                throw error;
            } finally {
                this.active.delete(JSON.stringify([entry.documentId, keyOf(entry)]));
            }
        })();
    }

    project(entry) {
        if (TERMINAL.has(entry.status)) return entry;
        if (entry.taskId) {
            let task;
            try { task = this.taskStatus(entry.documentId, entry.taskId); } catch { /* Evidence can be temporarily unreadable. */ }
            if (task) {
                const status = TASK_STATUS[task.phase] ?? (task.interrupted ? 'unknown' : 'running');
                return {...entry, status, updatedAt: Date.parse(task.updatedAt), code: task.code, revision: task.revision};
            }
        }
        if (entry.status === 'running' && this.active.has(JSON.stringify([entry.documentId, keyOf(entry)]))) return entry;
        let outcome;
        try { outcome = this.resolveOutcome(entry); } catch { /* Keep the original identity available for another check. */ }
        if (outcome?.ok) return {...entry, status: 'success', revision: outcome.revision, code: undefined,
            updatedAt: Number.isFinite(outcome.updatedAt) ? outcome.updatedAt : entry.updatedAt};
        return {...entry, status: 'unknown', code: entry.code || 'COMMAND_RESULT_UNKNOWN'};
    }

    list(documentId, requestId = null) {
        const rows = this.read(this.file(documentId), documentId);
        return rows.filter(entry => requestId === null || entry.requestId === requestId).map(entry => {
            const {operation, status, taskId, startedAt, updatedAt, code, revision} = this.project(entry);
            return {documentId, requestId: entry.requestId, operation, status, taskId, startedAt, code: allowedCode(code),
                revision: Number.isSafeInteger(revision) ? revision : undefined,
                durationMs: status === 'running' ? undefined : Math.max(0, updatedAt - startedAt)};
        }).sort((left, right) => right.startedAt - left.startedAt);
    }

    clearCompleted(documentId) {
        const file = this.file(documentId);
        const entries = this.read(file, documentId);
        const pending = [], removed = [];
        for (const entry of entries) {
            if (TERMINAL.has(this.project(entry).status)) removed.push({operation:entry.operation, requestId:entry.requestId});
            else pending.push(entry);
        }
        if (removed.length) this.write(file, documentId, pending);
        return removed;
    }
}
