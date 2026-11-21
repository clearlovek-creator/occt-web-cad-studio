import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBackendRelease } from '../gateway/backend-release.mjs';
import { validateNativeRuntime } from '../gateway/native-runtime-release.mjs';
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
    if (!['--release', '--workspace'].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i]))
        throw Error('Invalid backend runtime argument');
    options[args[i]] = args[i + 1];
}
if (!options['--release'] || !options['--workspace'])
    throw Error('Backend release and application workspace are required');
const release = validateBackendRelease(options['--release']), workspace = fs.realpathSync(path.resolve(options['--workspace']));
if (fs.realpathSync(import.meta.dirname) !== fs.realpathSync(path.join(release.directory, 'runtime/scripts')))
    throw Error('Backend launcher must execute from the selected snapshot');
process.env.CAD_APPLICATION_ROOT = workspace;
process.env.CAD_BACKEND_RELEASE_DIR = release.directory;
process.env.CAD_BACKEND_RELEASE_ID = release.releaseId;
process.env.CAD_BACKEND_MANIFEST_SHA256 = release.manifestSha256;
if (release.native) {
    const native = validateNativeRuntime(path.join(release.directory, 'native'), release.native, { verifyFiles: false });
    Object.assign(process.env, { GEOMETRY_WORKER_PATH: native.roles.geometry, MESH_WORKER_PATH: native.roles.mesh, GEOMETRY_SOURCE_INSPECTOR_PATH: native.roles.inspector, CAD_NATIVE_LOCK_PATH: native.roles.lock, CAD_NATIVE_SWAP_PATH: native.roles.swap, CAD_NATIVE_GEOMETRY_BIN: native.geometryBin, GMSH_BIN: native.meshBin });
    for(const name of ['DISCRETE_SURFACE_WORKER_PATH','DISCRETE_SURFACE_RUNTIME_BIN','DISCRETE_SURFACE_LICENSE_INPUTS'])delete process.env[name];
    if(native.roles.discrete)Object.assign(process.env,{DISCRETE_SURFACE_WORKER_PATH:native.roles.discrete,DISCRETE_SURFACE_RUNTIME_BIN:native.discreteBin});
}
if(release.sdk)process.env.CAD_PI_SDK_ROOT=path.join(release.directory,'pi-sdk');
await import(pathToFileURL(path.join(release.directory, 'runtime/gateway/server.mjs')).href);
