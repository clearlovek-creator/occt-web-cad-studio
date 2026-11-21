import path from 'node:path';
import { selectBackendRelease } from '../../gateway/backend-release.mjs';
/** Explicit artifact acceptance only. An invalid requested release must never
 * fall back to workspace source and turn a release test into a source test. */
export function backendTestArguments(workspace, environment = process.env) {
    const releaseRoot = environment.CAD_TEST_BACKEND_RELEASE_ROOT;
    if (!releaseRoot)
        return [path.join(workspace, 'gateway/server.mjs')];
    const release = selectBackendRelease(releaseRoot, environment.CAD_TEST_BACKEND_RELEASE_ID);
    return [path.join(release.directory, 'runtime/scripts/backend-server.mjs'), '--release', release.directory, '--workspace', workspace];
}
