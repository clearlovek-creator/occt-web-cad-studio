import { validateBackendRelease, BackendReleaseError } from './backend-release.mjs';
const root = process.env.CAD_BACKEND_RELEASE_DIR, expected = process.env.CAD_BACKEND_MANIFEST_SHA256, id = process.env.CAD_BACKEND_RELEASE_ID;
if (!root || !expected || !id)
    throw new BackendReleaseError('BACKEND_RELEASE_INVALID', '后台子进程缺少固定版本凭据。');
// JS-only children never load OCCT/Gmsh; do not re-hash hundreds of MiB of
// native files on every query. The main startup certifies those separately.
const release = validateBackendRelease(root, { expectedManifestSha256: expected, verifyNative: false, verifySdk: process.env.CAD_BACKEND_CHILD_ROLE === 'pi-bundled' });
if (release.releaseId !== id)
    throw new BackendReleaseError('BACKEND_RELEASE_INVALID', '后台子进程版本与主进程不一致。');
