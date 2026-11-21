import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { atomicJson, assertRegularDirectory, copyCertifiedFiles, fileInventory, hashFile, readSmallJson } from './frontend-release.mjs';
import { createNativeRuntime, nativeRuntimeInputs, validateNativeRuntime } from './native-runtime-release.mjs';
import { createPiSdkRelease, validatePiSdkRelease } from './pi-sdk-release.mjs';
const ID = /^backend-[0-9]{13}-[a-f0-9-]{36}$/, HASH = /^[a-f0-9]{64}$/;
const REQUIRED = ['runtime/scripts/backend-server.mjs', 'runtime/gateway/server.mjs', 'runtime/gateway/backend-release.mjs', 'runtime/gateway/backend-runtime.mjs', 'runtime/gateway/backend-child-preflight.mjs', 'runtime/gateway/mesh-quality-thread.mjs', 'runtime/gateway/mesh-artifact-thread.mjs', 'runtime/gateway/pi-rpc-runtime.mjs', 'runtime/gateway/pi-cad-mcp-extension.mjs', 'runtime/gateway/cad-mcp-server.mjs'];
export class BackendReleaseError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
const fail = message => new BackendReleaseError('BACKEND_RELEASE_INVALID', message);
const sum = files => crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
const scope = Object.freeze({ owned: ['gateway-mjs', 'shared-mjs', 'query-workers', 'cad-mcp-adapter'], external: ['pi-sdk', 'native-workers-and-helpers', 'system-runtime', 'user-resources-and-configuration'] });
const nativeScope = Object.freeze({ owned: [...scope.owned, 'native-pe-import-closure'], external: ['pi-sdk', 'system-runtime', 'user-resources-and-configuration', 'dynamic-native-plugins'] });
const sdkScope = Object.freeze({ owned: [...nativeScope.owned, 'pi-sdk-source-lock-closure'], external: ['system-runtime', 'user-resources-and-configuration', 'dynamic-native-plugins'] });
function bounded(files) {
    if (files.length > 2048 || files.reduce((n, file) => n + file.bytes, 0) > 32 * 1024 * 1024)
        throw fail('后台代码快照超过 2048 文件或 32 MiB 预算。');
    return files;
}
function sourceFiles(workspace) {
    const files = [];
    for (const folder of ['gateway', 'shared'])
        for (const item of fileInventory(path.join(workspace, folder)))
            if (item.file.endsWith('.mjs'))
                files.push({ ...item, file: folder + '/' + item.file });
    const script = 'scripts/backend-server.mjs', file = path.join(workspace, script), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw fail('后台启动入口不是普通文件。');
    files.push({ file: script, bytes: stat.size, sha256: hashFile(file) });
    return bounded(files.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
function checkSyntax(runtime, files) {
    // Parse without linking/evaluating. The engine's static module requests cover
    // multiline imports/re-exports; text matching can miss valid ESM syntax.
    const script = `
        import fs from 'node:fs';
        import path from 'node:path';
        import vm from 'node:vm';
        import {isBuiltin} from 'node:module';
        const files=JSON.parse(fs.readFileSync(0,'utf8')),owned=new Set(files);
        for(const file of files){
            try{
                const module=new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{identifier:file});
                for(const name of module.dependencySpecifiers){
                    if(isBuiltin(name))continue;
                    if(!name.startsWith('.'))throw Error('后台项目代码出现未打包的模块依赖：'+name);
                    if(!owned.has(path.resolve(path.dirname(file),name)))throw Error('后台模块依赖不在代码快照中：'+name);
                }
            }catch(error){process.stderr.write(JSON.stringify({file,error:String(error.message).slice(0,300)}));process.exit(1);}
        }
    `;
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--max-old-space-size=256', '--input-type=module', '-e', script], { input: JSON.stringify(files.map(file => path.join(runtime, file.file))), encoding: 'utf8', timeout: 30000, maxBuffer: 8192, windowsHide: true, env: { ...backendEnvironment(process.env), NODE_NO_WARNINGS: '1' } });
    if (result.error || result.status !== 0)
        throw fail('后台模块语法检查失败或依赖校验不通过，未发布候选：' + String(result.stderr || result.error?.message || result.status).slice(0, 1000));
}
export function createBackendRelease({ workspace, releaseRoot, select = true, nativeRuntime = true, piSdk = true }) {
    if (piSdk && !nativeRuntime)
        throw fail('SDK 封存需要完整原生发布；兼容源码模式须显式关闭 SDK。');
    workspace = fs.realpathSync(path.resolve(workspace));
    releaseRoot = path.resolve(releaseRoot);
    fs.mkdirSync(releaseRoot, { recursive: true });
    assertRegularDirectory(releaseRoot);
    const releaseId = 'backend-' + Date.now() + '-' + crypto.randomUUID(), staging = path.join(releaseRoot, '.pending-' + crypto.randomUUID()), directory = path.join(releaseRoot, releaseId);
    try {
        const before = sourceFiles(workspace);
        const runtime = path.join(staging, 'runtime');
        copyCertifiedFiles(workspace, runtime, before);
        atomicJson(path.join(runtime, 'package.json'), { private: true, type: 'module' });
        checkSyntax(runtime, before);
        if (JSON.stringify(sourceFiles(workspace)) !== JSON.stringify(before))
            throw fail('工作区在后台快照构建中发生变化，候选已拒绝。');
        const native = nativeRuntime ? createNativeRuntime(path.join(staging, 'native'), nativeRuntime === true ? nativeRuntimeInputs(workspace) : nativeRuntime) : null;
        const sdk = piSdk ? createPiSdkRelease(path.join(staging, 'pi-sdk'), piSdk === true ? { sourceRoot: process.env.PI_SDK_ROOT || path.resolve(workspace, '../pi') } : piSdk) : null;
        const files = bounded(fileInventory(staging, { exclude: ['native', 'pi-sdk'] })), manifest = { format: 'web-cad-backend-release', version: sdk ? 3 : native ? 2 : 1, releaseId, nodeVersion: process.versions.node, createdAt: new Date().toISOString(), mode: 'project-code-snapshot', scope: sdk ? sdkScope : native ? nativeScope : scope, sourceSha256: sum(files), files, ...(native ? { native } : {}), ...(sdk ? { sdk } : {}) };
        for (const file of REQUIRED)
            if (!files.some(item => item.file === file))
                throw fail('后台代码快照缺少必要入口：' + file);
        atomicJson(path.join(staging, 'release.json'), manifest);
        fs.renameSync(staging, directory);
        const result = validateBackendRelease(directory);
        if (select)
            atomicJson(path.join(releaseRoot, 'selected.json'), { format: 'web-cad-backend-selection', version: 1, releaseId });
        return result;
    }
    finally {
        if (path.dirname(staging) !== releaseRoot || !path.basename(staging).startsWith('.pending-'))
            throw fail('后台暂存清理位置无效。');
        if (fs.existsSync(staging)) {
            assertRegularDirectory(staging);
            fs.rmSync(staging, { recursive: true, force: true });
        }
    }
}
export function validateBackendRelease(directory, { expectedManifestSha256, verifyNative = true, verifySdk = true } = {}) {
    directory = path.resolve(directory);
    assertRegularDirectory(directory);
    const manifestPath = path.join(directory, 'release.json'), manifest = readSmallJson(manifestPath), manifestSha256 = hashFile(manifestPath);
    if (expectedManifestSha256 && manifestSha256 !== expectedManifestSha256)
        throw fail('后台发布清单在启动后发生变化。');
    if (manifest?.format !== 'web-cad-backend-release' || ![1, 2, 3].includes(manifest.version) || !ID.test(manifest.releaseId) || path.basename(directory) !== manifest.releaseId || manifest.mode !== 'project-code-snapshot' || manifest.nodeVersion !== process.versions.node || !HASH.test(manifest.sourceSha256) || JSON.stringify(manifest.scope) !== JSON.stringify(manifest.version === 3 ? sdkScope : manifest.version === 2 ? nativeScope : scope) || !Array.isArray(manifest.files) || Boolean(manifest.native) !== (manifest.version >= 2) || Boolean(manifest.sdk) !== (manifest.version === 3))
        throw fail('后台发布身份、Node 版本或范围无效。');
    const files = bounded(fileInventory(directory, { exclude: ['release.json', ...(manifest.version >= 2 ? ['native'] : []), ...(manifest.version === 3 ? ['pi-sdk'] : [])] }));
    if (JSON.stringify(files) !== JSON.stringify(manifest.files) || sum(files) !== manifest.sourceSha256)
        throw fail('后台代码缺失、增加或内容变化，未加载不一致版本。');
    for (const file of REQUIRED)
        if (!files.some(item => item.file === file))
            throw fail('后台快照缺少必要入口。');
    if (manifest.native)
        validateNativeRuntime(path.join(directory, 'native'), manifest.native, { verifyFiles: verifyNative });
    if (manifest.sdk)
        validatePiSdkRelease(path.join(directory, 'pi-sdk'), manifest.sdk, { verifyFiles: verifySdk });
    return { ...manifest, manifestSha256, directory };
}
export function selectBackendRelease(root, id) {
    root = path.resolve(root);
    if (!fs.existsSync(root))
        throw new BackendReleaseError('BACKEND_RELEASE_MISSING', '没有后台代码快照，请先运行 npm run build:backend。');
    assertRegularDirectory(root);
    if (!id) {
        const file = path.join(root, 'selected.json');
        if (!fs.existsSync(file))
            throw new BackendReleaseError('BACKEND_RELEASE_MISSING', '尚未选择后台代码快照，请先运行 npm run build:backend。');
        const selection = readSmallJson(file, 4096);
        if (selection.format !== 'web-cad-backend-selection' || selection.version !== 1)
            throw fail('后台版本选择记录无效。');
        id = selection.releaseId;
    }
    if (!ID.test(id || ''))
        throw fail('后台发布标识不合法。');
    return validateBackendRelease(path.join(root, id));
}
export function backendEnvironment(environment) { return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^CAD_(?:BACKEND_|NATIVE_|PI_SDK_)|^CAD_APPLICATION_ROOT$|^NODE_OPTIONS$|^NODE_PATH$|^NODE_V8_COVERAGE$/i.test(key))); }
