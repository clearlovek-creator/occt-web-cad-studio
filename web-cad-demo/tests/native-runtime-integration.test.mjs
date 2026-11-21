import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createBackendRelease, backendEnvironment, validateBackendRelease } from '../gateway/backend-release.mjs';
import { validateNativeRuntime } from '../gateway/native-runtime-release.mjs';
import { stopTestChild } from './helpers/stop-test-child.mjs';
const workspace = path.resolve(import.meta.dirname, '..');
test('bundled native workers and all helper roles run without installed DLL paths; corruption blocks before storage startup', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-native-integration-')), data = path.join(scratch, '工程'), releases = path.join(scratch, '发布');
    let child;
    const release = createBackendRelease({ workspace, releaseRoot: releases, nativeRuntime: true,piSdk:false }), native = validateNativeRuntime(path.join(release.directory, 'native'), release.native), systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:/Windows';
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const api = `http://127.0.0.1:${port}/api`;
    const env = Object.fromEntries(Object.entries(backendEnvironment(process.env)).filter(([key]) => key.toLowerCase() !== 'path'));
    Object.assign(env, { PATH: path.join(systemRoot, 'System32'), GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: data, GEOMETRY_WORKER_PATH: 'Z:/unpublished/geometry.exe', MESH_WORKER_PATH: 'Z:/unpublished/mesh.exe', GEOMETRY_SOURCE_INSPECTOR_PATH: 'Z:/unpublished/inspector.exe', CAD_NATIVE_LOCK_PATH: 'Z:/unpublished/lock.exe', CAD_NATIVE_SWAP_PATH: 'Z:/unpublished/swap.exe', CAD_NATIVE_GEOMETRY_BIN: 'Z:/unpublished/dll', GMSH_BIN: 'Z:/unpublished/dll', PI_CLI_PATH: path.join(workspace, 'tests/fixtures/pi-rpc-fixture.mjs'), PI_CLI_CWD: workspace });
    const start = () => spawn(process.execPath, [path.join(release.directory, 'runtime/scripts/backend-server.mjs'), '--release', release.directory, '--workspace', workspace], { cwd: scratch, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const request = async (route, body) => { const response = await fetch(api + route, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
    const stop = async () => { if (!child)
        return; if (child.exitCode === null && child.signalCode === null) {
        const control = JSON.parse(fs.readFileSync(path.join(data, '.gateway-control.json'), 'utf8')), ending = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Native integration Gateway exit not confirmed; preserve ' + scratch)), 25000); child.once('exit', code => { clearTimeout(timer); if (code === 0)
            resolve();
        else
            reject(Error('Native integration shutdown ' + code)); }); });
        await fetch(api + '/runtime/shutdown', { method: 'POST', headers: { 'x-cad-shutdown-token': control.token }, signal: AbortSignal.timeout(3000) }).catch(() => { });
        await ending;
        assert.equal(JSON.parse(fs.readFileSync(path.join(data, '.gateway-last-shutdown.json'), 'utf8')).state, 'complete');
    } await stopTestChild(child); child = null; };
    try {
        child = start();
        await new Promise((resolve, reject) => { let output = '', errors = ''; const timer = setTimeout(() => done(Error('Bundled native startup timeout: ' + errors)), 15000); const exited = code => done(Error(`Bundled native startup ${code}: ${errors}`)); function done(error) { clearTimeout(timer); child.removeListener('exit', exited); if (error)
            reject(error);
        else
            resolve(); } child.once('error', done); child.once('exit', exited); child.stderr.on('data', bytes => errors = (errors + bytes).slice(-8192)); child.stdout.on('data', bytes => { output = (output + bytes).slice(-8192); if (output.includes('Geometry gateway ready'))
            done(); }); });
        const health = await request('/health');
        assert.equal(health.backendRelease.scope, 'project-code-and-native-pe-v1');
        assert.equal(health.backendRelease.nativeRuntime.sha256, release.native.sha256);
        assert.equal(health.storage.writer.ownerPid, child.pid);
        assert.equal(JSON.stringify(health.backendRelease).includes(release.directory), false);
        const box = await request('/commands', { documentId: 'default', operation: 'primitive.box', parameters: { width: 12, depth: 10, height: 8 } });
        assert.equal(box.bodyCount, 1);
        const mesh = await request('/documents/default/mesh/jobs', { qualityThreshold: 0 });
        assert.equal(mesh.mesh.admission.status, 'accepted');
        assert.ok(mesh.mesh.elementCount > 0);
        const saved = await fetch(api + '/documents/default/project/save', { method: 'POST', signal: AbortSignal.timeout(20000) });
        assert.equal(saved.status, 200, await saved.clone().text());
        const packageBytes = Buffer.from(await saved.arrayBuffer());
        assert.ok(packageBytes.byteLength > 100);
        const opened = await fetch(api + '/documents/native_copy/project/open', { method: 'POST', headers: { 'content-type': 'application/vnd.webcad.project' }, body: packageBytes, signal: AbortSignal.timeout(20000) });
        assert.equal(opened.status, 200, await opened.clone().text());
        assert.equal((await opened.json()).bodyCount, 1, 'Opening the portable project exercises the bundled snapshot-source inspector.');
        const session = await request('/pi/sessions', { sessionId: 'native-bundle', documentId: 'default' });
        assert.equal(session.ok, true);
        const { SourceFileSwap } = await import(pathToFileURL(path.join(release.directory, 'runtime/gateway/source-file-swap.mjs')).href), swap = new SourceFileSwap({ dataDir: data, executablePath: native.roles.swap, env });
        try {
            const folder = path.join(data, 'source-restores', 'bundle-test'), target = path.join(data, 'imports', 'bundle-source.step'), stage = path.join(folder, 'candidate.step');
            fs.mkdirSync(folder, { recursive: true });
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(stage, 'isolated helper bytes, not CAD geometry');
            await swap.swap({ mode: 'install', target, stage });
            assert.equal(fs.readFileSync(target, 'utf8'), 'isolated helper bytes, not CAD geometry');
        }
        finally {
            await swap.close();
        }
        await stop();
        const report = fs.readFileSync(path.join(data, '.gateway-last-shutdown.json')), dll = release.native.profiles.mesh.files.find(file => file.file.endsWith('.dll')), target = path.join(release.directory, 'native/mesh', dll.file), before = fs.readFileSync(target);
        fs.appendFileSync(target, 'changed');
        try {
            assert.throws(() => validateBackendRelease(release.directory), /改变/);
            child = start();
            let output = '';
            child.stdout.on('data', bytes => output = (output + bytes).slice(-8192));
            child.stderr.on('data', () => { });
            const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Damaged native startup did not exit')), 15000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
            assert.notEqual(code, 0);
            assert.equal(output.includes('Geometry gateway ready'), false);
            assert.deepEqual(fs.readFileSync(path.join(data, '.gateway-last-shutdown.json')), report);
            assert.equal(fs.existsSync(path.join(data, '.gateway-control.json')), false);
            await stopTestChild(child);
            child = null;
        }
        finally {
            fs.writeFileSync(target, before);
        }
    }
    finally {
        await stop();
        assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
        assert.match(path.basename(scratch), /^cad-native-integration-/);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
