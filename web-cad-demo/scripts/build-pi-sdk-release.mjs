import path from 'node:path';
import { createPiSdkRelease, validatePiSdkRelease } from '../gateway/pi-sdk-release.mjs';
const [source, output] = process.argv.slice(2);
if (!source || !output || process.argv.length !== 4)
    throw Error('Usage: build-pi-sdk-release.mjs source-directory output-directory');
const directory = path.resolve(output), binding = createPiSdkRelease(directory, { sourceRoot: path.resolve(source) }), runtime = validatePiSdkRelease(directory, binding);
console.log(JSON.stringify({ ok: true, directory, binding, ...runtime }));
