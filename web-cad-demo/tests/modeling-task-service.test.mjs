import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {ModelingTaskService} from '../gateway/modeling-task-service.mjs';
import {normalizeModelingTaskStatus, modelingTaskLabel, modelingTaskExplanation} from '../shared/modeling-task-status.mjs';

const meta = (requestKey = 'request-1') => ({documentId: 'doc', operation: 'primitive.box', requestKey, digest: 'a'.repeat(64), outcomeFingerprint: 'b'.repeat(64)});
function fixture(options = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-modeling-task-'));
  const warnings = [], service = new ModelingTaskService(data, {...options, onWarning: message => warnings.push(message)});
  return {data, service, warnings, clean() { assert.equal(path.dirname(path.resolve(data)), path.resolve(os.tmpdir())); assert.ok(path.basename(data).startsWith('cad-modeling-task-')); fs.rmSync(data, {recursive: true, force: true}); }};
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };

test('task reservation binds stable identity and input but never persists parameters or accepts caller-owned IDs', () => {
  const f = fixture();
  try {
    const first = f.service.reserve({...meta(), taskId: 'spoofed', ownerInstanceId: 'spoofed', apiKey: 'secret-input'});
    assert.notEqual(first.taskId, 'spoofed');
    assert.deepEqual(f.service.reserve(meta()), first);
    assert.equal(first.phase, 'reserved'); assert.equal(first.cancellable, true);
    assert.doesNotMatch(fs.readFileSync(f.service.file(first.taskId), 'utf8'), /secret-input|spoofed/);
    assert.doesNotMatch(JSON.stringify(first), /digest|outcomeFingerprint|ownerInstanceId/);
    assert.throws(() => f.service.reserve({...meta(), digest: 'c'.repeat(64)}), {code: 'MODELING_TASK_CONFLICT'});
    assert.throws(() => f.service.claim(first.taskId, {...meta(), outcomeFingerprint: 'c'.repeat(64)}), {code: 'MODELING_TASK_CONFLICT'});
    assert.equal(f.service.status().active, 0);
  } finally { f.clean(); }
});

test('unsubmitted cancellation is terminal, idempotent and cannot be claimed later', () => {
  const f = fixture();
  try {
    const reserved = f.service.reserve(meta()), cancelled = f.service.cancel('doc', reserved.taskId);
    assert.equal(cancelled.phase, 'cancelled'); assert.equal(cancelled.execution, 'not-started'); assert.equal(cancelled.cancellable, false);
    assert.deepEqual(f.service.cancel('doc', reserved.taskId), cancelled);
    assert.throws(() => f.service.claim(reserved.taskId, meta()), {code: 'MODELING_TASK_ALREADY_SUBMITTED'});
  } finally { f.clean(); }
});

test('queued cancellation retains intent until the scheduler proves it never started', async () => {
  const f = fixture();
  try {
    const reserved = f.service.reserve(meta()), task = f.service.claim(reserved.taskId, meta()), pending = deferred();
    const finished = f.service.finish(task, pending.promise);
    const failed = assert.rejects(finished, {code: 'DOCUMENT_ACTION_CANCELLED'});
    const stopping = f.service.cancel('doc', reserved.taskId);
    assert.equal(stopping.cancelRequested, true); assert.equal(stopping.phase, 'queued'); assert.equal(stopping.cancellable, false);
    assert.equal(task.controller.signal.aborted, true);
    assert.deepEqual(f.service.cancel('doc', reserved.taskId), stopping);
    pending.reject(Object.assign(Error('not started'), {code: 'DOCUMENT_ACTION_CANCELLED'})); await failed;
    assert.equal(f.service.get('doc', reserved.taskId).phase, 'cancelled');
    assert.equal(f.service.status().active, 0);
  } finally { f.clean(); }
});

test('executing cancellation aborts only execution and waits for confirmed full-project rollback', async () => {
  const f = fixture();
  try {
    const record = f.service.reserve(meta()), task = f.service.claim(record.taskId, meta()), hold = deferred();
    const execution = f.service.runAction(task, async () => {
      assert.equal(f.service.commandOptions().signal, undefined);
      f.service.enterExecuting(); assert.equal(f.service.commandOptions().signal, task.controller.signal);
      await hold.promise;
      f.service.beginRecovery(); assert.equal(f.service.commandOptions().signal, undefined);
      throw Object.assign(Error('cancelled and restored'), {code: 'WORKER_CANCELLED', projectRollback: {documentId: 'doc', confirmed: true}});
    });
    const finished = f.service.finish(task, execution), failed = assert.rejects(finished, {code: 'WORKER_CANCELLED'});
    const stopping = f.service.cancel('doc', task.taskId);
    assert.equal(stopping.phase, 'stopping'); assert.equal(f.service.status().active, 1);
    hold.resolve(); await failed;
    assert.equal(f.service.get('doc', task.taskId).phase, 'cancelled');
  } finally { f.clean(); }
});

