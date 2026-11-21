import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gatedGeometryGateway } from './helpers/gated-geometry-gateway.mjs';
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cad-step-task-api-'));
function clean(data) { assert.equal(path.dirname(data), path.resolve(os.tmpdir())); assert.ok(path.basename(data).startsWith('cad-step-task-api-')); fs.rmSync(data, { recursive: true, force: true }); }
async function bytesFor(f) { await f.cad('primitive.box', { width: 7, depth: 8, height: 9 }, {}, 'source'); await f.cad('primitive.sphere', { radius: 2, x: 30 }, {}, 'source'); assert.equal((await f.post('/documents/source/exports/step', {})).value.ok, true); const response = await fetch(f.api + '/exports/source/download'); assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer()); }
async function baseline(f) { const body = await f.cad('primitive.box', { width: 10, depth: 20, height: 30 }); const type = await f.cad('property.type.create', { key: 'StepTaskData', association: 'required', targetScope: 'body', fields: [{ key: 'enabled', type: 'bool' }] }); await f.cad('property.instance.create', { typeId: type.type.typeId, value: { enabled: true }, target: { kind: 'body', bodyId: body.bodyId } }); await f.cad('property.set', { key: 'stepTaskMarker', type: 'int', value: 42 }, { kind: 'body', bodyId: body.bodyId }); await f.cad('variable.set', { name: 'stepTaskSize', type: 'length', expression: '13 mm' }); return snapshot(f); }
async function snapshot(f) { return { model: await f.cad('document.summary'), typed: (await f.cad('property.instance.list')).instances, raw: (await f.cad('property.list')).propertyRecords }; }
async function unchanged(f, before, { sameToken = true } = {}) { const after = await snapshot(f); for (const key of ['revision', 'features', 'bodyMetadata', 'entityIdentities', 'variables', 'coordinateSystems', 'materials', ...(sameToken ? ['stateToken'] : [])])
    assert.deepEqual(after.model[key], before.model[key], key); assert.deepEqual(after.typed, before.typed); assert.deepEqual(after.raw, before.raw); }
const input = (bytes, model, extra = {}) => ({ protocolVersion: 1, operation: 'step.import', documentId: 'default', requestId: randomUUID(), fileName: '零件.step', expectedBytes: bytes.length, baseRevision: model.revision, baseStateToken: model.stateToken, ...extra });
async function reserve(f, command) { const response = await f.post('/documents/' + command.documentId + '/imports/step/tasks', { command }); assert.equal(response.status, 201, JSON.stringify(response)); return response.value.modelingTask; }
const headers = (command, task) => ({ 'Content-Type': 'application/step', 'X-Cad-Task-Id': task.taskId, 'X-Request-Id': command.requestId, 'X-File-Name': encodeURIComponent(command.fileName), ...(command.baseRevision === undefined ? {} : { 'X-Base-Revision': String(command.baseRevision) }), ...(command.baseStateToken === undefined ? {} : { 'X-Base-State-Token': command.baseStateToken }) });
async function upload(f, command, task, bytes, extra = {}) { const response = await fetch(f.api + '/documents/' + command.documentId + '/imports/step', { method: 'POST', headers: { ...headers(command, task), ...extra }, body: bytes }); return { status: response.status, value: await response.json() }; }
const status = (f, task) => f.get('/documents/' + task.documentId + '/modeling-tasks/' + task.taskId).then(value => value.modelingTask);

