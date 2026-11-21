import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { peImports, isSystemImport, createNativeRuntime, validateNativeRuntime } from '../gateway/native-runtime-release.mjs';
function image(imports = [], delay = []) {
    const b = Buffer.alloc(4096), pe = 0x80, opt = pe + 24;
    b.writeUInt16LE(0x5a4d, 0);
    b.writeUInt32LE(pe, 0x3c);
    b.writeUInt32LE(0x4550, pe);
    b.writeUInt16LE(0x8664, pe + 4);
    b.writeUInt16LE(1, pe + 6);
    b.writeUInt16LE(240, pe + 20);
    b.writeUInt16LE(0x20b, opt);
    b.writeUInt32LE(0x200, opt + 60);
    b.writeUInt32LE(16, opt + 108);
    const s = opt + 240;
    b.writeUInt32LE(0x1000, s + 12);
    b.writeUInt32LE(0xe00, s + 16);
    b.writeUInt32LE(0x200, s + 20);
    let nameAt = 0x600;
    for (const [items, index, offset, stride, field] of [[imports, 1, 0x200, 20, 12], [delay, 13, 0x400, 32, 4]]) {
        if (!items.length)
            continue;
        b.writeUInt32LE(offset + 0xe00, opt + 112 + index * 8);
        b.writeUInt32LE((items.length + 1) * stride, opt + 116 + index * 8);
        for (let i = 0; i < items.length; i++) {
            const at = offset + i * stride;
            if (index === 13)
                b.writeUInt32LE(1, at);
            b.writeUInt32LE(nameAt + 0xe00, at + field);
            nameAt += b.write(items[i] + '\0', nameAt, 'ascii');
        }
    }
    return b;
}
function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-native-release-')), geometry = path.join(root, '几何'), mesh = path.join(root, '网格'), shared = path.join(root, '共有'), out = path.join(root, '封存');
    for (const directory of [geometry, mesh, shared])
        fs.mkdirSync(directory);
    const file = (directory, name, imports = ['KERNEL32.dll']) => { const target = path.join(directory, name); fs.writeFileSync(target, image(imports)); return target; };
    const inputs = { geometry: { roles: { geometry: file(geometry, 'geometry.exe', ['same.dll']), inspector: file(geometry, 'inspector.exe'), lock: file(geometry, 'lock.exe'), swap: file(geometry, 'swap.exe') }, search: [geometry, shared] }, mesh: { roles: { mesh: file(mesh, 'mesh.exe', ['same.dll']) }, search: [mesh, shared] } };
    file(geometry, 'same.dll', ['support.dll']);
    const other = file(mesh, 'same.dll', ['support.dll']);
    const bytes = fs.readFileSync(other);
    bytes[4095] = 7;
    fs.writeFileSync(other, bytes);
    file(shared, 'support.dll');
    fs.writeFileSync(path.join(shared, 'unused.dll'), 'not a PE; must not be crawled into the release');
    try {
        return run({ root, geometry, mesh, shared, out, inputs, file });
    }
    finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-native-release-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
