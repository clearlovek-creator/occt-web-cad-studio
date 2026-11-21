import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {isDeepStrictEqual} from 'node:util';
import { collectProjectSources, decodeProjectPackage, encodeProjectPackage, ProjectFileError } from "./project-package.mjs";
import { readManagedStepSource, verifyStepSource } from './step-source-integrity.mjs';
import {assetDirectoryChain} from './mesh-asset-registry.mjs';
import {captureMeshSource} from '../shared/mesh-source.mjs';
const identityMatches=(a,b)=>a&&b&&['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(key=>String(a[key])===String(b[key]));
function privateDirectory(parent,prefix){assetDirectoryChain(parent);const created=fs.mkdtempSync(path.toNamespacedPath(path.join(parent,prefix)));return path.join(path.resolve(parent),path.basename(created));}
function checkCancelled(signal){if(signal?.aborted)throw new ProjectFileError('工程文件操作已取消，未提交。','PROJECT_FILE_CANCELLED');}
function fileOperationError(error){if(error instanceof ProjectFileError||!/^((PROJECT|MESH|SURFACE)_[A-Z0-9_]{1,90})$/.test(error?.code||''))return error;const mapped=new ProjectFileError(error.message,error.code);if(error.projectRollback)Object.defineProperty(mapped,'projectRollback',{value:error.projectRollback});return mapped;}
function atomicJson(target, value) {
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 64 * 1024 * 1024)
        throw new ProjectFileError('工程打开恢复记录超过 64 MiB，未继续执行。', 'PROJECT_JOURNAL_TOO_LARGE');
    const temporary = `${target}.tmp-${crypto.randomUUID()}`;
    const fd = fs.openSync(temporary, "wx");
    try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(temporary, target);
    }
    catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}
