import {randomUUID} from 'node:crypto';
import {ModelingTaskError} from './modeling-task-service.mjs';

const BOOLEAN_LABELS = {
    'boolean.fuse': '并集', 'boolean.cut': '差集', 'boolean.common': '交集',
    'boolean.section': '截交线', 'boolean.split': '分割', 'boolean.partition': '分区',
    'boolean.fragments': '提取片段', 'boolean.imprint': '压印',
};
const BODY_LABELS = {
    'body.delete': '删除 Body', 'body.update': '修改 Body',
    'transform.translate': '移动 Body', 'transform.rotate': '旋转 Body',
    'transform.mirror': '镜像 Body', 'transform.scale': '缩放 Body',
    'transform.scale_non_uniform': '非均匀缩放 Body',
};
export const PI_BATCH_OPERATIONS = Object.freeze([...Object.keys(BODY_LABELS), ...Object.keys(BOOLEAN_LABELS)]);
const TARGET_LABELS = {delete: '删除', modify: '修改', consume: '消耗', keep: '保留'};
const problem = (code, message, status) => new ModelingTaskError(code, message, status);
const inactive = () => problem('PI_APPROVAL_INACTIVE', '原操作已结束或会话已变化。请通过当前会话重新核对。');
const stale = () => problem('PI_APPROVAL_STALE', '工程在确认期间发生变化，原操作已失效。请让助手重新读取工程和选择对象，再提交确认。');

function booleanIds(inputs, plural, single) {
    return Array.isArray(inputs?.[plural]) ? inputs[plural] : inputs?.[single] ? [inputs[single]] : [];
}

export function requiresPiWriteApproval({operation, inputs, parameters}) {
    return operation === 'body.delete' || operation === 'project.batch' ||
        Object.hasOwn(BOOLEAN_LABELS, operation) &&
        (operation !== 'boolean.imprint' && parameters?.keepTool !== true ||
            new Set(booleanIds(inputs, 'targetBodies', 'targetBody')).size > 1);
}

export function summarizePiWrite(input, view) {
    const steps = input.operation === 'project.batch' ? input.steps : [input];
    const bodies = new Map(view.bodyMetadata?.map(body => [body.bodyId, body]));
    const affected = (ids, action, role) => [...new Set(ids)].map(id => {
        const body = bodies.get(id);
        if (!body) throw problem('PI_APPROVAL_TARGET_CHANGED','受影响的 Body 已不可用，请重新读取工程和选择对象。');
        return {id, name: String(body.name || id).slice(0, 120), action: TARGET_LABELS[action], role};
    });
    let targetCount = 0;
    return steps.map(({operation, inputs, parameters}) => {
        const isBoolean = Object.hasOwn(BOOLEAN_LABELS, operation);
        const label = isBoolean ? BOOLEAN_LABELS[operation] : BODY_LABELS[operation];
        if (!label) throw problem('PI_BATCH_OPERATION_UNSUPPORTED','此助手批次只接受现有 Body 的编辑和布尔操作。',400);
        const targets = isBoolean ? booleanIds(inputs, 'targetBodies', 'targetBody') : [inputs?.bodyId];
        const tools = isBoolean ? booleanIds(inputs, 'toolBodies', 'toolBody') : [];
        if (!targets.length || isBoolean && (!tools.length || targets.some(id => tools.includes(id))))
            throw problem('PI_APPROVAL_TARGET_INVALID','确认前需要指定有效目标体和工具体。',400);
        targetCount += targets.length + tools.length;
        if (targetCount > 64) throw problem('PI_APPROVAL_TARGET_LIMIT','一项确认最多展示 64 个 Body 引用，请拆分操作。',400);
        return {operation, label, targets: [
            ...affected(targets, operation === 'body.delete' ? 'delete' : isBoolean ? parameters?.keepTarget === true ? 'keep' : 'consume' : 'modify',isBoolean?'目标体':undefined),
            ...affected(tools, operation === 'boolean.imprint' || parameters?.keepTool === true ? 'keep' : 'consume','工具体'),
        ]};
    });
}

export class PiWriteApprovals {
    constructor({currentState, isLive, pendingMs = 90000}) {
        Object.assign(this, {currentState, isLive, pendingMs});
        this.records = new WeakMap();
    }

