import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), directory = args[args.indexOf('--session-dir') + 1];
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'gateway-origin.json'), JSON.stringify({ apiRoot: process.env.CAD_GEOMETRY_API_URL }));
await import('./pi-rpc-fixture.mjs');
