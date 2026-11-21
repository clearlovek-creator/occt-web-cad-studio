import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ModelingController } from '../app/modeling/modeling-controller.ts';
const stamp = new Date().toISOString(), taskId = randomUUID(), token = 'a'.repeat(64), newToken = 'b'.repeat(64);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const model = (sequence = 5) => ({ ok: true, documentId: 'default', bodyId: sequence === 5 ? 'original' : 'newer', positions: [], revision: sequence, stateSequence: sequence, stateToken: sequence === 5 ? token : newToken });
const task = (requestKey, phase = 'reserved', sequence = 1, extra = {}) => ({ version: 1, documentId: 'default', taskId, operation: 'step.import', requestKey, phase, sequence, createdAt: stamp, updatedAt: stamp, cancelRequested: ['cancelled', 'stopping'].includes(phase), cancellable: ['reserved', 'receiving', 'queued', 'executing'].includes(phase), reportDurable: true, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
test('registered STEP freezes its file and edit baseline, binds the task header, and never adopts an old recovered receipt over newer geometry', async () => {
    const reserve = deferred(), calls = [], file = new File(['original STEP bytes'], '零件.step');
    let request, current, uploads = 0;
    const receipt = { ...model(6), bodyId: 'imported', revision: 1, stepImport: { bodyCount: 2, modelLengthUnit: 'mm' } };
    const controller = new ModelingController({ taskControl: true, fetchImpl: async (url, init) => {
            calls.push({ url, init });
            if (url.endsWith('/imports/step/tasks')) {
                request = JSON.parse(init.body).command;
                return reserve.promise;
            }
            if (url.endsWith('/imports/step')) {
                uploads++;
                assert.equal(init.body, file);
                assert.equal(init.headers['X-Cad-Task-Id'], taskId);
                assert.equal(init.headers['X-Base-State-Token'], token);
                assert.equal(init.headers['X-Base-Revision'], '5');
                current = task(request.requestId, 'succeeded', 7);
                throw Error('accepted response lost');
            }
            return url.endsWith('/result') ? json({ ok: true, result: receipt }) : json({ ok: true, modelingTask: current });
        } });
    try {
        controller.adoptModel(model());
        const running = controller.importStep(file);
        assert.equal(request.expectedBytes, file.size);
        assert.equal(request.fileName, file.name);
        assert.equal(request.baseStateToken, token);
        assert.equal(JSON.stringify(request).includes('original STEP bytes'), false);
        controller.adoptModel(model(9));
        current = task(request.requestId);
        reserve.resolve(json({ ok: true, modelingTask: current }, 201));
        const result = await running;
        assert.equal(result.bodyId, 'imported');
        assert.equal(uploads, 1);
        assert.equal(controller.getSnapshot().model.bodyId, 'newer');
        assert.equal(controller.getSnapshot().stateSequence, 9);
        assert.equal(controller.getSnapshot().stepImportStatus.taskId, taskId);
        assert.equal(controller.getSnapshot().stepImportStatus.phase, 'complete');
        assert.ok(calls.some(call => call.url.endsWith('/result')));
    }
    finally {
        controller.disposeTaskTracking();
    }
});
test('upload cancellation remains busy until the server proves no execution, then journals neutrally and keeps the previous model', async () => {
    const pending = deferred();
    let current, request;
    const controller = new ModelingController({ taskControl: true, fetchImpl: async (url, init) => {
            if (url.endsWith('/imports/step/tasks')) {
                request = JSON.parse(init.body).command;
                current = task(request.requestId);
                return json({ ok: true, modelingTask: current }, 201);
            }
            if (url.endsWith('/imports/step'))
                return pending.promise;
            if (url.endsWith('/cancel')) {
                current = task(request.requestId, 'receiving', 3, { cancelRequested: true, cancellable: false });
                return json({ ok: true, modelingTask: current });
            }
            return json({ ok: true, modelingTask: current });
        } });
    try {
        controller.adoptModel(model());
        const running = controller.importStep(new Blob(['STEP bytes'])), failed = assert.rejects(running, error => error.code === 'STEP_IMPORT_UPLOAD_CANCELLED');
        await new Promise(resolve => setImmediate(resolve));
        current = task(request.requestId, 'receiving', 2);
        await controller.checkModelingTask(taskId);
        assert.equal(controller.getSnapshot().stepImportStatus.taskId, taskId);
        await controller.cancelModelingTask(taskId);
        assert.equal(controller.getSnapshot().busy, true);
        current = task(request.requestId, 'cancelled', 4, { execution: 'not-started', code: 'STEP_IMPORT_UPLOAD_CANCELLED' });
        pending.resolve(json({ ok: false, documentId: 'default', code: 'STEP_IMPORT_UPLOAD_CANCELLED', error: '上传已取消，未执行几何。', modelingTask: current }, 409));
        await failed;
        assert.equal(controller.getSnapshot().busy, false);
        assert.equal(controller.getSnapshot().error, null);
        assert.equal(controller.getSnapshot().model.bodyId, 'original');
        assert.equal(controller.getSnapshot().commandLog.at(-1).status, 'cancelled');
    }
    finally {
        controller.disposeTaskTracking();
    }
});
test('lost STEP registration is discovered read-only so its reservation stays cancellable, and the file is never sent as fallback', async () => {
    let current, request, uploads = 0;
    const calls = [];
    const controller = new ModelingController({ taskControl: true, fetchImpl: async (url, init) => {
            calls.push({ url, method: init?.method || 'GET' });
            if (url.endsWith('/imports/step/tasks')) {
                request = JSON.parse(init.body).command;
                current = task(request.requestId);
                throw Error('registration reply lost');
            }
            if (url.endsWith('/imports/step')) {
                uploads++;
                throw Error('File must not be sent');
            }
            if (url.endsWith('/cancel')) {
                current = task(request.requestId, 'cancelled', 2, { execution: 'not-started' });
                return json({ ok: true, modelingTask: current });
            }
            return json({ ok: true, tasks: [current] });
        } });
    try {
        controller.adoptModel(model());
        await assert.rejects(controller.importStep(new Blob(['STEP bytes'])), error => error.code === 'MODELING_TASK_RESERVATION_FAILED');
        assert.equal(uploads, 0);
        assert.ok(calls.some(call => call.method === 'GET' && call.url.endsWith('/modeling-tasks')));
        assert.equal(controller.getSnapshot().modelingTasks[0].task.taskId, taskId);
        assert.equal(controller.getSnapshot().busy, true);
        await controller.cancelModelingTask(taskId);
        assert.equal(controller.getSnapshot().busy, false);
    }
    finally {
        controller.disposeTaskTracking();
    }
});
