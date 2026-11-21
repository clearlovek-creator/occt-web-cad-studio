import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayErrorStatus} from '../gateway/gateway-error-status.mjs';

test('native service unavailability is not misreported as invalid user geometry arguments', () => {
  for (const code of ['WORKER_UNAVAILABLE', 'WORKER_MEMORY_LIMIT', 'WORKER_MEMORY_EXHAUSTED', 'WORKER_STOP_UNCONFIRMED']) assert.equal(gatewayErrorStatus(code), 503);
  assert.equal(gatewayErrorStatus('PRIMITIVE_ARGUMENTS'), 400);
  assert.equal(gatewayErrorStatus('WORKER_CANCELLED'), 409);
  assert.equal(gatewayErrorStatus('PROJECT_JOURNAL_TOO_LARGE'),413);
  assert.equal(gatewayErrorStatus('PROJECT_ROLLBACK_PROOF_INVALID'),503);
});
