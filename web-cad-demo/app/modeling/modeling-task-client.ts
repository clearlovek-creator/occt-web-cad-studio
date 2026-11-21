import { normalizeModelingTaskStatus, modelingTaskTerminal, type ModelingTaskStatus } from '../../shared/modeling-task-status.mjs';
import {normalizeProjectOpenInput,normalizeProjectOpenTask,type ProjectOpenInput,type ProjectOpenTask} from '../../shared/project-open-input.mjs';
import {normalizeProjectSaveInput,normalizeProjectSaveTask,normalizeProjectBackupReceipt,type ProjectSaveInput,type ProjectSaveTask,type ProjectBackupReceipt} from '../../shared/project-save-input.mjs';
import {normalizeProjectCreateInput,normalizeProjectCreateTask,normalizeProjectCreateReceipt,type ProjectCreateInput,type ProjectCreateTask} from '../../shared/project-create-input.mjs';
import {readProjectBackup,ProjectBackupReadError} from './project-backup-read.ts';
import { isReadOnlyCommand, type ModelingCommandRequest, type ModelingBatchRequest, type ModelingCommandResponse, type ModelingCommandErrorPayload } from './command-contract.ts';
export type ModelingTaskObservation = {
    task: ModelingTaskStatus;
    /** Discovered from the shared task registry, not submitted by this page. */
    external?: boolean;
    notice: string | null;
    checking: boolean;
    cancelPending: boolean;
    projectOpen?:ProjectOpenTask;
    projectSave?:ProjectSaveTask;
    projectCreate?:ProjectCreateTask;
    backupReceipt?:ProjectBackupReceipt;
    download?:{phase:'reading'|'stopping'|'ready'|'failed'|'cancelled';receivedBytes:number;totalBytes:number;notice:string|null};
};

