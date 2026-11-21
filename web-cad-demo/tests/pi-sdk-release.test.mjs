import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPiSdkRelease, validatePiSdkRelease } from '../gateway/pi-sdk-release.mjs';
import { hashFile } from '../gateway/frontend-release.mjs';
const workspaceNames = { telemetry: 'pi-telemetry', ai: 'pi-ai', tui: 'pi-tui', agent: 'pi-agent-core', protocol: 'pi-protocol', client: 'pi-client', 'session-backends/sqlite-node': 'pi-session-backend-sqlite-node', server: 'pi-server', 'coding-agent': 'pi-coding-agent' };
function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-sdk-release-')), source = path.join(root, 'SDK-源码'), output = path.join(root, '封存'), lock = { name: 'pi-monorepo', lockfileVersion: 3, packages: {} }, write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
    const pkg = (directory, metadata, files = {}) => {
        const base = path.join(source, directory);
        write(path.join(base, 'package.json'), metadata);
        for (const [file, value] of Object.entries(files))
            write(path.join(base, file), value);
        lock.packages[directory] = { ...metadata };
        delete lock.packages[directory].description;
        delete lock.packages[directory].scripts;
        return base;
    };
    write(path.join(source, 'package.json'), { name: 'pi-monorepo', private: true });
    write(path.join(source, 'LICENSE'), 'SDK license fixture');
    write(path.join(source, '.env'), 'PRIVATE_SDK_KEY=never-copy-this');
    write(path.join(source, '.npmrc'), 'private-auth-token');
    const paths = {};
    for (const [folder, name] of Object.entries(workspaceNames)) {
        const dependencies = folder === 'agent' ? { tiny: '2.0.0' } : folder === 'coding-agent' ? { tiny: '1.0.0', '@earendil-works/pi-ai': '^0.84.2' } : {};
        pkg('packages/' + folder, { name: '@earendil-works/' + name, version: '0.84.2', description: 'initial', license: 'MIT', dependencies }, { 'src/index.ts': 'export const value = 1;', 'src/cli.ts': "throw Error('BUILD_MUST_NOT_EXECUTE_SDK');", 'docs/help.md': 'Native documentation' });
        paths['@earendil-works/' + name] = ['./packages/' + folder + '/src/index.ts'];
    }
    pkg('node_modules/tsx', { name: 'tsx', version: '4.0.0', optionalDependencies: { 'optional-absent': '1.0.0' } }, { 'dist/cli.mjs': 'export {};' });
    pkg('node_modules/tiny', { name: 'tiny', version: '1.0.0', license: 'MIT' }, { 'index.js': 'export default 1;', '.env': 'private package env', 'LICENSE': 'Tiny license' });
    pkg('packages/agent/node_modules/tiny', { name: 'tiny', version: '2.0.0', license: 'MIT' }, { 'index.js': 'export default 2;' });
    const link = path.join(source, 'node_modules/@earendil-works/pi-ai');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(source, 'packages/ai'), link, 'junction');
    write(path.join(source, 'tsconfig.json'), { extends: './tsconfig.base.json', compilerOptions: { paths } });
    write(path.join(source, 'tsconfig.base.json'), { compilerOptions: { target: 'ES2022' } });
    const saveLock = () => write(path.join(source, 'package-lock.json'), lock);
    saveLock();
    try {
        return run({ root, source, output, lock, write, saveLock, build: () => createPiSdkRelease(output, { sourceRoot: source }) });
    }
    finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-sdk-release-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
