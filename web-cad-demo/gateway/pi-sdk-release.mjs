import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { atomicJson, assertRegularDirectory, copyCertifiedFiles, hashFile, readSmallJson } from './frontend-release.mjs';
export class PiSdkReleaseError extends Error {
    constructor(message) { super(message); this.name = 'PiSdkReleaseError'; this.code = 'PI_SDK_RELEASE_INVALID'; }
}
const fail = message => new PiSdkReleaseError(message);
const PACKAGE = /^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/, HASH = /^[a-f0-9]{64}$/;
const WORKSPACES = ['telemetry', 'ai', 'tui', 'agent', 'protocol', 'client', 'session-backends/sqlite-node', 'server', 'coding-agent'];
export const PI_SDK_LIMITS = Object.freeze({ files: 50000, bytes: 512 * 1024 * 1024, fileBytes: 64 * 1024 * 1024, packages: 512, entries: 150000, manifestBytes: 16 * 1024 * 1024 });
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort(cmp).map(key => [key, canonical(value[key])])) : value;
const relative = (root, file) => path.relative(root, file).replaceAll('\\', '/');
const within = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const forbidden = name => name.toLowerCase() === 'node_modules' || ['.git', '.pi', '.data', '.cache', 'coverage', '.npmrc', '.yarnrc', '.pnp.cjs'].includes(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name);
function regular(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > PI_SDK_LIMITS.fileBytes)
        throw fail('SDK 输入不是有界普通单链接文件。');
    return stat;
}
function certifiedJson(file, limit = 2 * 1024 * 1024) {
    const stat = regular(file);
    if (stat.size > limit)
        throw fail('SDK JSON 输入超限。');
    const bytes = fs.readFileSync(file);
    if (bytes.length > limit || bytes.length !== stat.size)
        throw fail('SDK JSON 在读取中变化。');
    let value;
    try {
        value = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw fail('SDK JSON 输入损坏。');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw fail('SDK JSON 必须为对象。');
    return { value, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function entries(directory, budget) {
    const handle = fs.opendirSync(directory), items = [];
    try {
        for (;;) {
            const item = handle.readSync();
            if (!item)
                break;
            if (++budget.entries > PI_SDK_LIMITS.entries)
                throw fail('SDK 目录清点超限。');
            items.push(item);
        }
    }
    finally {
        handle.closeSync();
    }
    return items.sort((a, b) => cmp(a.name, b.name));
}
function contentInventory(root, { workspace = false, budget = { entries: 0, files: 0, bytes: 0 } } = {}) {
    assertRegularDirectory(root);
    const files = [];
    const selected = new Set(['src', 'docs', 'examples', 'README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md', 'package.json', 'npm-shrinkwrap.json', 'containerization.md']);
    const walk = directory => {
        for (const entry of entries(directory, budget)) {
            if (forbidden(entry.name))
                continue;
            if (directory === root && workspace && !selected.has(entry.name))
                continue;
            const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
            if (stat.isSymbolicLink())
                throw fail('SDK 包内部不能包含链接。');
            if (stat.isDirectory())
                walk(file);
            else {
                regular(file);
                budget.bytes += stat.size;
                budget.files++;
                if (budget.bytes > PI_SDK_LIMITS.bytes || budget.files > PI_SDK_LIMITS.files)
                    throw fail('SDK 文件预算超限。');
                files.push({ file: relative(root, file), bytes: stat.size, sha256: hashFile(file) });
            }
        }
    };
    walk(root);
    return files;
}
function lockKey(root, source) {
    const key = relative(root, source);
    if (!key || key.startsWith('../') || path.isAbsolute(key))
        throw fail('SDK 依赖离开所选仓库。');
    return key;
}
function sameDependencyFields(pkg, locked) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'])
        if (JSON.stringify(canonical(pkg[field] || {})) !== JSON.stringify(canonical(locked[field] || {})))
            throw fail('SDK 已安装包依赖元数据与锁文件不一致：' + pkg.name);
}
export function createPiSdkRelease(directory, { sourceRoot } = {}) {
    sourceRoot = fs.realpathSync(path.resolve(sourceRoot));
    directory = path.resolve(directory);
    if (within(sourceRoot, directory) || fs.existsSync(directory))
        throw fail('SDK 封存目标必须是仓库外的新目录。');
    const lockFile = path.join(sourceRoot, 'package-lock.json'), lockProof = certifiedJson(lockFile, 16 * 1024 * 1024), sourceLock = lockProof.value, sourceLockSha256 = lockProof.sha256, workspaces = new Map();
    if (sourceLock.lockfileVersion !== 3 || !sourceLock.packages)
        throw fail('需要版本 3 的 SDK 安装锁。');
    for (const name of WORKSPACES) {
        const source = fs.realpathSync(path.join(sourceRoot, 'packages', name)), pkg = readSmallJson(path.join(source, 'package.json'));
        if (!PACKAGE.test(pkg.name))
            throw fail('SDK 工作区包名称无效。');
        workspaces.set(source, { source, pkg, destination: relative(sourceRoot, source) });
    }
    const rootPkg = readSmallJson(path.join(sourceRoot, 'package.json'));
    if (rootPkg.name !== 'pi-monorepo')
        throw fail('选择目录不是预期 Pi SDK 仓库。');
    const loader = path.join(sourceRoot, 'node_modules/tsx'), queue = [...workspaces.values()].map(item => item.source).concat(loader), records = new Map(), omitted = [], budget = { entries: 0, files: 0, bytes: 0 };
    const destinationOf = source => {
        const owned = workspaces.get(source);
        if (owned)
            return owned.destination;
        const rootModules = path.join(sourceRoot, 'node_modules');
        if (within(rootModules, source))
            return relative(sourceRoot, source);
        for (const owner of [...workspaces.values()].sort((a, b) => b.source.length - a.source.length))
            if (within(path.join(owner.source, 'node_modules'), source))
                return owner.destination + '/' + relative(owner.source, source);
        throw fail('SDK 依赖不在受管的安装布局中。');
    };
    while (queue.length) {
        const source = fs.realpathSync(queue.shift());
        if (records.has(source))
            continue;
        if (records.size >= PI_SDK_LIMITS.packages)
            throw fail('SDK 依赖包数量超限。');
        const packageProof = certifiedJson(path.join(source, 'package.json')), pkg = packageProof.value, key = lockKey(sourceRoot, source), locked = sourceLock.packages[key], expectedName = locked?.name || (key.includes('node_modules/') ? key.slice(key.lastIndexOf('node_modules/') + 13) : undefined);
        if (typeof pkg.name !== 'string' || !PACKAGE.test(pkg.name) || typeof pkg.version !== 'string' || !locked || locked.link || locked.extraneous || locked.version !== pkg.version || expectedName !== pkg.name)
            throw fail('SDK 已安装包未被精确锁定：' + String(pkg.name));
        sameDependencyFields(pkg, locked);
        const destination = destinationOf(source);
        if ([...records.values()].some(item => item.destination === destination))
            throw fail('SDK 包目标路径冲突。');
        const files = contentInventory(source, { workspace: workspaces.has(source), budget });
        if (files.find(file => file.file === 'package.json')?.sha256 !== packageProof.sha256)
            throw fail('SDK 依赖解析字节与封存包元数据不一致。');
        records.set(source, { source, destination, pkg, files, sourceKey: key });
        const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
        for (const name of Object.keys(dependencies).sort(cmp)) {
            if (!PACKAGE.test(name))
                throw fail('SDK 依赖名称无效。');
            const paths = createRequire(path.join(source, 'package.json')).resolve.paths(name) || [], found = paths.map(folder => path.join(folder, name)).find(candidate => fs.existsSync(path.join(candidate, 'package.json')));
            if (found) {
                if (queue.length >= 4096)
                    throw fail('SDK 依赖清点队列超限。');
                queue.push(found);
            }
            else if (Object.hasOwn(pkg.optionalDependencies || {}, name) || pkg.peerDependenciesMeta?.[name]?.optional === true)
                omitted.push({ package: pkg.name, dependency: name, reason: 'optional-not-installed' });
            else
                throw fail('SDK 缺少必需的已安装依赖：' + name);
        }
    }
    const all = [...records.values()], totalFiles = all.reduce((n, p) => n + p.files.length, 0), totalBytes = all.reduce((n, p) => n + p.files.reduce((sum, f) => sum + f.bytes, 0), 0);
    if (totalFiles > PI_SDK_LIMITS.files || totalBytes > PI_SDK_LIMITS.bytes)
        throw fail('SDK 运行快照超过总文件/字节预算。');
    const tsProof = certifiedJson(path.join(sourceRoot, 'tsconfig.json')), baseProof = certifiedJson(path.join(sourceRoot, 'tsconfig.base.json')), tsconfig = tsProof.value, baseConfig = baseProof.value;
    if (tsconfig.extends !== './tsconfig.base.json' || baseConfig.extends !== undefined)
        throw fail('SDK tsconfig 继承超出封存根目录。');
    if ([tsconfig, baseConfig].some(value => value.compilerOptions?.baseUrl !== undefined && !['.', './'].includes(value.compilerOptions.baseUrl)))
        throw fail('SDK tsconfig baseUrl 超出已支持的封存根目录。');
    const safeTarget = target => typeof target === 'string' && target.startsWith('./') && !/[\\:\u0000]/.test(target) && !target.split('/').includes('..');
    for (const config of [tsconfig, baseConfig])
        for (const targets of Object.values(config.compilerOptions?.paths || {}))
            if (!Array.isArray(targets) || targets.some(target => !safeTarget(target)))
                throw fail('SDK tsconfig 路径超出已支持的相对布局。');
    const mappings = {};
    for (const [name, targets] of Object.entries(tsconfig.compilerOptions?.paths || {})) {
        mappings[name] = targets.map(target => {
            for (const owner of workspaces.values()) {
                const prefix = './' + relative(sourceRoot, owner.source);
                if (target === prefix || target.startsWith(prefix + '/'))
                    return './' + owner.destination + target.slice(prefix.length);
            }
            return target;
        });
    }
    fs.mkdirSync(directory, { recursive: true });
    assertRegularDirectory(directory);
    for (const item of all)
        copyCertifiedFiles(item.source, path.join(directory, item.destination), item.files);
    atomicJson(path.join(directory, 'package.json'), { private: true, type: 'module' });
    atomicJson(path.join(directory, 'tsconfig.base.json'), baseConfig);
    atomicJson(path.join(directory, 'tsconfig.json'), { ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, paths: mappings } });
    for (const file of ['LICENSE', 'package-lock.json']) {
        const input = path.join(sourceRoot, file), stat = regular(input);
        copyCertifiedFiles(sourceRoot, directory, [{ file: file === 'package-lock.json' ? 'package-lock.json' : file, bytes: stat.size, sha256: hashFile(input) }]);
    }
    // The original lock is provenance, not an install recipe for the relocated
    // sealed tree. No npm install/build/lifecycle or provider request is run.
    fs.renameSync(path.join(directory, 'package-lock.json'), path.join(directory, 'source-package-lock.json'));
    const finalBudget = { entries: 0, files: 0, bytes: 0 };
    for (const item of all)
        if (JSON.stringify(contentInventory(item.source, { workspace: workspaces.has(item.source), budget: finalBudget })) !== JSON.stringify(item.files))
            throw fail('SDK 包在封存中发生变化。');
    if (hashFile(lockFile) !== sourceLockSha256 || hashFile(path.join(sourceRoot, 'tsconfig.json')) !== tsProof.sha256 || hashFile(path.join(sourceRoot, 'tsconfig.base.json')) !== baseProof.sha256)
        throw fail('SDK 锁或配置在封存中发生变化。');
    const files = snapshotInventory(directory), packages = all.map(item => ({ name: item.pkg.name, version: item.pkg.version, directory: item.destination, sourceKey: item.sourceKey, license: typeof item.pkg.license === 'string' ? item.pkg.license : null })).sort((a, b) => cmp(a.directory, b.directory));
    const descriptor = { format: 'web-cad-pi-sdk', version: 1, mode: 'tsx-source-lock-closure', platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, sdkVersion: records.get(fs.realpathSync(path.join(sourceRoot, 'packages/coding-agent'))).pkg.version, sourceLockSha256, cli: 'node_modules/tsx/dist/cli.mjs', entry: 'packages/coding-agent/src/cli.ts', tsconfig: 'tsconfig.json', packages, omitted: omitted.sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b))), files };
    atomicJson(path.join(directory, 'sdk-release.json'), descriptor);
    const binding = { format: 'web-cad-pi-sdk-binding', version: 1, sdkVersion: descriptor.sdkVersion, mode: descriptor.mode, manifest: { bytes: fs.statSync(path.join(directory, 'sdk-release.json')).size, sha256: hashFile(path.join(directory, 'sdk-release.json')) } };
    validatePiSdkRelease(directory, binding);
    return binding;
}
function snapshotInventory(directory) {
    // Unlike package enumeration, the complete sealed result has no ignored
    // node_modules. Reject links and any late extra file, including config.
    const files = [], budget = { entries: 0 };
    let bytes = 0;
    const walk = folder => {
        for (const entry of entries(folder, budget)) {
            const file = path.join(folder, entry.name), stat = fs.lstatSync(file);
            if (stat.isSymbolicLink())
                throw fail('SDK 发布不能含链接。');
            if (stat.isDirectory())
                walk(file);
            else {
                if (file === path.join(directory, 'sdk-release.json'))
                    continue;
                regular(file);
                bytes += stat.size;
                if (bytes > PI_SDK_LIMITS.bytes || files.length >= PI_SDK_LIMITS.files)
                    throw fail('SDK 运行目录超限。');
                files.push({ file: relative(directory, file), bytes: stat.size, sha256: hashFile(file) });
            }
        }
    };
    assertRegularDirectory(directory);
    walk(directory);
    return files;
}
export function validatePiSdkRelease(directory, binding, { verifyFiles = true } = {}) {
    assertRegularDirectory(directory);
    const proof = certifiedJson(path.join(directory, 'sdk-release.json'), PI_SDK_LIMITS.manifestBytes);
    if (binding?.format !== 'web-cad-pi-sdk-binding' || binding.version !== 1 || binding.mode !== 'tsx-source-lock-closure' || proof.bytes !== binding.manifest?.bytes || !HASH.test(binding.manifest?.sha256 || '') || proof.sha256 !== binding.manifest.sha256)
        throw fail('Pi SDK 绑定清单无效或已变化。');
    const descriptor = proof.value;
    if (descriptor.format !== 'web-cad-pi-sdk' || descriptor.version !== 1 || descriptor.mode !== binding.mode || descriptor.sdkVersion !== binding.sdkVersion || descriptor.nodeVersion !== process.versions.node || descriptor.platform !== process.platform || descriptor.arch !== process.arch || !Array.isArray(descriptor.files) || descriptor.files.length > PI_SDK_LIMITS.files || descriptor.cli !== 'node_modules/tsx/dist/cli.mjs' || descriptor.entry !== 'packages/coding-agent/src/cli.ts' || descriptor.tsconfig !== 'tsconfig.json')
        throw fail('Pi SDK 平台、版本或入口无效。');
    const safe = file => typeof file === 'string' && file.length <= 2048 && !file.split('/').some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part));
    if (!HASH.test(descriptor.sourceLockSha256 || '') || !Array.isArray(descriptor.packages) || descriptor.packages.length > PI_SDK_LIMITS.packages || !Array.isArray(descriptor.omitted) || descriptor.omitted.length > 4096)
        throw fail('SDK 包或来源元数据无效。');
    const names = new Set();
    let bytes = 0;
    for (const file of descriptor.files) {
        if (!safe(file.file) || names.has(file.file) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > PI_SDK_LIMITS.fileBytes || !HASH.test(file.sha256 || ''))
            throw fail('SDK 文件清单无效。');
        names.add(file.file);
        bytes += file.bytes;
    }
    if (bytes > PI_SDK_LIMITS.bytes)
        throw fail('SDK 声明的总字节超限。');
    for (const file of ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'source-package-lock.json', descriptor.cli, descriptor.entry])
        if (!names.has(file))
            throw fail('SDK 清单缺少必要入口。');
    const packageDirs = new Set();
    for (const pkg of descriptor.packages)
        if (typeof pkg.name !== 'string' || !PACKAGE.test(pkg.name) || typeof pkg.version !== 'string' || !safe(pkg.directory) || !safe(pkg.sourceKey) || packageDirs.has(pkg.directory) || !names.has(pkg.directory + '/package.json'))
            throw fail('SDK 包身份或目录无效。');
        else
            packageDirs.add(pkg.directory);
    if (verifyFiles && (JSON.stringify(snapshotInventory(directory)) !== JSON.stringify(descriptor.files) || hashFile(path.join(directory, 'source-package-lock.json')) !== descriptor.sourceLockSha256))
        throw fail('Pi SDK 文件缺失、增加或内容改变。');
    return { cliPath: path.join(directory, descriptor.cli), cliArgs: ['--tsconfig', path.join(directory, descriptor.tsconfig), path.join(directory, descriptor.entry)], cwd: directory, version: descriptor.sdkVersion, manifestSha256: binding.manifest.sha256, files: descriptor.files.length, bytes: descriptor.files.reduce((n, file) => n + file.bytes, 0), packages: descriptor.packages.length };
}
