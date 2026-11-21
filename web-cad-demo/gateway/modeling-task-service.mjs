import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeModelingTaskStatus } from '../shared/modeling-task-status.mjs';
import {normalizeProjectOpenInput,projectOpenCanonical} from '../shared/project-open-input.mjs';
import {normalizeProjectSaveInput,projectSaveCanonical} from '../shared/project-save-input.mjs';
import {normalizeProjectCreateInput,projectCreateCanonical} from '../shared/project-create-input.mjs';
import {writeTaskRecord, taskPersistenceDiagnostic} from './task-record-file.mjs';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DOCUMENT = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const PHASES = new Set(['reserved', 'receiving', 'queued', 'preparing', 'executing', 'stopping', 'rolling-back', 'committing', ...TERMINAL, 'unknown']);
const NEXT = {
    reserved: ['receiving', 'queued', 'cancelled', 'failed'], receiving: ['queued', 'cancelled', 'failed', 'unknown'], queued: ['preparing', 'failed', 'cancelled', 'unknown'],
    preparing: ['executing', 'rolling-back', 'failed', 'succeeded', 'unknown'],
    executing: ['stopping', 'committing', 'rolling-back', 'failed', 'unknown'],
    stopping: ['rolling-back', 'cancelled', 'failed', 'unknown'],
    committing: ['rolling-back', 'succeeded', 'failed', 'unknown'],
    'rolling-back': ['cancelled', 'failed', 'unknown'],
};
const date = () => new Date().toISOString();
export class ModelingTaskError extends Error {
    constructor(code, message, status = 409) { super(message); this.name = 'ModelingTaskError'; this.code = code; this.status = status; this.retryableByModel = false; }
}
const fault = (code, message, status) => new ModelingTaskError(code, message, status);
/** Task status is not geometry authority; durable project receipts remain so. */
export class ModelingTaskService {
    constructor(dataDir, { ownerInstanceId = randomUUID(), resolveOutcome = () => null, maxRecords = 2048, onWarning = console.warn, onTerminal = () => { } } = {}) {
        if (!UUID.test(ownerInstanceId) || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 4096)
            throw fault('MODELING_TASK_CONFIG_INVALID', '建模任务存储配置无效。', 503);
        this.dataDir = path.resolve(dataDir);
        this.root = path.join(dataDir, 'modeling-tasks');
        Object.assign(this, { ownerInstanceId, resolveOutcome, maxRecords, onWarning, onTerminal });
        this.records = new Map();
        this.active = new Map();
        this.context = new AsyncLocalStorage();
        this.lastError = null;
        this.persistence = {attempts: 0, failures: 0, reconciled: 0, lastFailure: null};
        fs.mkdirSync(this.root, { recursive: true });
        this.checkRoot();
        const files = fs.readdirSync(this.root);
        if (files.length > maxRecords)
            throw fault('MODELING_TASK_CAPACITY', '建模任务记录超过容量，原记录已保留。', 503);
        for (const name of files) {
            if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5)))
                throw fault('MODELING_TASK_STORE_UNAVAILABLE', '任务目录含未知或未完成材料，已保留；需检查后恢复。', 503);
            const record = this.readFile(path.join(this.root, name));
            if (record.taskId + '.json' !== name)
                throw fault('MODELING_TASK_STORE_UNAVAILABLE', '建模任务身份与文件不一致。', 503);
            this.records.set(record.taskId, record);
        }
    }
    checkRoot() {
        const stat = fs.lstatSync(this.root);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw fault('MODELING_TASK_STORE_UNAVAILABLE', '建模任务目录类型异常。', 503);
    }
    file(taskId) {
        if (!UUID.test(taskId))
            throw fault('MODELING_TASK_INVALID', '建模任务标识无效。', 400);
        this.checkRoot();
        return path.join(this.root, taskId + '.json');
    }
    validateMeta(meta) {
        if (!meta || !DOCUMENT.test(meta.documentId) || typeof meta.operation !== 'string' || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*){1,3}$/.test(meta.operation) || meta.operation.length > 100 || typeof meta.requestKey !== 'string' || !meta.requestKey || Buffer.byteLength(meta.requestKey) > 512 || /[\x00-\x1f\x7f]/.test(meta.requestKey) || !/^[a-f0-9]{64}$/.test(meta.digest) || !/^[a-f0-9]{64}$/.test(meta.outcomeFingerprint))
            throw fault('MODELING_TASK_INVALID', '建模任务缺少有效工程、命令、请求身份或输入摘要。', 400);
        if(meta.projectOpenInput!==undefined)this.validateProjectOpenBinding(meta,meta.projectOpenInput);
        if(meta.projectSaveInput!==undefined)this.validateProjectSaveBinding(meta,meta.projectSaveInput);
        if(meta.projectCreateInput!==undefined)this.validateProjectCreateBinding(meta,meta.projectCreateInput);
    }
    validateProjectOpenBinding(meta,value){
        let input;try{input=normalizeProjectOpenInput(value);}catch{throw fault('MODELING_TASK_INVALID','工程文件任务绑定无效，未采用。',400);}
        const fingerprint=createHash('sha256').update(projectOpenCanonical(input)).digest('hex');
        if(meta.operation!=='project.open'||meta.documentId!==input.documentId||meta.requestKey!==input.requestId||meta.digest!==fingerprint||meta.outcomeFingerprint!==fingerprint)throw fault('MODELING_TASK_INVALID','工程文件绑定与任务身份或指纹不一致。',400);
        return input;
    }
    validateProjectSaveBinding(meta,value){
        let input;try{input=normalizeProjectSaveInput(value);}catch{throw fault('MODELING_TASK_INVALID','工程保存任务绑定无效，未采用。',400);}
        const fingerprint=createHash('sha256').update(projectSaveCanonical(input)).digest('hex');
        if(meta.operation!=='project.save'||meta.documentId!==input.documentId||meta.requestKey!==input.requestId||meta.digest!==fingerprint||meta.outcomeFingerprint!==fingerprint)throw fault('MODELING_TASK_INVALID','工程保存绑定与任务身份或指纹不一致。',400);
        return input;
    }
    validateProjectCreateBinding(meta,value){
        let input;try{input=normalizeProjectCreateInput(value);}catch{throw fault('MODELING_TASK_INVALID','新建工程任务绑定无效，未采用。',400);}
        const fingerprint=createHash('sha256').update(projectCreateCanonical(input)).digest('hex');
        if(meta.operation!=='project.create'||meta.documentId!==input.documentId||meta.requestKey!==input.requestId||meta.digest!==fingerprint||meta.outcomeFingerprint!==fingerprint)throw fault('MODELING_TASK_INVALID','新建绑定与任务身份或来源指纹不一致。',400);
        return input;
    }
    readFile(file) {
        const before = fs.lstatSync(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 32768n)
            throw fault('MODELING_TASK_STORE_UNAVAILABLE', '建模任务记录类型或大小异常。', 503);
        let record;
        try {
            record = JSON.parse(fs.readFileSync(file, 'utf8'));
        }
        catch {
            throw fault('MODELING_TASK_STORE_UNAVAILABLE', '建模任务记录无法解析，原文件已保留。', 503);
        }
        const after = fs.lstatSync(file, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
            throw fault('MODELING_TASK_STORE_UNAVAILABLE', '建模任务记录读取期间变化。', 503);
        this.validateMeta(record);
        if (record.version !== 1 || !UUID.test(record.taskId) || !UUID.test(record.ownerInstanceId) || !PHASES.has(record.phase) || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt)) || typeof record.cancelRequested !== 'boolean')
            throw fault('MODELING_TASK_STORE_UNAVAILABLE', '建模任务记录协议无效。', 503);
        return record;
    }
    save(record, { bestEffort = false } = {}) {
        this.persistence.attempts++;
        try {
            const file = this.file(record.taskId);
            if (fs.existsSync(file)) {
                const stat = fs.lstatSync(file);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
                    throw Error('Invalid task file type');
            }
            const durable = { ...record };
            delete durable.reportDurable;
            const publication = writeTaskRecord(file, durable);
            if (publication.reconciled) this.persistence.reconciled++;
            this.records.set(record.taskId, durable);
            return durable;
        }
        catch (cause) {
            this.lastError = 'MODELING_TASK_REPORT_UNAVAILABLE';
            const diagnostic = taskPersistenceDiagnostic(cause, record);
            this.persistence.failures++;
            this.persistence.lastFailure = diagnostic;
            this.warn('[modeling-task] Phase report persistence failed: ' + JSON.stringify(diagnostic) + '; geometry outcome must be queried from its durable project receipt.');
            if (!bestEffort) {
                const error = fault(this.lastError, '建模任务阶段无法持久保存，未继续新的执行阶段。', 503);
                error.details = {taskPersistence: diagnostic};
                throw error;
            }
            const transient = { ...record, reportDurable: false };
            this.records.set(record.taskId, transient);
            return transient;
        }
    }
    warn(message) { try { this.onWarning(message); } catch { /* Auxiliary diagnostics cannot replace a task or geometry outcome. */ } }
    reserve(meta,{projectOpenInput,projectSaveInput,projectCreateInput}={}) {
        this.validateMeta(meta);
        const binding=projectOpenInput===undefined?undefined:this.validateProjectOpenBinding(meta,projectOpenInput);
        const saveBinding=projectSaveInput===undefined?undefined:this.validateProjectSaveBinding(meta,projectSaveInput);
        const createBinding=projectCreateInput===undefined?undefined:this.validateProjectCreateBinding(meta,projectCreateInput);
        const existing = [...this.records.values()].find(record => record.documentId === meta.documentId && record.operation === meta.operation && record.requestKey === meta.requestKey);
        if (existing) {
            if (existing.digest !== meta.digest)
                throw fault('MODELING_TASK_CONFLICT', '同一建模请求身份已绑定不同输入。');
            if(binding&&!existing.projectOpenInput)throw fault('MODELING_TASK_CONFLICT','已有任务缺少原文件绑定，不能补造附件身份。');
            if(saveBinding&&!existing.projectSaveInput)throw fault('MODELING_TASK_CONFLICT','已有任务缺少保存基线绑定，不能补造。');
            if(createBinding&&!existing.projectCreateInput)throw fault('MODELING_TASK_CONFLICT','已有任务缺少新建来源绑定，不能补造。');
            return this.publicRecord(existing);
        }
        if ([...this.records.values()].filter(record => record.ownerInstanceId === this.ownerInstanceId && !TERMINAL.has(record.phase) && record.phase !== 'unknown').length >= 65)
            throw fault('MODELING_TASK_CAPACITY', '等待提交或执行的任务已满，请等待或取消未提交任务。', 429);
        if (this.records.size >= this.maxRecords)
            throw fault('MODELING_TASK_CAPACITY', '建模任务记录已满，请显式删除已完成任务；不会清理未确认结果。', 429);
        const now = date();
        const { documentId, operation, requestKey, digest, outcomeFingerprint } = meta;
        return this.publicRecord(this.save({ version: 1, taskId: randomUUID(), ownerInstanceId: this.ownerInstanceId, documentId, operation, requestKey, digest, outcomeFingerprint, phase: 'reserved', sequence: 1, cancelRequested: false, createdAt: now, updatedAt: now,...(binding?{projectOpenInput:binding}:{}),...(saveBinding?{projectSaveInput:saveBinding}:{}),...(createBinding?{projectCreateInput:createBinding}:{}) }));
    }
    checked(taskId, documentId) {
        this.file(taskId);
        const record = this.records.get(taskId);
        if (!record || record.documentId !== documentId)
            throw fault('MODELING_TASK_NOT_FOUND', '未找到当前工程的建模任务；不会根据旧任务重新执行。', 404);
        return record;
    }
    claim(taskId, meta, { receiving = false } = {}) {
        this.validateMeta(meta);
        if (receiving && !['step.import','project.open'].includes(meta.operation))
            throw fault('MODELING_TASK_OPERATION_UNSUPPORTED', '只有专用文件导入流程可以接收上传。', 400);
        const record = this.checked(taskId, meta.documentId);
        if(receiving&&meta.operation==='project.open'&&!record.projectOpenInput)throw fault('MODELING_TASK_CONFLICT','工程任务没有原始文件绑定，未接收上传。');
        if (record.digest !== meta.digest || record.operation !== meta.operation || record.requestKey !== meta.requestKey || record.outcomeFingerprint !== meta.outcomeFingerprint)
            throw fault('MODELING_TASK_CONFLICT', '任务与原始命令身份或输入不一致，未执行。');
        if (record.ownerInstanceId !== this.ownerInstanceId || record.phase !== 'reserved' || this.active.has(taskId))
            throw fault('MODELING_TASK_ALREADY_SUBMITTED', '任务已有提交或后台已变化，请查询原任务，不要重复执行。');
        const task = { taskId, controller: new AbortController(), mode: receiving ? 'receiving' : 'queued' };
        this.update(taskId, task.mode);
        this.active.set(taskId, task);
        return task;
    }
    update(taskId, phase, patch = {}, options) {
        const previous = this.records.get(taskId);
        if (!previous || !PHASES.has(phase))
            throw fault('MODELING_TASK_INVALID', '建模任务阶段无效。', 400);
        if (phase !== previous.phase && !NEXT[previous.phase]?.includes(phase))
            throw fault('MODELING_TASK_PHASE_INVALID', '建模任务阶段不能跳跃或倒退。', 503);
        const record = this.save({ ...previous, ...patch, phase, sequence: previous.sequence + 1, updatedAt: date() }, options);
        if (TERMINAL.has(phase) || phase === 'unknown')
            try {
                this.onTerminal(record);
            }
            catch {
                this.warn('[modeling-task] Auxiliary terminal report failed; the geometry outcome is unchanged.');
            }
        return record;
    }
    publicRecord(record) {
        const active = this.active.get(record.taskId);
        let projected = record;
        const boundFileTask=record.operation==='project.open'&&record.projectOpenInput||record.operation==='project.save'&&record.projectSaveInput||record.operation==='project.create'&&record.projectCreateInput;
        if (!active && !TERMINAL.has(record.phase)) {
            const outcome = this.resolveOutcome(record);
            if (outcome?.ok)
                projected = { ...record, phase: 'succeeded', revision: outcome.revision, stateToken: outcome.stateToken, recovered: true };
            else if (record.ownerInstanceId !== this.ownerInstanceId)
                projected = boundFileTask&&record.phase==='reserved'?{...record,interrupted:true,execution:'not-started'}:{ ...record, phase: 'unknown', interrupted: true };
        }
        const { version, taskId, documentId, operation, requestKey, phase, sequence, createdAt, updatedAt, cancelRequested } = projected;
        const cancellableOwner=record.ownerInstanceId===this.ownerInstanceId||boundFileTask&&record.phase==='reserved'&&projected.execution==='not-started';
        const result = { version, taskId, documentId, operation, requestKey, phase, sequence, createdAt, updatedAt, cancelRequested, cancellable: Boolean(cancellableOwner) && !cancelRequested && ['reserved', 'receiving', 'queued', 'executing'].includes(phase), reportDurable: projected.reportDurable !== false };
        for (const key of ['revision', 'stateToken', 'code', 'error', 'recovered', 'interrupted', 'execution','restored','unchanged'])
            if (projected[key] !== undefined)
                result[key] = projected[key];
        return normalizeModelingTaskStatus(result, record.documentId, record.taskId);
    }
    get(documentId, taskId) { return this.publicRecord(this.checked(taskId, documentId)); }
    list(documentId) {
        if (!DOCUMENT.test(documentId))
            throw fault('MODELING_TASK_INVALID', '工程标识无效。', 400);
        const priority = record => TERMINAL.has(record.phase) ? 2 : record.ownerInstanceId === this.ownerInstanceId && record.phase !== 'unknown' ? 0 : 1;
        return [...this.records.values()].filter(record => record.documentId === documentId).sort((a, b) => priority(a) - priority(b) || b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(record => this.publicRecord(record));
    }
    abandonUnsubmitted(documentId, taskId) {
        const record = this.checked(taskId, documentId);
        if (record.ownerInstanceId !== this.ownerInstanceId || record.phase !== 'reserved' || this.active.has(taskId))
            throw fault('MODELING_TASK_ALREADY_SUBMITTED', '任务已被接收或后台已变化，不能按未提交清理。');
        return this.publicRecord(this.update(taskId, 'failed', { code: 'MODELING_TASK_NOT_SUBMITTED', execution: 'not-started' }));
    }
    cancel(documentId, taskId) {
        const record = this.checked(taskId, documentId), status = this.publicRecord(record);
        if (record.cancelRequested || TERMINAL.has(status.phase) || status.phase === 'stopping' || status.phase === 'rolling-back')
            return status;
        if (!status.cancellable)
            throw fault('MODELING_TASK_NOT_CANCELLABLE', '任务正在准备恢复点、提交或恢复，当前阶段不能取消；请查询最终状态。');
        const task = this.active.get(taskId);
        if (record.phase === 'reserved')
            return this.publicRecord(this.update(taskId, 'cancelled', { cancelRequested: true, execution: 'not-started' }));
        this.update(taskId, ['receiving', 'queued'].includes(record.phase) ? record.phase : 'stopping', { cancelRequested: true });
        task.controller.abort();
        return this.get(documentId, taskId);
    }
    runAction(task, action) {
        return this.context.run(task, async () => { task.mode = 'preparing'; this.update(task.taskId, 'preparing'); return action(); });
    }
    enterQueued(task) {
        if (this.active.get(task.taskId) !== task || task.mode !== 'receiving')
            throw fault('MODELING_TASK_PHASE_INVALID', '上传任务不能跳过接收阶段。', 503);
        if (task.controller.signal.aborted)
            throw fault('DOCUMENT_ACTION_CANCELLED', '上传已取消，未进入几何执行。');
        this.update(task.taskId, 'queued');
        task.mode = 'queued';
    }
    enterExecuting() {
        const task = this.context.getStore();
        if (!task)
            return;
        this.update(task.taskId, 'executing');
        task.mode = 'executing';
    }
    beginCommit() {
        const task = this.context.getStore();
        if (!task)
            return;
        if (task.mode === 'committing')
            return;
        if (task.controller.signal.aborted)
            throw fault('WORKER_CANCELLED', '建模任务已请求取消；正在恢复原工程。');
        this.update(task.taskId, 'committing');
        task.mode = 'committing';
    }
    beginRecovery() {
        const task = this.context.getStore();
        if (!task)
            return;
        // Always remove cancellation from recovery before attempting a report write.
        task.mode = 'rolling-back';
        this.update(task.taskId, 'rolling-back', {}, { bestEffort: true });
    }
    commandOptions() { const task = this.context.getStore(); return task?.mode === 'executing' ? { signal: task.controller.signal } : {}; }
    async finish(task, promise, selectResult = value => value) {
        try {
            const value = await promise, result = selectResult(value);
            const restored = result?.ok !== true && result?.projectRollback?.confirmed === true && result.projectRollback.documentId === this.records.get(task.taskId).documentId;
            this.update(task.taskId, result?.ok ? 'succeeded' : 'failed', { ...(Number.isSafeInteger(result?.revision) ? { revision: result.revision } : {}), ...(typeof result?.stateToken === 'string' && /^[a-f0-9]{64}$/.test(result.stateToken) ? { stateToken: result.stateToken } : {}), ...(result?.code ? { code: String(result.code).slice(0, 100) } : {}), ...(typeof result?.error === 'string' ? { error: result.error.replaceAll(this.dataDir, '[工程数据]').slice(0, 1000) } : {}), ...(restored ? { restored: true } : {}) }, { bestEffort: true });
            return value;
        }
        catch (error) {
            const record = this.records.get(task.taskId), restored = error?.projectRollback?.confirmed === true && error.projectRollback.documentId === record.documentId;
            const unchanged=record.operation==='project.save'&&error?.projectSaveUnchanged?.confirmed===true&&error.projectSaveUnchanged.documentId===record.documentId;
            const notStarted = task.mode === 'receiving' || ['DOCUMENT_ACTION_CANCELLED', 'DOCUMENT_ACTION_QUEUE_LIMIT', 'DOCUMENT_ACTION_INPUT_LIMIT', 'DOCUMENT_ACTION_QUEUE_TIMEOUT', 'SERVICE_STOPPING'].includes(error?.code) && task.mode === 'queued' || record.operation==='project.open'&&task.mode==='preparing'&&error?.projectOpenNotStarted?.documentId===record.documentId&&error.projectOpenNotStarted.confirmed===true || record.operation==='project.save'&&task.mode==='preparing'&&error?.projectSaveNotStarted?.confirmed===true&&error.projectSaveNotStarted.documentId===record.documentId;
            const createNotStarted=record.operation==='project.create'&&task.mode==='preparing'&&error?.projectCreateNotStarted?.confirmed===true&&error.projectCreateNotStarted.documentId===record.documentId;
            const cancelled = record.cancelRequested && (notStarted || createNotStarted || (restored||unchanged) && error.code === 'WORKER_CANCELLED');
            if (cancelled)
                try {
                    error.message = notStarted||createNotStarted ? (task.mode === 'receiving' ? (record.operation==='project.open'?'已取消工程文件上传，目标工程未打开。':'已取消文件上传，几何导入未执行。') : '已取消排队，命令未执行。') : unchanged?'已取消备份生成，工程几何与属性未修改。':'已取消此项建模，原几何、属性与历史已恢复。';
                }
                catch { /* Preserve immutable original errors and keep the verified task status. */ }
            const uncertain = !restored && !unchanged && !notStarted && !createNotStarted && !['queued', 'preparing'].includes(task.mode);
            this.update(task.taskId, cancelled ? 'cancelled' : uncertain ? 'unknown' : 'failed', { code: String(error?.code || 'MODELING_TASK_FAILED').slice(0, 100), error: String(error?.message || '建模未完成。').replaceAll(this.dataDir, '[工程数据]').slice(0, 1000), ...(notStarted||createNotStarted ? { execution: 'not-started' } : {}), ...(restored ? { restored: true } : {}),...(unchanged?{unchanged:true}:{}) }, { bestEffort: true });
            try {
                error.modelingTask = this.get(record.documentId, task.taskId);
            }
            catch { /* Original execution error remains authoritative. */ }
            throw error;
        }
        finally {
            this.active.delete(task.taskId);
        }
    }
    result(documentId, taskId) {
        const record = this.checked(taskId, documentId);
        if (this.publicRecord(record).phase !== 'succeeded')
            throw fault('MODELING_TASK_RESULT_UNCONFIRMED', '任务尚未证明成功，未返回推测结果。');
        const result = this.resolveOutcome(record);
        if (!result?.ok)
            throw fault('MODELING_TASK_RESULT_EXPIRED', '原始提交回执已不可用；请查询当前工程，不要重复执行旧任务。', 410);
        return result;
    }
    delete(documentId, taskId) {
        const record = this.checked(taskId, documentId);
        if (this.active.has(taskId) || !TERMINAL.has(this.publicRecord(record).phase))
            throw fault('MODELING_TASK_ACTIVE', '不能删除活动或结果未确认的任务。');
        const file = this.file(taskId), actual = this.readFile(file);
        if (actual.digest !== record.digest || actual.documentId !== documentId || actual.taskId !== taskId)
            throw fault('MODELING_TASK_STORE_UNAVAILABLE', '任务材料已变化，未删除。', 503);
        fs.unlinkSync(file);
        this.records.delete(taskId);
    }
    clearCompleted(documentId) {
        if (!DOCUMENT.test(documentId))
            throw fault('MODELING_TASK_INVALID', '工程标识无效。', 400);
        let deleted = 0, retained = 0;
        for (const record of [...this.records.values()]) {
            if (record.documentId !== documentId || this.active.has(record.taskId) || !TERMINAL.has(record.phase))
                continue;
            try {
                this.delete(documentId, record.taskId);
                deleted++;
            }
            catch {
                retained++;
            }
        }
        return { deleted, retained };
    }
    status() { return { stored: this.records.size, active: this.active.size, maxRecords: this.maxRecords, maxPending: 65, lastError: this.lastError, persistence: structuredClone(this.persistence) }; }
}
