import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
const [directory, mode, data] = process.argv.slice(2), manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'));
const load = file => import(pathToFileURL(path.join(directory, 'runtime/gateway', file)).href);
if (mode === 'quality' || mode === 'artifact') {
    const job = JSON.parse(fs.readFileSync(path.join(data, 'job.json'), 'utf8'));
    if (mode === 'quality') {
        const { MeshQualityQueryPool } = await load('mesh-quality-pool.mjs'), pool = new MeshQualityQueryPool();
        try {
            const result = await pool.query({ file: path.join(data, 'mesh-jobs', job.documentId, job.jobId, 'quality.json'), job, input: { issue: 'all', limit: 1 } });
            console.log(JSON.stringify({ mode, total: result.total, build: pool.status().lastBuild, releaseId: manifest.releaseId }));
        }
        finally {
            await pool.close();
        }
    }
    else {
        const { MeshArtifactPool } = await load('mesh-artifact-pool.mjs'), pool = new MeshArtifactPool({ dataDir: data });
        try {
            const result = await pool.execute({ operation: 'read', job });
            console.log(JSON.stringify({ mode, status: result.mesh.admission.status, releaseId: manifest.releaseId }));
        }
        finally {
            await pool.close();
        }
    }
}
else if (mode === 'mcp') {
    const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, protocolVersion: 1, gateway: true, worker: true, capabilities: { nativeGeometry: null } })); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { CadMcpProcessClient } = await load('cad-mcp-process-client.mjs'), serverPath = path.join(directory, 'runtime/gateway/cad-mcp-server.mjs'), client = new CadMcpProcessClient({ serverPath, apiRoot: `http://127.0.0.1:${server.address().port}/api`, cwd: data });
    try {
        await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'snapshot-test', version: '1' } }, { readOnly: true });
        client.notify('notifications/initialized');
        const result = await client.request('tools/list', {}, { readOnly: true });
        console.log(JSON.stringify({ mode, hasBox: result.tools.some(tool => tool.name === 'primitive__box'), serverPath, releaseId: manifest.releaseId }));
    }
    finally {
        await client.stop();
        await new Promise(resolve => server.close(resolve));
    }
}
else if (mode === 'pi') {
    const { PiRpcSession } = await load('pi-rpc-runtime.mjs'), sessionRoot = path.join(data, 'pi-test'), session = new PiRpcSession({ sessionId: 'pinned', documentId: 'default', cliPath: fileURLToPath(new URL('./pi-backend-snapshot-fixture.mjs', import.meta.url)), extensionPath: path.join(directory, 'runtime/gateway/pi-cad-mcp-extension.mjs'), cwd: data, sessionRoot, agentConfigDir: path.join(data, 'config') });
    try {
        await session.start();
        const marker = JSON.parse(fs.readFileSync(path.join(sessionRoot, 'snapshot-paths.json'), 'utf8'));
        console.log(JSON.stringify({ mode, ...marker, releaseId: manifest.releaseId }));
    }
    finally {
        await session.dispose();
    }
}
else
    throw Error('Unsupported snapshot probe');