function changeManifest(f, binding, change) { const target = path.join(f.output, 'sdk-release.json'), value = JSON.parse(fs.readFileSync(target, 'utf8')); change(value); fs.writeFileSync(target, JSON.stringify(value)); return { ...binding, manifest: { bytes: fs.statSync(target).size, sha256: hashFile(target) } }; }
test('SDK source snapshot preserves workspace paths, nested package versions, licenses and optional omissions without private configuration', () => fixture(f => {
    // Key order is not a dependency change.
    f.lock.packages['packages/coding-agent'].dependencies = { '@earendil-works/pi-ai': '^0.84.2', tiny: '1.0.0' };
    f.saveLock();
    const binding = f.build(), runtime = validatePiSdkRelease(f.output, binding), manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'sdk-release.json'), 'utf8'));
    assert.equal(runtime.version, '0.84.2');
    assert.equal(runtime.packages, 12);
    assert.equal(fs.lstatSync(path.join(f.output, 'packages/ai')).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(f.output, '.env')), false);
    assert.equal(fs.existsSync(path.join(f.output, '.npmrc')), false);
    assert.equal(fs.existsSync(path.join(f.output, 'node_modules/tiny/.env')), false);
    assert.equal(fs.readFileSync(path.join(f.output, 'node_modules/tiny/index.js'), 'utf8'), 'export default 1;');
    assert.equal(fs.readFileSync(path.join(f.output, 'packages/agent/node_modules/tiny/index.js'), 'utf8'), 'export default 2;');
    assert.ok(manifest.omitted.some(item => item.dependency === 'optional-absent'));
    assert.equal(JSON.stringify(manifest).includes(f.source), false);
    assert.ok(manifest.files.some(item => item.file === 'LICENSE'));
}));
test('editing the original SDK never changes the sealed source/runtime', () => fixture(f => {
    const binding = f.build();
    fs.writeFileSync(path.join(f.source, 'packages/ai/src/index.ts'), 'unpublished source');
    assert.equal(validatePiSdkRelease(f.output, binding).manifestSha256, binding.manifest.sha256);
    assert.throws(() => f.build(), /新目录/);
}));
test('missing mandatory packages and unlocked installed versions fail before a snapshot is created', () => fixture(f => {
    const target = path.join(f.source, 'node_modules/tiny/package.json'), before = fs.readFileSync(target);
    fs.unlinkSync(target);
    assert.throws(() => f.build(), /必需/);
    assert.equal(fs.existsSync(f.output), false);
    fs.writeFileSync(target, before);
    const pkg = JSON.parse(before);
    pkg.version = '9.0.0';
    fs.writeFileSync(target, JSON.stringify(pkg));
    assert.throws(() => f.build(), /精确锁定/);
}));
test('dependency metadata mismatches and external tsconfig inheritance are refused', () => fixture(f => {
    f.lock.packages['packages/ai'].dependencies = { unreviewed: '1.0.0' };
    f.saveLock();
    assert.throws(() => f.build(), /元数据/);
    delete f.lock.packages['packages/ai'].dependencies;
    f.saveLock();
    f.write(path.join(f.source, 'tsconfig.json'), { extends: '../outside.json', compilerOptions: { paths: {} } });
    assert.throws(() => f.build(), /继承/);
    assert.equal(fs.existsSync(f.output), false);
    f.write(path.join(f.source, 'tsconfig.json'), { extends: './tsconfig.base.json', compilerOptions: { baseUrl: '../outside', paths: {} } });
    assert.throws(() => f.build(), /baseUrl/);
    for (const target of ['./..\\outside.ts', './packages/ai/src/index.ts:stream', '../outside.ts']) {
        f.write(path.join(f.source, 'tsconfig.json'), { extends: './tsconfig.base.json', compilerOptions: { paths: { escape: [target] } } });
        assert.throws(() => f.build(), /相对布局/);
        assert.equal(fs.existsSync(f.output), false);
    }
    f.write(path.join(f.source, 'tsconfig.json'), { extends: './tsconfig.base.json' });
    f.write(path.join(f.source, 'tsconfig.base.json'), { compilerOptions: { paths: { escape: ['./..\\outside.ts'] } } });
    assert.throws(() => f.build(), /相对布局/);
}));
test('dependency graph metadata must match the exact package bytes that are copied', () => fixture(f => {
    const original = fs.readFileSync, target = path.join(f.source, 'packages/coding-agent/package.json');
    fs.readFileSync = function (file, ...args) {
        const value = original.call(this, file, ...args);
        if (file !== target)
            return value;
        return typeof value === 'string' ? value.replace('initial', 'changed') : Buffer.from(value.toString('utf8').replace('initial', 'changed'));
    };
    try {
        assert.throws(() => f.build(), /解析字节/);
        assert.equal(fs.existsSync(f.output), false);
    }
    finally {
        fs.readFileSync = original;
    }
}));
test('source internal links, hardlinks and per-file limits do not enter a release', () => fixture(f => {
    const target = path.join(f.source, 'packages/ai/src/index.ts'), link = path.join(f.source, 'packages/ai/src/linked.ts');
    fs.linkSync(target, link);
    assert.throws(() => f.build(), /单链接/);
    fs.unlinkSync(link);
    fs.truncateSync(target, 64 * 1024 * 1024 + 1);
    assert.throws(() => f.build(), /有界/);
}));
test('sealed files and the bound SDK manifest reject missing, changed and additional bytes', () => fixture(f => {
    const binding = f.build(), target = path.join(f.output, 'packages/ai/src/index.ts'), before = fs.readFileSync(target);
    fs.appendFileSync(target, 'x');
    assert.throws(() => validatePiSdkRelease(f.output, binding), /内容改变/);
    fs.writeFileSync(target, before);
    const added = path.join(f.output, 'private.json');
    fs.writeFileSync(added, '{}');
    assert.throws(() => validatePiSdkRelease(f.output, binding), /增加/);
    fs.unlinkSync(added);
    fs.unlinkSync(target);
    assert.throws(() => validatePiSdkRelease(f.output, binding));
    assert.equal(validatePiSdkRelease(f.output, binding, { verifyFiles: false }).version, '0.84.2');
    fs.appendFileSync(path.join(f.output, 'sdk-release.json'), ' ');
    assert.throws(() => validatePiSdkRelease(f.output, binding), /绑定/);
}));
test('manifest paths, identities, entrypoints and declared budgets are validated without loading SDK code', () => fixture(f => {
    const binding = f.build(), original = fs.readFileSync(path.join(f.output, 'sdk-release.json'));
    const invalid = change => { fs.writeFileSync(path.join(f.output, 'sdk-release.json'), original); const updated = changeManifest(f, binding, change); assert.throws(() => validatePiSdkRelease(f.output, updated, { verifyFiles: false })); };
    invalid(value => value.files[0].file = '../escape');
    invalid(value => value.files.push({ ...value.files[0] }));
    invalid(value => value.files[0].bytes = 1024 * 1024 * 1024);
    invalid(value => value.packages[0].directory = 'outside');
    invalid(value => value.entry = '../source/cli.ts');
    invalid(value => value.nodeVersion = '0.0.0');
}));