test('failed rollback stays unknown and cannot be deleted or represented as cancelled', async () => {
  const f = fixture();
  try {
    const record = f.service.reserve(meta()), task = f.service.claim(record.taskId, meta());
    const execution = f.service.runAction(task, async () => { f.service.enterExecuting(); f.service.cancel('doc', task.taskId); f.service.beginRecovery(); throw Object.assign(Error('unconfirmed exit'), {code: 'PROJECT_ROLLBACK_FAILED'}); });
    await assert.rejects(f.service.finish(task, execution), {code: 'PROJECT_ROLLBACK_FAILED'});
    const status = f.service.get('doc', task.taskId); assert.equal(status.phase, 'unknown'); assert.equal(status.cancellable, false);
    assert.throws(() => f.service.delete('doc', task.taskId), {code: 'MODELING_TASK_ACTIVE'});
  } finally { f.clean(); }
});

test('preparing and committing are non-cancellable and late cancellation never invokes Undo', async () => {
  const receipt = {ok: true, revision: 9, stateToken: 'd'.repeat(64)}, f = fixture({resolveOutcome: () => receipt});
  try {
    const record = f.service.reserve(meta()), task = f.service.claim(record.taskId, meta());
    const value = await f.service.finish(task, f.service.runAction(task, async () => {
      assert.throws(() => f.service.cancel('doc', task.taskId), {code: 'MODELING_TASK_NOT_CANCELLABLE'});
      f.service.enterExecuting(); f.service.beginCommit();
      assert.equal(f.service.commandOptions().signal, undefined);
      assert.throws(() => f.service.cancel('doc', task.taskId), {code: 'MODELING_TASK_NOT_CANCELLABLE'});
      return receipt;
    }));
    assert.equal(value, receipt); assert.equal(f.service.cancel('doc', task.taskId).phase, 'succeeded');
    assert.equal(f.service.result('doc', task.taskId), receipt);
  } finally { f.clean(); }
});

test('cancelled intent before commit forces recovery rather than publishing a successful result', async () => {
  const f = fixture();
  try {
    const record = f.service.reserve(meta()), task = f.service.claim(record.taskId, meta());
    await f.service.runAction(task, async () => {
      f.service.enterExecuting(); f.service.cancel('doc', task.taskId);
      assert.throws(() => f.service.beginCommit(), {code: 'WORKER_CANCELLED'});
      f.service.beginRecovery();
      assert.equal(f.service.commandOptions().signal, undefined);
    });
    // This low-level fixture deliberately does not finish an execution; no
    // false successful receipt is created, and a new owner reports unknown.
    const restarted = new ModelingTaskService(f.data);
    assert.equal(restarted.get('doc', task.taskId).phase, 'unknown');
  } finally { f.clean(); }
});

test('restart is read-only and uses only an injected durable receipt, never replays or assumes an interrupted cancellation completed', () => {
  const f = fixture();
  try {
    const record = f.service.reserve(meta()); f.service.claim(record.taskId, meta());
    const file = f.service.file(record.taskId), before = fs.readFileSync(file);
    const restarted = new ModelingTaskService(f.data);
    assert.equal(restarted.get('doc', record.taskId).phase, 'unknown');
    assert.throws(() => restarted.claim(record.taskId, meta()), {code: 'MODELING_TASK_ALREADY_SUBMITTED'});
    assert.deepEqual(fs.readFileSync(file), before);
    const receipt = {ok: true, revision: 7};
    const proven = new ModelingTaskService(f.data, {resolveOutcome: () => receipt});
    assert.equal(proven.get('doc', record.taskId).phase, 'succeeded');
    assert.equal(proven.get('doc', record.taskId).recovered, true);
    assert.equal(proven.result('doc', record.taskId), receipt);
    assert.deepEqual(fs.readFileSync(file), before);
  } finally { f.clean(); }
});

test('capacity requires explicit terminal deletion and deleted task IDs cannot be used to execute again', () => {
  const f = fixture({maxRecords: 1});
  try {
    const record = f.service.reserve(meta());
    assert.throws(() => f.service.reserve(meta('request-2')), {code: 'MODELING_TASK_CAPACITY'});
    f.service.cancel('doc', record.taskId); f.service.delete('doc', record.taskId);
    assert.throws(() => f.service.claim(record.taskId, meta()), {code: 'MODELING_TASK_NOT_FOUND'});
    assert.notEqual(f.service.reserve(meta('request-2')).taskId, record.taskId);
  } finally { f.clean(); }
});

