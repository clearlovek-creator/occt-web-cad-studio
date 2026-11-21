import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createBackendRelease, validateBackendRelease, selectBackendRelease, backendEnvironment } from '../gateway/backend-release.mjs';
import { backendRuntimeInfo } from '../gateway/backend-runtime.mjs';
import { copyCertifiedFiles, fileInventory, hashFile } from '../gateway/frontend-release.mjs';
import { createArtifactFixture } from './helpers/mesh-artifact-fixture.mjs';
import { stopTestChild } from './helpers/stop-test-child.mjs';
import { backendTestArguments } from './helpers/backend-test-runtime.mjs';
const root = path.resolve(import.meta.dirname, '..');
const children = new Set();
function track(child) {
    children.add(child);
    child.once('exit', () => children.delete(child));
    child.once('error', () => {
        if (!child.pid)
            children.delete(child);
    });
    return child;
}
async function fixture(run) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-backend-release-')), workspace = path.join(scratch, 'workspace-代码'), releases = path.join(scratch, 'releases-发布');
    const files = [];
    for (const folder of ['gateway', 'shared'])
        for (const item of fileInventory(path.join(root, folder)))
            if (item.file.endsWith('.mjs'))
                files.push({ ...item, file: folder + '/' + item.file });
    const file = 'scripts/backend-server.mjs', target = path.join(root, file);
    files.push({ file, bytes: fs.statSync(target).size, sha256: hashFile(target) });
    copyCertifiedFiles(root, workspace, files);
    fs.writeFileSync(path.join(workspace, '.env'), 'PRIVATE_SNAPSHOT_SENTINEL=must-not-ship');
    fs.mkdirSync(path.join(workspace, '.data'));
    fs.writeFileSync(path.join(workspace, '.data', 'providers.json'), 'private-provider-sentinel');
    try {
        await run({ scratch, workspace, releases, build: () => createBackendRelease({ workspace, releaseRoot: releases, nativeRuntime: false,piSdk:false }) });
    }
    finally {
        assert.equal(children.size, 0, 'Preserve private snapshots/data until every test-owned process has actually exited.');
        assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
        assert.match(path.basename(scratch), /^cad-backend-release-/);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}