const sign = value => { const rest = { ...value }; delete rest.sha256; return { ...rest, sha256: crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex') }; };
function addDiscrete(f){
    const directory=path.join(f.root,'离散'),noticesRoot=path.join(f.root,'许可');fs.mkdirSync(directory);fs.mkdirSync(path.join(noticesRoot,'worker'),{recursive:true});
    const names=['libgmp-10.dll','libmpfr-6.dll','libgcc_s_seh-1.dll','libwinpthread-1.dll'];
    const discrete=f.file(directory,'discrete.exe',names),packages=names.map(name=>{const target=f.file(directory,name);return {runtime:{file:name,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}};});
    const license=fs.readFileSync(path.resolve(import.meta.dirname,'../discrete-surface-worker/LICENSE'));fs.writeFileSync(path.join(noticesRoot,'worker/LICENSE'),license);
    const evidence={format:'web-cad-discrete-license-inputs',version:1,route:{selected:'GPL-3.0-or-later',commercialLicenseUsed:false,separateProcessExemptionClaimed:false,wholeRepositoryRelicensed:false},distributionGate:{state:'blocked',publicDistributionQualified:false},captures:[{file:'worker/LICENSE',bytes:license.length,sha256:crypto.createHash('sha256').update(license).digest('hex')}],packages};
    fs.writeFileSync(path.join(noticesRoot,'result.json'),JSON.stringify(evidence));f.inputs.discrete={roles:{discrete},search:[directory],noticesRoot};return {directory,noticesRoot,evidence};
}
test('optional discrete runtime is a new version with its own PE closure and captured GPL materials',()=>fixture(f=>{
    addDiscrete(f);const value=createNativeRuntime(f.out,f.inputs),runtime=validateNativeRuntime(f.out,value);assert.equal(value.version,2);assert.deepEqual(Object.keys(value.profiles),['geometry','mesh','discrete']);assert.equal(runtime.discreteBin,path.join(f.out,'discrete'));assert.equal(runtime.roles.discrete,path.join(f.out,'discrete/discrete.exe'));assert.equal(runtime.files,14);assert.equal(value.distribution.qualified,false);assert.equal(value.distribution.licenseRoute,'GPL-3.0-or-later');assert.equal(value.notices.length,2);assert.ok(value.notices.some(item=>item.file==='notices/discrete/worker/LICENSE'));assert.equal(JSON.stringify(value).includes(f.root),false);
}));
test('old two-profile native format is still exact and never pretends to include a discrete engine',()=>fixture(f=>{
    const value=createNativeRuntime(f.out,f.inputs),runtime=validateNativeRuntime(f.out,value);assert.equal(value.version,1);assert.equal(runtime.roles.discrete,undefined);assert.equal(value.notices,undefined);assert.equal(value.distribution,undefined);const changed=sign({...value,version:2});assert.throws(()=>validateNativeRuntime(f.out,changed,{verifyFiles:false}));
}));
test('discrete runtime refuses missing or mismatched source notices before copying any runtime',()=>fixture(f=>{
    const fixture=addDiscrete(f),file=path.join(fixture.noticesRoot,'result.json');fixture.evidence.packages[0].runtime.sha256='a'.repeat(64);fs.writeFileSync(file,JSON.stringify(fixture.evidence));assert.throws(()=>createNativeRuntime(f.out,f.inputs),/实际表面重构/);assert.equal(fs.existsSync(f.out),false);
}));
test('discrete source materials cannot declare commercial use, a GPL process exemption or public-source compliance',()=>fixture(f=>{
    const fixture=addDiscrete(f),file=path.join(fixture.noticesRoot,'result.json');for(const change of [copy=>copy.route.commercialLicenseUsed=true,copy=>copy.route.separateProcessExemptionClaimed=true,copy=>copy.route.wholeRepositoryRelicensed=true,copy=>copy.distributionGate.publicDistributionQualified=true,copy=>copy.packages=[]]){const copy=structuredClone(fixture.evidence);change(copy);fs.writeFileSync(file,JSON.stringify(copy));assert.throws(()=>createNativeRuntime(f.out,f.inputs));assert.equal(fs.existsSync(f.out),false);}
}));
test('discrete runtime detects modified DLLs and notices, including before a JS-only child reads the manifest',()=>fixture(f=>{
    addDiscrete(f);const value=createNativeRuntime(f.out,f.inputs),target=path.join(f.out,'notices/discrete/worker/LICENSE');fs.appendFileSync(target,'changed');assert.throws(()=>validateNativeRuntime(f.out,value));const bad=structuredClone(value);bad.distribution.qualified=true;assert.throws(()=>validateNativeRuntime(f.out,sign(bad),{verifyFiles:false}));
}));
test('new notice paths, duplicate identities and profile downgrade attempts are rejected without filesystem fallback',()=>fixture(f=>{
    addDiscrete(f);const value=createNativeRuntime(f.out,f.inputs);for(const change of [copy=>copy.notices[0].file='notices/discrete/../escape',copy=>copy.notices.push(copy.notices[0]),copy=>delete copy.profiles.discrete,copy=>copy.version=1,copy=>copy.profiles.discrete.roles.discrete='../discrete.exe']){const copy=structuredClone(value);change(copy);assert.throws(()=>validateNativeRuntime(f.out,sign(copy),{verifyFiles:false}));}
}));
test('PE static and RVA-delay dependencies are parsed exactly without executing or guessing names', () => {
    assert.deepEqual(peImports(image(['KERNEL32.dll', 'ABC.DLL'], ['late.dll'])), ['abc.dll', 'kernel32.dll', 'late.dll']);
    assert.deepEqual(peImports(image(['WINSPOOL.DRV'])), ['winspool.drv']);
    assert.equal(isSystemImport('api-ms-win-crt-runtime-l1-1-0.dll'), true);
    assert.equal(isSystemImport('libstdc++-6.dll'), false);
});
test('truncated, wrong-architecture, escaping names, bad RVAs and unterminated tables are refused', () => {
    assert.throws(() => peImports(Buffer.alloc(8)));
    const wrong = image();
    wrong.writeUInt16LE(0x14c, 0x84);
    assert.throws(() => peImports(wrong), /x64/);
    assert.throws(() => peImports(image(['../escape.dll'])), /名称/);
    const rva = image(['a.dll']);
    rva.writeUInt32LE(0xffff0000, 0x200 + 12);
    assert.throws(() => peImports(rva), /地址/);
    const unterminated = image(['a.dll']);
    unterminated.writeUInt32LE(20, 0x80 + 24 + 116 + 8);
    assert.throws(() => peImports(unterminated), /结束/);
    const delay = image([], ['a.dll']);
    delay.writeUInt32LE(0, 0x400);
    assert.throws(() => peImports(delay), /非 RVA/);
});
test('geometry and Gmsh keep separate recursive DLL closures even for different same-name DLLs', () => fixture(f => {
    const value = createNativeRuntime(f.out, f.inputs), runtime = validateNativeRuntime(f.out, value);
    assert.equal(runtime.files, 9);
    assert.notEqual(value.profiles.geometry.files.find(file => file.file === 'same.dll').sha256, value.profiles.mesh.files.find(file => file.file === 'same.dll').sha256);
    assert.equal(fs.existsSync(path.join(f.out, 'geometry/unused.dll')), false);
    assert.equal(JSON.stringify(value).includes(f.root), false);
    fs.writeFileSync(f.inputs.geometry.roles.geometry, 'workspace changed');
    assert.equal(validateNativeRuntime(f.out, value).sha256, value.sha256);
}));
test('missing explicit dependency is rejected before any runtime output is copied', () => fixture(f => {
    fs.unlinkSync(path.join(f.shared, 'support.dll'));
    assert.throws(() => createNativeRuntime(f.out, f.inputs), /support.dll/);
    assert.equal(fs.existsSync(f.out), false, 'Resolve the complete closure before copying any output.');
}));
test('native source links, invalid PE files and oversized images are rejected', () => fixture(f => {
    const target = path.join(f.geometry, 'same.dll'), saved = fs.readFileSync(target), link = path.join(f.root, 'hardlink.dll');
    fs.linkSync(target, link);
    assert.throws(() => createNativeRuntime(f.out, f.inputs), /单链接/);
    fs.unlinkSync(link);
    fs.writeFileSync(target, 'bad');
    assert.throws(() => createNativeRuntime(f.out, f.inputs), /映像/);
    fs.writeFileSync(target, saved);
    fs.truncateSync(target, 64 * 1024 * 1024 + 1);
    assert.throws(() => createNativeRuntime(f.out, f.inputs), /有界/);
}));
test('DLL closure is derived from the exact certified image bytes, not a second unverified read', () => fixture(f => {
    const original = fs.readFileSync, target = f.inputs.geometry.roles.geometry;
    fs.readFileSync = function (file, ...args) { if (file === target)
        return image(); return original.call(this, file, ...args); };
    try {
        assert.throws(() => createNativeRuntime(f.out, f.inputs), /解析字节/);
        assert.equal(fs.existsSync(f.out), false);
    }
    finally {
        fs.readFileSync = original;
    }
}));
test('changed, additional and missing runtime files fail full validation, not silently source fallback', () => fixture(f => {
    const value = createNativeRuntime(f.out, f.inputs), target = path.join(f.out, 'mesh/same.dll'), saved = fs.readFileSync(target);
    fs.writeFileSync(target, image());
    assert.throws(() => validateNativeRuntime(f.out, value), /改变/);
    fs.writeFileSync(target, saved);
    const added = path.join(f.out, 'mesh/unknown.dll');
    fs.writeFileSync(added, image());
    assert.throws(() => validateNativeRuntime(f.out, value));
    fs.unlinkSync(added);
    fs.unlinkSync(target);
    assert.throws(() => validateNativeRuntime(f.out, value));
    assert.equal(validateNativeRuntime(f.out, value, { verifyFiles: false }).sha256, value.sha256, 'JS-only children verify the pinned descriptor without reading native DLL bytes.');
}));
test('manifest identity, profile roles, traversal, duplicate names, budgets and system declarations are strict', () => fixture(f => {
    const value = createNativeRuntime(f.out, f.inputs);
    const invalid = change => { const copy = structuredClone(value); change(copy); assert.throws(() => validateNativeRuntime(f.out, sign(copy), { verifyFiles: false })); };
    invalid(copy => copy.profiles.mesh.roles.mesh = '../escape.exe');
    invalid(copy => copy.profiles.mesh.files.push({ ...copy.profiles.mesh.files[0] }));
    invalid(copy => copy.profiles.mesh.files[0].file = '../escape.dll');
    invalid(copy => copy.profiles.mesh.systemImports.push('libunbundled.dll'));
    invalid(copy => copy.profiles.mesh.files[0].bytes = 1024 * 1024 * 1024);
    invalid(copy => copy.platform = 'not-windows');
    assert.throws(() => validateNativeRuntime(f.out, { ...value, sha256: 'a'.repeat(64) }), /摘要/);
}));
