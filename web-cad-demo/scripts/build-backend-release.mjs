import path from 'node:path';
import { createBackendRelease } from '../gateway/backend-release.mjs';
const workspace = path.resolve(import.meta.dirname, '..'), args = process.argv.slice(2);
let releaseRoot = path.join(workspace, '.backend-releases'), nativeRuntime = true, piSdk = true;
const seen = new Set();
for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key))
        throw Error('Duplicate backend build argument');
    seen.add(key);
    if (key === '--project-code-only') {
        nativeRuntime = false;
        piSdk = false;
    }
    else if (key === '--external-pi-sdk')
        piSdk = false;
    else if (key === '--pi-sdk-root' && args[i + 1] && !args[i + 1].startsWith('--'))
        piSdk = { sourceRoot: path.resolve(args[++i]) };
    else if (key === '--release-root' && args[i + 1] && !args[i + 1].startsWith('--'))
        releaseRoot = path.resolve(args[++i]);
    else
        throw Error('Usage: build-backend-release.mjs [--release-root directory] [--pi-sdk-root directory] [--external-pi-sdk | --project-code-only]');
}
if((seen.has('--project-code-only')&&(seen.has('--external-pi-sdk')||seen.has('--pi-sdk-root')))||(seen.has('--external-pi-sdk')&&seen.has('--pi-sdk-root')))throw Error('Backend build modes cannot be combined.');
const release = createBackendRelease({ workspace, releaseRoot, nativeRuntime, piSdk });
console.log(JSON.stringify({ ok: true, releaseId: release.releaseId, directory: release.directory, manifestSha256: release.manifestSha256, sourceSha256: release.sourceSha256, mode: release.mode, scope: release.scope, ...(release.native ? { nativeSha256: release.native.sha256 } : {}), ...(release.sdk ? { piSdkVersion: release.sdk.sdkVersion, piSdkManifestSha256: release.sdk.manifest.sha256 } : {}) }));
