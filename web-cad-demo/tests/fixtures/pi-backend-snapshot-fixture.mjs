import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Deterministic transport only: imports the real owned adapter, never an LLM.
const args = process.argv.slice(2), directory = args[args.indexOf('--session-dir') + 1], extension = args[args.indexOf('--extension') + 1];
const adapter = await import(pathToFileURL(extension).href);
if (typeof adapter.default !== 'function')
    throw Error('Snapshot adapter missing');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'snapshot-paths.json'), JSON.stringify({ extension, mcp: process.env.CAD_MCP_SERVER_PATH, role: process.env.CAD_BACKEND_CHILD_ROLE }));
await import('./pi-rpc-fixture.mjs');