function snapshotProof(file) {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 32n || before.size > 1024n ** 3n)
        throw new ProjectFileError('工程打开恢复快照类型或大小无效。', 'PROJECT_ROLLBACK_PROOF_INVALID');
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = fs.openSync(file, 'r');
    let bytes = 0;
    try {
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, count));
            bytes += count;
        }
        const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
        for (const item of [after, current])
            if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some(key => item[key] !== before[key]))
                throw new ProjectFileError('工程打开恢复快照在核验期间变化。', 'PROJECT_ROLLBACK_PROOF_INVALID');
    }
    finally {
        fs.closeSync(fd);
    }
    if (BigInt(bytes) !== before.size)
        throw new ProjectFileError('工程打开恢复快照读取不完整。', 'PROJECT_ROLLBACK_PROOF_INVALID');
    return { bytes, sha256: hash.digest('hex') };
}
/** Caller must serialize save/open with all mutations of the same document. */
export class ProjectFileService {
    constructor({ dataDir, historyStore, propertySchemaStore, projectDataStore=propertySchemaStore, command, inspectSources, meshIntegration, maxUnpackedBytes = 512 * 1024 * 1024, maxPackedBytes = 256 * 1024 * 1024, onExecutionStart = () => { }, onCommitStart = () => { }, onRecoveryStart = () => { }, captureExecutionState = () => null, assertExecutionState = () => { }, onWarning = console.warn }) {
        Object.assign(this, { dataDir, historyStore, propertySchemaStore, projectDataStore, command, inspectSources, meshIntegration, maxUnpackedBytes, maxPackedBytes, onExecutionStart, onCommitStart, onRecoveryStart, captureExecutionState, assertExecutionState, onWarning });
        this.active = new Set();
        this.blocked = new Set();
        this.terminalJournals = new Map();
        this.transactions = path.join(dataDir, "project-transactions");
        this.assets = path.join(dataDir, "project-assets");
        fs.mkdirSync(this.transactions, { recursive: true });
        fs.mkdirSync(this.assets, { recursive: true });
    }
    check(result) { if (!result?.ok)
        throw new ProjectFileError(result?.error || "几何内核未完成工程操作。", result?.code || "PROJECT_KERNEL_FAILED"); return result; }
    validateId(id) { if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
        throw new ProjectFileError("工程 ID 无效。"); }
    journalPath(id) { this.validateId(id); return path.join(this.transactions, `${id}.pending.json`); }
    hasUnconfirmed(id) { return this.active.has(id) || this.blocked.has(id) || fs.existsSync(this.journalPath(id)) && !this.terminalJournals.has(id); }
    assertModelAccess(id) { if (!this.active.has(id) && this.hasUnconfirmed(id))
        throw new ProjectFileError('工程打开恢复尚未完成，已停止后续几何访问；请重启后台完成恢复。', 'PROJECT_RECOVERY_REQUIRED'); }
    assertAvailable(id) { this.validateId(id); if (this.active.has(id) || this.hasUnconfirmed(id) || fs.existsSync(this.journalPath(id)))
        throw new ProjectFileError('工程打开或恢复记录清理尚未完成，未开始另一次打开；请等待或重启后台恢复。', 'PROJECT_RECOVERY_REQUIRED'); }
    finishFiles(id, journal) {
        if (journal.phase === 'rolled-back')
            this.removeAssets(id, journal.assetDirectory);
        else if(journal.version===3){assetDirectoryChain(journal.assetDirectory);fs.rmSync(path.join(journal.assetDirectory,'input.cadproj'),{force:true});}
        fs.rmSync(journal.rollbackPath, { force: true });
        fs.rmSync(this.journalPath(id), { force: true });
        this.terminalJournals.delete(id);
    }
    removeAssets(id, directory) {
        const resolved = path.resolve(directory);
        if (path.dirname(resolved) !== path.resolve(this.assets) || !path.basename(resolved).startsWith(`${id}-`))
            throw new Error("Project asset cleanup escaped its managed directory.");
        if(fs.existsSync(resolved))assetDirectoryChain(resolved);
        fs.rmSync(resolved, { recursive: true, force: true });
    }
    validateJournal(id, journal) {
        const rollback = path.resolve(journal.rollbackPath || "");
        if (![1, 2, 3].includes(journal.version) || journal.documentId !== id || !["prepared", "committed", 'rolled-back'].includes(journal.phase) || path.dirname(rollback) !== path.resolve(this.transactions) || !path.basename(rollback).startsWith(`rollback-${id}-`) || !rollback.endsWith(".xbf"))
            throw new Error(`Invalid project recovery journal: ${id}`);
        if (path.dirname(path.resolve(journal.assetDirectory || "")) !== path.resolve(this.assets) || !path.basename(journal.assetDirectory).startsWith(`${id}-`))
            throw new Error("Invalid project recovery asset path.");
        this.historyStore.normalize(id, journal.beforeHistory, journal.phase === 'prepared');
        this.projectDataStore.validateSnapshot(journal.beforeSchema);
        if (journal.version >= 2) {
            const proof = journal.rollbackProof;
            if (!proof || !Number.isSafeInteger(proof.bytes) || proof.bytes < 32 || proof.bytes > 1024 ** 3 || typeof proof.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.sha256))
                throw new ProjectFileError('工程打开恢复快照证明无效。', 'PROJECT_ROLLBACK_PROOF_INVALID');
            if (journal.phase === 'prepared') {
                const actual = snapshotProof(rollback);
                if (actual.bytes !== proof.bytes || actual.sha256 !== proof.sha256)
                    throw new ProjectFileError('工程打开恢复快照内容已变化，已保留记录且未采用错误快照。', 'PROJECT_ROLLBACK_PROOF_INVALID');
            }
        }
        if(journal.version===3){
            if(!this.meshIntegration)throw new ProjectFileError('工程恢复需要支持网格资产事务的后台版本。','PROJECT_MESH_ASSET_UPGRADE_REQUIRED');
            const registry=this.meshIntegration.registry;
            registry.validateSnapshot(id,journal.beforeMeshAssets);registry.validateSnapshot(id,journal.nextMeshAssets);
            if(journal.nextMeshAssets.setId&&journal.nextMeshAssets.archiveRoot.split('/')[0]!==path.basename(journal.assetDirectory))throw new ProjectFileError('工程恢复日志的网格资产不属于本次暂存。','PROJECT_MESH_REGISTRY_CONFLICT');
        }
    }
    replaceMeshSnapshot(id,journal,which){
        if(journal.version!==3)return;
        const registry=this.meshIntegration.registry,current=registry.snapshot(id);
        if(!isDeepStrictEqual(current,journal.beforeMeshAssets)&&!isDeepStrictEqual(current,journal.nextMeshAssets))throw new ProjectFileError('网格登记已被其他操作替换，保留恢复日志且不覆盖其他资产。','PROJECT_MESH_REGISTRY_CONFLICT');
        registry.replaceSnapshot(id,journal[which]);
    }
    recover() {
        for (const entry of fs.readdirSync(this.transactions)) {
            const match = entry.match(/^([A-Za-z0-9_-]{1,64})\.pending\.json$/);
            if (!match)
                continue;
            const id = match[1], target = path.join(this.transactions, entry);
            try {
                const stat = fs.lstatSync(target);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024)
                    throw new Error('工程打开恢复日志类型或大小无效。');
                let journal = JSON.parse(fs.readFileSync(target, "utf8"));
                this.validateJournal(id, journal);
                if (journal.phase === "prepared") {
                    this.replaceMeshSnapshot(id,journal,'beforeMeshAssets');
                    this.projectDataStore.replaceSnapshot(id, journal.beforeSchema, { preserveUpdatedAt: true });
                    this.historyStore.commit(id, journal.beforeHistory, { cleanup: false });
                    journal = { ...journal, version: journal.version, phase: 'rolled-back' };
                    // Old v1 records have no proven rollback bytes; retain their original
                    // recovery semantics, but do not publish a new v2 proof for them.
                    atomicJson(target, journal);
                }
                else this.replaceMeshSnapshot(id,journal,journal.phase==='committed'?'nextMeshAssets':'beforeMeshAssets');
                this.terminalJournals.set(id, journal);
                this.blocked.delete(id);
                this.finishFiles(id, journal);
                this.onWarning(`[project] ${id}: ${journal.phase === 'rolled-back' ? "rolled back interrupted open" : "finalized committed open"}.`);
            }
            catch (error) {
                if (!this.terminalJournals.has(id)) {
                    this.blocked.add(id);
                    this.historyStore.markRestoreError(id, '工程打开事务恢复失败，原始记录已保留：' + error.message);
                }
                this.onWarning(`[project] ${id}: open recovery blocked: ${error.message}`);
            }
        }
    }
    async save(id, { name, signal } = {}) {
        this.validateId(id);
        this.assertModelAccess(id);
        if (this.active.has(id))
            throw new ProjectFileError('工程仍在打开，未生成不完整备份。', 'PROJECT_RECOVERY_REQUIRED');
        if(this.meshIntegration)return this.saveWithMeshes(id,{name,signal});
        const summary = this.check(await this.command("document.summary", { documentId: id }));
        const sources = collectProjectSources(summary.features || [], this.dataDir, { maxSourceBytes: this.maxUnpackedBytes });
        const schema = this.projectDataStore.validateSnapshot(this.projectDataStore.list(id));
        const snapshot = path.join(this.transactions, `export-${id}-${crypto.randomBytes(16).toString("base64url")}.xbf`);
        let retainSnapshot=false;
        try {
            this.check(await this.command("document.snapshot", { documentId: id, parameters: { path: snapshot } }));
            const bytes = encodeProjectPackage({ geometry: fs.readFileSync(snapshot), ...(schema.projectDataVersion===1?{projectData:schema}:{propertySchema:schema}), sources, documentId: id, revision: summary.revision, name }, { maxUnpackedBytes: this.maxUnpackedBytes });
            if (bytes.length > this.maxPackedBytes)
                throw new ProjectFileError("工程包超过上传大小限制，未生成不可重新打开的文件。", "PROJECT_TOO_LARGE");
            return bytes;
        }
        catch(error){retainSnapshot=error?.code==='WORKER_STOP_UNCONFIRMED';throw error;}
        finally {
            if(!retainSnapshot)fs.rmSync(snapshot, { force: true });
        }
    }
    async saveWithMeshes(id,{name,signal}){
        let lock,directory,retain=false;
        try{
            lock=await this.meshIntegration.begin(id);this.active.add(id);
            checkCancelled(signal);
            const generation=this.captureExecutionState(id),summary=this.check(await this.command('document.summary',{documentId:id})),schema=this.projectDataStore.validateSnapshot(this.projectDataStore.list(id));
            directory=privateDirectory(this.transactions,`export-${id}-`);
            this.check(await this.command('document.snapshot',{documentId:id,parameters:{path:path.join(directory,'model.xbf')}}));
            checkCancelled(signal);
            const packed=await this.meshIntegration.pack(lock,{folderName:path.basename(directory),summary,projectData:schema,name,maxUnpackedBytes:this.maxUnpackedBytes,maxPackedBytes:this.maxPackedBytes,signal});
            this.assertExecutionState(id,generation);checkCancelled(signal);return packed.bytes;
        }catch(error){retain=error?.code==='WORKER_STOP_UNCONFIRMED';if(retain)this.blocked.add(id);throw fileOperationError(error);}
        finally{
            this.active.delete(id);
            try{if(directory&&!retain){assetDirectoryChain(directory);if(path.dirname(directory)!==path.resolve(this.transactions)||!path.basename(directory).startsWith(`export-${id}-`))throw Error('Project export cleanup escaped its owner');fs.rmSync(directory,{recursive:true,force:true});}}
            finally{if(lock&&!retain)this.meshIntegration.end(lock);}
        }
    }
    async prepareMeshInput(id,bytes,lock,signal){
        if(!Buffer.isBuffer(bytes)||bytes.length>this.maxPackedBytes)throw new ProjectFileError('工程文件超出上传大小限制。','PROJECT_TOO_LARGE');
        checkCancelled(signal);const directory=privateDirectory(this.assets,`${id}-`);
        try{const file=path.join(directory,'input.cadproj'),fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const unpacked=await this.meshIntegration.prepare(lock,{folderName:path.basename(directory),maxUnpackedBytes:this.maxUnpackedBytes,maxPackedBytes:this.maxPackedBytes,signal});checkCancelled(signal);return {unpacked,directory};}
        catch(error){this.removeAssets(id,directory);throw error;}
    }
    assertPreparedFiles(directory,unpacked){
        const files=[{name:'model.xbf',identity:unpacked.geometryIdentity},...unpacked.sources];
        for(const [index,row]of files.entries()){
            if(index&& !/^source-[0-9]+-[a-f0-9]{16}\.step$/.test(row.name||''))throw new ProjectFileError('工程来源暂存角色无效。','PROJECT_SOURCE_BINDINGS_MISMATCH');
            const file=path.join(directory,row.name);assetDirectoryChain(path.dirname(file));const stat=fs.lstatSync(file,{bigint:true});
            if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||!identityMatches(stat,row.identity))throw new ProjectFileError('工程暂存文件在校验后变化。','PROJECT_INPUT_CHANGED');
        }
    }
    async open(id,bytes,options={}){
        this.assertAvailable(id);let lock;
        try{lock=this.meshIntegration?await this.meshIntegration.begin(id):null;return await this.openTransaction(id,bytes,{...options,meshLock:lock});}catch(error){throw fileOperationError(error);}finally{if(lock)this.meshIntegration.end(lock);}
    }
    async openTransaction(id, bytes, { receipt, decorateResult = value => value, meshLock, signal } = {}) {
        this.assertAvailable(id);
        if (typeof decorateResult !== 'function' || receipt !== undefined && (!receipt || Array.isArray(receipt) || typeof receipt !== 'object' || Object.keys(receipt).some(key => !['key', 'fingerprint'].includes(key)) || typeof receipt.key !== 'string' || !receipt.key.startsWith(`${id}:project.open:`) || receipt.key === `${id}:project.open:` || Buffer.byteLength(receipt.key) > 640 || /[\x00-\x1f\x7f]/.test(receipt.key) || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)))
            throw new ProjectFileError('工程打开回执身份无效，未执行。', 'PROJECT_OPEN_RECEIPT_INVALID');
        receipt = receipt ? Object.freeze({ key: receipt.key, fingerprint: receipt.fingerprint }) : undefined;
        const staged=meshLock?await this.prepareMeshInput(id,bytes,meshLock,signal):null;
        const unpacked = staged?.unpacked||decodeProjectPackage(bytes, { maxUnpackedBytes: this.maxUnpackedBytes });
        if(unpacked.meshArchive!==undefined)throw new ProjectFileError('此工程包含便携网格资产，当前打开事务尚未接入资产登记；未丢弃网格或修改当前工程。','PROJECT_MESH_ASSET_UPGRADE_REQUIRED');
        if(unpacked.projectData&&this.projectDataStore===this.propertySchemaStore){if(staged)this.removeAssets(id,staged.directory);throw new ProjectFileError('当前工程数据服务不支持网格方案，未打开会丢失数据的工程。','PROJECT_DATA_UPGRADE_REQUIRED');}
        // Validate every type and value before touching the current document or disk state.
        let schema;
        try {
            schema = this.projectDataStore.validateSnapshot(unpacked.projectData||unpacked.propertySchema);
        }
        catch (error) {
            if(staged)this.removeAssets(id,staged.directory);
            throw new ProjectFileError(`工程属性数据无效：${error.message}`, "INVALID_PROJECT_SCHEMA");
        }
        const assetDirectory = staged?.directory||privateDirectory(this.assets, `${id}-`);
        // Keep the native XBF path short while preserving the journal's document prefix.
        const rollbackPath = path.join(this.transactions, `rollback-${id}-${crypto.randomBytes(16).toString("base64url")}.xbf`);
        const journalPath = this.journalPath(id);
        let journal = null, nextPath = null, prepared = false, committed = false;
        const sourceWarnings = [];
        this.active.add(id);
        try {
            const input = path.join(assetDirectory, "model.xbf");
            if(staged)this.assertPreparedFiles(assetDirectory,unpacked);else fs.writeFileSync(input, unpacked.geometry);
            const sourceBindings = unpacked.sources.map((source, index) => {
                if(staged)return {featureId:source.featureId,path:path.join(assetDirectory,source.name)};
                const target = path.join(assetDirectory, `source-${index}-${crypto.createHash("sha256").update(source.bytes).digest("hex").slice(0, 16)}.step`);
                fs.writeFileSync(target, source.bytes);
                return { featureId: source.featureId, path: target };
            });
            if (!unpacked.legacy) {
                if (!this.inspectSources)
                    throw new ProjectFileError('缺少只读检查点来源检查器，未打开未经核对的工程包。', 'SOURCE_INSPECTOR_UNAVAILABLE');
                const inspected = await this.inspectSources(input);
                if (!inspected.metadataComplete)
                    throw new ProjectFileError('工程几何缺少可读取的来源元数据，无法核对完整工程包。', 'PROJECT_SOURCE_METADATA_UNAVAILABLE');
                const sources = new Map(unpacked.sources.map((source, index) => [source.featureId, sourceBindings[index].path]));
                if (inspected.sources.length !== sources.size)
                    throw new ProjectFileError('工程包的 STEP 来源清单与真实检查点不一致，未修改当前工程。', 'PROJECT_SOURCE_BINDINGS_MISMATCH');
                let legacySources = 0;
                for (const reference of inspected.sources) {
                    const file = sources.get(reference.featureId);
                    if (!file)
                        throw new ProjectFileError('工程包缺少检查点实际依赖的 STEP 来源。', 'PROJECT_SOURCE_BINDINGS_MISMATCH');
                    if (verifyStepSource(reference, readManagedStepSource(file, this.dataDir, { maxBytes: this.maxUnpackedBytes, retainBytes: false })) === 'legacy-unverified')
                        legacySources++;
                }
                if (legacySources)
                    sourceWarnings.push(`工程含 ${legacySources} 个旧版 STEP 来源，缺少建模时的内容指纹；已保留兼容打开，但不能认证为原始来源。请在来源检查中复核。`);
            }
            checkCancelled(signal);if(staged)this.assertPreparedFiles(assetDirectory,unpacked);
            this.check(await this.command("document.snapshot", { documentId: id, parameters: { path: rollbackPath } }));
            journal = { version: meshLock?3:2, phase: "prepared", documentId: id, rollbackPath, rollbackProof: snapshotProof(rollbackPath), assetDirectory, beforeHistory: this.historyStore.get(id), beforeSchema: this.projectDataStore.list(id),...(meshLock?{beforeMeshAssets:this.meshIntegration.registry.snapshot(id),nextMeshAssets:unpacked.preparedMeshAssets.snapshot}:{}) };
            atomicJson(journalPath, journal);
            prepared = true;
            const executionState = this.captureExecutionState(id);
            this.onExecutionStart(id);
            const restored = this.check(await this.command("document.restore", { documentId: id, parameters: { path: input, ...(!unpacked.legacy ? { sourceBindings } : {}) } }));
            if (sourceBindings.length && restored.sourceBindingsApplied !== sourceBindings.length)
                throw new ProjectFileError("当前几何 Worker 不支持便携工程来源绑定，请更新 Worker 后重试。", "WORKER_UPGRADE_REQUIRED");
            if(unpacked.preparedMeshAssets?.snapshot.setId){const expected=unpacked.preparedMeshAssets.index.source,live=this.check(await this.command('document.summary',{documentId:id})),actual=captureMeshSource(live,id);if(!isDeepStrictEqual(actual.bodies,expected.bodies))throw new ProjectFileError('恢复几何的持久身份与工程网格基线不一致，未登记到错误几何。','PROJECT_MESH_SOURCE_MISMATCH');}
            this.projectDataStore.replaceSnapshot(id, schema, { preserveUpdatedAt: true });
            checkCancelled(signal);await meshLock?.lease.verify();checkCancelled(signal);
            this.onCommitStart(id);
            nextPath = this.historyStore.snapshotPath(id);
            this.check(await this.command("document.snapshot", { documentId: id, parameters: { path: nextPath } }));
            const view = this.check(await this.command("document.view", { documentId: id }));
            const nextHistory = { current: nextPath, undo: [], redo: [], restoreError: null, events: [{ eventId: `project-open-${crypto.randomUUID()}`, operation: "project.open", afterRevision: view.revision, createdAt: new Date().toISOString() }] };
            const base = { ...view, propertySchema: this.propertySchemaStore.list(id), ...(schema.projectDataVersion===1?{meshStrategies:schema.meshStrategies}:{}), projectFile: { format: unpacked.legacy ? "legacy-xbf" : "web-cad-project", version: unpacked.packageVersion||1, sourceCount: sourceBindings.length, name: typeof unpacked.metadata?.document?.name === "string" ? unpacked.metadata.document.name.trim().slice(0, 120) : null }, warnings: [...(view.warnings || []), ...sourceWarnings, ...(unpacked.legacy ? ["已打开旧版 XBF：此格式不含属性类型/实例、网格方案和便携 STEP 来源。"] : [])] };
            const result = receipt ? decorateResult(base, id, this.historyStore.prepareCommit(id, nextHistory)) : base;
            if (receipt) {
                if (!result || result.ok !== true || result.documentId !== id)
                    throw new ProjectFileError('工程打开回执与目标工程不一致，未提交。', 'PROJECT_OPEN_RECEIPT_INVALID');
                nextHistory.idempotency = [{ ...receipt, response: result, recordedAt: new Date().toISOString() }];
            }
            this.assertExecutionState(id, executionState);
            if(meshLock){this.meshIntegration.assertImportCapacity(meshLock,unpacked.preparedMeshAssets.index.bindings.length);this.replaceMeshSnapshot(id,journal,'nextMeshAssets');}
            this.historyStore.commit(id, nextHistory, { cleanup: false });
            atomicJson(journalPath, { ...journal, phase: "committed" });
            committed = true;
            this.terminalJournals.set(id, { ...journal, phase: 'committed' });
            try {
                this.finishFiles(id, { ...journal, phase: 'committed' });
                this.historyStore.cleanup(this.historyStore.documentDirectory(id), this.historyStore.get(id));
            }
            catch (error) {
                this.onWarning(`[project] Committed ${id}; deferred cleanup: ${error.message}`);
            }
            return result;
        }
        catch (error) {
            prepared ||= fs.existsSync(journalPath);
            if (prepared && !committed) {
                try {
                    try {
                        this.onRecoveryStart(id);
                    }
                    catch (reportError) {
                        this.onWarning('[project] Open recovery phase report deferred: ' + reportError.message);
                    }
                    this.validateJournal(id, journal);
                    this.check(await this.command("document.restore", { documentId: id, parameters: { path: rollbackPath } }));
                    this.projectDataStore.replaceSnapshot(id, journal.beforeSchema, { preserveUpdatedAt: true });
                    this.replaceMeshSnapshot(id,journal,'beforeMeshAssets');
                    this.historyStore.commit(id, journal.beforeHistory, { cleanup: false });
                    const terminal = { ...journal, phase: 'rolled-back' };
                    atomicJson(journalPath, terminal);
                    this.terminalJournals.set(id, terminal);
                    this.blocked.delete(id);
                    if (error && typeof error === 'object')
                        try {
                            Object.defineProperty(error, 'projectRollback', { value: { documentId: id, confirmed: true }, configurable: true });
                        }
                        catch { /* Immutable errors remain conservative. */ }
                }
                catch (rollbackError) {
                    this.blocked.add(id);
                    this.historyStore.markRestoreError(id, '工程打开恢复尚未完成：' + rollbackError.message);
                    throw new ProjectFileError(`工程打开失败，恢复尚未完成。重启网关会重试恢复。${rollbackError.message}`, "PROJECT_ROLLBACK_FAILED");
                }
            }
            if (!committed)
                try {
                    if (prepared)
                        this.finishFiles(id, { ...journal, phase: 'rolled-back' });
                    else {
                        fs.rmSync(rollbackPath, { force: true });
                        this.removeAssets(id, assetDirectory);
                    }
                    if (nextPath)
                        this.historyStore.discard(nextPath);
                }
                catch (cleanupError) {
                    this.onWarning('[project] Rejected open cleanup deferred: ' + cleanupError.message);
                }
            throw error;
        }
        finally {
            this.active.delete(id);
        }
    }
}