    view(record) {
        if (!record || record.status === 'checking') return null;
        const {id, documentId, streamId, operation, steps, status, expiresAt, revision, error} = record;
        return {id, documentId, streamId, operation, steps, status, expiresAt, revision, ...(error ? {code:error.code, notice:error.message} : {})};
    }

    finish(record, status, error) {
        clearTimeout(record.timer);
        Object.assign(record, {status, error});
        if (error) record.reject?.(error);
        record.resolve = record.reject = null;
    }

    live(session, record) {
        return this.isLive(session) && record.streamId === session.streamId;
    }

    refresh(session, record) {
        if (!record || !['checking','pending','approved'].includes(record.status)) return;
        if (!this.live(session, record)) this.finish(record,'cancelled',inactive());
        else if (Date.now() >= record.expiresAt) this.finish(record,'expired',problem('PI_APPROVAL_EXPIRED','确认已过期。请让助手重新核对操作。'));
        else if (this.currentState(record.documentId) !== record.baseStateToken) this.finish(record,'stale',stale());
    }

    async request(session, meta, baseStateToken, loadSummary, signal) {
        const previous = this.records.get(session);
        this.refresh(session, previous);
        if (previous && ['checking','pending','approved'].includes(previous.status))
            throw problem('PI_APPROVAL_BUSY','已有一项助手操作等待确认。');
        if (signal.aborted || !this.isLive(session)) throw inactive();
        if (!/^[a-f0-9]{64}$/.test(baseStateToken || '') || this.currentState(meta.documentId) !== baseStateToken) throw stale();
        const record = {id:randomUUID(), documentId:meta.documentId, streamId:session.streamId, operation:meta.operation,
            digest:meta.digest, requestKey:meta.requestKey, baseStateToken, status:'checking', expiresAt:Date.now()+this.pendingMs};
        this.records.set(session, record);
        const interrupted = () => {
            if (['checking','pending','approved'].includes(record.status))
                this.finish(record,'cancelled',problem('PI_APPROVAL_CANCELLED','助手操作已停止，未执行写入。'));
        };
        signal.addEventListener('abort',interrupted,{once:true});
        try {
            const {steps,revision} = await loadSummary();
            this.refresh(session, record);
            if (record.status !== 'checking') throw record.error || inactive();
            Object.assign(record,{steps, revision, status:'pending'});
            return await new Promise((resolve,reject) => {
                Object.assign(record,{resolve,reject});
                record.timer=setTimeout(()=>this.refresh(session,record),Math.max(0,record.expiresAt-Date.now()));
            });
        } catch (error) {
            if (record.status === 'checking') this.finish(record,'cancelled',error);
            throw error;
        } finally {
            signal.removeEventListener('abort',interrupted);
        }
    }

    get(session) {
        const record = this.records.get(session);
        this.refresh(session, record);
        return record?.streamId === session.streamId ? this.view(record) : null;
    }

    decide(session, id, decision) {
        const record = this.records.get(session);
        this.refresh(session, record);
        if (record?.id !== id || record.streamId !== session.streamId) throw inactive();
        if (record.status !== 'pending') throw record.error || inactive();
        if (decision === 'cancel') {
            this.finish(record,'cancelled',problem('PI_APPROVAL_REJECTED','用户取消了这项操作，未执行写入。'));
        } else {
            const resolve = record.resolve;
            record.expiresAt = Date.now()+120000;
            this.finish(record,'approved');
            resolve(record.id);
        }
        return this.view(record);
    }

    revoke(session, id) {
        const record = this.records.get(session);
        if (record && (id === undefined || record.id === id) && ['checking','pending','approved'].includes(record.status))
            this.finish(record,'cancelled',problem('PI_APPROVAL_CANCELLED','助手操作已停止，未执行写入。'));
    }

    consume(session, id, meta) {
        const record = this.records.get(session);
        this.refresh(session, record);
        if (!record || record.id !== id || record.streamId !== session.streamId ||
            record.documentId !== meta.documentId || record.operation !== meta.operation ||
            record.requestKey !== meta.requestKey || record.digest !== meta.digest) throw inactive();
        if (record.status !== 'approved') throw record.error || inactive();
        this.finish(record,'submitted');
    }
}
