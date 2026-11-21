export const MODELING_TASK_PHASES = ['reserved', 'receiving', 'queued', 'preparing', 'executing', 'stopping', 'rolling-back', 'committing', 'succeeded', 'failed', 'cancelled', 'unknown'];
export const modelingTaskTerminal = phase => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(phase);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function normalizeModelingTaskStatus(value, documentId, taskId) {
    if (!value || value.version !== 1 || typeof value.documentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.documentId) || value.documentId !== documentId || !UUID.test(value.taskId) || taskId && value.taskId !== taskId || !MODELING_TASK_PHASES.includes(value.phase) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || typeof value.operation !== 'string' || value.operation.length > 100 || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*){1,3}$/.test(value.operation) || typeof value.requestKey !== 'string' || !value.requestKey || value.requestKey.length > 512 || /[\x00-\x1f\x7f]/.test(value.requestKey) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || typeof value.cancelRequested !== 'boolean' || typeof value.cancellable !== 'boolean' || value.cancellable && (value.cancelRequested || !['reserved', 'receiving', 'queued', 'executing'].includes(value.phase)) || typeof value.reportDurable !== 'boolean')
        throw Error('建模任务状态不符合当前工程和任务协议。');
    const { version, documentId: id, taskId: task, operation, requestKey, phase, sequence, createdAt, updatedAt, cancelRequested, cancellable, reportDurable } = value;
    const result = { version, documentId: id, taskId: task, operation, requestKey, phase, sequence, createdAt, updatedAt, cancelRequested, cancellable, reportDurable };
    if (Number.isSafeInteger(value.revision) && value.revision >= 0)
        result.revision = value.revision;
    if (typeof value.stateToken === 'string' && /^[a-f0-9]{64}$/.test(value.stateToken))
        result.stateToken = value.stateToken;
    for (const key of ['code', 'error'])
        if (typeof value[key] === 'string')
            result[key] = value[key].slice(0, key === 'code' ? 100 : 1000);
    for (const key of ['recovered', 'interrupted', 'restored','unchanged'])
        if (typeof value[key] === 'boolean')
            result[key] = value[key];
    if (value.execution === 'not-started')
        result.execution = value.execution;
    return result;
}
export function modelingTaskLabel(task) {
    if (!task)
        return '';
    if (task.cancelRequested && task.phase === 'queued')
        return '正在取消排队';
    if(task.cancelRequested&&task.phase==='receiving')return '正在取消上传';
    return ({ reserved: '准备提交', receiving:'正在接收文件', queued: '等待内核', preparing: '准备恢复点', executing: '正在执行', stopping: '正在停止内核', 'rolling-back': '正在恢复工程', committing: '正在提交', succeeded: '操作已完成', failed: '操作未完成', cancelled: '已取消', unknown: '结果待核对' })[task.phase] || '状态待核对';
}
export function modelingTaskExplanation(task) {
    if (!task) return null;
    if(task.operation==='project.create'){
        if(task.phase==='succeeded')return '新工程已创建。打开目标工程会读取最新状态，不会重复新建。';
        if(task.phase==='reserved')return '新建任务已登记，原工程保持不变；可取消本次操作。';
        if(task.phase==='unknown')return '新建结果尚未确认，原工程未被替换。请检查原任务，不要重复新建。';
        if(task.phase==='stopping')return '正在等待新建任务的内核停止；原工程保持不变。';
        if(task.phase==='rolling-back')return '正在恢复目标工程的新建前状态；原工程保持不变。';
        if(['failed','cancelled'].includes(task.phase))return task.execution==='not-started'?'未执行新建，原工程保持不变。':task.restored===true?'新建未提交，目标工程已恢复；原工程保持不变。':'新建未完成，请核对目标工程；未替换原工程。';
        return '正在创建独立的新工程，完成并读取当前状态后才切换页面；原工程保持不变。';
    }
    if(task.operation==='project.save'){
        if(task.phase==='unknown')return '备份生成结果尚未确认，请检查原任务；不会重新生成，也不能由当前几何推测旧文件。';
        if(task.phase==='reserved')return '备份任务已登记，尚未生成文件；取消不会修改工程。';
        if(task.phase==='executing')return '正在生成指定工程版本的备份；不会修改几何或属性。';
        if(task.phase==='committing')return '正在校验并封存备份文件，此阶段暂不可取消。';
        if(task.phase==='succeeded')return '后台已生成固定备份。浏览器下载启动不代表文件已保存到本地。';
        if(['failed','cancelled'].includes(task.phase)&&task.unchanged===true)return '备份未发布，工程几何与属性未修改。';
    }
    if(task.operation==='project.open'){
        if(task.phase==='reserved')return task.execution==='not-started'?'此任务的文件未提交。可取消任务后重新选择文件；不会自动重传。':'文件已登记，尚未进入工程恢复；可取消本次操作。';
        if(task.phase==='receiving')return '正在接收工程文件，当前工程保持不变；取消将停止本次上传。';
        if(task.phase==='succeeded')return '目标工程已创建。打开目标工程会读取最新状态，不会再次上传文件。';
        if(task.phase==='unknown')return '目标工程的打开结果尚未确认，当前工程未被替换。请检查状态或从恢复工程列表核对；不会重传文件。';
        if(['failed','cancelled'].includes(task.phase)&&task.execution==='not-started')return '文件未用于恢复目标工程，当前工程保持不变。';
    }
    if (task.phase === 'receiving') return '文件尚未进入几何转换；取消将停止本次上传。';
    if (task.operation === 'step.import' && task.phase === 'reserved') return '文件尚未上传；若上传未启动，可取消此任务后重新选择文件。';
    if (task.phase === 'preparing') return '正在保存工程恢复点，此阶段暂不可取消。';
    if (task.phase === 'committing') return '正在写入完整工程，暂不可取消。';
    if (task.phase === 'rolling-back') return '正在恢复几何、属性和历史；请等待核对结果。';
    if (task.phase === 'stopping') return '正在等待内核退出，随后恢复工程；请稍候。';
    if (task.phase === 'unknown') return '结果尚未确认。请检查状态或载入工程；不会重新执行命令。';
    if (task.phase === 'cancelled' || task.phase === 'failed') {
        if (task.execution === 'not-started') return '该命令未执行。';
        if (task.restored === true) return '此操作未提交，原工程已恢复。';
        return '操作未完成，请查看任务详情并核对工程。';
    }
    return null;
}