test('dedicated STEP registration and upload reject untrusted origins, paths and malformed envelopes before consuming input or geometry', async () => {
    const data = scratch(); let f;
    try {
        f = await gatedGeometryGateway(data);
        const before = await baseline(f), command = input(Buffer.from('STEP'), before.model), endpoint = '/documents/default/imports/step/tasks', at = f.events.length;
        for (const patch of [{protocolVersion: 2}, {operation: 'primitive.box'}, {documentId: 'other'}, {expectedBytes: 0}, {expectedBytes: 2 ** 31}, {fileName: '../outside.step'}, {fileName: 'bad\n.step'}, {requestId: 'invalid request'}, {baseRevision: -1}, {baseStateToken: 'z'.repeat(64)}, {path: 'C:/outside.step'}]) {
            const response = await f.post(endpoint, {command: {...command, ...patch}});
            assert.equal(response.status, 400, JSON.stringify({patch, response}));
            assert.equal(response.value.code, 'STEP_IMPORT_TASK_ARGUMENTS');
        }
        assert.equal((await f.post(endpoint + '?unexpected=1', {command})).status, 400);
        assert.equal((await f.post(endpoint, {command, path: 'outside.step'})).status, 400);
        assert.equal((await f.post(endpoint, {command}, {origin: 'https://untrusted.example'})).status, 403);
        // fetch may replace a caller-supplied Host; use the actual HTTP wire.
        const foreignHost = await new Promise((resolve, reject) => {
            const body = JSON.stringify({command}), request = httpRequest(f.api + endpoint, {method: 'POST', headers: {Host: 'untrusted.example:' + f.port, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}}, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
            request.once('error', reject); request.end(body);
        });
        assert.equal(foreignHost, 403);
        assert.equal((await f.get('/documents/default/modeling-tasks')).tasks.length, 0);
        const task = await reserve(f, command), response = await upload(f, command, task, Buffer.from('STEP'), {Origin: 'https://untrusted.example'});
        assert.equal(response.status, 403); assert.equal((await status(f, task)).phase, 'reserved');
        assert.equal((await f.get('/health')).lifecycle.stepInputs.slots, 0);
        assert.equal(f.events.slice(at).some(item => item.type === 'fixture.native-request' && item.operation === 'step.import'), false);
        await f.cancel(task); await unchanged(f, before);
        const sourceDirectory = path.join(data, 'imports'); if (fs.existsSync(sourceDirectory)) assert.deepEqual(fs.readdirSync(sourceDirectory), []);
    } finally { if (f) { assert.equal(await f.stop(), 0); clean(data); } }
});

test('a malformed STEP reports failed with actual whole-project rollback proof and leaves no installed source', async () => {
    const data = scratch(); let f;
    try {
        f = await gatedGeometryGateway(data);
        const before = await baseline(f), bytes = Buffer.from('not a STEP file'), command = input(bytes, before.model), task = await reserve(f, command);
        const result = await upload(f, command, task, bytes);
        assert.equal(result.value.ok, false);
        assert.equal(result.value.modelingTask.phase, 'failed');
        assert.equal(result.value.modelingTask.restored, true);
        assert.ok(result.value.modelingTask.error);
        assert.equal(Object.hasOwn(result.value, 'projectRollback'), false);
        assert.equal((await status(f, task)).restored, true);
        const report = await f.get('/documents/default/imports/step/status?requestId=' + command.requestId);
        assert.equal(report.ok, true); assert.ok(report.stepImportStatus);
        assert.equal(report.stepImportStatus.unchanged, true);
        await unchanged(f, before);
        assert.deepEqual(fs.readdirSync(path.join(data, 'imports')), []);
    } finally { if (f) { assert.equal(await f.stop(), 0); clean(data); } }
});
test('STEP registration binds a single upload without CAD changes; cancellation before attachment releases project admission', async () => {
    const data = scratch();
    let f;
    try {
        f = await gatedGeometryGateway(data);
        const bytes = await bytesFor(f), before = await baseline(f), command = input(bytes, before.model), task = await reserve(f, command);
        await unchanged(f, before);
        assert.equal((await reserve(f, command)).taskId, task.taskId);
        assert.equal(task.operation, 'step.import');
        assert.equal((await f.post('/documents/default/imports/step/tasks', { command: { ...command, expectedBytes: bytes.length + 1 } })).value.code, 'MODELING_TASK_CONFLICT');
        assert.equal((await upload(f, command, task, bytes, { 'X-File-Name': 'other.step' })).value.code, 'MODELING_TASK_CONFLICT');
        assert.equal((await status(f, task)).phase, 'reserved');
        assert.equal((await f.cancel(task)).value.modelingTask.phase, 'cancelled');
        assert.equal((await upload(f, command, task, bytes)).value.code, 'MODELING_TASK_ALREADY_SUBMITTED');
        await reserve(f, input(bytes, before.model));
        await unchanged(f, before);
    }
    finally {
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
test('cancelling a real partial upload waits for staging cleanup, executes no STEP and preserves the engineering baseline', async () => {
    const data = scratch();
    let f, request;
    try {
        f = await gatedGeometryGateway(data);
        const bytes = await bytesFor(f), before = await baseline(f), command = input(bytes, before.model), task = await reserve(f, command), at = f.events.length;
        const reply = new Promise(resolve => { request = httpRequest(f.api + '/documents/default/imports/step', { method: 'POST', headers: { ...headers(command, task), 'Content-Length': bytes.length } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); }); request.once('error', () => resolve('disconnected')); request.write(bytes.subarray(0, 100)); });
        await f.until(async () => (await status(f, task)).phase === 'receiving', 'Upload did not enter receiving');
        const cancelled = await f.cancel(task);
        assert.equal(cancelled.value.modelingTask.cancelRequested, true);
        await f.until(async () => (await status(f, task)).phase === 'cancelled', 'Upload cancellation was not finalized');
        await reply;
        assert.equal((await status(f, task)).execution, 'not-started');
        assert.equal((await f.get('/health')).lifecycle.stepInputs.slots, 0);
        assert.deepEqual(fs.readdirSync(path.join(data, 'pending-step-inputs')), []);
        assert.equal(f.events.slice(at).some(item => item.type === 'fixture.native-request' && item.operation === 'step.import'), false);
        await unchanged(f, before);
    }
    finally {
        request?.destroy();
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
test('queued STEP cancellation has no native conversion and removes only its verified unused source', async () => {
    const data = scratch();
    let f;
    try {
        f = await gatedGeometryGateway(data);
        const bytes = await bytesFor(f), before = await baseline(f);
        await f.cad('primitive.box', { width: 2, depth: 2, height: 2 }, {}, 'busy');
        const at = f.events.length;
        f.tell('arm-geometry');
        await f.event('geometry-armed', at);
        const active = f.post('/commands', { documentId: 'busy', operation: 'primitive.box', parameters: { width: 3, depth: 3, height: 3 } });
        await f.event('geometry-held', at);
        const command = input(bytes, before.model), task = await reserve(f, command), pending = upload(f, command, task, bytes);
        await f.until(async () => (await status(f, task)).phase === 'queued', 'Import did not queue');
        assert.equal(fs.readdirSync(path.join(data, 'imports')).length, 1);
        await f.cancel(task);
        const result = await pending;
        assert.equal(result.value.code, 'DOCUMENT_ACTION_CANCELLED');
        assert.equal(result.value.modelingTask.phase, 'cancelled');
        assert.deepEqual(fs.readdirSync(path.join(data, 'imports')), []);
        assert.equal(f.events.slice(at).some(item => item.type === 'fixture.native-request' && item.operation === 'step.import'), false);
        f.tell('release-geometry');
        await active;
        await unchanged(f, before);
    }
    finally {
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
test('cancelling an already converted STEP waits for actual OS exit and restores geometry, both property systems, variables and history', async () => {
    const data = scratch();
    let f;
    try {
        f = await gatedGeometryGateway(data);
        const bytes = await bytesFor(f), before = await baseline(f), command = input(bytes, before.model), task = await reserve(f, command), at = f.events.length;
        f.tell('arm-step');
        await f.event('step-armed', at);
        f.tell('arm-geometry-exit');
        await f.event('geometry-exit-armed', at);
        const pending = upload(f, command, task, bytes);
        assert.equal((await f.event('step-held', at)).bodyCount, 2);
        await f.cancel(task);
        await f.event('geometry-exit-held', at);
        assert.equal((await status(f, task)).phase, 'stopping');
        assert.equal((await f.get('/health')).lifecycle.documentActions.active, 1);
        f.tell('release-geometry-exit');
        const result = await pending;
        assert.equal(result.value.code, 'WORKER_CANCELLED');
        assert.equal(result.value.modelingTask.phase, 'cancelled');
        assert.equal(result.value.projectRollback.confirmed, true);
        await unchanged(f, before);
        assert.deepEqual(fs.readdirSync(path.join(data, 'imports')), []);
        assert.deepEqual(fs.readdirSync(path.join(data, 'pending-step-inputs')), []);
    }
    finally {
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
test('STEP commit is non-cancellable and the exact original import receipt survives later edits and restart without uploading again', async () => {
    const data = scratch();
    let f;
    try {
        f = await gatedGeometryGateway(data);
        const bytes = await bytesFor(f), before = await baseline(f), command = input(bytes, before.model), task = await reserve(f, command), at = f.events.length;
        f.tell('arm-step');
        await f.event('step-armed', at);
        const pending = upload(f, command, task, bytes);
        await f.event('step-held', at);
        f.tell('arm-task-commit');
        await f.event('task-commit-armed', at);
        f.tell('release-geometry');
        await f.event('task-commit-held', at);
        assert.equal((await status(f, task)).phase, 'committing');
        assert.equal((await f.cancel(task)).value.code, 'MODELING_TASK_NOT_CANCELLABLE');
        f.tell('release-geometry');
        const first = await pending;
        assert.equal(first.value.ok, true, JSON.stringify(first));
        assert.equal(first.value.stepImportStatus.taskId, task.taskId);
        assert.equal(first.value.stepImportStatus.phase, 'complete');
        const original = { ...first.value };
        delete original.modelingTask;
        delete original.stepImportStatus;
        assert.deepEqual((await f.get('/documents/default/modeling-tasks/' + task.taskId + '/result')).result, original);
        assert.equal(fs.existsSync(first.value.features[0].stringParameters.sourcePath), true);
        assert.deepEqual(fs.readdirSync(path.join(data, 'pending-step-inputs')), []);
        await f.cad('primitive.box', { width: 1, depth: 1, height: 1, x: 90 });
        const later = await f.cad('document.summary');
        assert.equal(later.bodyCount, 3);
        await f.stop();
        f = await gatedGeometryGateway(data);
        assert.deepEqual((await f.get('/documents/default/modeling-tasks/' + task.taskId + '/result')).result, original);
        assert.equal((await reserve(f, command)).taskId, task.taskId);
        assert.equal((await upload(f, command, task, bytes)).value.code, 'MODELING_TASK_ALREADY_SUBMITTED');
        assert.equal((await f.cad('document.summary')).stateToken, later.stateToken);
    }
    finally {
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
test('STEP statistics-report failure after acceptance cannot convert a committed import into a failure or delete its source', async () => {
    const data = scratch();
    let f;
    try {
        f = await gatedGeometryGateway(data);
        const bytes = await bytesFor(f), before = await baseline(f), command = input(bytes, before.model), task = await reserve(f, command), at = f.events.length;
        f.tell('fail-step-report');
        await f.event('step-report-armed', at);
        const result = await upload(f, command, task, bytes);
        assert.equal(result.value.ok, true);
        assert.equal(result.value.modelingTask.phase, 'succeeded');
        assert.equal(result.value.stepImportStatus.phase, 'complete');
        assert.equal(result.value.stepImportStatus.reportDurable, false);
        assert.ok(result.value.warnings.length);
        assert.equal(fs.existsSync(result.value.features[0].stringParameters.sourcePath), true);
        assert.equal((await f.get('/documents/default/modeling-tasks/' + task.taskId + '/result')).result.ok, true);
    }
    finally {
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
test('unconfirmed process exit keeps STEP unknown with its source and recovery journal, never claiming cancellation before restart recovery', async () => {
    const data = scratch();
    let f;
    try {
        f = await gatedGeometryGateway(data, { GEOMETRY_WORKER_STOP_TIMEOUT_MS: '40' });
        const bytes = await bytesFor(f), before = await baseline(f), command = input(bytes, before.model), task = await reserve(f, command), at = f.events.length;
        f.tell('arm-step');
        await f.event('step-armed', at);
        f.tell('arm-geometry-exit');
        await f.event('geometry-exit-armed', at);
        const pending = upload(f, command, task, bytes);
        await f.event('step-held', at);
        await f.cancel(task);
        await f.event('geometry-exit-held', at);
        const result = await pending;
        assert.equal(result.value.code, 'PROJECT_ROLLBACK_FAILED');
        assert.equal(result.value.modelingTask.phase, 'unknown');
        assert.equal(result.value.projectRollback, undefined);
        assert.equal(fs.readdirSync(path.join(data, 'imports')).length, 1);
        assert.ok(fs.readdirSync(path.join(data, 'document-transactions')).some(name => name.endsWith('.pending.json')));
        assert.equal((await f.get('/health')).runtime.workerChannel.state, 'blocked');
        f.tell('release-geometry-exit');
        await f.event('geometry-exit', at);
        await f.stop();
        f = await gatedGeometryGateway(data);
        await unchanged(f, before, { sameToken: false });
        assert.equal((await status(f, task)).phase, 'unknown');
        assert.equal(fs.readdirSync(path.join(data, 'imports')).length, 1);
        assert.deepEqual(fs.readdirSync(path.join(data, 'pending-step-inputs')), []);
    }
    finally {
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
test('Gateway exit after durable STEP commit but before task publication recovers the exact accepted receipt without a second conversion', async () => {
    const data = scratch();
    let f;
    try {
        f = await gatedGeometryGateway(data);
        const bytes = await bytesFor(f), before = await baseline(f), command = input(bytes, before.model), task = await reserve(f, command), at = f.events.length;
        f.tell('exit-step-task-terminal');
        await f.event('step-task-terminal-exit-armed', at);
        await assert.rejects(upload(f, command, task, bytes));
        await new Promise(resolve => { if (f.child.exitCode !== null)
            return resolve(); f.child.once('close', resolve); });
        assert.equal(f.child.exitCode, 88);
        assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'modeling-tasks', task.taskId + '.json'), 'utf8')).phase, 'committing');
        assert.deepEqual(fs.readdirSync(path.join(data, 'pending-step-inputs')), []);
        f = await gatedGeometryGateway(data);
        const recovered = await status(f, task);
        assert.equal(recovered.phase, 'succeeded');
        assert.equal(recovered.recovered, true);
        const result = (await f.get('/documents/default/modeling-tasks/' + task.taskId + '/result')).result;
        assert.equal(result.bodyCount, 2);
        assert.equal(result.stepImport.bodyCount, 2);
        assert.equal(fs.existsSync(result.features[0].stringParameters.sourcePath), true);
        assert.equal((await f.cad('document.summary')).stateToken, result.stateToken);
        assert.equal(f.events.some(item => item.type === 'fixture.native-request' && item.operation === 'step.import'), false);
    }
    finally {
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
test('cooperative shutdown interrupts a partial registered upload and releases staging ownership without modifying its project', async () => {
    const data = scratch();
    let f, request;
    try {
        f = await gatedGeometryGateway(data);
        const bytes = await bytesFor(f), before = await baseline(f), command = input(bytes, before.model), task = await reserve(f, command);
        const reply = new Promise(resolve => { request = httpRequest(f.api + '/documents/default/imports/step', { method: 'POST', headers: { ...headers(command, task), 'Content-Length': bytes.length } }, response => { response.resume(); response.once('end', resolve); }); request.once('error', resolve); request.write(bytes.subarray(0, 100)); });
        await f.until(async () => (await status(f, task)).phase === 'receiving', 'Upload did not start');
        assert.equal(await f.stop(), 0);
        await reply;
        assert.equal(JSON.parse(fs.readFileSync(path.join(data, '.gateway-last-shutdown.json'), 'utf8')).state, 'complete');
        assert.deepEqual(fs.readdirSync(path.join(data, 'pending-step-inputs')), []);
        f = await gatedGeometryGateway(data);
        await unchanged(f, before);
        assert.equal((await status(f, task)).phase, 'failed');
        assert.equal((await status(f, task)).execution, 'not-started');
    }
    finally {
        request?.destroy();
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
test('a queued STEP source changed to equal-length bytes is refused before conversion and preserves both original input and changed evidence', async () => {
    const data = scratch();
    let f;
    try {
        f = await gatedGeometryGateway(data);
        const bytes = await bytesFor(f), before = await baseline(f);
        await f.cad('primitive.box', { width: 2, depth: 2, height: 2 }, {}, 'busy');
        const at = f.events.length;
        f.tell('arm-geometry');
        await f.event('geometry-armed', at);
        const active = f.post('/commands', { documentId: 'busy', operation: 'primitive.box', parameters: { width: 3, depth: 3, height: 3 } });
        await f.event('geometry-held', at);
        const command = input(bytes, before.model), task = await reserve(f, command), pending = upload(f, command, task, bytes);
        await f.until(async () => (await status(f, task)).phase === 'queued', 'Import did not queue');
        const file = path.join(data, 'imports', fs.readdirSync(path.join(data, 'imports'))[0]), changed = Buffer.from(bytes);
        changed[0] ^= 1;
        fs.writeFileSync(file, changed);
        f.tell('release-geometry');
        await active;
        const result = await pending;
        assert.equal(result.value.code, 'STEP_IMPORT_UPLOAD_CHANGED');
        assert.equal(result.value.modelingTask.phase, 'failed');
        assert.equal(f.events.slice(at).some(item => item.type === 'fixture.native-request' && item.operation === 'step.import'), false);
        await unchanged(f, before);
        assert.deepEqual(fs.readFileSync(file), changed);
        const originals = fs.readdirSync(path.join(data, 'pending-step-inputs'));
        assert.equal(originals.length, 1);
        assert.deepEqual(fs.readFileSync(path.join(data, 'pending-step-inputs', originals[0])), bytes);
        assert.equal((await f.get('/health')).lifecycle.stepInputs.retainedSlots, 1);
    }
    finally {
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
test('the two-input STEP staging budget refuses a third upload before native execution and releases only cancelled leases', async () => {
    const data = scratch();
    let f;
    try {
        f = await gatedGeometryGateway(data);
        const bytes = await bytesFor(f), commands = [];
        for (const documentId of ['queued-a', 'queued-b', 'queued-c']) {
            const state = await f.cad('primitive.box', { width: 2, depth: 3, height: 4 }, {}, documentId);
            commands.push(input(bytes, state, { documentId }));
        }
        await f.cad('primitive.box', { width: 2, depth: 2, height: 2 }, {}, 'busy');
        const at = f.events.length;
        f.tell('arm-geometry');
        await f.event('geometry-armed', at);
        const active = f.post('/commands', { documentId: 'busy', operation: 'primitive.box', parameters: { width: 3, depth: 3, height: 3 } });
        await f.event('geometry-held', at);
        const first = await reserve(f, commands[0]), one = upload(f, commands[0], first, bytes);
        await f.until(async () => (await status(f, first)).phase === 'queued', 'First import did not queue');
        const second = await reserve(f, commands[1]), two = upload(f, commands[1], second, bytes);
        await f.until(async () => (await status(f, second)).phase === 'queued', 'Second import did not queue');
        const third = await reserve(f, commands[2]), refused = await upload(f, commands[2], third, bytes);
        assert.equal(refused.status, 429);
        assert.equal(refused.value.code, 'STEP_IMPORT_UPLOAD_CAPACITY');
        assert.equal(refused.value.modelingTask.execution, 'not-started');
        assert.equal((await f.get('/health')).lifecycle.stepInputs.slots, 2);
        await f.cancel(first);
        await f.cancel(second);
        await one;
        await two;
        assert.equal((await f.get('/health')).lifecycle.stepInputs.slots, 0);
        assert.deepEqual(fs.readdirSync(path.join(data, 'imports')), []);
        f.tell('release-geometry');
        await active;
    }
    finally {
        if (f) {
            assert.equal(await f.stop(), 0);
            clean(data);
        }
    }
});
