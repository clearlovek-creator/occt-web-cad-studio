import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createBackendRelease, validateBackendRelease } from '../gateway/backend-release.mjs';
import { stopTestChild } from './helpers/stop-test-child.mjs';
const workspace = path.resolve(import.meta.dirname, '..');
function token(value) {
    if (typeof value === 'string') {
        try {
            return token(JSON.parse(value));
        }
        catch {
            return null;
        }
    }
    if (!value || typeof value !== 'object')
        return null;
    if (typeof value.stateToken === 'string')
        return value.stateToken;
    for (const item of Object.values(value)) {
        const found = token(item);
        if (found)
            return found;
    }
    return null;
}
test('V3 runs from an empty application directory and the sealed native Pi performs a real local model/tool/CAD loop', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-sdk-backend-')), data = path.join(scratch, '工程'), application = path.join(scratch, 'empty-application'), releases = path.join(scratch, '发布');
    fs.mkdirSync(application);
    let child, release, sdkDir, verified = false;
    const requests = [], tools = [], errors = [], provider = createServer(async (request, response) => {
        try {
            assert.equal(request.url, '/v1/chat/completions');
            assert.equal(request.method, 'POST');
            let bytes = 0, parts = [];
            for await (const part of request) {
                bytes += part.length;
                assert.ok(bytes < 2 * 1024 * 1024);
                parts.push(part);
            }
            const body = JSON.parse(Buffer.concat(parts));
            assert.equal(body.model, 'sdk-fixture');
            requests.push(body);
            const phase = requests.length;
            assert.ok(body.tools.some(tool => tool.function?.name === 'query_model'));
            assert.ok(body.tools.some(tool => tool.function?.name === 'primitive__box'));
            let delta, finish;
            if (phase === 1) {
                delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'sealed-query', type: 'function', function: { name: 'query_model', arguments: JSON.stringify({ kind: 'geometry-tree' }) } }] };
                finish = 'tool_calls';
                tools.push('query_model');
            }
            else if (phase === 2) {
                const observed = token(body.messages.filter(message => message.role === 'tool'));
                assert.match(observed, /^[a-f0-9]{64}$/);
                delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'sealed-box', type: 'function', function: { name: 'primitive__box', arguments: JSON.stringify({ baseStateToken: observed, parameters: { width: 10, depth: 20, height: 30 } }) } }] };
                finish = 'tool_calls';
                tools.push('primitive__box');
            }
            else {
                assert.equal(phase, 3, 'No model/tool command retries');
                assert.ok(body.messages.filter(message => message.role === 'tool').length >= 2);
                delta = { role: 'assistant', content: 'The CAD tool confirmed one box.' };
                finish = 'stop';
            }
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            const chunk = (delta, reason) => ({ id: 'sdk-response-' + phase, object: 'chat.completion.chunk', created: 1, model: 'sdk-fixture', choices: [{ index: 0, delta, finish_reason: reason }] });
            response.write('data: ' + JSON.stringify(chunk(delta, null)) + '\n\n');
            response.write('data: ' + JSON.stringify(chunk({}, finish)) + '\n\n');
            response.end('data: [DONE]\n\n');
        }
        catch (error) {
            errors.push(error.message);
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'Local SDK fixture assertion failed' } }));
        }
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const api = `http://127.0.0.1:${port}/api`;
    const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']), env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
    Object.assign(env, { GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: data, CAD_GEOMETRY_API_URL: 'http://127.0.0.1:1/api', AGENT_ALLOW_PRIVATE_URL: 'true', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CLI_PATH: 'Z:/must-not-load/cli.mjs', PI_SDK_ROOT: 'Z:/must-not-load/sdk', PI_PACKAGE_DIR: 'Z:/must-not-load/assets', JITI_ALIAS: '{"@earendil-works/pi-ai":"Z:/wrong.ts"}', TSX_TSCONFIG_PATH: 'Z:/wrong.json' });
    const start = () => spawn(process.execPath, [path.join(release.directory, 'runtime/scripts/backend-server.mjs'), '--release', release.directory, '--workspace', application], { cwd: application, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const request = async (route, body) => { const response = await fetch(api + route, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) }), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
    const stop = async () => {
        if (!child)
            return;
        if (child.exitCode === null && child.signalCode === null) {
            // Startup observation expiring is not proof of process exit. Keep
            // the same owned handle and await its control endpoint or exit.
            const controlFile = path.join(data, '.gateway-control.json'), deadline = Date.now() + 120000;
            while (!fs.existsSync(controlFile) && child.exitCode === null && child.signalCode === null) {
                if (Date.now() >= deadline)
                    throw Error('SDK Gateway control/exit remains unconfirmed; preserve ' + scratch);
                await delay(50);
            }
            if (child.exitCode !== null || child.signalCode !== null) {
                await stopTestChild(child);
                child = null;
                return;
            }
            const control = JSON.parse(fs.readFileSync(path.join(data, '.gateway-control.json'), 'utf8')), ending = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(Error('SDK Gateway exit not confirmed; preserve ' + scratch)), 25000);
                child.once('exit', code => {
                    clearTimeout(timer);
                    if (code === 0)
                        resolve();
                    else
                        reject(Error('SDK Gateway shutdown ' + code));
                });
            });
            await fetch(api + '/runtime/shutdown', { method: 'POST', headers: { 'x-cad-shutdown-token': control.token }, signal: AbortSignal.timeout(3000) }).catch(() => { });
            await ending;
            assert.equal(JSON.parse(fs.readFileSync(path.join(data, '.gateway-last-shutdown.json'), 'utf8')).state, 'complete');
        }
        await stopTestChild(child);
        child = null;
    };
    try {
        release = createBackendRelease({ workspace, releaseRoot: releases });
        sdkDir = path.join(release.directory, 'pi-sdk');
        assert.equal(release.version, 3);
        child = start();
        await new Promise((resolve, reject) => {
            let out = '', diagnostic = '';
            const timer = setTimeout(() => done(Error('SDK Gateway startup timeout ' + diagnostic)), 120000);
            const exited = code => done(Error(`SDK Gateway exited ${code}: ${diagnostic}`));
            function done(error) {
                clearTimeout(timer);
                child.removeListener('exit', exited);
                if (error)
                    reject(error);
                else
                    resolve();
            }
            child.once('error', done);
            child.once('exit', exited);
            child.stderr.on('data', bytes => diagnostic = (diagnostic + bytes).slice(-8192));
            child.stdout.on('data', bytes => {
                out = (out + bytes).slice(-8192);
                if (out.includes('Geometry gateway ready'))
                    done();
            });
        });
        const health = await request('/health');
        assert.equal(health.backendRelease.scope, 'project-code-native-pi-sdk-v1');
        assert.equal(health.backendRelease.piSdk.manifestSha256, release.sdk.manifest.sha256);
        assert.equal(health.backendRelease.externalDependencies.includes('pi-sdk'), false);
        assert.equal(JSON.stringify(health.backendRelease).includes(scratch), false);
        await request('/agent/providers', { id: 'sdk-fixture', name: 'Local offline test', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, protocol: 'chat-completions', model: 'sdk-fixture', apiKey: 'local-fixture-not-a-real-secret' });
        const session = await request('/pi/sessions', { sessionId: 'sealed-sdk', documentId: 'default', providerId: 'sdk-fixture' }), rpc = command => request('/pi/sessions/sealed-sdk/commands', { documentId: 'default', streamId: session.streamId, command });
        await rpc({ type: 'set_model', provider: 'sdk-fixture', modelId: 'sdk-fixture' });
        await rpc({ type: 'set_auto_retry', enabled: false });
        const controller = new AbortController(), stream = await fetch(api + `/pi/sessions/sealed-sdk/events?documentId=default&streamId=${session.streamId}&after=0`, { signal: controller.signal });
        assert.equal(stream.status, 200);
        const reader = stream.body.getReader();
        const ended = (async () => {
            let wire = '';
            const decoder = new TextDecoder(), timer = setTimeout(() => controller.abort(), 20000);
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        throw Error('Native SDK event stream ended before agent_end');
                    wire = (wire + decoder.decode(value, { stream: true })).slice(-65536);
                    if (wire.includes('"type":"agent_end"'))
                        return;
                }
            }
            finally {
                clearTimeout(timer);
            }
        })();
        ended.catch(() => { });
        try {
            await rpc({ type: 'prompt', message: 'Create one box 10 by 20 by 30. Query the document first.' });
            await ended;
        }
        finally {
            controller.abort();
            await reader.cancel().catch(() => { });
        }
        const summary = await request('/commands', { documentId: 'default', operation: 'document.summary' });
        assert.equal(summary.bodyCount, 1, JSON.stringify({ summary, fixtureErrors: errors }));
        const measured = await request('/commands', { documentId: 'default', operation: 'geometry.measure', inputs: { bodyId: summary.bodies[0].bodyId || summary.bodies[0].id } });
        assert.ok(Math.abs(measured.volume - 6000) < 1e-6);
        const messages = (await rpc({ type: 'get_messages' })).response.data.messages;
        assert.ok(messages.some(message => message.role === 'toolResult' && message.toolName === 'query_model'));
        assert.ok(messages.some(message => message.role === 'toolResult' && message.toolName === 'primitive__box' && !message.isError));
        assert.deepEqual(tools, ['query_model', 'primitive__box']);
        assert.equal(requests.length, 3);
        assert.deepEqual(errors, []);
        const sessions = path.join(data, 'pi-sessions/sealed-sdk'), transcript = fs.readdirSync(sessions).find(name => name.endsWith('.jsonl'));
        assert.ok(transcript);
        const header = JSON.parse(fs.readFileSync(path.join(sessions, transcript), 'utf8').split('\n')[0]);
        assert.equal(path.resolve(header.cwd), path.join(data, 'pi-workspaces/default'), 'Mutable Pi project settings must stay outside the SDK release.');
        await stop();
        validateBackendRelease(release.directory);
        const stable = fs.readFileSync(path.join(data, '.gateway-last-shutdown.json')), target = path.join(sdkDir, 'packages/agent/src/agent-loop.ts'), before = fs.readFileSync(target);
        fs.appendFileSync(target, '\n// invalid release change');
        try {
            assert.throws(() => validateBackendRelease(release.directory), /Pi SDK.*改变/);
            child = start();
            child.stdout.on('data', () => { });
            child.stderr.on('data', () => { });
            const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Corrupt SDK bootstrap did not terminate')), 15000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
            assert.notEqual(code, 0);
            assert.deepEqual(fs.readFileSync(path.join(data, '.gateway-last-shutdown.json')), stable);
            assert.equal(fs.existsSync(path.join(data, '.gateway-control.json')), false);
            await stopTestChild(child);
            child = null;
        }
        finally {
            fs.writeFileSync(target, before);
        }
        verified = true;
    }
    catch (error) {
        console.error('SDK integration failed; diagnostics: ' + scratch + '\n' + error.stack);
        throw error;
    }
    finally {
        try {
            await stop();
            if (verified) {
                assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
                assert.match(path.basename(scratch), /^cad-sdk-backend-/);
                fs.rmSync(scratch, { recursive: true, force: true });
            }
        }
        finally {
            provider.closeAllConnections();
            await new Promise(resolve => provider.close(resolve));
        }
    }
});
