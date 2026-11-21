import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertRegularDirectory, copyCertifiedFiles, fileInventory, hashFile,readSmallJson } from './frontend-release.mjs';
export class NativeRuntimeError extends Error {
    constructor(code, message) { super(message); this.name = 'NativeRuntimeError'; this.code = code; }
}
const fail = message => new NativeRuntimeError('NATIVE_RUNTIME_INVALID', message);
const NAME = /^[A-Za-z0-9_+.-]{1,160}\.(?:dll|exe)$/i, HASH = /^[a-f0-9]{64}$/;
const SYSTEM = new Set(('advapi32 avrt bcrypt bcryptprimitives cabinet cfgmgr32 comctl32 comdlg32 crypt32 cryptbase cryptsp d2d1 d3d11 d3d12 d3d9 dbghelp dnsapi dwrite dwmapi dxgi gdi32 glu32 hid imm32 iphlpapi kernel32 kernelbase mpr msvcrt mswsock ncrypt netapi32 normaliz ntdll ole32 oleaut32 opengl32 powrprof profapi psapi rpcrt4 secur32 setupapi shell32 shlwapi sspicli ucrtbase user32 userenv usp10 uxtheme version winhttp wininet winmm winspool wintrust wldap32 ws2_32 wsock32 wtsapi32').split(' ').map(name => name + '.dll'));
export const NATIVE_RUNTIME_LIMITS = Object.freeze({ files: 2048, bytes: 512 * 1024 * 1024, imageBytes: 64 * 1024 * 1024, imports: 1024 });
SYSTEM.add('msimg32.dll');
SYSTEM.add('winspool.drv');
SYSTEM.add('gdiplus.dll');
const importName = name => (NAME.test(name) && name.toLowerCase().endsWith('.dll')) || name.toLowerCase() === 'winspool.drv';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function isSystemImport(name) { return SYSTEM.has(name.toLowerCase()) || /^(?:api|ext)-ms-win-[a-z0-9-]+\.dll$/i.test(name); }
/** Bounded PE32+ AMD64 static/delay import reader. No executing external tools,
 * loading DLLs, registry searches or arbitrary PATH discovery during builds. */