test('phase persistence failure cannot abort recovery or conceal the actual project outcome', async () => {
  const f = fixture(), rename = fs.renameSync;
  try {
    const record = f.service.reserve(meta()), task = f.service.claim(record.taskId, meta());
    await f.service.runAction(task, async () => {
      f.service.enterExecuting(); f.service.cancel('doc', task.taskId);
      fs.renameSync = () => { throw Object.assign(Error('simulated locked report'), {code: 'EPERM'}); };
      f.service.beginRecovery();
      assert.equal(f.service.commandOptions().signal, undefined);
      const status = f.service.get('doc', task.taskId); assert.equal(status.phase, 'rolling-back'); assert.equal(status.reportDurable, false);
    });
    assert.ok(f.warnings.length);
  } finally { fs.renameSync = rename; f.clean(); }
});

test('status protocol is identity-bound, bounded, text-only and does not enable cancel on a terminal phase', () => {
  const f = fixture();
  try {
    const record = f.service.reserve(meta());
    assert.equal(modelingTaskLabel(record), '准备提交');
    assert.deepEqual(normalizeModelingTaskStatus({...record, digest: 'secret'}, 'doc', record.taskId), record);
    assert.throws(() => normalizeModelingTaskStatus(record, 'other', record.taskId));
    assert.throws(() => normalizeModelingTaskStatus(record, 'doc', randomUUID()));
    assert.throws(() => normalizeModelingTaskStatus({...record, phase: 'succeeded', cancellable: true}, 'doc'));
    assert.throws(() => f.service.update(record.taskId, 'succeeded'), {code: 'MODELING_TASK_PHASE_INVALID'});
  } finally { f.clean(); }
});

test('abandon is a reserved-only comparison and cannot cancel a concurrently claimed or previous-owner task', () => {
  const f = fixture();
  try {
    const first = f.service.reserve(meta()), abandoned = f.service.abandonUnsubmitted('doc', first.taskId);
    assert.equal(abandoned.phase, 'failed'); assert.equal(abandoned.execution, 'not-started');
    assert.equal(abandoned.cancelRequested, false);
    assert.throws(() => f.service.claim(first.taskId, meta()), {code: 'MODELING_TASK_ALREADY_SUBMITTED'});
    const next = f.service.reserve(meta('request-2')), active = f.service.claim(next.taskId, meta('request-2'));
    assert.throws(() => f.service.abandonUnsubmitted('doc', next.taskId), {code: 'MODELING_TASK_ALREADY_SUBMITTED'});
    assert.equal(active.controller.signal.aborted, false);
    assert.equal(f.service.get('doc', next.taskId).phase, 'queued');
    const reserved = f.service.reserve(meta('request-3')), restarted = new ModelingTaskService(f.data);
    assert.throws(() => restarted.abandonUnsubmitted('doc', reserved.taskId), {code: 'MODELING_TASK_ALREADY_SUBMITTED'});
    assert.equal(restarted.get('doc', reserved.taskId).phase, 'unknown');
  } finally { f.clean(); }
});

test('explicit completed cleanup preserves reserved, active, unknown and foreign-project records', async () => {
  const f = fixture();
  try {
    const done = f.service.reserve(meta('done')); f.service.cancel('doc', done.taskId);
    const reserved = f.service.reserve(meta('reserved'));
    const queued = f.service.reserve(meta('queued')); f.service.claim(queued.taskId, meta('queued'));
    const uncertain = f.service.reserve(meta('unknown')), active = f.service.claim(uncertain.taskId, meta('unknown'));
    await assert.rejects(f.service.finish(active, f.service.runAction(active, async () => {
      f.service.enterExecuting(); throw Object.assign(Error('unconfirmed outcome'), {code: 'WORKER_FAILED'});
    })), {code: 'WORKER_FAILED'});
    const foreign = f.service.reserve({...meta('foreign'), documentId: 'other'}); f.service.cancel('other', foreign.taskId);
    assert.deepEqual(f.service.clearCompleted('doc'), {deleted: 1, retained: 0});
    assert.throws(() => f.service.get('doc', done.taskId), {code: 'MODELING_TASK_NOT_FOUND'});
    for (const [id, phase] of [[reserved.taskId, 'reserved'], [queued.taskId, 'queued'], [uncertain.taskId, 'unknown']]) assert.equal(f.service.get('doc', id).phase, phase);
    assert.equal(f.service.get('other', foreign.taskId).phase, 'cancelled');
  } finally { f.clean(); }
});