async function probe(release, mode, data, extra = {}) {
    const env = { ...backendEnvironment(process.env), CAD_BACKEND_RELEASE_DIR: release.directory, CAD_BACKEND_RELEASE_ID: release.releaseId, CAD_BACKEND_MANIFEST_SHA256: release.manifestSha256, ...extra }, child = track(spawn(process.execPath, [path.join(root, 'tests/fixtures/backend-snapshot-probe.mjs'), release.directory, mode, data], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    try {
        return await new Promise((resolve, reject) => {
            let output = '', errors = '';
            const timer = setTimeout(() => reject(Error('Backend probe timeout ' + errors)), 30000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.stdout.on('data', bytes => {
                output += bytes;
                if (Buffer.byteLength(output) > 32768)
                    reject(Error('Probe output limit'));
            });
            child.stderr.on('data', bytes => errors = (errors + bytes).slice(-16384));
            child.once('exit', code => {
                clearTimeout(timer);
                if (code !== 0)
                    reject(Error(`Probe ${mode} ${code}: ${errors}`));
                else
                    try {
                        resolve(JSON.parse(output));
                    }
                    catch (error) {
                        reject(error);
                    }
            });
        });
    }
    finally {
        await stopTestChild(child);
    }
}
test('project snapshots are self-contained MJS, versioned, selected and free of environment/data files', async () => fixture(async (f) => {
    const release = f.build(), selected = selectBackendRelease(f.releases);
    assert.equal(selected.releaseId, release.releaseId);
    assert.equal(release.nodeVersion, process.versions.node);
    assert.equal(release.mode, 'project-code-snapshot');
    assert.ok(release.scope.external.includes('pi-sdk'));
    assert.ok(release.files.every(file => file.file.startsWith('runtime/')));
    assert.equal(release.files.some(file => /\.env|providers\.json|node_modules|\.data/.test(file.file)), false);
    assert.equal(fs.existsSync(path.join(release.directory, 'runtime/.env')), false);
    assert.equal(fs.existsSync(path.join(release.directory, 'runtime/.data')), false);
    assert.equal(release.manifestSha256, hashFile(path.join(release.directory, 'release.json')));
    assert.equal(validateBackendRelease(release.directory).sourceSha256, release.sourceSha256);
    assert.deepEqual(backendTestArguments(root, {}), [path.join(root, 'gateway/server.mjs')]);
    assert.deepEqual(backendTestArguments(root, { CAD_TEST_BACKEND_RELEASE_ROOT: f.releases }), [path.join(release.directory, 'runtime/scripts/backend-server.mjs'), '--release', release.directory, '--workspace', root]);
    assert.throws(() => backendTestArguments(root, { CAD_TEST_BACKEND_RELEASE_ROOT: path.join(f.scratch, 'missing-release-root') }), { code: 'BACKEND_RELEASE_MISSING' });
    const manifestPath = path.join(release.directory, 'release.json'), bytes = fs.readFileSync(manifestPath), manifest = JSON.parse(bytes);
    manifest.nodeVersion = '0.0.0';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => validateBackendRelease(release.directory), /Node/);
    fs.writeFileSync(manifestPath, bytes);
}));
test('invalid syntax is rejected without executing code or changing the prior selected release', async () => fixture(async (f) => {
    const release = f.build();
    fs.writeFileSync(path.join(f.workspace, 'gateway', 'mesh-quality-thread.mjs'), 'const incomplete = ;');
    assert.throws(() => f.build(), /语法检查失败/);
    assert.equal(selectBackendRelease(f.releases).releaseId, release.releaseId);
    assert.equal(fs.readdirSync(f.releases).some(name => name.startsWith('.pending-')), false);
}));
test('source links, unbundled bare imports, corrupt selection and path traversal are rejected', async () => fixture(async (f) => {
    assert.throws(() => selectBackendRelease(f.releases), { code: 'BACKEND_RELEASE_MISSING' });
    const release = f.build(), entry = path.join(f.workspace, 'gateway', 'mesh-quality-thread.mjs'), before = fs.readFileSync(entry);
    fs.writeFileSync(entry, "import 'not-a-pinned-dependency';");
    assert.throws(() => f.build(), /未打包/);
    fs.writeFileSync(entry, "import {\n missing\n} from './not-in-the-snapshot.mjs';");
    assert.throws(() => f.build(), /依赖不在/);
    fs.writeFileSync(entry, "export {\n missing\n} from './not-in-the-snapshot.mjs';");
    assert.throws(() => f.build(), /依赖不在/);
    assert.equal(selectBackendRelease(f.releases).releaseId, release.releaseId);
    fs.writeFileSync(entry, "// import 'not-a-real-dependency';\nthrow Error('PARSER_MUST_NOT_EVALUATE_MODULES');");
    assert.equal(f.build().mode, 'project-code-snapshot', 'Comments are not dependencies; valid module bodies must not execute during build.');
    fs.writeFileSync(entry, before);
    const link = path.join(f.workspace, 'shared', 'linked.mjs');
    fs.linkSync(entry, link);
    assert.throws(() => f.build());
    fs.unlinkSync(link);
    assert.throws(() => selectBackendRelease(f.releases, '../escape'));
    fs.writeFileSync(path.join(f.releases, 'selected.json'), 'broken');
    assert.throws(() => selectBackendRelease(f.releases));
    assert.equal(validateBackendRelease(release.directory).releaseId, release.releaseId);
}));
test('snapshot tampering, additions and changed manifest identity fail closed', async () => fixture(async (f) => {
    const release = f.build(), file = path.join(release.directory, 'runtime/shared/mesh-statistics.mjs'), before = fs.readFileSync(file);
    fs.appendFileSync(file, '\n// unexpected modification');
    assert.throws(() => validateBackendRelease(release.directory));
    fs.writeFileSync(file, before);
    fs.writeFileSync(path.join(release.directory, 'runtime/shared/unknown.mjs'), 'export {};');
    assert.throws(() => validateBackendRelease(release.directory));
    fs.unlinkSync(path.join(release.directory, 'runtime/shared/unknown.mjs'));
    fs.appendFileSync(path.join(release.directory, 'release.json'), ' ');
    assert.throws(() => validateBackendRelease(release.directory, { expectedManifestSha256: release.manifestSha256 }), /清单/);
}));
test('environment inheritance cannot inject an old release, Node preload or module search path', () => {
    const value = backendEnvironment({ CAD_BACKEND_RELEASE_DIR: 'wrong', CAD_NATIVE_LOCK_PATH: 'wrong', CAD_NATIVE_GEOMETRY_BIN: 'wrong', CAD_APPLICATION_ROOT: 'wrong', NODE_OPTIONS: '--import private', NODE_PATH: 'wrong', NODE_V8_COVERAGE: 'wrong', GEOMETRY_DATA_DIR: 'data', PI_CLI_PATH: 'external-sdk', PATH: 'runtime', PROVIDER_TEST_KEY: 'retained-for-backend-only' });
    assert.deepEqual(Object.keys(value).sort(), ['GEOMETRY_DATA_DIR', 'PATH', 'PI_CLI_PATH', 'PROVIDER_TEST_KEY']);
});
test('incomplete backend runtime credentials cannot be misreported as workspace mode', () => {
    const keys = ['CAD_BACKEND_RELEASE_ID', 'CAD_BACKEND_RELEASE_DIR', 'CAD_BACKEND_MANIFEST_SHA256'], saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
        for (const key of keys)
            delete process.env[key];
        assert.equal(backendRuntimeInfo(root).mode, 'workspace-source');
        for (const key of keys) {
            process.env[key] = 'incomplete';
            assert.throws(() => backendRuntimeInfo(root), { code: 'BACKEND_RELEASE_INVALID' });
            delete process.env[key];
        }
    }
    finally {
        for (const key of keys)
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
    }
});
test('new quality/artifact workers and CAD/Pi adapters keep the snapshot after workspace scripts change', async () => fixture(async (f) => {
    const release = f.build(), data = path.join(f.scratch, 'data'), saved = createArtifactFixture(data, 100);
    fs.writeFileSync(path.join(data, 'job.json'), JSON.stringify(saved.job));
    for (const file of ['gateway/mesh-quality-thread.mjs', 'gateway/mesh-artifact-thread.mjs', 'gateway/cad-mcp-server.mjs', 'gateway/pi-cad-mcp-extension.mjs', 'shared/mesh-statistics.mjs'])
        fs.writeFileSync(path.join(f.workspace, file), "throw Error('UNPUBLISHED_WORKSPACE_CODE');");
    assert.equal((await probe(release, 'quality', data)).total, 100);
    assert.equal((await probe(release, 'artifact', data)).status, 'accepted');
    const mcp = await probe(release, 'mcp', data);
    assert.equal(mcp.hasBox, true);
    assert.ok(mcp.serverPath.startsWith(release.directory + path.sep));
    const pi = await probe(release, 'pi', data);
    assert.ok(pi.extension.startsWith(release.directory + path.sep));
    assert.ok(pi.mcp.startsWith(release.directory + path.sep));
    assert.equal(pi.role, 'pi-external');
}));
test('child preflight rejects damaged snapshot helpers instead of falling back to intact workspace code', async () => fixture(async (f) => {
    const release = f.build(), data = path.join(f.scratch, 'data'), saved = createArtifactFixture(data, 1);
    fs.writeFileSync(path.join(data, 'job.json'), JSON.stringify(saved.job));
    fs.appendFileSync(path.join(release.directory, 'runtime/shared/mesh-statistics.mjs'), '\n// damaged snapshot');
    await assert.rejects(probe(release, 'quality', data), /快照|代码|变化|不一致/);
    await assert.rejects(probe(release, 'artifact', data));
    await assert.rejects(probe(release, 'mcp', data));
    await assert.rejects(probe(release, 'pi', data));
    assert.equal(fs.existsSync(path.join(data, 'mesh-jobs', saved.job.documentId, saved.job.jobId, 'quality-pages')), false);
    assert.equal(fs.existsSync(path.join(data, 'pi-test', 'snapshot-paths.json')), false);
}));
test('snapshot bootstrap serves real CAD/mesh APIs and starts Pi with the same fixed adapters', async () => fixture(async (f) => {
    const release = f.build(), data = path.join(f.scratch, 'api-data'), saved = createArtifactFixture(data, 100), qualityBefore = fs.readFileSync(saved.store.qualityOutput(saved.job));
    // This private copy is the snapshot's build input, never the user's source.
    for (const file of ['gateway/server.mjs', 'gateway/mesh-quality-thread.mjs', 'gateway/mesh-artifact-thread.mjs', 'gateway/pi-cad-mcp-extension.mjs'])
        fs.writeFileSync(path.join(f.workspace, file), "throw Error('UNPUBLISHED_SOURCE_MUST_NOT_RUN');");
    const socket = net.createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const api = `http://127.0.0.1:${port}/api`, child = track(spawn(process.execPath, [path.join(release.directory, 'runtime/scripts/backend-server.mjs'), '--release', release.directory, '--workspace', root], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...backendEnvironment(process.env), GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: data, PI_CLI_PATH: path.join(root, 'tests/fixtures/pi-backend-snapshot-fixture.mjs'), PI_CLI_CWD: root } }));
    const request = async (route, body) => { const response = await fetch(api + route, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) }), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
    let ready = false;
    try {
        await new Promise((resolve, reject) => {
            let text = '', errors = '';
            const timer = setTimeout(() => done(Error('Snapshot API startup timeout: ' + errors)), 15000);
            const exited = code => done(Error(`Snapshot API exited ${code}: ${errors}`));
            function done(error) {
                clearTimeout(timer);
                child.removeListener('exit', exited);
                child.removeListener('error', done);
                if (error)
                    reject(error);
                else
                    resolve();
            }
            child.once('error', done);
            child.once('exit', exited);
            child.stderr.on('data', bytes => errors = (errors + bytes).slice(-16384));
            child.stdout.on('data', bytes => {
                text = (text + bytes).slice(-16384);
                if (text.includes('Geometry gateway ready'))
                    done();
            });
        });
        ready = true;
        const health = await request('/health');
        assert.equal(health.backendRelease.releaseId, release.releaseId);
        assert.equal(health.backendRelease.manifestSha256, release.manifestSha256);
        assert.equal(health.backendRelease.scope, 'project-code-only');
        assert.equal(health.storage.writer.ownerPid, child.pid);
        const summary = await request('/commands', { documentId: 'default', operation: 'document.summary' });
        assert.equal(summary.ok, true);
        assert.equal(summary.bodies.length, 0);
        const quality = await request(`/mesh/jobs/${saved.job.jobId}/quality?issue=all&limit=1`);
        assert.equal(quality.total, 100);
        assert.equal(quality.cells.length, 1);
        const result = await request(`/mesh/jobs/${saved.job.jobId}`);
        assert.equal(result.ok, true);
        assert.deepEqual(fs.readFileSync(saved.store.qualityOutput(saved.job)), qualityBefore);
        const session = await request('/pi/sessions', { documentId: 'default', sessionId: 'snapshot-api' });
        assert.equal(session.ok, true);
        const marker = JSON.parse(fs.readFileSync(path.join(data, 'pi-sessions/snapshot-api/snapshot-paths.json'), 'utf8'));
        assert.equal(marker.extension, path.join(release.directory, 'runtime/gateway/pi-cad-mcp-extension.mjs'));
        assert.equal(marker.mcp, path.join(release.directory, 'runtime/gateway/cad-mcp-server.mjs'));
        assert.equal(marker.role, 'pi-external');
        const final = await request('/commands', { documentId: 'default', operation: 'document.summary' });
        assert.equal(final.stateToken, summary.stateToken, 'Transport checks must not create CAD geometry or call a paid model.');
    }
    finally {
        if (ready && child.exitCode === null && child.signalCode === null) {
            const control = JSON.parse(fs.readFileSync(path.join(data, '.gateway-control.json'), 'utf8'));
            assert.equal(control.ownerPid, child.pid);
            const ended = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(Error('Snapshot Gateway has not confirmed graceful exit; preserve its data.')), 25000);
                child.once('exit', code => {
                    clearTimeout(timer);
                    if (code === 0)
                        resolve();
                    else
                        reject(Error('Snapshot Gateway shutdown exit ' + code));
                });
            });
            // Observe this same process even if the stop response is interrupted.
            await fetch(api + '/runtime/shutdown', { method: 'POST', headers: { 'x-cad-shutdown-token': control.token }, signal: AbortSignal.timeout(3000) }).then(response => assert.equal(response.status, 202)).catch(() => { });
            await ended;
            const report = JSON.parse(fs.readFileSync(path.join(data, '.gateway-last-shutdown.json'), 'utf8'));
            assert.equal(report.state, 'complete');
            assert.equal(report.ownerInstanceId, control.ownerInstanceId);
        }
        else
            await stopTestChild(child);
    }
}));
