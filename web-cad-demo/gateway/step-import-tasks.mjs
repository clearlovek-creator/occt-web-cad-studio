import path from 'node:path';
import { createHash } from 'node:crypto';
import { ModelingTaskError } from './modeling-task-service.mjs';
import { PendingProjectInputError } from './pending-project-inputs.mjs';
const requestPattern = /^[A-Za-z0-9._:-]{1,160}$/, token = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code, message, status = 409) => new ModelingTaskError(code, message, status);
function canonical(value) { if (Array.isArray(value))
    return value.map(canonical); if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value; }
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
/** One registered file attachment, one original engineering transaction. */
export class StepImportTasks {
    constructor({ dataDir, tasks, imports, inputs, maxBytes, createSourcePath, fingerprint, execute }) { Object.assign(this, { dataDir: path.resolve(dataDir), tasks, imports, inputs, maxBytes, createSourcePath, fingerprint, execute }); }
    validate(documentId, input) {
        const keys = ['protocolVersion', 'operation', 'documentId', 'requestId', 'fileName', 'expectedBytes', 'baseRevision', 'baseStateToken'];
        if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !keys.includes(key)) || input.protocolVersion !== 1 || input.operation !== 'step.import' || input.documentId !== documentId || typeof input.requestId !== 'string' || !requestPattern.test(input.requestId) || typeof input.fileName !== 'string' || !input.fileName || input.fileName.length > 240 || /[\x00-\x1f\x7f/\\]/.test(input.fileName) || !Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1 || input.expectedBytes > this.maxBytes || input.baseRevision !== undefined && (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) || input.baseStateToken !== undefined && !token(input.baseStateToken))
            throw fail('STEP_IMPORT_TASK_ARGUMENTS', 'STEP 任务需提供有效文件名、大小、工程、请求身份和编辑基线。', 400);
        return { protocolVersion: 1, operation: 'step.import', documentId, requestId: input.requestId, fileName: input.fileName, expectedBytes: input.expectedBytes, ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}), ...(input.baseStateToken !== undefined ? { baseStateToken: input.baseStateToken } : {}) };
    }
    command(record) { const transfer = record.transfer; this.imports.validateTransfer(record.documentId, transfer); return { protocolVersion: 1, operation: 'step.import', documentId: record.documentId, requestId: record.requestId, fileName: record.fileName, expectedBytes: transfer.expectedBytes, ...(transfer.baseRevision !== undefined ? { baseRevision: transfer.baseRevision } : {}), ...(transfer.baseStateToken !== undefined ? { baseStateToken: transfer.baseStateToken } : {}) }; }
    fields(record) { const command = this.command(record); return { documentId: record.documentId, clientRequestId: record.requestId, ...(command.baseRevision !== undefined ? { baseRevision: command.baseRevision } : {}), ...(command.baseStateToken !== undefined ? { baseStateToken: command.baseStateToken } : {}), parameters: { path: path.join(this.dataDir, 'imports', record.transfer.sourceName) } }; }
    meta(record) { const fields = this.fields(record), fingerprint = this.fingerprint('step.import', fields); if (fingerprint !== record.transfer.outcomeFingerprint)
        throw fail('STEP_IMPORT_TASK_CHANGED', '导入材料与原任务指纹不一致，未执行。'); return { documentId: record.documentId, operation: 'step.import', requestKey: record.requestId, digest: digest({ command: this.command(record), sourceName: record.transfer.sourceName }), outcomeFingerprint: fingerprint }; }
    register(documentId, input) {
        const command = this.validate(documentId, input), existing = this.imports.getRecord(documentId, command.requestId);
        if (existing) {
            if (!existing.transfer || digest(this.command(existing)) !== digest(command))
                throw fail('MODELING_TASK_CONFLICT', '此导入身份已绑定其他文件或基线；未接收新上传。');
            return { modelingTask: this.tasks.get(documentId, existing.transfer.taskId), stepImportStatus: this.imports.publicRecord(existing) };
        }
        const sourceName = path.basename(this.createSourcePath(documentId)), fields = { documentId, clientRequestId: command.requestId, ...(command.baseRevision !== undefined ? { baseRevision: command.baseRevision } : {}), ...(command.baseStateToken !== undefined ? { baseStateToken: command.baseStateToken } : {}), parameters: { path: path.join(this.dataDir, 'imports', sourceName) } };
        const outcomeFingerprint = this.fingerprint('step.import', fields), meta = { documentId, operation: 'step.import', requestKey: command.requestId, digest: digest({ command, sourceName }), outcomeFingerprint }, task = this.tasks.reserve(meta);
        try {
            const stepImportStatus = this.imports.begin(documentId, command.requestId, command.fileName, { taskId: task.taskId, sourceName, expectedBytes: command.expectedBytes, outcomeFingerprint, ...(command.baseRevision !== undefined ? { baseRevision: command.baseRevision } : {}), ...(command.baseStateToken !== undefined ? { baseStateToken: command.baseStateToken } : {}) });
            return { modelingTask: task, stepImportStatus };
        }
        catch (error) {
            try {
                this.tasks.abandonUnsubmitted(documentId, task.taskId);
            }
            catch { /* Preserve the original admission error. */ }
            throw error;
        }
    }
    settle(task) {
        if (task.operation !== 'step.import')
            return;
        const record = this.imports.active.get(this.imports.key(task.documentId, task.requestKey));
        if (!record?.transfer || record.transfer.taskId !== task.taskId)
            return;
        if (task.phase === 'succeeded') {
            const result = this.tasks.result(task.documentId, task.taskId);
            this.imports.advance(task.documentId, task.requestKey, 'complete', { revision: result.revision, stateToken: result.stateToken, report: result.stepImport });
        }
        else if (['failed', 'cancelled', 'unknown'].includes(task.phase))
            this.imports.advance(task.documentId, task.requestKey, task.phase === 'unknown' ? 'unknown' : 'failed', { code: task.code || (task.phase === 'cancelled' ? 'STEP_IMPORT_CANCELLED' : 'STEP_IMPORT_FAILED'), error: task.error, unchanged: task.phase !== 'unknown' && (task.restored === true || task.execution === 'not-started' || task.phase === 'cancelled') });
    }
    async upload(documentId, taskId, headers, request) {
        if (typeof taskId !== 'string' || typeof headers['x-request-id'] !== 'string' || typeof headers['x-file-name'] !== 'string')
            throw fail('STEP_IMPORT_TASK_ARGUMENTS', 'STEP 上传必须携带唯一任务与原请求身份、文件名。', 400);
        const record = this.imports.getRecord(documentId, headers['x-request-id']);
        if (!record?.transfer || record.transfer.taskId !== taskId)
            throw fail('MODELING_TASK_CONFLICT', 'STEP 上传与登记任务不一致。');
        const expected = this.command(record);
        let fileName;
        try {
            fileName = decodeURIComponent(headers['x-file-name'] || '');
        }
        catch {
            throw fail('STEP_IMPORT_TASK_ARGUMENTS', 'STEP 文件名编码无效。', 400);
        }
        if (fileName !== expected.fileName || headers['x-base-state-token'] !== expected.baseStateToken || headers['x-base-revision'] !== (expected.baseRevision === undefined ? undefined : String(expected.baseRevision)) || headers['content-length'] !== undefined && headers['content-length'] !== String(expected.expectedBytes))
            throw fail('MODELING_TASK_CONFLICT', 'STEP 上传文件或基线不符合登记内容；未接收。');
        const task = this.tasks.claim(taskId, this.meta(record), { receiving: true });
        const operation = (async () => {
            let staged, installed, retained = false;
            try {
                staged = await this.inputs.receive(request, { maxBytes: this.maxBytes, declaredBytes: expected.expectedBytes, signal: task.controller.signal });
                const fields = this.fields(record);
                installed = await staged.copyTo(fields.parameters.path, { signal: task.controller.signal });
                this.tasks.enterQueued(task);
                this.imports.advance(documentId, record.requestId, 'queued', { bytes: staged.bytes });
                const result = await this.execute(fields, (phase, patch) => this.imports.advance(documentId, record.requestId, phase, patch), task, () => installed.verify());
                retained = Boolean(result.ok);
                return result;
            }
            catch (error) {
                retained ||= error?.projectRollback?.confirmed !== true && ['executing', 'stopping', 'rolling-back', 'committing'].includes(task.mode);
                if (error instanceof PendingProjectInputError)
                    throw fail(error.code === 'SERVICE_STOPPING' ? error.code : error.code.replace(/^PROJECT_INPUT_/, 'STEP_IMPORT_UPLOAD_'), error.message, error.status);
                throw error;
            }
            finally {
                await installed?.dispose({ retain: retained });
                await staged?.release();
            }
        })();
        const result = await this.tasks.finish(task, operation), status = this.imports.get(documentId, record.requestId);
        return { ...result, modelingTask: this.tasks.get(documentId, taskId), stepImportStatus: status, ...(status?.reportDurable === false ? { warnings: [...(result.warnings || []), '导入已提交，但统计报告落盘未确认，请保留任务身份并核对工程。'] } : {}) };
    }
}