test('STEP receiving cancellation does not finish until upload ownership ends and cannot transition to the geometry queue',async()=>{
  const terminal=[],f=fixture({onTerminal:record=>terminal.push({phase:record.phase,execution:record.execution})});
  try{const metadata={...meta(),operation:'step.import'},record=f.service.reserve(metadata),task=f.service.claim(record.taskId,metadata,{receiving:true}),pending=deferred(),finished=f.service.finish(task,pending.promise),rejected=assert.rejects(finished,{code:'STEP_IMPORT_UPLOAD_CANCELLED'});assert.equal(f.service.get('doc',task.taskId).phase,'receiving');assert.equal(f.service.cancel('doc',task.taskId).cancelRequested,true);assert.equal(f.service.status().active,1);assert.equal(terminal.length,0);assert.throws(()=>f.service.enterQueued(task),{code:'DOCUMENT_ACTION_CANCELLED'});pending.reject(Object.assign(Error('upload stopped'),{code:'STEP_IMPORT_UPLOAD_CANCELLED'}));await rejected;assert.equal(f.service.get('doc',task.taskId).phase,'cancelled');assert.equal(f.service.get('doc',task.taskId).execution,'not-started');assert.deepEqual(terminal,[{phase:'cancelled',execution:'not-started'}]);
  }finally{f.clean();}
});

test('failed result reports restored only for a confirmed rollback of the same document and persists that proof across restart', async () => {
  const f = fixture();
  try {
    for (const [key, proof, expected] of [['missing', undefined, false], ['foreign', {documentId: 'other', confirmed: true}, false], ['unconfirmed', {documentId: 'doc', confirmed: false}, false], ['verified', {documentId: 'doc', confirmed: true}, true]]) {
      const metadata = meta(key), record = f.service.reserve(metadata), task = f.service.claim(record.taskId, metadata);
      const result = {ok: false, code: 'STEP_INVALID', error: `${f.data}/imports/source.step ${'x'.repeat(1100)}`};
      if (proof) Object.defineProperty(result, 'projectRollback', {value: proof});
      assert.equal(await f.service.finish(task, f.service.runAction(task, async () => { f.service.enterExecuting(); return result; })), result);
      const status = f.service.get('doc', task.taskId);
      assert.equal(status.phase, 'failed'); assert.equal(status.restored === true, expected);
      assert.equal(status.error.length, 1000); assert.ok(!status.error.includes(f.data));
      assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(result)), 'projectRollback'), false);
      assert.equal(new ModelingTaskService(f.data).get('doc', task.taskId).restored === true, expected);
    }
  } finally { f.clean(); }
});

test('only verified thrown rollback errors publish restoration and auxiliary report failure cannot replace the result', async () => {
  const f = fixture({onTerminal: () => { throw Error('report unavailable'); }});
  try {
    const metadata = meta(), record = f.service.reserve(metadata), task = f.service.claim(record.taskId, metadata);
    const error = Object.assign(Error('native refused'), {code: 'WORKER_FAILED', projectRollback: {documentId: 'doc', confirmed: true}});
    await assert.rejects(f.service.finish(task, f.service.runAction(task, async () => { f.service.enterExecuting(); throw error; })), reason => reason === error);
    assert.equal(f.service.get('doc', task.taskId).phase, 'failed');
    assert.equal(f.service.get('doc', task.taskId).restored, true);
    assert.equal(error.modelingTask.restored, true);
    assert.equal(f.service.status().active, 0);
    assert.match(f.warnings.at(-1), /Auxiliary terminal report failed/);
  } finally { f.clean(); }
});

test('task explanations never infer restoration from failed or cancelled labels and unknown wins over stale proof', () => {
  for (const phase of ['failed', 'cancelled']) {
    assert.doesNotMatch(modelingTaskExplanation({phase}), /已恢复/);
    assert.match(modelingTaskExplanation({phase, restored: true}), /原工程已恢复/);
    assert.equal(modelingTaskExplanation({phase, execution: 'not-started'}), '该命令未执行。');
  }
  assert.match(modelingTaskExplanation({phase: 'unknown', restored: true}), /尚未确认/);
  assert.equal(modelingTaskExplanation(null), null);
  const status = {version: 1, documentId: 'doc', taskId: randomUUID(), operation: 'step.import', requestKey: 'request', phase: 'failed', sequence: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancelRequested: false, cancellable: false, reportDurable: true};
  assert.equal(normalizeModelingTaskStatus({...status, restored: 'yes'}, 'doc').restored, undefined);
  assert.equal(normalizeModelingTaskStatus({...status, restored: true}, 'doc').restored, true);
});
