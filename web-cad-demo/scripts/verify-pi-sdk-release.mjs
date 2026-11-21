import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { PiRpcSession } from '../gateway/pi-rpc-runtime.mjs';
import { validatePiSdkRelease } from '../gateway/pi-sdk-release.mjs';
const [directory, manifestSha256] = process.argv.slice(2);
if (!directory || !manifestSha256)
    throw Error('Usage: verify-pi-sdk-release.mjs sdk-directory manifest-sha256');
const root = path.resolve(directory), descriptor = JSON.parse(fs.readFileSync(path.join(root, 'sdk-release.json'), 'utf8')), binding = { format: 'web-cad-pi-sdk-binding', version: 1, sdkVersion: descriptor.sdkVersion, mode: descriptor.mode, manifest: { bytes: fs.statSync(path.join(root, 'sdk-release.json')).size, sha256: manifestSha256 } }, runtime = validatePiSdkRelease(root, binding), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-pi-sdk-rpc-')), requests = [];
const server = createServer((request, response) => { requests.push({ method: request.method, path: request.url }); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, gateway: true, worker: true, protocolVersion: 1 })); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']), env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
Object.assign(env, { CAD_GEOMETRY_API_URL: `http://127.0.0.1:${server.address().port}/api`, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', JITI_FS_CACHE: 'false', TSX_CACHE_DIR: path.join(scratch, 'tsx-cache'), PI_PACKAGE_DIR: path.join(root, 'packages/coding-agent') });
let diagnostic = '';
const session = new PiRpcSession({ sessionId: 'sealed-sdk', documentId: 'test', ...runtime, extensionPath: path.resolve('gateway/pi-cad-mcp-extension.mjs'), sessionRoot: path.join(scratch, 'session'), agentConfigDir: path.join(scratch, 'config'), env, spawnImpl: (...args) => { const child = spawn(...args); child.stderr.on('data', bytes => diagnostic = (diagnostic + bytes).slice(-16384)); return child; } });
try {
    await session.start();
    const owned = session.child, state = await session.request({ type: 'get_state' }), messages = await session.request({ type: 'get_messages' });
    assert.equal(state.success, true);
    assert.deepEqual(messages.data.messages, []);
    await session.stop();
    assert.ok(owned.exitCode !== null || owned.signalCode !== null);
    assert.equal(session.stoppingChild, null);
    assert.ok(requests.length > 0);
    assert.ok(requests.every(request => request.method === 'GET' && request.path === '/api/health'));
    validatePiSdkRelease(root, binding);
    console.log(JSON.stringify({ ok: true, sdkVersion: runtime.version, packages: runtime.packages, files: runtime.files, bytes: runtime.bytes, handshake: true, readOnlyRequests: requests.length, artifactUnchanged: true, paidProviderCalls: 0 }));
}
catch (error) {
    console.error('Isolated SDK startup diagnostic: ' + diagnostic);
    throw error;
}
finally {
    await session.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    assert.match(path.basename(scratch), /^cad-pi-sdk-rpc-/);
    fs.rmSync(scratch, { recursive: true, force: true });
}
