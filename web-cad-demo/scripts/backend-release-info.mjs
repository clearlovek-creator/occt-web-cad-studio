import { selectBackendRelease } from '../gateway/backend-release.mjs';
const [root, id] = process.argv.slice(2);
if (!root)
    throw Error('Backend release root is required');
const release = selectBackendRelease(root, id);
console.log(JSON.stringify({ releaseId: release.releaseId, directory: release.directory, manifestSha256: release.manifestSha256, sourceSha256: release.sourceSha256, mode: release.mode, scope: release.scope }));
