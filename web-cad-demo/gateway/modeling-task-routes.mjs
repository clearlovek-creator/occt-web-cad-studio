import { resolveCorsOrigin } from './cors.mjs';
import { ModelingTaskError } from './modeling-task-service.mjs';
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
export function authorizeModelingTaskRequest(request, webOrigin, port) {
    let host;
    try {
        host = new URL('http://' + request.headers.host);
    }
    catch {
        throw new ModelingTaskError('MODELING_TASK_FORBIDDEN', '建模任务控制只允许受信任的本机工作台访问。', 403);
    }
    const origin = String(request.headers.origin || '');
    if (!localHosts.has(host.hostname) || Number(host.port || 80) !== port || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || origin && resolveCorsOrigin(origin, webOrigin) !== origin)
        throw new ModelingTaskError('MODELING_TASK_FORBIDDEN', '建模任务请求来源不受信任，未执行。', 403);
}
async function emptyBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024)
            throw new ModelingTaskError('MODELING_TASK_REQUEST_LIMIT', '任务控制请求超过 1 KiB。', 413);
        chunks.push(chunk);
    }
    let body;
    try {
        body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    }
    catch {
        throw new ModelingTaskError('MODELING_TASK_ARGUMENTS', '任务控制请求必须是空 JSON 对象。', 400);
    }
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length)
        throw new ModelingTaskError('MODELING_TASK_ARGUMENTS', '任务控制请求不能携带命令参数。', 400);
}
export async function handleModelingTaskRoute({ request, response, url, service, readJson, prepareCommand, beforeReserve, sendJson, webOrigin, port }) {
    const match = url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/modeling-tasks(?:\/([a-f0-9-]{36})(?:\/(cancel|result|abandon))?)?$/);
    if (!match)
        return false;
    authorizeModelingTaskRequest(request, webOrigin, port);
    if ([...url.searchParams].length)
        throw new ModelingTaskError('MODELING_TASK_ARGUMENTS', '建模任务请求不支持查询参数。', 400);
    const [, documentId, taskId, action] = match;
    if (!taskId && request.method === 'POST') {
        const body = await readJson(request);
        if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'command'))
            throw new ModelingTaskError('MODELING_TASK_ARGUMENTS', '请提供唯一的 command 对象以登记任务。', 400);
        const meta = prepareCommand(body.command, documentId);
        if (meta.documentId !== documentId)
            throw new ModelingTaskError('MODELING_TASK_CONFLICT', '任务工程与命令工程不一致。');
        const bindings = beforeReserve?.(request, response, body.command, meta);
        sendJson(response, 201, { ok: true, protocolVersion: 1, documentId, modelingTask: service.reserve(meta, bindings && await bindings) });
        return true;
    }
    if (request.method === 'GET') {
        const payload = !taskId ? { tasks: service.list(documentId) } : action === 'result' ? { result: service.result(documentId, taskId) } : !action ? { modelingTask: service.get(documentId, taskId) } : null;
        if (payload) {
            sendJson(response, 200, { ok: true, protocolVersion: 1, documentId, ...payload });
            return true;
        }
    }
    if (!taskId && request.method === 'DELETE') {
        await emptyBody(request);
        sendJson(response, 200, { ok: true, protocolVersion: 1, documentId, cleanup: service.clearCompleted(documentId) });
        return true;
    }
    if(taskId&&request.method==='POST'&&action==='abandon'){await emptyBody(request);sendJson(response,200,{ok:true,protocolVersion:1,documentId,modelingTask:service.abandonUnsubmitted(documentId,taskId)});return true;}
    if (taskId && request.method === 'POST' && action === 'cancel') {
        await emptyBody(request);
        sendJson(response, 202, { ok: true, protocolVersion: 1, documentId, modelingTask: service.cancel(documentId, taskId) });
        return true;
    }
    if (taskId && request.method === 'DELETE' && !action) {
        await emptyBody(request);
        service.delete(documentId, taskId);
        sendJson(response, 200, { ok: true, protocolVersion: 1, documentId, taskId });
        return true;
    }
    throw new ModelingTaskError('MODELING_TASK_ROUTE_UNSUPPORTED', '此建模任务动作不受支持。', 405);
}
