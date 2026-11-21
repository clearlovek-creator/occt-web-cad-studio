import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {waitGatewayReady} from './helpers/wait-gateway-ready.mjs';

function child() { const value = new EventEmitter(); Object.assign(value, {stdout: new PassThrough(), stderr: new PassThrough(), pid: 12345, exitCode: null, signalCode: null}); value.kill = () => { throw Error('Observation must not kill the process'); }; return value; }
test('gateway readiness recognizes a startup line split across arbitrary stream chunks', async () => {
  const process = child(), ready = waitGatewayReady(process); for (const byte of Buffer.from('Geometry gateway ready at 127.0.0.1:12345\n')) process.stdout.write(Buffer.from([byte])); await ready;
  assert.equal(process.stdout.listenerCount('data'), 0); assert.equal(process.stderr.listenerCount('data'), 0); assert.equal(process.listenerCount('exit'), 0);
});
test('gateway observation timeout preserves the live child and labels readiness as unconfirmed, never exited', async () => {
  const process = child(); await assert.rejects(waitGatewayReady(process, {timeoutMs: 5}), error => error.code === 'GATEWAY_READY_TIMEOUT' && error.pid === process.pid && error.message.includes('does not confirm process exit'));
  assert.equal(process.exitCode, null); assert.equal(process.signalCode, null); assert.equal(process.listenerCount('exit'), 0);
});
test('a real exit before readiness is distinct from timeout and bounded diagnostics are retained', async () => {
  const process = child(), pending = waitGatewayReady(process, {diagnosticBytes: 64}), checked = assert.rejects(pending, error => error.code === 'GATEWAY_READY_PROCESS_EXIT' && error.message.includes('exit-tail') && !error.message.includes('private-prefix'));
  process.stderr.write('private-prefix' + 'x'.repeat(1000) + 'exit-tail'); process.exitCode = 87; process.emit('exit', 87, null); await checked;
});
test('an already exited child cannot be mistaken for a live startup wait', async () => {
  const process = child(); process.exitCode = 1; await assert.rejects(waitGatewayReady(process), {code: 'GATEWAY_READY_PROCESS_EXIT'}); assert.equal(process.stdout.listenerCount('data'), 0);
});