/** Transfers are displayed and controlled from their source workspace. */
export const modelingTaskSourceDocument = (item: ModelingTaskObservation) => item.projectCreate?.sourceDocumentId || item.projectOpen?.sourceDocumentId || item.task.documentId;
/** Both endpoints must stay busy until a transfer has an authoritative outcome. */
export const modelingTaskTouchesDocument = (item: ModelingTaskObservation, documentId: string) => item.task.documentId === documentId || modelingTaskSourceDocument(item) === documentId;
type Packet = {
    ok: boolean;
    status: number;
    payload: ModelingCommandResponse | ModelingCommandErrorPayload;
};
type Session = ModelingTaskObservation & {
    timer?: ReturnType<typeof setTimeout>;
    pending?: Promise<ModelingTaskStatus>;
    startedAt: number;
    stopped: boolean;
    downloadAbort?:AbortController;
    createSubmitted?:boolean;
};
const rank: Record<string, number> = { reserved: 0, receiving:1, queued: 2, preparing: 3, executing: 4, committing: 5, stopping: 5, 'rolling-back': 6, unknown: 7, failed: 8, cancelled: 8, succeeded: 8 };
export class ModelingTaskClientError extends Error {
    readonly payload: ModelingCommandErrorPayload;
    readonly status: number;
    constructor(payload: ModelingCommandErrorPayload, status: number) { super(payload.error); this.name = 'ModelingTaskClientError'; this.payload = payload; this.status = status; }
}
export const canTrackModelingTask = (request: ModelingCommandRequest) => !isReadOnlyCommand(request.operation) && !request.options?.preview && !(request as ModelingCommandRequest & {
    preview?: boolean;
}).preview && !['step.import', 'step.export', 'document.snapshot', 'document.restore', 'document.naming.upgrade'].includes(request.operation);
export class ModelingTaskClient {
    private readonly sessions = new Map<string, Session>();
    private readonly discoveries = new Map<string, Promise<void>>();
    private readonly createDiscoveries = new Map<string, Promise<{omitted:number}>>();
    private batching = 0;
    private batched = false;
    private disposed = false;
    private apiRoot: string;
    private fetchImpl: typeof fetch;
    private onChange: (tasks: ModelingTaskObservation[]) => void;
    private options: {
        pollMs?: number;
        recoveryMs?: number;
        watchMs?: number;
    };
    constructor(apiRoot: string, fetchImpl: typeof fetch, onChange: (tasks: ModelingTaskObservation[]) => void, options: {
        pollMs?: number;
        recoveryMs?: number;
        watchMs?: number;
    } = {}) { this.apiRoot = apiRoot; this.fetchImpl = fetchImpl; this.onChange = onChange; this.options = options; }
    private emit() { if(this.batching){this.batched=true;return;}if (!this.disposed)
        this.onChange([...this.sessions.values()].map(({ task, external, notice, checking, cancelPending,projectOpen,projectSave,projectCreate,backupReceipt,download }) => ({ task, ...(external?{external:true}:{}), notice, checking, cancelPending,...(projectOpen?{projectOpen}: {}),...(projectSave?{projectSave}:{}),...(projectCreate?{projectCreate}:{}),...(backupReceipt?{backupReceipt}:{}),...(download?{download:{...download}}:{}) }))); }
    private route(task: ModelingTaskStatus, suffix = '') { return `${this.apiRoot}/documents/${encodeURIComponent(task.documentId)}/modeling-tasks/${encodeURIComponent(task.taskId)}${suffix}`; }
    private error(code: string, error: string, status = 502) { return new ModelingTaskClientError({ ok: false, code, error, recoverable: true, retryableByModel: false }, status); }
    private verifyCreateReceipt(session:Session,value:unknown){if(!session.projectCreate)throw this.error('MODELING_TASK_PROTOCOL','新建工程缺少原来源绑定，未采用回执。');return normalizeProjectCreateReceipt(value,session.task,session.projectCreate);}
    private async json(url: string, init?: RequestInit, limitBytes = 4 * 1024 * 1024): Promise<{
        response: Response;
        payload: Record<string, unknown>;
    }> {
        const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(5000) });
        const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
        let total = 0;
        if (!reader)
            throw this.error('MODELING_TASK_PROTOCOL', '任务状态响应为空。');
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                total += value.byteLength;
                if (total > limitBytes) {
                    await reader.cancel();
                    throw this.error('MODELING_TASK_RESPONSE_LIMIT', '任务服务响应超过读取预算。');
                }
                chunks.push(value);
            }
        }
        finally {
            reader.releaseLock();
        }
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.byteLength;
        }
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        }
        catch {
            throw this.error('MODELING_TASK_PROTOCOL', '任务服务返回无效状态；未重新提交命令。');
        }
        if (!payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean')
            throw this.error('MODELING_TASK_PROTOCOL', '任务服务响应不符合协议。');
        if (!response.ok || payload.ok !== true)
            throw new ModelingTaskClientError({ ...payload, ok: false, code: String(payload.code || 'MODELING_TASK_FAILED'), error: String(payload.error || '任务控制未完成。'), retryableByModel: false } as ModelingCommandErrorPayload, response.status);
        return { response, payload };
    }
    private accept(session: Session, value: unknown) {
        const next = normalizeModelingTaskStatus(value, session.task.documentId, session.task.taskId);
        if (next.operation !== session.task.operation || next.requestKey !== session.task.requestKey)
            throw this.error('MODELING_TASK_PROTOCOL', '任务响应与原始命令身份不一致。');
        const old = session.task;
        if (next.sequence < old.sequence || next.sequence === old.sequence && rank[next.phase] < rank[old.phase])
            return;
        session.task = next;
        if(session.projectOpen&&next.phase!=='reserved')session.projectOpen={...session.projectOpen,canUpload:false};
        if(session.projectSave&&next.phase!=='reserved')session.projectSave={...session.projectSave,canGenerate:false};
        if(session.projectCreate&&next.phase!=='reserved')session.projectCreate={...session.projectCreate,canCreate:false};
        session.notice = null;
        if (modelingTaskTerminal(next.phase)) {
            clearTimeout(session.timer);
            session.stopped = true;
        }
        if (JSON.stringify(next) !== JSON.stringify(old))
            this.emit();
    }
    private add(task: ModelingTaskStatus,projectOpen?:ProjectOpenTask,projectSave?:ProjectSaveTask,external=false,projectCreate?:ProjectCreateTask) {
        const existing = this.sessions.get(task.taskId);
        if (existing) {
            const metadata=JSON.stringify([existing.projectOpen,existing.projectSave,existing.projectCreate]);
            if(projectOpen){if(existing.projectOpen)normalizeProjectOpenTask(projectOpen,task,existing.projectOpen.sourceDocumentId,existing.projectOpen);existing.projectOpen=projectOpen;}
            if(projectSave){if(existing.projectSave)normalizeProjectSaveTask(projectSave,task,existing.projectSave);existing.projectSave=projectSave;}
            if(projectCreate){if(existing.projectCreate)normalizeProjectCreateTask(projectCreate,task,existing.projectCreate.sourceDocumentId,existing.projectCreate);if(task.sequence>=existing.task.sequence)existing.projectCreate=projectCreate;}
            this.accept(existing, task);
            if(existing.projectCreate&&(existing.task.phase!=='reserved'||existing.task.cancelRequested))existing.projectCreate={...existing.projectCreate,canCreate:false};
            if(metadata!==JSON.stringify([existing.projectOpen,existing.projectSave,existing.projectCreate]))this.emit();
            return existing;
        }
        if (this.sessions.size >= 128) {
            const removable = [...this.sessions.values()].find(session => modelingTaskTerminal(session.task.phase)&&!session.downloadAbort);
            if (removable)
                this.sessions.delete(removable.task.taskId);
            else
                throw this.error('MODELING_TASK_CLIENT_CAPACITY', '页面跟踪的建模任务已满，请等待或核对现有任务。', 429);
        }
        const session: Session = { task, ...(external?{external:true}:{}), notice: null, checking: false, cancelPending: false, startedAt: Date.now(), stopped: modelingTaskTerminal(task.phase),...(projectOpen?{projectOpen}:{}),...(projectSave?{projectSave}:{}),...(projectCreate?{projectCreate}:{}) };
        this.sessions.set(task.taskId, session);
        this.emit();
        return session;
    }
    private schedule(session: Session) {
        clearTimeout(session.timer);
        if (this.disposed || session.stopped)
            return;
        if (Date.now() - session.startedAt > (this.options.watchMs ?? 600000)) {
            session.notice = '状态观察已暂停，请点击“检查状态”；没有重新执行命令。';
            this.emit();
            return;
        }
        session.timer = setTimeout(() => { void this.refresh(session.task.taskId).catch(() => { }).finally(() => this.schedule(session)); }, this.options.pollMs ?? 500);
    }
    async refresh(taskId: string): Promise<ModelingTaskStatus> {
        const session = this.sessions.get(taskId);
        if (!session)
            throw this.error('MODELING_TASK_NOT_FOUND', '页面未持有此任务身份。', 404);
        if (session.pending)
            return session.pending;
        session.checking = true;
        this.emit();
        const pending = (async () => {
            try {
                const { payload } = await this.json(this.route(session.task));
                this.accept(session, payload.modelingTask);
                session.notice = null;
                return session.task;
            }
            catch (error) {
                session.notice = error instanceof Error ? error.message : '任务状态暂不可用；未重复执行。';
                throw error;
            }
            finally {
                session.checking = false;
                session.pending = undefined;
                this.emit();
            }
        })();
        session.pending = pending;
        return pending;
    }
    restore(documentId: string): Promise<void> {
        if(this.disposed)return Promise.resolve();
        const existing=this.discoveries.get(documentId);if(existing)return existing;
        const pending=(async()=>{
            const { payload } = await this.json(`${this.apiRoot}/documents/${encodeURIComponent(documentId)}/modeling-tasks`);
            if (!Array.isArray(payload.tasks) || payload.tasks.length > 100)
                throw this.error('MODELING_TASK_PROTOCOL', '任务清单不符合有界协议。');
            // Validate the complete page before publishing any externally-owned task.
            const tasks = payload.tasks.map(value => normalizeModelingTaskStatus(value, documentId));
            if(this.disposed)return;
            this.batching++;
            try{for (const task of tasks)if(!['project.open','project.create'].includes(task.operation))this.schedule(this.add(task,undefined,undefined,true));}
            finally{this.batching--;if(!this.batching&&this.batched){this.batched=false;this.emit();}}
        })();
        this.discoveries.set(documentId,pending);
        void pending.finally(()=>{if(this.discoveries.get(documentId)===pending)this.discoveries.delete(documentId);}).catch(()=>{});
        return pending;
    }
    /** Read-only discovery by source. Never reattach a file after refresh/restart. */
    async restoreProjectOpens(sourceDocumentId:string){
        const {payload}=await this.json(`${this.apiRoot}/documents/${encodeURIComponent(sourceDocumentId)}/project/open-tasks?limit=50`);
        if(payload.sourceDocumentId!==sourceDocumentId||!Number.isSafeInteger(payload.total)||Number(payload.total)<0||!Array.isArray(payload.items)||payload.items.length>50||!Array.isArray(payload.active)||payload.active.length>65||!Array.isArray(payload.attention)||payload.attention.length>4096||payload.nextCursor!==null&&typeof payload.nextCursor!=='string')throw this.error('MODELING_TASK_PROTOCOL','工程文件任务清单不符合有界协议。');
        const rows=new Map<string,{task:ModelingTaskStatus;projectOpen:ProjectOpenTask}>();
        const parse=(value:unknown)=>{
            if(!value||typeof value!=='object')throw this.error('MODELING_TASK_PROTOCOL','工程文件任务条目无效。');
            const row=value as {modelingTask:ModelingTaskStatus;projectOpen:unknown},task=normalizeModelingTaskStatus(row.modelingTask,row.modelingTask?.documentId),projectOpen=normalizeProjectOpenTask(row.projectOpen,task,sourceDocumentId);
            const old=rows.get(task.taskId);if(old)normalizeProjectOpenTask(projectOpen,task,sourceDocumentId,old.projectOpen);
            if(!old||task.sequence>=old.task.sequence)rows.set(task.taskId,{task,projectOpen});
        };
        // Validate the complete page before publishing any of it.
        for(const row of [...payload.active,...payload.items])parse(row);
        const attention=payload.attention.map(value=>{if(!value||typeof value!=='object')throw this.error('MODELING_TASK_PROTOCOL','工程文件待核对条目无效。');const row=value as {taskId:string;documentId:string;needsRead:unknown};if(!/^[a-f0-9-]{36}$/.test(row.taskId)||!/^[A-Za-z0-9_-]{1,64}$/.test(row.documentId)||row.needsRead!==true)throw this.error('MODELING_TASK_PROTOCOL','工程文件待核对身份无效。');return row;});
        let omitted=0;
        for(const row of attention){if(rows.has(row.taskId))continue;if(rows.size>=120){omitted++;continue;}const {payload:detail}=await this.json(`${this.apiRoot}/documents/${encodeURIComponent(row.documentId)}/project/open/tasks/${encodeURIComponent(row.taskId)}`);if((detail.modelingTask as ModelingTaskStatus)?.taskId!==row.taskId||(detail.modelingTask as ModelingTaskStatus)?.documentId!==row.documentId)throw this.error('MODELING_TASK_PROTOCOL','工程文件待核对回复属于其他任务。');parse(detail);}
        for(const row of rows.values())this.schedule(this.add(row.task,row.projectOpen));
        return {omitted};
    }
    /** Source-owned discovery is GET-only, including tasks whose first reply was lost. */
    restoreProjectCreates(sourceDocumentId:string):Promise<{omitted:number}>{
        if(this.disposed)return Promise.resolve({omitted:0});
        const existing=this.createDiscoveries.get(sourceDocumentId);if(existing)return existing;
        const pending=this.readProjectCreates(sourceDocumentId);
        this.createDiscoveries.set(sourceDocumentId,pending);
        void pending.finally(()=>{if(this.createDiscoveries.get(sourceDocumentId)===pending)this.createDiscoveries.delete(sourceDocumentId);}).catch(()=>{});
        return pending;
    }
    private async readProjectCreates(sourceDocumentId:string){
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(sourceDocumentId))throw this.error('PROJECT_CREATE_TASK_ARGUMENTS','新建任务的来源工程身份无效。',400);
        const {payload}=await this.json(`${this.apiRoot}/documents/${encodeURIComponent(sourceDocumentId)}/project/create-tasks?limit=50`);
        if(payload.sourceDocumentId!==sourceDocumentId||!Number.isSafeInteger(payload.total)||Number(payload.total)<0||!Array.isArray(payload.items)||payload.items.length>50||!Array.isArray(payload.active)||payload.active.length>65||!Array.isArray(payload.attention)||payload.attention.length>4096||payload.nextCursor!==null&&(typeof payload.nextCursor!=='string'||!/^[a-f0-9-]{36}$/.test(payload.nextCursor)))throw this.error('MODELING_TASK_PROTOCOL','新建工程任务清单不符合有界协议。');
        const rows=new Map<string,{task:ModelingTaskStatus;projectCreate:ProjectCreateTask}>();
        const parse=(value:unknown)=>{
            if(!value||typeof value!=='object'||Array.isArray(value))throw this.error('MODELING_TASK_PROTOCOL','新建工程任务条目无效。');
            const row=value as {modelingTask:ModelingTaskStatus;projectCreate:unknown},task=normalizeModelingTaskStatus(row.modelingTask,row.modelingTask?.documentId),projectCreate=normalizeProjectCreateTask(row.projectCreate,task,sourceDocumentId);
            const old=rows.get(task.taskId),held=this.sessions.get(task.taskId);
            if(old)normalizeProjectCreateTask(projectCreate,task,sourceDocumentId,old.projectCreate);
            if(held){if(held.task.documentId!==task.documentId||held.task.operation!==task.operation||held.task.requestKey!==task.requestKey)throw this.error('MODELING_TASK_PROTOCOL','新建任务与页面已有身份不一致。');if(held.projectCreate)normalizeProjectCreateTask(projectCreate,task,sourceDocumentId,held.projectCreate);}
            if(!old||task.sequence>=old.task.sequence)rows.set(task.taskId,{task,projectCreate});
        };
        for(const row of [...payload.active,...payload.items])parse(row);
        const attention=new Map<string,{taskId:string;documentId:string}>();
        for(const value of payload.attention){
            if(!value||typeof value!=='object'||Array.isArray(value))throw this.error('MODELING_TASK_PROTOCOL','新建工程待核对条目无效。');
            const row=value as {taskId:string;documentId:string;needsRead:unknown};
            if(!/^[a-f0-9-]{36}$/.test(row.taskId)||!/^[A-Za-z0-9_-]{1,64}$/.test(row.documentId)||row.needsRead!==true||attention.has(row.taskId)&&attention.get(row.taskId)!.documentId!==row.documentId||rows.has(row.taskId)&&rows.get(row.taskId)!.task.documentId!==row.documentId)throw this.error('MODELING_TASK_PROTOCOL','新建工程待核对身份无效。');
            attention.set(row.taskId,row);
        }
        let omitted=0;
        for(const row of attention.values()){
            if(rows.has(row.taskId))continue;if(rows.size>=120){omitted++;continue;}if(this.disposed)return {omitted:0};
            const {payload:detail}=await this.json(`${this.apiRoot}/documents/${encodeURIComponent(row.documentId)}/project/create/tasks/${encodeURIComponent(row.taskId)}`);
            if((detail.modelingTask as ModelingTaskStatus)?.taskId!==row.taskId||(detail.modelingTask as ModelingTaskStatus)?.documentId!==row.documentId)throw this.error('MODELING_TASK_PROTOCOL','新建工程待核对回复属于其他任务。');parse(detail);
        }
        if(rows.size>Number(payload.total)||payload.nextCursor!==null&&(payload.items.length===0||(payload.items.at(-1) as {modelingTask:ModelingTaskStatus}).modelingTask.taskId!==payload.nextCursor))throw this.error('MODELING_TASK_PROTOCOL','新建工程清单的数量或分页身份不一致。');
        if(this.disposed)return {omitted:0};
        // Fail before publishing if this entire page cannot fit the bounded registry.
        const additions=[...rows.keys()].filter(id=>!this.sessions.has(id)).length,removable=[...this.sessions.values()].filter(session=>!rows.has(session.task.taskId)&&modelingTaskTerminal(session.task.phase)&&!session.downloadAbort).length;
        if(this.sessions.size+additions-removable>128)throw this.error('MODELING_TASK_CLIENT_CAPACITY','页面任务已满，未部分接收新建任务清单；请先核对现有任务。',429);
        this.batching++;
        try{
            let excess=Math.max(0,this.sessions.size+additions-128);
            for(const [id,session] of this.sessions){if(!excess)break;if(!rows.has(id)&&modelingTaskTerminal(session.task.phase)&&!session.downloadAbort){clearTimeout(session.timer);this.sessions.delete(id);excess--;this.batched=true;}}
            for(const row of rows.values())this.schedule(this.add(row.task,undefined,undefined,true,row.projectCreate));
        }
        finally{this.batching--;if(!this.batching&&this.batched){this.batched=false;this.emit();}}
        return {omitted};
    }
    async cancel(taskId: string) {
        const session = this.sessions.get(taskId);
        if (!session || !session.task.cancellable || session.notice || session.cancelPending)
            throw this.error('MODELING_TASK_NOT_CANCELLABLE', '当前任务阶段不允许取消，或需要先核对状态。', 409);
        session.cancelPending = true;
        session.startedAt = Date.now();
        this.emit();
        try {
            const { payload } = await this.json(this.route(session.task, '/cancel'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            this.accept(session, payload.modelingTask);
            this.schedule(session);
            return session.task;
        }
        catch (error) {
            session.notice = '取消请求的结果尚未确认，请检查状态；没有重复发送。';
            throw error;
        }
        finally {
            session.cancelPending = false;
            this.emit();
        }
    }
    private async recover(session: Session): Promise<Packet | null> {
        const deadline = Date.now() + (this.options.recoveryMs ?? 5000);
        do {
            const task = await this.refresh(session.task.taskId);
            if (task.phase === 'succeeded') {
                const { payload } = await this.json(this.route(task, '/result'), undefined, 64 * 1024 * 1024);
                const result = payload.result as ModelingCommandResponse;
                if (!result || result.ok !== true || result.documentId !== task.documentId)
                    throw this.error('MODELING_TASK_PROTOCOL', '原始提交回执与任务不一致。');
                if(task.operation==='project.save'){session.backupReceipt=normalizeProjectBackupReceipt(result,task,session.projectSave);this.emit();}
                if(task.operation==='project.create')this.verifyCreateReceipt(session,result);
                return { ok: true, status: 200, payload: { ...result, modelingTask: task } };
            }
            if (modelingTaskTerminal(task.phase))
                return { ok: false, status: 409, payload: { ok: false, code: task.code || (task.phase === 'cancelled' ? 'WORKER_CANCELLED' : 'MODELING_TASK_RESULT_UNCONFIRMED'), error: task.error || (task.phase === 'cancelled' ? '建模任务已取消。' : '建模结果尚未确认，请核对工程。'), documentId: task.documentId, requestId: task.requestKey, modelingTask: task, retryableByModel: false } };
            if (Date.now() >= deadline)
                break;
            await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 500));
        } while (Date.now() <= deadline);
        return null;
    }
    async run<TRequest extends ModelingCommandRequest|ProjectOpenInput|ProjectSaveInput|ProjectCreateInput>(request: TRequest, submit: (headers: Record<string, string>, frozenCommand: TRequest) => Promise<Packet>): Promise<Packet> {
        if (this.disposed)
            throw this.error('MODELING_TASK_CLIENT_CLOSED', '任务连接已关闭。');
        const documentId = request.documentId!;
        // Snapshot once. Reservation and mutation always describe the same input,
        // even if a form or controller changes while waiting for registration.
        const command = JSON.parse(JSON.stringify(request)) as TRequest;
        let projectFile:ProjectOpenInput|null=null;
        try{if(command.operation==='project.open')projectFile=normalizeProjectOpenInput(command);}catch{throw new ModelingTaskClientError({ok:false,code:'PROJECT_OPEN_TASK_ARGUMENTS',error:'工程文件名、长度或来源状态无效，文件尚未上传。',execution:'not-started',retryableByModel:false},400);}
        let saveInput:ProjectSaveInput|null=null;
        try{if(command.operation==='project.save')saveInput=normalizeProjectSaveInput(command);}catch{throw new ModelingTaskClientError({ok:false,code:'PROJECT_SAVE_TASK_ARGUMENTS',error:'保存任务或工程基线无效，未开始生成备份。',execution:'not-started',retryableByModel:false},400);}
        let createInput:ProjectCreateInput|null=null;
        try{if(command.operation==='project.create')createInput=normalizeProjectCreateInput(command);}catch{throw new ModelingTaskClientError({ok:false,code:'PROJECT_CREATE_TASK_ARGUMENTS',error:'新建任务缺少独立目标、原工程身份或完整基线，未开始创建。',execution:'not-started',retryableByModel:false},400);}
        const fileTransfer=projectFile||saveInput||createInput||command.operation==='step.import'&&'expectedBytes' in command;
        let payload: Record<string, unknown>;
        try {
            const registration=projectFile?'project/open/tasks':saveInput?'project/save/tasks':createInput?'project/create/tasks':fileTransfer?'imports/step/tasks':'modeling-tasks';
            ({ payload } = await this.json(`${this.apiRoot}/documents/${encodeURIComponent(documentId)}/${registration}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }) }));
        }
        catch (error) {
            // A lost registration response never authorizes sending the file.
            // Read-only discovery keeps its reserved task reachable for cancel.
            if(fileTransfer)try{if(projectFile)await this.restoreProjectOpens(projectFile.sourceDocumentId);else if(createInput)await this.restoreProjectCreates(createInput.sourceDocumentId);else await this.restore(documentId);}catch{/* Keep the original registration outcome; never submit as fallback. */}
            if (error instanceof ModelingTaskClientError)
                throw new ModelingTaskClientError({ ...error.payload, execution: 'not-started' }, error.status);
            throw new ModelingTaskClientError({ ok: false, code: 'MODELING_TASK_RESERVATION_FAILED', error: '任务登记未完成，命令尚未发送；可检查任务清单。', execution: 'not-started', retryableByModel: false }, 0);
        }
        const task = normalizeModelingTaskStatus(payload.modelingTask, documentId);
        const expectedKey=command.operation==='project.batch'?((command as unknown as ModelingBatchRequest).batchId||command.requestId):((command as ModelingCommandRequest).options?.idempotencyKey || (command as ModelingCommandRequest & {
            idempotencyKey?: string;
        }).idempotencyKey || command.requestId);
        if (task.requestKey !== expectedKey || ['project.batch','step.import','project.open','project.save','project.create'].includes(command.operation)&&task.operation!==command.operation)
            throw this.error('MODELING_TASK_PROTOCOL', '登记任务的请求身份不一致。');
        const projectOpen=projectFile?normalizeProjectOpenTask(payload.projectOpen,task,projectFile.sourceDocumentId,projectFile):undefined;
        const projectSave=saveInput?normalizeProjectSaveTask(payload.projectSave,task,saveInput):undefined;
        const projectCreate=createInput?normalizeProjectCreateTask(payload.projectCreate,task,createInput.sourceDocumentId,createInput):undefined;
        const session = this.add(task,projectOpen,projectSave,false,projectCreate);
        this.schedule(session);
        try {
            const admission=session.task;
            if (admission.phase !== 'reserved'||projectOpen&&!projectOpen.canUpload||projectSave&&!projectSave.canGenerate||projectCreate&&(!session.projectCreate?.canCreate||session.createSubmitted)) {
                const recovered = await this.recover(session);
                if (recovered)
                    return recovered;
                throw this.error('MODELING_TASK_RESULT_UNCONFIRMED', '此任务已有提交，请查询原任务；未再次执行。', 409);
            }
            if(projectCreate)session.createSubmitted=true;
            const packet = await submit({ 'X-Cad-Task-Id': task.taskId }, command);
            const value = packet.payload as Record<string, unknown>;
            if (value.ok === true && value.documentId !== documentId)
                throw this.error('MODELING_TASK_PROTOCOL', '建模结果不属于提交任务的工程。');
            if (value.modelingTask)
                this.accept(session, value.modelingTask);
            else
                await this.refresh(task.taskId);
            if((!packet.ok||!value.ok)&&session.task.phase==='reserved'){
                // This metadata-only compare-and-abandon action refuses if a
                // concurrent request has already claimed the task. Never send
                // a general cancellation automatically after an HTTP failure.
                try{const {payload}=await this.json(this.route(session.task,'/abandon'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});this.accept(session,payload.modelingTask);}catch{await this.refresh(task.taskId);}
            }
            if(packet.ok&&value.ok===true&&session.task.phase!=='succeeded')throw this.error('MODELING_TASK_RESULT_UNCONFIRMED','回复未能证明该任务已经提交，请核对任务；没有重新执行。',409);
            if(packet.ok&&value.ok===true&&session.task.operation==='project.save'){session.backupReceipt=normalizeProjectBackupReceipt(value,session.task,session.projectSave);this.emit();}
            if(packet.ok&&value.ok===true&&session.task.operation==='project.create')this.verifyCreateReceipt(session,value);
            return packet;
        }
        catch (originalError) {
            try {
                const recovered = await this.recover(session);
                if (recovered)
                    return recovered;
            }
            catch { /* Keep the original request failure and task identity. */ }
            if (session.task.phase === 'succeeded') {
                session.notice = session.task.operation==='project.save'?'备份已生成，但原回执暂不可读；请检查原任务，不要重新生成。':'操作已提交，但原始回执暂不可读；请载入当前工程，不要再次提交。';
                this.emit();
                throw new ModelingTaskClientError({ ok: false, code: 'MODELING_TASK_RECEIPT_UNAVAILABLE', error: session.notice, documentId, requestId: task.requestKey, modelingTask: session.task, retryableByModel: false }, 503);
            }
            session.notice = '命令结果尚未确认，请检查任务状态；不会自动重新执行。';
            this.emit();
            throw originalError;
        }
        finally {
            if (modelingTaskTerminal(session.task.phase)) {
                session.stopped = true;
                clearTimeout(session.timer);
            }
        }
    }
    async downloadBackup(taskId:string){
        const session=this.sessions.get(taskId);
        if(!session||session.task.operation!=='project.save')throw this.error('PROJECT_SAVE_TASK_NOT_FOUND','页面未持有此工程的保存任务。',404);
        if(this.disposed)throw this.error('MODELING_TASK_CLIENT_CLOSED','任务连接已关闭。');
        if([...this.sessions.values()].some(item=>item.downloadAbort))throw this.error('PROJECT_BACKUP_DOWNLOAD_BUSY','页面正在读取另一份备份，请等待或停止下载。',409);
        const abort=new AbortController();session.downloadAbort=abort;session.download={phase:'reading',receivedBytes:0,totalBytes:0,notice:null};this.emit();
        try{
            const task=await this.check(taskId);if(task.phase!=='succeeded')throw this.error('MODELING_TASK_RESULT_UNCONFIRMED','备份生成结果尚未确认，未开始下载，也不会重新生成。',409);
            if(abort.signal.aborted)throw new ProjectBackupReadError('PROJECT_BACKUP_DOWNLOAD_CANCELLED','已停止下载，后台备份仍保留。');
            const {payload}=await this.json(this.route(task,'/result'),undefined,32768);
            const receipt=normalizeProjectBackupReceipt(payload.result,task,session.projectSave);session.backupReceipt=receipt;session.download={phase:'reading',receivedBytes:0,totalBytes:receipt.projectBackup.bytes,notice:null};this.emit();
            const file=await readProjectBackup(this.apiRoot,this.fetchImpl,receipt,{signal:abort.signal,onProgress:(receivedBytes,totalBytes)=>{if(session.download?.phase==='reading'){session.download={phase:'reading',receivedBytes,totalBytes,notice:null};this.emit();}}});
            session.download={phase:'ready',receivedBytes:file.size,totalBytes:file.size,notice:'备份已读取并校验。浏览器下载不代表文件已保存到本地。'};return file;
        }catch(error){const cancelled=abort.signal.aborted||error instanceof ProjectBackupReadError&&error.code==='PROJECT_BACKUP_DOWNLOAD_CANCELLED',reason=error instanceof ProjectBackupReadError||error instanceof ModelingTaskClientError?error:new ProjectBackupReadError('PROJECT_BACKUP_DOWNLOAD_FAILED','原保存任务不会重新执行；文件读取或校验未完成，请检查任务后重试下载。');session.download={phase:cancelled?'cancelled':'failed',receivedBytes:session.download?.receivedBytes||0,totalBytes:session.download?.totalBytes||0,notice:cancelled?'已停止下载，后台备份仍保留，可再次下载。':reason.message};if(cancelled)throw new ProjectBackupReadError('PROJECT_BACKUP_DOWNLOAD_CANCELLED','已停止下载，后台备份仍保留，可再次下载。');throw reason;
        }finally{session.downloadAbort=undefined;this.emit();}
    }
    cancelBackupDownload(taskId:string){const session=this.sessions.get(taskId);if(!session?.downloadAbort)return false;session.download={phase:'stopping',receivedBytes:session.download?.receivedBytes||0,totalBytes:session.download?.totalBytes||0,notice:'正在停止下载；不会删除备份或修改几何。'};session.downloadAbort.abort();this.emit();return true;}
    async readResult(taskId:string){const session=this.sessions.get(taskId);if(!session)throw this.error('MODELING_TASK_NOT_FOUND','页面未持有此任务身份。',404);const task=await this.check(taskId);if(task.phase!=='succeeded')throw this.error('MODELING_TASK_RESULT_UNCONFIRMED','原任务尚未证明提交，未读取或重做修改。',409);const {payload}=await this.json(this.route(task,'/result'),undefined,64*1024*1024);const result=payload.result as ModelingCommandResponse;if(!result||result.ok!==true||result.documentId!==task.documentId)throw this.error('MODELING_TASK_PROTOCOL','原任务回执不属于其工程。');return result;}
    async check(taskId: string) { const session = this.sessions.get(taskId); if (!session)
        throw this.error('MODELING_TASK_NOT_FOUND', '页面未持有此任务身份。', 404); session.startedAt = Date.now(); const value = await this.refresh(taskId); session.stopped = modelingTaskTerminal(value.phase); this.schedule(session); return value; }
    async clearCompleted(documentId: string) {if([...this.sessions.values()].some(item=>item.task.documentId===documentId&&item.downloadAbort))throw this.error('PROJECT_BACKUP_DOWNLOAD_BUSY','备份下载尚未结束，未清理任务记录。',409); const { payload } = await this.json(`${this.apiRoot}/documents/${encodeURIComponent(documentId)}/modeling-tasks`, { method: 'DELETE' }); const cleanup = payload.cleanup as {
        deleted?: number;
        retained?: number;
    }; if (!cleanup || !Number.isSafeInteger(cleanup.deleted) || !Number.isSafeInteger(cleanup.retained))
        throw this.error('MODELING_TASK_PROTOCOL', '任务清理结果不符合协议。'); for (const [id, session] of this.sessions)
        if (session.task.documentId === documentId && ['succeeded', 'failed', 'cancelled'].includes(session.task.phase)) {
            clearTimeout(session.timer);
            this.sessions.delete(id);
        } this.emit(); return cleanup; }
    hasPending(documentId: string) { return [...this.sessions.values()].some(session => modelingTaskTouchesDocument(session,documentId) && !modelingTaskTerminal(session.task.phase)); }
    dispose() { this.disposed = true; for (const session of this.sessions.values()) {
        session.stopped = true;
        session.downloadAbort?.abort();
        clearTimeout(session.timer);
    } }
}
