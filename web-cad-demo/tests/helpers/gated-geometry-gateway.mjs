import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {waitGatewayReady} from './wait-gateway-ready.mjs';
import {observeGatewayStop} from './observe-gateway-stop.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
export async function gatedGeometryGateway(data, environment = {}) {
  const port = await freePort(), api = 'http://127.0.0.1:' + port + '/api';
  const child = spawn(process.execPath, ['tests/fixtures/gateway-shutdown.mjs'], {cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, GEOMETRY_DATA_DIR: data, GEOMETRY_PORT: String(port), GEOMETRY_WORKER_TIMEOUT_MS: '5000', GEOMETRY_WORKER_STARTUP_TIMEOUT_MS: '5000', GEOMETRY_WORKER_STOP_TIMEOUT_MS: '2000', CAD_TEST_NATIVE_REQUEST_EVENTS: '1', ...environment}});
  const events = []; let buffer = '', ready = false, diagnostics = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.includes('Geometry gateway ready')) ready = true; try { events.push(JSON.parse(line)); } catch { /* Human startup line. */ } } });
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-32768); });
  async function until(predicate, message, timeoutMs = 10000) { const deadline = Date.now() + timeoutMs; for (;;) { const result = await predicate(); if (result) return result; assert.equal(child.exitCode, null, diagnostics); assert.ok(Date.now() < deadline, message + '\n' + diagnostics); await tick(); } }
  const get = async route => fetch(api + route).then(response => response.json());
  const post = async (route, body, headers = {}) => { const response = await fetch(api + route, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)}); return {status: response.status, value: await response.json()}; };
  const tell = type => child.stdin.write(JSON.stringify({type}) + '\n');
  const event = (name, offset = 0) => until(() => events.slice(offset).find(item => item.type === 'fixture.' + name), 'Missing gated event: ' + name);
  async function cad(operation, parameters = {}, inputs = {}, documentId = 'default') { const state = await get('/documents/' + documentId); const result = await post('/commands', {operation, documentId, requestId: randomUUID(), parameters, inputs, baseRevision: state.revision, baseStateToken: state.stateToken}); assert.equal(result.value.ok, true, JSON.stringify(result)); return result.value; }
  async function reserve(command) { const result = await post('/documents/' + command.documentId + '/modeling-tasks', {command}); assert.equal(result.status, 201, JSON.stringify(result)); return result.value.modelingTask; }
  const submit = (command, task) => post('/commands', command, {'x-cad-task-id': task.taskId});
  const cancel = task => post('/documents/' + task.documentId + '/modeling-tasks/' + task.taskId + '/cancel', {});
  async function stop() {
    if (child.exitCode != null || child.signalCode != null) return child.exitCode;
    tell('release-geometry'); tell('release-geometry-exit'); tell('release-mesh-recovery');
    const control = JSON.parse(fs.readFileSync(path.join(data, '.gateway-control.json'), 'utf8'));
    const proof=await observeGatewayStop(child,signal=>fetch(api + '/runtime/shutdown', {method: 'POST',signal,headers: {'x-cad-shutdown-token': control.token}}));
    events.push({type:'fixture.shutdown-proof',pid:child.pid,...proof});return proof.exitCode;
  }
  const readyTimeoutMs=environment.CAD_TEST_GATEWAY_RELEASE_ROOT||process.env.CAD_TEST_GATEWAY_RELEASE_ROOT?60000:15000;
  const waitReady=async(timeoutMs=readyTimeoutMs)=>{if(ready)return;await waitGatewayReady(child,{timeoutMs});ready=true;};
  const fixture={api, port, child, events, get, post, cad, reserve, submit, cancel, tell, event, until, stop,waitReady};
  try{await waitReady();}catch(error){Object.defineProperty(error,'fixture',{value:fixture});throw error;}
  return fixture;
}
