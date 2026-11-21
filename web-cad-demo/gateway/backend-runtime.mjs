import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BackendReleaseError, validateBackendRelease } from './backend-release.mjs';
import { validatePiSdkRelease } from './pi-sdk-release.mjs';
let activePiRuntime = null;
let activeDiscreteRuntime = null;
let activeMeshRuntime = null;
export function backendPiRuntime() { return activePiRuntime ? { ...activePiRuntime, cliArgs: [...activePiRuntime.cliArgs] } : null; }
export function backendDiscreteRuntime() { return activeDiscreteRuntime ? structuredClone(activeDiscreteRuntime) : null; }
export function backendMeshRuntime() { return activeMeshRuntime ? structuredClone(activeMeshRuntime) : null; }
export function backendChildArgs(environment = process.env) {
    const root = environment.CAD_BACKEND_RELEASE_DIR;
    if (!root)
        return [];
    return ['--import', pathToFileURL(path.join(root, 'runtime/gateway/backend-child-preflight.mjs')).href];
}
export function backendWorkerOptions() { return process.env.CAD_BACKEND_RELEASE_DIR ? { execArgv: backendChildArgs(), env: { ...process.env, CAD_BACKEND_CHILD_ROLE: 'query-worker' } } : {}; }
export function backendChildEnvironment(environment = process.env, role = 'mcp') {
    const keys = ['CAD_BACKEND_RELEASE_DIR', 'CAD_BACKEND_RELEASE_ID', 'CAD_BACKEND_MANIFEST_SHA256', 'CAD_APPLICATION_ROOT'];
    return { ...Object.fromEntries(keys.filter(key => environment[key]).map(key => [key, environment[key]])), ...(environment.CAD_BACKEND_RELEASE_DIR ? { CAD_BACKEND_CHILD_ROLE: role } : {}) };
}
export function backendRuntimeInfo(codeRoot) {
    activePiRuntime = null;
    activeDiscreteRuntime = null;
    activeMeshRuntime = null;
    const releaseId = process.env.CAD_BACKEND_RELEASE_ID;
    const credentials = ['CAD_BACKEND_RELEASE_ID', 'CAD_BACKEND_RELEASE_DIR', 'CAD_BACKEND_MANIFEST_SHA256'];
    if (!credentials.some(key => process.env[key]))
        return { mode: 'workspace-source', releaseId: null, nodeVersion: process.versions.node };
    if (!credentials.every(key => process.env[key]))
        throw new BackendReleaseError('BACKEND_RELEASE_INVALID', '后台固定版本凭据不完整，不能回退工作区模式。');
    const root = process.env.CAD_BACKEND_RELEASE_DIR, expected = root && path.join(root, 'runtime');
    if (!expected || fs.realpathSync(codeRoot) !== fs.realpathSync(expected))
        throw new BackendReleaseError('BACKEND_RELEASE_INVALID', '后台入口不属于所选代码快照。');
    const release = validateBackendRelease(root, { expectedManifestSha256: process.env.CAD_BACKEND_MANIFEST_SHA256 });
    if (release.releaseId !== releaseId)
        throw new BackendReleaseError('BACKEND_RELEASE_INVALID', '后台运行版本与所选快照不一致。');
    if (release.sdk)
        activePiRuntime = validatePiSdkRelease(path.join(root, 'pi-sdk'), release.sdk, { verifyFiles: false });
    if(release.native?.profiles.discrete){const profile=release.native.profiles.discrete;activeDiscreteRuntime={workerPath:path.join(root,'native/discrete',profile.roles.discrete),runtimePath:path.join(root,'native/discrete'),files:profile.files,distributionQualified:false};}
    if(release.native?.profiles.mesh){const profile=release.native.profiles.mesh;activeMeshRuntime={workerPath:path.join(root,'native/mesh',profile.roles.mesh),runtimePath:path.join(root,'native/mesh'),files:profile.files};}
    return { mode: 'project-code-snapshot', releaseId, sourceSha256: release.sourceSha256, manifestSha256: release.manifestSha256, verifiedAt: new Date().toISOString(), nodeVersion: process.versions.node, scope: release.sdk ? 'project-code-native-pi-sdk-v1' : release.native ? 'project-code-and-native-pe-v1' : 'project-code-only', externalDependencies: release.scope.external, ...(release.native ? { nativeRuntime: { sha256: release.native.sha256, importPolicy: release.native.importPolicy, ...(activeDiscreteRuntime?{distributionQualified:false,licenseRoute:'GPL-3.0-or-later'}:{}), profiles: Object.fromEntries(Object.entries(release.native.profiles).map(([name, profile]) => [name, { files: profile.files.length, bytes: profile.files.reduce((n, file) => n + file.bytes, 0) }])) } } : {}), ...(activePiRuntime ? { piSdk: { version: activePiRuntime.version, manifestSha256: activePiRuntime.manifestSha256, files: activePiRuntime.files, bytes: activePiRuntime.bytes, packages: activePiRuntime.packages } } : {}) };
}