export function peImports(bytes, {imageBytes = NATIVE_RUNTIME_LIMITS.imageBytes} = {}) {
    if (!Number.isSafeInteger(imageBytes) || imageBytes < 256 || imageBytes > 128 * 1024 * 1024 || !Buffer.isBuffer(bytes) || bytes.length < 256 || bytes.length > imageBytes)
        throw fail('原生映像大小无效。');
    const range = (offset, size) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length)
            throw fail('PE 映像字段越界。');
        return offset;
    };
    const u16 = offset => bytes.readUInt16LE(range(offset, 2)), u32 = offset => bytes.readUInt32LE(range(offset, 4));
    if (u16(0) !== 0x5a4d)
        throw fail('原生文件不是 PE 映像。');
    const pe = u32(0x3c);
    if (u32(pe) !== 0x4550 || u16(pe + 4) !== 0x8664)
        throw fail('仅支持 Windows x64 PE 映像。');
    const count = u16(pe + 6), optional = pe + 24, size = u16(pe + 20);
    range(optional, size);
    if (!count || count > 96 || size < 112 || u16(optional) !== 0x20b)
        throw fail('PE 节或可选头无效。');
    const number = u32(optional + 108);
    if (number > 16 || 112 + number * 8 > size)
        throw fail('PE 数据目录无效。');
    const headers = u32(optional + 60), sections = [];
    range(optional + size, count * 40);
    for (let i = 0; i < count; i++) {
        const at = optional + size + i * 40;
        sections.push({ rva: u32(at + 12), raw: u32(at + 20), size: u32(at + 16) });
    }
    const address = (rva, length) => {
        if (rva < headers)
            return range(rva, length);
        const section = sections.find(item => rva >= item.rva && rva - item.rva + length <= item.size);
        if (!section)
            throw fail('PE 导入地址不在文件数据中。');
        return range(section.raw + rva - section.rva, length);
    };
    const nameAt = rva => {
        let text = '';
        for (let i = 0; i <= 160; i++) {
            const value = bytes[address(rva + i, 1)];
            if (!value) {
                if (!importName(text))
                    throw fail('PE DLL 名称无效：' + JSON.stringify(text));
                return text.toLowerCase();
            }
            if (value < 33 || value > 126)
                throw fail('PE DLL 名称不是受支持的 ASCII。');
            text += String.fromCharCode(value);
        }
        throw fail('PE DLL 名称过长。');
    };
    const imports = new Set();
    for (const [index, stride, nameOffset, delay] of [[1, 20, 12, false], [13, 32, 4, true]]) {
        if (number <= index)
            continue;
        const rva = u32(optional + 112 + index * 8), length = u32(optional + 116 + index * 8);
        if (!rva && !length)
            continue;
        if (!rva || length < stride || length > 1024 * 1024)
            throw fail('PE 导入目录无效。');
        let ended = false;
        for (let offset = 0; offset + stride <= length; offset += stride) {
            const at = address(rva + offset, stride);
            let zero = true;
            for (let j = 0; j < stride; j += 4)
                if (u32(at + j))
                    zero = false;
            if (zero) {
                ended = true;
                break;
            }
            if (imports.size >= NATIVE_RUNTIME_LIMITS.imports)
                throw fail('PE DLL 导入数量超限。');
            if (delay && u32(at) !== 1)
                throw fail('不支持非 RVA 延迟导入，未猜测 DLL 地址。');
            imports.add(nameAt(u32(at + nameOffset)));
        }
        if (!ended)
            throw fail('PE 导入目录缺少结束记录。');
    }
    return [...imports].sort(compare);
}
function certified(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > NATIVE_RUNTIME_LIMITS.imageBytes)
        throw fail('原生输入必须是有界普通单链接文件。');
    return { file: path.basename(file), bytes: stat.size, sha256: hashFile(file) };
}
function checkBudget(files) {
    if (files.length > NATIVE_RUNTIME_LIMITS.files || files.reduce((n, file) => n + file.bytes, 0) > NATIVE_RUNTIME_LIMITS.bytes)
        throw fail('原生运行库超过文件数量或 512 MiB 总预算。');
}
export function nativeRuntimeInputs(workspace, environment = process.env) {
    const geometry = path.resolve(environment.GEOMETRY_WORKER_PATH || path.join(workspace, 'geometry-worker/build/occt_geometry_worker.exe'));
    const mesh = path.resolve(environment.MESH_WORKER_PATH || path.join(workspace, 'mesh-worker/build-gmsh/gmsh_mesh_worker.exe'));
    const geometryDir = path.dirname(geometry), mingw = environment.MINGW_BIN || 'C:/msys64/ucrt64/bin';
    const result={
        geometry: { roles: { geometry, inspector: path.resolve(environment.GEOMETRY_SOURCE_INSPECTOR_PATH || path.join(geometryDir, 'cad_snapshot_source_inspector.exe')), lock: path.join(geometryDir, 'cad_data_directory_lock.exe'), swap: path.join(geometryDir, 'cad_source_file_swap.exe') }, search: [geometryDir, environment.OCCT_BIN || path.resolve(workspace, '../install-mingw-ucrt64/win64/gcc/bin'), mingw] },
        mesh: { roles: { mesh }, search: [path.dirname(mesh), environment.GMSH_BIN || mingw, mingw] },
    };
    if(environment.DISCRETE_SURFACE_WORKER_PATH||environment.DISCRETE_SURFACE_LICENSE_INPUTS){
        if(!environment.DISCRETE_SURFACE_WORKER_PATH||!environment.DISCRETE_SURFACE_LICENSE_INPUTS)throw fail('表面重构封存必须同时指定程序和许可材料，不能用部分配置回退。');
        const discrete=path.resolve(environment.DISCRETE_SURFACE_WORKER_PATH);
        result.discrete={roles:{discrete},search:[path.dirname(discrete)],noticesRoot:path.resolve(environment.DISCRETE_SURFACE_LICENSE_INPUTS)};
    }
    return result;
}
export function collectNativeRuntimeProfile(input) {
    const directories = [...new Set(input.search.map(directory => fs.realpathSync(path.resolve(directory))))], indexes = new Map();
    for (const directory of directories) {
        assertRegularDirectory(directory);
        const names = new Map();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!/\.dll$/i.test(entry.name))
                continue;
            const key = entry.name.toLowerCase();
            if (names.has(key))
                throw fail('DLL 目录包含大小写冲突。');
            names.set(key, entry.name);
        }
        indexes.set(directory, names);
    }
    const resolve = name => {
        for (const directory of directories) {
            const spelling = indexes.get(directory).get(name);
            if (spelling)
                return path.join(directory, spelling);
        }
        throw fail('缺少显式运行库依赖：' + name);
    };
    const queue = Object.values(input.roles).map(file => path.resolve(file)), found = new Map(), system = new Set(), roles = {};
    for (const [role, file] of Object.entries(input.roles)) {
        if (!NAME.test(path.basename(file)) || !file.toLowerCase().endsWith('.exe'))
            throw fail('原生角色入口无效。');
        roles[role] = path.basename(file);
    }
    while (queue.length) {
        const file = queue.shift(), key = path.basename(file).toLowerCase(), proof = certified(file), previous = found.get(key);
        if (previous) {
            if (previous.proof.sha256 !== proof.sha256)
                throw fail('同一运行配置存在不同内容的同名原生文件。');
            continue;
        }
        const image = fs.readFileSync(file);
        if (image.length !== proof.bytes || crypto.createHash('sha256').update(image).digest('hex') !== proof.sha256)
            throw fail('原生依赖解析字节与已认证映像不一致。');
        const imports = peImports(image);
        found.set(key, { source: file, proof, imports });
        checkBudget([...found.values()].map(item => item.proof));
        for (const name of imports)
            if (isSystemImport(name))
                system.add(name);
            else if (!found.has(name))
                queue.push(resolve(name));
    }
    return { roles, systemImports: [...system].sort(compare), entries: [...found.values()].sort((a, b) => compare(a.proof.file, b.proof.file)) };
}
export function createNativeRuntime(directory, inputs) {
    if (process.platform !== 'win32' || process.arch !== 'x64')
        throw fail('原生封存当前仅验证 Windows x64。');
    const extended=Object.hasOwn(inputs,'discrete'),expected = { geometry: ['geometry', 'inspector', 'lock', 'swap'], mesh: ['mesh'],...(extended?{discrete:['discrete']}:{}) };
    if (JSON.stringify(Object.keys(inputs).sort()) !== JSON.stringify(Object.keys(expected).sort()))
        throw fail('原生配置必须包含 geometry 和 mesh，可显式增加完整 discrete 配置。');
    const profiles = {};
    const collected = {};
    for (const name of Object.keys(expected)) {
        if (JSON.stringify(Object.keys(inputs[name].roles).sort()) !== JSON.stringify([...expected[name]].sort()))
            throw fail('原生配置角色不完整。');
        collected[name] = collectNativeRuntimeProfile(inputs[name]);
    }
    let notices=[];
    if(extended){
        const evidence=readSmallJson(path.join(inputs.discrete.noticesRoot,'result.json'));
        if(evidence.format!=='web-cad-discrete-license-inputs'||evidence.version!==1||evidence.route?.selected!=='GPL-3.0-or-later'||evidence.route?.commercialLicenseUsed!==false||evidence.route?.separateProcessExemptionClaimed!==false||evidence.route?.wholeRepositoryRelicensed!==false||evidence.distributionGate?.state!=='blocked'||evidence.distributionGate?.publicDistributionQualified!==false||!Array.isArray(evidence.captures)||!Array.isArray(evidence.packages)||evidence.packages.length!==4)throw fail('表面重构许可材料缺少明确开源路线和未完成分发声明。');
        notices=fileInventory(inputs.discrete.noticesRoot);
        if(notices.length>128||notices.reduce((n,item)=>n+item.bytes,0)>2*1024*1024||!notices.some(item=>item.file==='worker/LICENSE'&&item.sha256==='416213203479e27015c32d9e8b30f80a287962a46750441b2223706cdd392116'))throw fail('表面重构许可材料超出预算或缺少准确 GPL 文本。');
        for(const item of evidence.captures)if(!notices.some(actual=>actual.file===item.file&&actual.bytes===item.bytes&&actual.sha256===item.sha256))throw fail('表面重构许可材料内容无法核对。');
        for(const item of evidence.packages||[])if(!collected.discrete.entries.some(entry=>entry.proof.file.toLowerCase()===item.runtime?.file?.toLowerCase()&&entry.proof.sha256===item.runtime.sha256))throw fail('许可材料没有对应实际表面重构运行库。');
    }
    checkBudget([...Object.values(collected).flatMap(profile => profile.entries.map(entry => entry.proof)),...notices]);
    fs.mkdirSync(directory, { recursive: true });
    assertRegularDirectory(directory);
    for (const [name, profile] of Object.entries(collected)) {
        const target = path.join(directory, name);
        fs.mkdirSync(target);
        for (const entry of profile.entries)
            copyCertifiedFiles(path.dirname(entry.source), target, [entry.proof]);
        profiles[name] = { roles: profile.roles, systemImports: profile.systemImports, files: profile.entries.map(entry => entry.proof) };
    }
    if(extended)copyCertifiedFiles(inputs.discrete.noticesRoot,path.join(directory,'notices/discrete'),notices);
    // Certify only selected files, never crawl/copy the entire MSYS installation.
    for (const profile of Object.values(collected))
        for (const entry of profile.entries)
            if (JSON.stringify(certified(entry.source)) !== JSON.stringify(entry.proof))
                throw fail('原生源文件在封存期间发生变化。');
    if(extended)for(const item of notices)if(hashFile(path.join(inputs.discrete.noticesRoot,item.file))!==item.sha256)throw fail('表面重构许可材料在封存期间改变。');
    const descriptor = { format: 'web-cad-native-runtime', version: extended?2:1, platform: process.platform, arch: process.arch, importPolicy: 'pe-amd64-static-delay-v1', profiles,...(extended?{notices:notices.map(item=>({...item,file:'notices/discrete/'+item.file})),distribution:{qualified:false,basis:'discrete-corresponding-source-incomplete-v1',licenseRoute:'GPL-3.0-or-later'}}:{}) };
    const value = { ...descriptor, sha256: digest(descriptor) };
    validateNativeRuntime(directory, value);
    return value;
}
export function validateNativeRuntime(directory, value, { verifyFiles = true } = {}) {
    if (value?.format !== 'web-cad-native-runtime' || ![1,2].includes(value.version) || value.platform !== process.platform || value.arch !== process.arch || value.importPolicy !== 'pe-amd64-static-delay-v1' || !HASH.test(value.sha256 || '') || !value.profiles)
        throw fail('原生运行库清单无效或平台不一致。');
    const { sha256, ...descriptor } = value;
    if (digest(descriptor) !== sha256)
        throw fail('原生运行库清单摘要不一致。');
    const extended=value.version===2;
    if (JSON.stringify(Object.keys(value.profiles).sort()) !== JSON.stringify(extended?['discrete','geometry','mesh']:['geometry', 'mesh']))
        throw fail('原生运行配置不完整。');
    const all = [];
    for (const [name, profile] of Object.entries(value.profiles)) {
        const roles = name === 'geometry' ? ['geometry', 'inspector', 'lock', 'swap'] : name==='discrete'?['discrete']:['mesh'];
        if (!profile || !Array.isArray(profile.files) || !Array.isArray(profile.systemImports) || JSON.stringify(Object.keys(profile.roles || {}).sort()) !== JSON.stringify(roles))
            throw fail('原生角色清单无效。');
        const names = new Set();
        for (const item of profile.files) {
            if (!NAME.test(item.file) || names.has(item.file.toLowerCase()) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > NATIVE_RUNTIME_LIMITS.imageBytes || !HASH.test(item.sha256 || ''))
                throw fail('原生文件清单无效。');
            names.add(item.file.toLowerCase());
            all.push(item);
        }
        for (const file of Object.values(profile.roles))
            if (!names.has(String(file).toLowerCase()) || !String(file).toLowerCase().endsWith('.exe'))
                throw fail('原生角色未封存。');
        if (profile.systemImports.some(name => typeof name !== 'string' || !importName(name) || !isSystemImport(name)))
            throw fail('系统 DLL 声明无效。');
    }
    if(extended){
        if(JSON.stringify(value.distribution)!==JSON.stringify({qualified:false,basis:'discrete-corresponding-source-incomplete-v1',licenseRoute:'GPL-3.0-or-later'})||!Array.isArray(value.notices)||!value.notices.length||value.notices.length>128||value.notices.reduce((n,item)=>n+item.bytes,0)>2*1024*1024)throw fail('表面重构分发和许可清单无效。');
        const seen=new Set();for(const item of value.notices){if(typeof item.file!=='string'||!/^notices\/discrete\/[A-Za-z0-9_./-]{1,256}$/.test(item.file)||item.file.split('/').some(part=>!part||part==='.'||part==='..')||seen.has(item.file.toLowerCase())||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>2*1024*1024||!HASH.test(item.sha256||''))throw fail('表面重构许可文件清单无效。');seen.add(item.file.toLowerCase());}
        if(!value.notices.some(item=>item.file==='notices/discrete/worker/LICENSE'&&item.sha256==='416213203479e27015c32d9e8b30f80a287962a46750441b2223706cdd392116'))throw fail('表面重构缺少准确 GPL 文本。');
    }else if(value.notices!==undefined||value.distribution!==undefined)throw fail('旧原生格式不能夹带未验证的新组件材料。');
    checkBudget([...all,...(extended?value.notices:[])]);
    assertRegularDirectory(directory);
    if (verifyFiles) {
        const expected = [...Object.entries(value.profiles).flatMap(([name, profile]) => profile.files.map(file => ({ ...file, file: name + '/' + file.file }))),...(extended?value.notices:[])].sort((a, b) => compare(a.file, b.file)), actual = fileInventory(directory);
        if (JSON.stringify(expected) !== JSON.stringify(actual))
            throw fail('原生程序或 DLL 缺失、增加或内容改变。');
    }
    const rolePaths = {};
    for (const [name, profile] of Object.entries(value.profiles))
        for (const [role, file] of Object.entries(profile.roles))
            rolePaths[role] = path.join(directory, name, file);
    return { roles: rolePaths, geometryBin: path.join(directory, 'geometry'), meshBin: path.join(directory, 'mesh'),...(extended?{discreteBin:path.join(directory,'discrete'),distributionQualified:false}:{}), sha256, files: all.length, bytes: all.reduce((n, file) => n + file.bytes, 0) };
}
