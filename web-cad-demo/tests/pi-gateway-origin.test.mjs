import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { stopTestChild } from './helpers/stop-test-child.mjs';
test('Gateway binds Pi CAD tools to its own port and ignores an inherited external API root', async () => {
    const root = path.resolve(import.meta.dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-pi-origin-')), socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const child = spawn(process.execPath, ['gateway/server.mjs'], { cwd: root, env: { ...process.env, GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: data, CAD_GEOMETRY_API_URL: 'http://127.0.0.1:1/api', PI_CLI_PATH: path.join(root, 'tests/fixtures/pi-gateway-origin-fixture.mjs'), PI_CLI_CWD: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Origin Gateway startup timeout')), 15000);
            child.once('error', reject);
            child.stderr.on('data', () => { });
            child.stdout.on('data', bytes => {
                if (String(bytes).includes('Geometry gateway ready')) {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });
        const response = await fetch(`http://127.0.0.1:${port}/api/pi/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'origin', documentId: 'default' }), signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 200);
        const marker = JSON.parse(fs.readFileSync(path.join(data, 'pi-sessions/origin/gateway-origin.json'), 'utf8'));
        assert.equal(marker.apiRoot, `http://127.0.0.1:${port}/api`);
    }
    finally {
        await stopTestChild(child);
        assert.equal(path.dirname(data), path.resolve(os.tmpdir()));
        assert.match(path.basename(data), /^cad-pi-origin-/);
        fs.rmSync(data, { recursive: true, force: true });
    }
});
