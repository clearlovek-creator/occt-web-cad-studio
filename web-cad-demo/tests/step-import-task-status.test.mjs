import test from 'node:test';
import assert from 'node:assert/strict';
import {StepImportTasks} from '../gateway/step-import-tasks.mjs';

for (const [name, fields, unchanged] of [
  ['failed without rollback evidence', {phase: 'failed'}, false],
  ['failed in preparation without evidence', {phase: 'failed', mode: 'preparing'}, false],
  ['failed with verified rollback', {phase: 'failed', restored: true}, true],
  ['rejected before execution', {phase: 'failed', execution: 'not-started'}, true],
  ['cancelled after verified service settlement', {phase: 'cancelled'}, true],
  ['unknown even with stale evidence', {phase: 'unknown', restored: true, execution: 'not-started'}, false],
]) test(`STEP terminal projection is evidence-bound: ${name}`, () => {
  const updates = [], imports = {
    key: (doc, request) => `${doc}:${request}`,
    active: new Map([['doc:request', {transfer: {taskId: 'task'}}]]),
    advance: (...args) => updates.push(args),
  };
  const service = new StepImportTasks({dataDir: '.', imports});
  service.settle({documentId: 'doc', requestKey: 'request', taskId: 'task', operation: 'step.import', ...fields});
  assert.equal(updates.length, 1);
  assert.equal(updates[0][2], fields.phase === 'unknown' ? 'unknown' : 'failed');
  assert.equal(updates[0][3].unchanged, unchanged);
  service.settle({documentId: 'doc', requestKey: 'request', taskId: 'other', operation: 'step.import', ...fields});
  service.settle({documentId: 'doc', requestKey: 'request', taskId: 'task', operation: 'primitive.box', ...fields});
  assert.equal(updates.length, 1);
});
